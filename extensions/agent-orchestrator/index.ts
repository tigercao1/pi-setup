/**
 * agent-orchestrator — hierarchical multi-agent teams for pi.
 *
 * One extension, three roles. The same file is loaded by the lead (your
 * session) and by every agent it spawns; `PI_ORCH_*` env vars tell each process
 * which role it is, and role decides which tools it gets.
 *
 *   lead ──spawn──> sub-orchestrator ──spawn──> worker
 *
 * Coordination is entirely through files under ~/.pi/orchestrator-teams/<team>/
 * (see state.ts), so agents are independent processes that survive each other.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { detectBackend, isAlive } from "./backend.ts";
import { activityLabel, readActivity } from "./digest.ts";
import {
	mailDelivery,
	mailMaxHoldMs,
	mailQuietMs,
	type OrchLevel,
	orchLevel,
	setOrchLevel,
	teamRetentionMs,
} from "./config.ts";
import { sweepTeams } from "./reap.ts";
import { createRuntime, type Runtime } from "./session.ts";
import {
	type Mail,
	childrenOf,
	logPath,
	postMail,
	readAttention,
	readStatus,
	watchMailbox,
	writeStatus,
} from "./state.ts";
import { choose } from "../_shared/prompt.ts";
import { renderTeamMessage } from "./render.ts";
import { cleanupTeam, pumpQueue, registerTools, renderStatus } from "./tools.ts";
import { openAgentsOverlay, startStatusWidget } from "./ui.ts";

const MAIL_TYPE = "team-message";
/**
 * Hard cap on a single delivered message. A teammate that pastes a log, a
 * dump, or a whole file into team_message would otherwise blow a hole in the
 * lead's context window — the exact cost this extension exists to avoid.
 */
const MAX_MAIL_CHARS = 4000;

function clamp(body: string): string {
	if (body.length <= MAX_MAIL_CHARS) return body;
	const kept = body.slice(0, MAX_MAIL_CHARS);
	const dropped = body.length - kept.length;
	return `${kept}\n\n[…truncated ${dropped} chars. Read the agent's deliverable or log instead of asking it to paste content.]`;
}

