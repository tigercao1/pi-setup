/**
 * session-bus — pass context between pi sessions.
 *
 * Every session announces itself to a shared registry and watches an inbox.
 * Another session can then hand it a note plus references: file paths, and the
 * sender's own session id (which the receiver can question directly with
 * `pi --session <id> -p "..."`).
 *
 * Two deliberate choices:
 *
 * 1. **Files, not a socket.** The most useful message is one left for a
 *    session that is not running. It is delivered when that session next
 *    starts.
 * 2. **Acted on, never interrupting.** By default mail is delivered like a
 *    steering message typed into that session: after its current step, or as a
 *    new turn when it is idle, so the receiver acknowledges it right away.
 *    `delivery: "queue"` holds it for the receiver's next prompt instead. The
 *    receiver's run is never aborted.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { formatRow, splitName } from "./labels.ts";
import { Picker, type PickerRow } from "./picker.ts";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	announce,
	type AckStatus,
	type BusMessage,
	type Delivery,
	type DeliveryAck,
	deliveryOf,
	markSeen,
	messageMarker,
	pruneAcks,
	removeAck,
	requeue,
	resolveDelivery,
	waitForAck,
	writeAck,
	formatMessage,
	isLive,
	isPending,
	isReachable,
	addressFor,
	buildSendPrompt,
	listTargets,
	sessionAddressFor,
	pathExists,
	pendingCount,
	sessionKey,
	receive,
	resolveTarget,
	send,
	type SessionEntry,
	type Target,
	watchInbox,
} from "./bus.ts";

const MAIL_TYPE = "session-mail";

type LiveContext = { isIdle?: () => boolean; hasUI?: boolean; ui?: { notify?: (m: string, t?: "info" | "warning" | "error") => void } };

type InputDialog = (
	title: string,
	placeholder?: string,
	opts?: { timeout?: number; signal?: AbortSignal },
) => Promise<string | undefined>;

const confirmWaitMs = (): number => {
	const fromEnv = Number.parseInt(process.env.PI_BUS_CONFIRM_WAIT_MS ?? "", 10);
	return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 120_000;
};

const ackWaitMs = (): number => {
	const fromEnv = Number.parseInt(process.env.PI_BUS_ACK_WAIT_MS ?? "", 10);
	return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : 5000;
};

export function describeAck(
	ack: DeliveryAck | null,
	delivery: Delivery,
	waitedMs: number,
	stillInInbox = true,
): string {
	const who = ack ? `**${ack.receiverAlias}** (session ${ack.receiverKey.slice(0, 8)}, ${ack.receiverCwd})` : "";
	if (!ack) {
		const seconds = Math.max(1, Math.round(waitedMs / 1000));
		return stillInInbox
			? `Not picked up within ${seconds}s: it is still in the receiver's inbox and will be delivered ` +
					`${delivery === "steer" ? "as steering" : "at the receiver's next prompt"} when a session there reads it.`
			: `Picked up, but the receiver did not acknowledge within ${seconds}s. It is probably running an older ` +
					"session-bus (reload it with /reload), which may hold the note until its current run ends. Delivery is not confirmed.";
	}
	const byStatus: Record<AckStatus, string> = {
		queued: `Delivered to ${who}, queued: it will see the note with its next prompt. No turn was started.`,
		steered: `Delivered as steering to ${who}. It was busy; it will see the note after its current step (the current assistant turn and its tool calls), before its next model call. Its run was not interrupted.`,
		started: ack.seenAt
			? `Receiver ${who} was idle; started a turn with the note.`
			: `Receiver ${who} was idle and accepted the note to start a turn, but has not yet confirmed the turn began.`,
		deferred: `Delivered to ${who}, which is compacting its context; it will receive the note as steering as soon as compaction ends.`,
	};
	return byStatus[ack.status];
}

export default function sessionBus(pi: ExtensionAPI): void {
	let self: SessionEntry | null = null;
	let disposers: Array<() => void> = [];
	let liveCtx: LiveContext | null = null;
	let compacting = false;
	let deferred: BusMessage[] = [];
	let deferTimer: ReturnType<typeof setInterval> | null = null;
	const awaitingSeen = new Set<string>();

	const stateOf = (e: Target): string =>
		isReachable(e) ? (e.busAware ? "●" : "◐") : "○";
	const queued = (e: Target): string =>
		pendingCount(e.address) > 0 ? `${pendingCount(e.address)} queued` : "";
	const home = (path: string): string => path.replace(process.env.HOME ?? "", "~");
	const rowFor = (e: Target, columns: number, inOwnDir: boolean): string =>
		e.kind === "session"
			? formatRow(
					{ state: stateOf(e), alias: `${inOwnDir ? "↳ " : ""}${e.alias}`, id: e.key.slice(0, 8), detail: queued(e) },
					columns,
				)
			: formatRow(
					{
						state: stateOf(e),
						alias: basename(e.cwd) || e.cwd,
						count: e.running,
						detail: [home(e.cwd), queued(e)].filter(Boolean).join("  "),
					},
					columns,
				);
	/**
	 * Every target as one flat list: each live session on its own row (no
	 * folder grouping), then folders that have no individually listed session.
	 * This folder first, then live, then running-without-bus, then offline.
	 */
	const flatTargets = (me: SessionEntry): Target[] => {
		const all = listTargets(me, { expandOthers: true });
		const expanded = new Set(all.filter((e) => e.kind === "session").map((e) => e.cwd));
		const flat = all.filter((e) => e.kind === "session" || !expanded.has(e.cwd));
		const rank = (e: Target): number =>
			e.cwd === me.cwd ? 0 : isReachable(e) ? (e.busAware ? 1 : 2) : 3;
		return flat
			.map((e, i) => ({ e, i }))
			.sort((a, b) => rank(a.e) - rank(b.e) || a.i - b.i)
			.map(({ e }) => e);
	};
	const pickerRow = (e: Target, ownCwd: string): PickerRow => {
		const individual = e.kind === "session" || (e.busAware && !e.key.startsWith("proc-"));
		return {
			state: stateOf(e),
			alias: individual ? e.alias : basename(e.cwd) || e.cwd,
			id: individual ? e.key.slice(0, 8) : undefined,
			detail: [e.cwd === ownCwd ? "this folder" : home(e.cwd), queued(e)].filter(Boolean).join("  "),
			search: `${e.cwd} ${e.key}`,
		};
	};
	const pickerColumns = (): number => Math.max(40, (process.stdout.columns ?? 80) - 6);

	const identity = (
		cwd: string,
		key: string,
		name?: string,
	): Omit<SessionEntry, "lastSeen"> => ({
		key,
		address: addressFor(cwd),
		alias: name?.trim() || basename(cwd) || "session",
		cwd,
		pid: process.pid,
		startedAt: new Date().toISOString(),
	});

	const render = (messages: BusMessage[], reason: "live" | "startup"): string => {
		const header =
			reason === "startup"
				? `✉ ${messages.length} message(s) arrived while this session was away`
				: messages.length > 1
					? `✉ ${messages.length} messages from other sessions`
					: "";
		return [header, ...messages.map((m, i) => formatMessage(m, messages.length > 1 ? i + 1 : undefined))]
			.filter(Boolean)
			.join("\n\n---\n\n");
	};

	const ack = (messages: BusMessage[], status: AckStatus): void => {
		if (!self) return;
		for (const m of messages) {
			try {
				writeAck({
					id: m.id,
					status,
					delivery: deliveryOf(m),
					receiverKey: self.key,
					receiverAlias: self.alias,
					receiverCwd: self.cwd,
				});
			} catch {
				// An ack is a courtesy to the sender; delivery does not depend on it.
			}
		}
	};

	const notify = (text: string): void => {
		if (liveCtx?.hasUI) liveCtx.ui?.notify?.(text, "info");
	};
	const senders = (messages: BusMessage[]): string =>
		[...new Set(messages.map((m) => `@${m.meta?.fromAlias ?? m.from}`))].join(", ");

	function queue(messages: BusMessage[], reason: "live" | "startup"): void {
		pi.sendMessage(
			{
				customType: MAIL_TYPE,
				content: render(messages, reason),
				display: true,
				details: { count: messages.length, from: messages.map((m) => m.meta?.fromAlias ?? m.from) },
			},
			{ deliverAs: "nextTurn" },
		);
		ack(messages, "queued");
		notify(`✉ Message from ${senders(messages)} queued for your next prompt.`);
	}

	/**
	 * Steering, exactly as if the human had typed the note into this session:
	 * pi queues it for after the current assistant turn and its tool calls when a
	 * run is active (shown in the queued-messages area), and starts a turn with it
	 * when idle. Nothing is aborted.
	 */
	function steer(messages: BusMessage[], reason: "live" | "startup"): void {
		if (compacting) {
			deferred.push(...messages);
			ack(messages, "deferred");
			notify(`✉ Message from ${senders(messages)} will be delivered when compaction finishes.`);
			scheduleDeferredFlush();
			return;
		}
		const idle = liveCtx?.isIdle?.() ?? true;
		for (const m of messages) awaitingSeen.add(m.id);
		ack(messages, idle ? "started" : "steered");
		pi.sendUserMessage(render(messages, reason), { deliverAs: "steer" });
		if (!idle) notify(`✉ Steering note from ${senders(messages)}: delivered after the current step.`);
	}

	function flushDeferred(): void {
		compacting = false;
		if (deferTimer) clearInterval(deferTimer);
		deferTimer = null;
		const pending = deferred;
		deferred = [];
		if (pending.length > 0) steer(pending, "live");
	}

	function scheduleDeferredFlush(): void {
		if (deferTimer) return;
		// Safety net for a compaction whose end event never arrives: an idle
		// session is by definition not compacting.
		deferTimer = setInterval(() => {
			if (liveCtx?.isIdle?.() ?? true) flushDeferred();
		}, 1000);
		deferTimer.unref?.();
	}

	function deliver(messages: BusMessage[], reason: "live" | "startup"): void {
		if (messages.length === 0) return;
		const queued = messages.filter((m) => deliveryOf(m) === "queue");
		const steering = messages.filter((m) => deliveryOf(m) === "steer");
		if (queued.length > 0) queue(queued, reason);
		if (steering.length > 0) steer(steering, reason);
	}

	const textOf = (message: unknown): string => {
		const content = (message as { content?: unknown })?.content;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content.map((c) => (c?.type === "text" ? String(c.text ?? "") : "")).join("\n");
	};

	pi.on("message_start", async (event) => {
		if (awaitingSeen.size === 0) return;
		const message = (event as { message?: { role?: string } }).message;
		if (message?.role !== "user") return;
		const text = textOf(message);
		for (const id of [...awaitingSeen]) {
			if (!text.includes(messageMarker(id))) continue;
			awaitingSeen.delete(id);
			try {
				markSeen(id);
			} catch {
				// Courtesy only.
			}
		}
	});

	pi.on("session_before_compact", async (event) => {
		if ((event as { reason?: string }).reason === "manual") compacting = true;
	});
	pi.on("session_compact", async () => flushDeferred());
	pi.on("session_compact_failed", async () => flushDeferred());
	pi.on("agent_start", async () => {
		if (compacting || deferred.length > 0) flushDeferred();
	});

	pi.on("session_start", async (_event, ctx) => {
		for (const dispose of disposers) dispose();
		disposers = [];
		liveCtx = ctx as LiveContext;
		compacting = false;
		try {
			pruneAcks();
		} catch {
			// Housekeeping only.
		}
		const currentName = (): string | undefined =>
			pi.getSessionName?.() ?? ctx.sessionManager?.getSessionName?.();
		self = announce(identity(ctx.cwd, sessionKey(ctx.sessionManager?.getSessionId?.()), currentName()));

		// Anything left while this session was not running, to its directory or to it alone.
		const mine = sessionAddressFor(self.key);
		deliver([...receive(self.address), ...receive(mine)], "startup");
		const stop = watchInbox(self.address, (mail) => deliver(mail, "live"));
		const stopMine = watchInbox(mine, (mail) => deliver(mail, "live"));
		disposers.push(stopMine);
		const heartbeat = setInterval(() => {
			if (self) self = announce({ ...self, alias: currentName()?.trim() || self.alias });
		}, 30_000);
		heartbeat.unref?.();
		disposers.push(stop, () => clearInterval(heartbeat));
	});

	pi.on("session_shutdown", async () => {
		for (const dispose of disposers) dispose();
		disposers = [];
		if (deferTimer) clearInterval(deferTimer);
		deferTimer = null;
		for (const m of deferred) requeue(m);
		deferred = [];
		liveCtx = null;
	});

	pi.registerTool({
		name: "session_list",
		label: "List pi sessions",
		description:
			"List other pi sessions on this machine that can receive context: alias, directory, and whether each is live. " +
			"Folders with several sessions are collapsed; pass `directory` to list the sessions inside one.",
		parameters: Type.Object({
			directory: Type.Optional(
				Type.String({ description: "Folder path or name whose individual sessions to list" }),
			),
		}),
		async execute(_id, params) {
			const { directory } = (params ?? {}) as { directory?: string };
			const all = listTargets(self ?? undefined, { expandOthers: Boolean(directory) }).filter(
				(e) =>
					!directory ||
					e.cwd === directory ||
					basename(e.cwd) === directory ||
					(e.kind === "session" && e.cwd === self?.cwd),
			);
			if (all.length === 0) {
				return {
					content: [{ type: "text", text: "No other pi sessions have announced themselves yet." }],
					details: {},
				};
			}
			const state = (e: Target): string =>
				isReachable(e)
					? e.busAware
						? `live${e.kind === "directory" && e.running > 1 ? ` (${e.running} sessions)` : ""}`
						: "running, no bus (receives after restart)"
					: "offline (still receives)";
			const rows = all.map((e) => {
				const { name, fork } = splitName(e.alias);
				const label =
					e.kind === "session"
						? `↳ ${name}${fork ? ` ⑂${fork}` : ""} · \`${e.key.slice(0, 13)}\``
						: basename(e.cwd) || e.alias;
				return `| ${label} | ${state(e)} | ${e.cwd} | ${pendingCount(e.address)} queued |`;
			});
			return {
				content: [
					{
						type: "text",
						text: [
							"| target | state | directory | inbox |",
							"|---|---|---|---|",
							...rows,
							"",
							"↳ rows are single sessions: send with `to: \"<id prefix>\"`. A folder row reaches whichever session there reads it first.",
							"Folders with several sessions are collapsed; call again with `directory` to list them. Offline sessions still receive on next start.",
						].join("\n"),
					},
				],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "session_send",
		label: "Send context to a session",
		description:
			"Hand context to another pi session. Prefer sending file PATHS and a short note over pasted content — " +
			"the receiver reads what it needs. ALWAYS works regardless of whether the target is running: an " +
			"offline session's mail is queued and delivered the moment it next starts, so never refuse to send " +
			"because a target is offline. `delivery` picks how a live receiver gets it: \"steer\" (default) delivers it " +
			"like a steering message typed into that session (after its current assistant turn and tool calls, before " +
			"its next model call; an idle receiver starts a turn and acknowledges right away); \"queue\" holds it for the " +
			"receiver's next prompt. Neither aborts the receiver. In an interactive session the human is asked whether " +
			"to add anything before it is sent. Notes over 4000 characters are sent as a file. The reply says what the " +
			"receiver acknowledged.",
		promptGuidelines: [
			"Use session_send to pass a finding or deliverable to a pi session working in another repo; " +
				"send paths and a summary, not large pasted text.",
		],
		parameters: Type.Object({
			to: Type.String({ description: "Alias, directory, or session id prefix (see session_list)" }),
			note: Type.String({ description: "Short summary of what you are handing over and why it matters" }),
			paths: Type.Optional(
				Type.Array(Type.String(), { description: "Absolute file paths the receiver should read" }),
			),
			shareSession: Type.Optional(
				Type.Boolean({
					description:
						"Include this session's id so the receiver can question it directly with `pi --session <id>`",
				}),
			),
			delivery: Type.Optional(
				StringEnum(["queue", "steer"] as const, {
					description:
						'"steer" (default): arrives like a message the user typed while it runs: after its current step, ' +
						"before its next model call; an idle receiver starts a turn with it. Never aborts the receiver. " +
						'"queue": shown to the receiver with its next prompt, no turn started.',
				}),
			),
			wake: Type.Optional(
				Type.Boolean({
					description: 'Deprecated alias for delivery: "steer". An explicit `delivery` wins.',
				}),
			),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const { to, paths, shareSession, wake } = params as {
				to: string;
				note: string;
				paths?: string[];
				shareSession?: boolean;
				delivery?: Delivery;
				wake?: boolean;
			};
			const delivery = resolveDelivery(params as { delivery?: Delivery; wake?: boolean });
			if (!self) return { content: [{ type: "text", text: "Session not registered yet." }], details: {} };
			const resolved = resolveTarget(to, self);
			if (!resolved.entry) {
				const list = (resolved.candidates ?? [])
					.map((e) => `  ${e.alias} (${isLive(e) ? "live" : "offline"}) — ${e.cwd}`)
					.join("\n");
				return {
					content: [
						{ type: "text", text: `${resolved.error}${list ? `\n\nKnown sessions:\n${list}` : ""}` },
					],
					details: {},
				};
			}
			// A reference the receiver cannot open is worse than no reference.
			const missing = (paths ?? []).filter((p) => !pathExists(p));
			const target = resolved.entry;
			let note = (params as { note: string }).note;
			const ui = (ctx as { hasUI?: boolean; ui?: LiveContext["ui"] & { input?: InputDialog } } | undefined);
			if (ui?.hasUI && ui.ui?.input && process.env.PI_BUS_CONFIRM !== "0") {
				const name = target.kind === "session" ? splitName(target.alias).name : basename(target.cwd);
				const preview = note.replace(/\s+/g, " ").slice(0, 160);
				const extra = await ui.ui.input(
					`Sending to ${name}${paths?.length ? ` with ${paths.length} file(s)` : ""}: "${preview}${note.length > 160 ? "…" : ""}". Anything else they should know? (Enter: send as is · type cancel: don't send)`,
					"optional: decisions, gotchas, what you want back",
					{ timeout: confirmWaitMs(), signal },
				);
				const added = extra?.trim() ?? "";
				if (added.toLowerCase() === "cancel") {
					return {
						content: [{ type: "text", text: `Not sent: the user cancelled the message to ${target.alias}.` }],
						details: { cancelled: true } as Record<string, unknown>,
					};
				}
				if (added) note = `${note}\n\nFrom the user, added before sending: ${added}`;
			}
			const message = send(target, self, {
				note,
				paths,
				sessionRef: shareSession ? self.key : undefined,
				delivery,
				wake,
			});
			const listening = target.busAware && (isLive(target) || isReachable(target));
			const waitMs = listening ? ackWaitMs() : 0;
			const received = waitMs > 0 ? await waitForAck(message.id, { timeoutMs: waitMs, signal }) : null;
			if (received) removeAck(message.id);
			const status = received
				? describeAck(received, delivery, waitMs)
				: listening
					? describeAck(null, delivery, waitMs, isPending(message))
					: target.busAware
						? `Sent to **${target.alias}**, which is offline: queued until it next starts, then delivered ${delivery === "steer" ? "as steering (starting a turn)" : "with its next prompt"}.`
						: `Sent to **${target.alias}**: a pi is running there without session-bus, so it is queued until that session reloads or restarts.`;
			return {
				content: [
					{
						type: "text",
						text: [
							status,
							missing.length > 0
								? `WARNING: these paths do not exist, so the receiver cannot read them: ${missing.join(", ")}`
								: "",
						]
							.filter(Boolean)
							.join("\n"),
					},
				],
				details: { id: message.id, delivery, ack: received ?? undefined } as Record<string, unknown>,
			};
		},
	});

	pi.registerCommand("sessions", {
		description: "List pi sessions that can exchange context",
		handler: async (_args, ctx) => {
			const columns = pickerColumns();
			const all = listTargets(self ?? undefined);
			const lines = all.map((e) => rowFor(e, columns, e.kind === "session"));
			ctx.ui.notify(
				lines.length > 0 ? `Sessions on this machine:\n${lines.join("\n")}` : "No sessions registered yet.",
				"info",
			);
		},
	});

	pi.registerCommand("send", {
		description: "Send context to another session (pick from a list, or /send <target> <message>)",
		getArgumentCompletions: (prefix: string) => {
			const items = listTargets(self ?? undefined, { expandOthers: prefix.length >= 4 })
				.map((e) => ({
					value: e.kind === "session" ? e.key.slice(0, 13) : e.alias.includes(" ") ? basename(e.cwd) : e.alias,
					label: e.kind === "session" ? `↳ ${e.alias}` : e.alias.includes(" ") ? basename(e.cwd) : e.alias,
					description: `${isLive(e) ? "live" : "offline"} — ${e.cwd}`,
				}));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const me = self;
			if (!me) return;
			const others = listTargets(me);
			if (others.length === 0) {
				ctx.ui.notify(
					"No other pi sessions have announced themselves yet. Open pi in another directory and it will appear here.",
					"info",
				);
				return;
			}

			const trimmed = args.trim();
			const split = trimmed.indexOf(" ");

			// Fast path: `/send <target> <message>` posts the text verbatim.
			if (split !== -1) {
				const resolved = resolveTarget(trimmed.slice(0, split), me);
				if (!resolved.entry) {
					ctx.ui.notify(resolved.error ?? "No such session.", "error");
					return;
				}
				const note = trimmed.slice(split + 1).trim();
				const paths = (note.match(/(?:^|\s)(\/[^\s]+)/g) ?? [])
					.map((p) => p.trim())
					.filter((p) => pathExists(p));
				send(resolved.entry, me, { note, paths: paths.length > 0 ? paths : undefined });
				ctx.ui.notify(
					`Sent to ${resolved.entry.alias} (${isLive(resolved.entry) ? "live" : "offline — queued"})`,
					"info",
				);
				return;
			}

			// Interactive: pick a session, describe what to send, and let THIS
			// session work out which files and findings that means.
			const ordered = flatTargets(me);
			const rows: PickerRow[] = ordered.map((e) => pickerRow(e, me.cwd));
			const preselected = trimmed === "" ? undefined : resolveTarget(trimmed, me).entry;
			const index = preselected
				? -1
				: await ctx.ui.custom<number | undefined>((tui, theme, _kb, done) => {
						const picker = new Picker(
							"Send to  (● live · ◐ receives after restart · ○ offline · ⑂ fork)",
							rows,
							done,
							{
								accent: (t) => theme.fg("accent", t),
								muted: (t) => theme.fg("muted", t),
								dim: (t) => theme.fg("dim", t),
							},
						);
						return {
							render: (width: number) => picker.render(width),
							invalidate: () => picker.invalidate(),
							handleInput: (data: string) => {
								picker.handleInput(data);
								tui.requestRender();
							},
						};
					});
			const chosen = preselected ?? (index === undefined ? undefined : ordered[index]);
			if (!chosen) return;
			if (!chosen.busAware) {
				ctx.ui.notify(
					`${basename(chosen.cwd)} is running but has not loaded session-bus, so it will only see this after a /reload or restart. Queuing anyway.`,
					"warning",
				);
			}

			const request = await ctx.ui.input(
				`What should ${chosen.kind === "session" ? splitName(chosen.alias).name : basename(chosen.cwd)} know?`,
				"e.g. the currency formatting decision and the files it touches",
			);
			if (!request || request.trim() === "") return;

			// Hand it to the agent: it has the context, so it decides what to attach.
			pi.sendUserMessage(buildSendPrompt(chosen, request.trim()));
		},
	});

	pi.registerCommand("inbox-sessions", {
		description: "Deliver any queued cross-session messages now",
		handler: async (_args, ctx) => {
			if (!self) return;
			const mail = [...receive(self.address), ...receive(sessionAddressFor(self.key))];
			if (mail.length === 0) {
				ctx.ui.notify("No cross-session messages waiting.", "info");
				return;
			}
			deliver(mail, "live");
			ctx.ui.notify(`Delivered ${mail.length} message(s).`, "info");
		},
	});
}