export default function agentOrchestrator(pi: ExtensionAPI): void {
	let stopWidget: (() => void) | null = null;
	let signalHandlersInstalled = false;

	// Registered once per process. session_start fires again on /new, /resume
	// and /fork, so registering there would duplicate every tool.
	const rt: Runtime = createRuntime(pi);
	registerTools(pi, rt);
	// Teammate mail is a custom message, so it needs a renderer to be readable.
	// Optional API: a pi build without it must still load the extension.
	if (typeof pi.registerMessageRenderer === "function") {
		pi.registerMessageRenderer(MAIL_TYPE, renderTeamMessage as never);
	}

	pi.on("session_start", async (_event, ctx) => {
		// Session-scoped resources only: watchers, widget, cwd binding.
		disposeAll();
		rt.attach(ctx.cwd, { hasUI: ctx.hasUI });
		if (ctx.model) rt.ownModel = { model: ctx.model.id, provider: ctx.model.provider };
		rt.ownSessionId = ctx.sessionManager?.getSessionId?.() ?? undefined;
		startMailbox(rt);
		if (rt.canSpawn) {
			startWatchdog(rt);
			startQueuePump(rt);
		}

		if (rt.isLead) {
			// Abandoned team directories accumulate for months otherwise. Only
			// removes teams whose lead process is gone and that have no live
			// agent, so a concurrent session is never touched.
			try {
				const swept = sweepTeams({ olderThanMs: teamRetentionMs(), keepTeam: rt.team });
				if (swept.removed.length > 0 && ctx.hasUI) {
					ctx.ui.notify(
						`agent-orchestrator: swept ${swept.removed.length} abandoned team director${swept.removed.length === 1 ? "y" : "ies"}`,
						"info",
					);
				}
			} catch {
				// Housekeeping must never block startup.
			}
		}

		// Every orchestrator session with a screen gets a widget of its own
		// subtree; a sub-orchestrator's pane used to show nothing at all.
		if (rt.canSpawn && ctx.hasUI && !stopWidget) {
			stopWidget = startStatusWidget(rt, ctx.ui, pendingMailCount);
			rt.disposers.push(() => {
				stopWidget?.();
				stopWidget = null;
			});
			if (rt.isLead) installSignalHandlers();
		}

		if (!rt.isLead && rt.team) {
			writeStatus(rt.team, { agent: rt.me, state: "active", note: "session started" });
		}
	});

	// A spawned agent's kickoff prompt is submitted by pi's print/json driver
	// right after session_start (modes/print-mode.js: session.prompt(initialMessage)
	// with no streamingBehavior). Delivering mail in that window with triggerTurn
	// starts a run via sendCustomMessage (not streaming → _runAgentPrompt), and
	// the driver's kickoff prompt() then throws "Agent is already processing"
	// and exits(1) — the worker dies before its first turn (observed:
	// prd-crosscheck in team-20260902180005). Buffer mail until the first run
	// is streaming; from agent_start on, the followUp path queues safely.
	// The lead is human-driven (no auto-submitted kickoff), so it keeps
	// immediate delivery — buffering there would silence the wake-up path
	// until the human typed something.
	let firstRunStarted = false;
	let pendingStartupMail: Mail[] = [];
	pi.on("agent_start", () => {
		firstRunStarted = true;
		if (pendingStartupMail.length > 0) {
			const mail = pendingStartupMail;
			pendingStartupMail = [];
			deliver(rt, mail);
		}
	});

	// /new, /resume and /fork all fire session_shutdown before session_start.
	// Without this flag, typing /new while agents are working cascade-kills the
	// entire live team.
	let switchingSession = false;
	pi.on("session_before_switch", async () => {
		switchingSession = true;
	});
	pi.on("session_before_fork", async () => {
		switchingSession = true;
	});

	pi.on("session_shutdown", async () => {
		if (!rt.isLead && rt.team) {
			// An agent that exits without reporting `done` did not deliver. Saying
			// "done" here would hide crashes and auth failures from the parent.
			const current = readStatus(rt.team, rt.me)?.state;
			const reported = current === "done" || current === "error" || current === "stuck";
			if (!reported) {
				writeStatus(rt.team, {
					agent: rt.me,
					state: "error",
					note: "process exited before reporting done",
				});
			}
			// Only speak up when exiting is news. A clean `done` was already
			// reported by the agent itself, and a second wake-up per worker is
			// pure context tax on the parent once a team gets wide.
			if (rt.parent && !reported) {
				postMail(rt.team, {
					from: rt.me,
					to: rt.parent,
					kind: "message",
					content:
						"My session ended WITHOUT completing the assignment. " +
						`Check my log and status file. Last state: ${current ?? "none"}.`,
				});
			}
		}
		// Only tear down a team this process owns, and only when the process is
		// really going away — not when the user merely switches sessions.
		// Anything still buffered must land in the transcript rather than vanish.
		flushMail(rt, false);
		if (rt.isLead && rt.owns && !switchingSession && rt.config()) {
			cleanupTeam(rt, { keepFiles: true });
		}
		switchingSession = false;
		disposeAll();
	});

	// ------------------------------------------------------- commands

	pi.registerCommand("team", {
		description: "Show the agent team tree",
		handler: async (_args, ctx) => {
			ctx.ui.notify(renderStatus(rt, { forHuman: true }), "info");
		},
	});

	pi.registerCommand("agents", {
		description: "Interactive agent tree overlay (lead only)",
		handler: async (_args, ctx) => {
			if (!rt.isLead) {
				ctx.ui.notify("/agents is lead-only. Use /team.", "warning");
				return;
			}
			await openAgentsOverlay(rt, ctx);
		},
	});

	pi.registerCommand("inbox", {
		description: "Deliver buffered teammate messages now, or show what is waiting",
		handler: async (args, ctx) => {
			const waiting = pendingMailCount();
			if (args.trim() === "" && waiting === 0) {
				ctx.ui.notify(
					`No teammate mail waiting. Delivery mode: ${mailDelivery()} ` +
						`(quiet ${Math.round(mailQuietMs() / 1000)}s, max hold ${Math.round(mailMaxHoldMs() / 1000)}s).`,
					"info",
				);
				return;
			}
			const sent = flushMail(rt, true);
			ctx.ui.notify(sent > 0 ? `Delivered ${sent} buffered message(s).` : "Nothing to deliver.", "info");
		},
	});

	pi.registerCommand("orch", {
		description: "Pick the orchestration level (or type auto | 1-tier | 2-tier)",
		getArgumentCompletions: (prefix) =>
			["auto", "1-tier", "2-tier"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			let value = args.trim();
			if (!value && ctx.hasUI) {
				const current = orchLevel();
				const describeLevel: Record<OrchLevel, string> = {
					auto: "auto: you choose canSpawn",
					"1-tier": "1-tier: workers only",
					"2-tier": "2-tier: auto-promote wide fan-out",
				};
				const picked = await choose(
					ctx,
					`Orchestration level (backend: ${detectBackend()})`,
					(["auto", "1-tier", "2-tier"] as OrchLevel[]).map((level) => ({
						label: `${describeLevel[level]}${level === current ? "  (current)" : ""}`,
						value: level,
					})),
				);
				if (picked) value = picked.value;
			}
			if (!value) {
				ctx.ui.notify(
					`Orchestration level: ${orchLevel()}  |  backend: ${detectBackend()}\n` +
						"auto = you choose canSpawn; 1-tier = workers only; 2-tier = auto-promote wide fan-out",
					"info",
				);
				return;
			}
			if (!["auto", "1-tier", "2-tier"].includes(value)) {
				ctx.ui.notify(`Unknown level '${value}'. Use auto, 1-tier, or 2-tier.`, "error");
				return;
			}
			setOrchLevel(value as OrchLevel);
			ctx.ui.notify(`Orchestration level set to ${value}.`, "info");
		},
	});

	// -------------------------------------------------------- helpers

	function startMailbox(runtime: Runtime): void {
		ensureMailboxWatcher(runtime);
		// The team can change WITHOUT a session_start: team_cleanup sets
		// runtime.team = null and the next team_spawn creates a fresh team in
		// the same session. The old one-shot retry timer cleared itself once the
		// FIRST team appeared, so a second team's mailbox was never watched and
		// worker mail — including exit-without-done reports — piled up
		// undelivered (observed: 9 messages over 2.5h in team-20260902180005,
		// discovered only by a manual team_status). Keep re-checking for the
		// life of the session.
		const timer = setInterval(() => ensureMailboxWatcher(runtime), 2000);
		timer.unref?.();
		runtime.disposers.push(() => clearInterval(timer));
	}

	let watchedTeam: string | null = null;
	let stopWatching: (() => void) | null = null;

	/** (Re)install the mailbox watcher whenever the current team changes. */
	function ensureMailboxWatcher(runtime: Runtime): void {
		if (!runtime.team || runtime.team === watchedTeam) return;
		stopWatching?.();
		stopWatching = watchMailbox(runtime.team, runtime.me, (mail) => deliver(runtime, mail));
		watchedTeam = runtime.team;
		runtime.disposers.push(() => {
			stopWatching?.();
			stopWatching = null;
			watchedTeam = null;
		});
	}

	const WATCHDOG_POLL_MS = Number(process.env.PI_ORCH_WATCHDOG_POLL_MS ?? 30000);
	/** Startup crashes belong to the one-shot liveness check; give it room. */
	const WATCHDOG_GRACE_MS = 20000;
	const TERMINAL_STATES = new Set(["done", "error", "stuck", "killed"]);

	/**
	 * Parent-side watchdog: notice when a direct child's process dies without
	 * reporting a terminal state, and tell the parent.
	 *
	 * The worker-side session_shutdown hook mails the parent on a graceful
	 * exit-without-done, and the one-shot liveness check covers the first ~8s
	 * after spawn. Everything in between — a mid-task crash, OOM, SIGKILL, or
	 * a turn-limit exit that never ran the shutdown hook — used to go
	 * unnoticed until someone ran team_status by hand. This poll closes that
	 * gap for the whole life of the team. Detection only: the recycle
	 * decision stays with the parent.
	 */
	function startWatchdog(runtime: Runtime): void {
		const timer = setInterval(() => {
			ensureMailboxWatcher(runtime); // belt and braces for the delivery path
			const config = runtime.config();
			if (!config) return;
			for (const agent of childrenOf(config, runtime.me)) {
				if (agent.killedAt) continue;
				const status = readStatus(config.team, agent.name);
				if (status && TERMINAL_STATES.has(status.state)) continue;
				if (status?.state === "queued") continue;
				if (isAlive(config.team, agent.name)) continue;
				if (Date.now() - Date.parse(agent.createdAt) < WATCHDOG_GRACE_MS) continue;

				const activity = readActivity(config.team, agent.name, 12);
				const note = activity.finished
					? "finished its turn without reporting a status (detected by watchdog)"
					: "process exited without reporting done (detected by watchdog)";
				writeStatus(config.team, { agent: agent.name, state: "error", note });
				const content =
					`⚠ Watchdog: agent '${agent.name}' ${activity.finished ? "finished its turn" : "its process exited"} ` +
					`without reporting done. Last status: ${status?.state ?? "none"}${status?.note ? ` (${status.note})` : ""}. ` +
					`Last activity: ${activityLabel(activity) || "unknown"}. Log: ${logPath(config.team, agent.name)}. ` +
					`Consider team_recycle({ name: "${agent.name}" }) — its handoff file, if one was written, seeds the replacement.`;
				if (runtime.isLead) {
					pi.sendMessage(
						{
							customType: MAIL_TYPE,
							content,
							display: true,
							details: { count: 1, from: ["watchdog"], kinds: ["message"] },
						},
						{ deliverAs: "followUp", triggerTurn: true },
					);
				} else if (runtime.parent) {
					postMail(config.team, { from: runtime.me, to: runtime.parent, kind: "message", content });
				}
			}
		}, WATCHDOG_POLL_MS);
		timer.unref?.();
		runtime.disposers.push(() => clearInterval(timer));
	}

	const QUEUE_POLL_MS = Number(process.env.PI_ORCH_QUEUE_POLL_MS ?? 3000);

	/**
	 * Start spawns that were queued behind a concurrency cap once a slot frees.
	 * Runs in every orchestrator process, so the queue drains while the
	 * spawner is parked in team_await, and after it has gone.
	 */
	function startQueuePump(runtime: Runtime): void {
		const timer = setInterval(() => {
			try {
				pumpQueue(runtime);
			} catch {
				// A failed pump retries on the next tick.
			}
		}, QUEUE_POLL_MS);
		timer.unref?.();
		runtime.disposers.push(() => clearInterval(timer));
	}

	/**
	 * Turn queued mail into a real message in this agent's conversation.
	 *
	 * `followUp` + `triggerTurn` means: never interrupt a tool call, but do wake
	 * an idle agent. That is what makes a lead able to sit idle and still react
	 * to a teammate finishing.
	 */
	/**
	 * Mail waiting for a quiet moment.
	 *
	 * Waking the lead on every arriving message means your answer gets buried
	 * under the lead's reaction to a teammate seconds after you start reading
	 * it. Batched mode accumulates instead: the lead is woken once, after the
	 * workers stop talking, with everything they said.
	 */
	let mailBuffer: Mail[] = [];
	let quietTimer: ReturnType<typeof setTimeout> | null = null;
	let firstBufferedAt = 0;

	const pendingMailCount = (): number => mailBuffer.length;

	function formatMail(runtime: Runtime, items: Mail[]): { body: string; details: unknown } {
		const attention = runtime.team ? readAttention(runtime.team, runtime.me) : [];
		const format = (item: Mail): string => {
			const urgent = attention.some((a) => a.level === "high" && a.from === item.from);
			const header =
				item.kind === "shutdown"
					? `⏹ shutdown request from @${item.from}`
					: item.kind === "broadcast"
						? `📣 broadcast from @${item.from}`
						: `▌ message from @${item.from}${urgent ? " (BLOCKED — needs your reply)" : ""}`;
			return `${header}\n\n${clamp(item.content)}`;
		};
		const senders = [...new Set(items.map((m) => m.from))];
		const body =
			items.length === 1
				? format(items[0] as Mail)
				: [`▌ ${items.length} messages from @${senders.join(", @")}`, "", items.map(format).join("\n\n---\n\n")].join("\n");
		return {
			body,
			details: { count: items.length, from: senders, kinds: [...new Set(items.map((m) => m.kind))] },
		};
	}

	/** Send whatever is buffered. `wake` false queues it without interrupting. */
	function flushMail(runtime: Runtime, wake: boolean): number {
		if (quietTimer) {
			clearTimeout(quietTimer);
			quietTimer = null;
		}
		if (mailBuffer.length === 0) return 0;
		const items = mailBuffer;
		mailBuffer = [];
		firstBufferedAt = 0;
		const { body, details } = formatMail(runtime, items);
		pi.sendMessage(
			{ customType: MAIL_TYPE, content: body, display: true, details },
			wake ? { deliverAs: "followUp", triggerTurn: true } : { deliverAs: "nextTurn" },
		);
		return items.length;
	}

	function deliver(runtime: Runtime, mail: Mail[]): void {
		if (mail.length === 0) return;
		if (!runtime.isLead && !firstRunStarted) {
			// Pre-kickoff window: delivering now would start a run and collide
			// with the driver's kickoff prompt(). See the agent_start handler.
			pendingStartupMail.push(...mail);
			return;
		}
		// Urgent traffic is the exception: a blocked worker and an explicit
		// shutdown request are worth interrupting for.
		const attentionNow = runtime.team ? readAttention(runtime.team, runtime.me) : [];
		const urgentSenders = new Set(
			attentionNow.filter((a) => a.level === "high").map((a) => a.from),
		);
		const urgent = mail.some((m) => m.kind === "shutdown" || urgentSenders.has(m.from));

		const policy = mailDelivery();
		mailBuffer.push(...mail);
		if (firstBufferedAt === 0) firstBufferedAt = Date.now();

		if (policy === "immediate" || urgent) {
			flushMail(runtime, true);
			return;
		}
		if (policy === "manual") {
			// Queued for the human's next prompt; never wakes the lead.
			flushMail(runtime, false);
			return;
		}

		// batched: wait for the workers to go quiet, but never hold forever.
		const heldFor = Date.now() - firstBufferedAt;
		if (heldFor >= mailMaxHoldMs()) {
			flushMail(runtime, true);
			return;
		}
		if (quietTimer) clearTimeout(quietTimer);
		quietTimer = setTimeout(
			() => flushMail(runtime, true),
			Math.min(mailQuietMs(), Math.max(0, mailMaxHoldMs() - heldFor)),
		);
		quietTimer.unref?.();
	}


	function installSignalHandlers(): void {
		if (signalHandlersInstalled) return;
		signalHandlersInstalled = true;
		// Ctrl+C on the lead must not leave orphaned agent processes behind.
		for (const signal of ["SIGINT", "SIGTERM"] as const) {
			process.on(signal, () => {
				if (rt.isLead && rt.owns && rt.config()) {
					try {
						cleanupTeam(rt, { keepFiles: true });
					} catch {
						// Best effort during shutdown.
					}
				}
			});
		}
	}

	function disposeAll(): void {
		for (const dispose of rt.disposers) {
			try {
				dispose();
			} catch {
				// Ignore disposer failures.
			}
		}
		rt.disposers = [];
	}
}
