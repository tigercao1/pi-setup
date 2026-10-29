/**
 * The `team_*` tools. Availability is gated by role:
 *
 *   lead / sub-orchestrator : spawn, status, diagnose, recycle, evaluate,
 *                             request_shutdown, force_shutdown, cleanup
 *   everyone                : message, broadcast, write_status, write_handoff
 *   non-lead                : attention
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { Type } from "typebox";
import {
	capturePane,
	detectBackend,
	isAlive,
	killAgent,
	quoteArgv,
	spawnAgent,
} from "./backend.ts";
import { activityLabel, readActivity } from "./digest.ts";
import { answerBlock } from "./answer.ts";
import { appendTrialLog, leadTrialArm, type TrialArm } from "./trial.ts";
import { takeModelsWarning } from "./personas.ts";
import { routeUnprofiled, type SpawnRouting } from "./route.ts";
import {
	allProfiles,
	readSettings,
	buildArgv,
	spawnLimits,
	maxTrackedAgents,
	reapRetentionMs,
	buildSystemPrompt,
	defaultContextFiles,
	resolveSkillPath,
	defaultSkills,
	NAMED_PROFILES,
	orchLevel,
	promoteThreshold,
	resolveRuntime,
	spawnEnv,
} from "./config.ts";
import {
	buildResumeArgv,
	checkResumable,
	findSessionFile,
	resumeEnv,
	scheduleSessionCapture,
	type ResumeMode,
} from "./resume.ts";
import type { Runtime } from "./session.ts";
import { findArchivedAgent, reapTeam, sweepTeams } from "./reap.ts";
import { buildViews, countsLine, countStates, displayState, STATE_ICON, subtreeOf } from "./view.ts";
import { runSkeptics, SKEPTIC_LABEL } from "./verify.ts";
import { type CapHit, claim, countCapHit, countLive, enqueue, holdsSlot, listQueue, queuePosition } from "./caps.ts";
import { ensureDir } from "../_shared/fsjson.ts";
import { absoluteContract, checkDone, invalidRequiredFields, missingFields, normalisePath } from "./contract.ts";
import { type GateReservation, gateShapeError, gateTrigger, runGate } from "./gate.ts";
import { askLine, askWithRetry, dismissAsks, finishAsk, isOwed, runAsk, startAsk, visibleAsks } from "./ask.ts";
import {
	type AgentRecord,
	addAgent,
	ancestorsOf,
	attentionDir,
	childrenOf,
	depthOf,
	descendantsOf,
	destroyTeam,
	evaluationsDir,
	findAgent,
	type HandoffReport,
	handoffsDir,
	logPath,
	mailboxDir,
	patchAgent,
	queueDir,
	postAttention,
	postMail,
	readAllStatuses,
	readAttention,
	readContract,
	readHandoff,
	readStatus,
	readTeam,
	type Role,
	type TaskContract,
	type TeamConfig,
	teamDir,
	teamExists,
	updateTeam,
	writeContract,
	writeHandoff,
	writeStatus,
} from "./state.ts";

const text = (body: string) => ({ content: [{ type: "text" as const, text: body }], details: {} });

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,47}$/;
const STALE_MS = 10 * 60 * 1000;

const ContractSchema = Type.Object({
	outputPath: Type.Optional(
		Type.String({ description: "Absolute path the agent must write its deliverable to" }),
	),
	outputFormat: Type.Optional(Type.String({ description: "markdown | json | typescript | ..." })),
	evaluationCriteria: Type.Optional(
		Type.Array(Type.String(), { description: "Specific, testable assertions" }),
	),
	passDefinition: Type.Optional(Type.String()),
	failDefinition: Type.Optional(Type.String()),
	requiredFields: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Strings the deliverable must contain, checked by team_await: a literal (case-insensitive) such as " +
				"'head SHA' or 'method:', or a regex written '/pattern/flags' such as '/\\b[0-9a-f]{7,40}\\b/'. " +
				"A done agent whose deliverable misses one is reported as GAP. Presence only, not truth.",
		}),
	),
});

const MAIL_BUDGET_CHARS = 3900;

export function registerTools(pi: ExtensionAPI, rt: Runtime): void {
	const canManage = rt.canSpawn;
	let answerSent = false;
	const withAnswer = (team: string, body: string): string => {
		if (rt.isLead || answerSent) return body;
		const status = readStatus(team, rt.me);
		if (status?.state !== "done" || !status.output) return body;
		answerSent = true;
		const block = answerBlock(rt.me, status.output, rt.cwd);
		const room = Math.max(200, MAIL_BUDGET_CHARS - block.length - 2);
		const message = body.length > room ? `${body.slice(0, room)}…` : body;
		return `${message}\n\n${block}`;
	};

	// ------------------------------------------------------------ spawn

	if (canManage) {
		pi.registerTool({
			name: "team_spawn",
			label: "Spawn agent",
			description:
				"Spawn a teammate agent in its own process (and pane, when a multiplexer is available). " +
				"Returns as soon as the agent starts — it works in parallel while you stay responsive. " +
				"Always give a self-contained task and a taskContract with an outputPath. " +
				"Deliverables start with a '## Answer' section (up to ~25 lines); team_await and the worker's done message carry " +
				"that section plus the path, not the whole file. " +
				"Nothing is inherited: skills, extensions and contextFiles are off under slim unless passed, " +
				"for every worker and grandchild. team_recycle replays the original spawn's channels.",
			promptSnippet: "Spawn a teammate agent to work on a task in parallel",
			promptGuidelines: [
				"Use team_spawn to delegate any large, parallelisable, or high-token task instead of doing it inline.",
				"Every team_spawn task must be self-contained: the teammate cannot see your conversation.",
				"After team_spawn, never block waiting for teammates: do not call sleep, do not poll team_status in a loop. " +
					"End your turn instead — teammate messages arrive on their own and wake you, and the human can keep working meanwhile.",
				"Give every team_spawn worker a taskContract with an absolute outputPath (a spawn without one returns a WARNING), " +
					"and requiredFields for anything the result must name (SHAs, method, sources) so team_await can flag a GAP.",
				"Pass each team_spawn channel explicitly at every spawn: skills (names only, the body is not injected; tell the worker to read it), " +
					"extensions: ['mcp'] for Linear/Confluence/Slack/Sentry/Datadog, contextFiles: true for house rules and repo conventions. " +
					"None is inherited by a grandchild; team_recycle keeps the ones the original spawn was given.",
				"A team_spawn WARNING about unresolved skills means the worker will not get them: fix the name or move the skill into a pi skill directory and respawn. " +
					"A resolved skill is still not a read one: confirm by grepping the worker log for the skill path before trusting work that depends on it.",
				"A spawn result is not proof the worker is healthy. A startup crash arrives as a 'Spawn failed' message; " +
					"an agent that exits without reporting shows as GAP in team_await. Recycle it once with a handoff telling it to checkpoint early, then treat a second miss as a gap.",
			],
			parameters: Type.Object({
				name: Type.String({ description: "Unique agent name, e.g. 'auth-refactor'" }),
				task: Type.String({
					description:
						"Full self-contained assignment. Include all context the agent needs; it cannot see your conversation.",
				}),
				canSpawn: Type.Optional(
					Type.Boolean({
						description:
							"true makes this a sub-orchestrator that can spawn its own workers. Default false.",
					}),
				),
				model: Type.Optional(
					Type.String({
						description:
							"Model override. Omit to inherit your own model — only set this when you have a concrete reason.",
					}),
				),
				provider: Type.Optional(
					Type.String({ description: "Provider for `model`, e.g. anthropic or vercel-ai-gateway" }),
				),
				thinkingLevel: Type.Optional(
					StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const),
				),
				profile: Type.Optional(
					StringEnum(Object.keys(allProfiles()) as [string, ...string[]], {
						description:
							"Named profile bundling model, provider, thinking level, skills and repo conventions. " +
							"Available: " +
							Object.entries(allProfiles())
								.map(([name, p]) => `${name} (${p.model ?? "inherit"})`)
								.join(", "),
					}),
				),
				extensions: Type.Optional(
					Type.Array(Type.String(), {
						description:
							"Extra extensions to load (names under ~/.pi/agent/extensions or paths). Off under slim unless passed. " +
							"Pass ['mcp'] for any task that reads Linear, Confluence, Slack, Sentry, Datadog or similar: without it the worker " +
							"cannot fetch the source and will improvise. 'mcp' expands to builtin:mcp, builtin:codemode and builtin:tool-search; " +
							"its tools are named mcp__<server>__<tool> and are reached through tool_search or a codemode script. " +
							"Replaces the profile's extensions when given.",
					}),
				),
				slim: Type.Optional(
					Type.Boolean({
						description:
							"Default true: the agent starts with no skills, extensions or context files except the ones passed in " +
							"skills, extensions and contextFiles (or its profile). false gives the agent your full context; expensive, prefer naming what it needs.",
					}),
				),
				visible: Type.Optional(
					Type.Boolean({
						description:
							"Show the agent in a visible pane. Defaults to true for sub-orchestrators, false (headless) for workers.",
					}),
				),
				contextFiles: Type.Optional(
					Type.Boolean({
						description:
							"Keep AGENTS.md/CLAUDE.md (house rules and repo conventions) in the agent's context. Off by default. " +
							"Set true for any task that writes code, commits, or opens a PR, and for every sub-orchestrator: " +
							"without it a manager does not follow the house process rules.",
					}),
				),
				skills: Type.Optional(
					Type.Array(Type.String(), {
						description:
							"Skills to load by name (e.g. 'my-skill') or absolute path, never a repo-relative path. Survives slim, " +
							"which otherwise strips all skills. Name every skill the task depends on. Only the name, description " +
							"and path reach the agent; the body is NOT in its prompt, so tell it to read the file. Names resolve from " +
							"the agent's cwd, then ~/.pi/agent/skills and the settings skill directories; unresolved names are listed " +
							"as a WARNING in the spawn result.",
					}),
				),
				cwd: Type.Optional(Type.String({ description: "Working directory for the agent" })),
				taskContract: Type.Optional(ContractSchema),
				gate: Type.Optional(
					Type.Object(
						{
							state: Type.String({ description: "Absolute path to the PR's gate state JSON" }),
							spawnId: Type.String({ description: "The spawn_id printed by `pr-gate-spawn.sh check` for this lane" }),
						},
						{
							description:
								"PR review gate reservation. team_spawn runs `pr-gate-spawn.sh verify` (the reservation exists, is for the " +
								"PR's recorded head, has no verdict and is not bound to another agent), then `bind` to record this agent " +
								"on it, and refuses the spawn otherwise. Required, unless gateExempt is given, for a gate-lane spawn: " +
								"any profiled spawn whose effective skills (profile skills from the built-in profile and settings team.profiles, " +
								"plus explicit skills and team.defaultSkills) include 'pr-approval-review', which covers every 'code-review' " +
								"and 'reviewer' spawn; or a 'code-review'/'reviewer' task that mentions 'pr-review-gate' or 'gate lane'. " +
								"verifier and verifier-mcp spawns are unaffected unless pr-approval-review is passed to them.",
						},
					),
				),
				gateExempt: Type.Optional(
					Type.String({
						description:
							"Reason a gate-shaped spawn (see gate) runs outside the PR review gate, e.g. 'review requested by Tiger' for a " +
							"review the user asked for directly, or 'ledger trail review'. Stored on the agent record and replayed by " +
							"team_recycle. Use gate instead for pr-review-gate lanes.",
					}),
				),
			}),
			async execute(_id, params) {
				const spawn = params as SpawnParams;
				const routing = await unprofiledRouting(rt, spawn);
				return text(spawnOne(rt, routing ? { ...spawn, routing } : spawn));
			},
		});
	}

	// ----------------------------------------------------------- status

	if (canManage) {
		pi.registerTool({
			name: "team_status",
			label: "Team status",
			description:
				"Show your own subtree: your direct children with live process state, status reports, staleness, " +
				"and a rolled-up tally of each child's own team, plus pending attention requests addressed to you.",
			parameters: Type.Object({
				depth: Type.Optional(
					Type.Number({ description: "Levels of your subtree to list. Default 1 (direct children with rollups)." }),
				),
				scope: Type.Optional(
					StringEnum(["mine", "team"] as const, {
						description: "mine (default) = your subtree; team = the whole tree from the lead",
					}),
				),
			}),
			async execute(_id, params) {
				const { depth, scope } = (params ?? {}) as { depth?: number; scope?: "mine" | "team" };
				return text(renderStatus(rt, { depth: depth ?? 1, scope: scope ?? "mine" }));
			},
		});

		pi.registerTool({
			name: "team_diagnose",
			label: "Diagnose agent",
			description:
				"See what an agent is doing right now: recent tool calls, what it said, tokens spent. " +
				"Use on a slow or suspected-stuck agent before recycling it.",
			parameters: Type.Object({
				name: Type.String(),
				lines: Type.Optional(Type.Number({ description: "Default 25, max 200" })),
				raw: Type.Optional(
					Type.Boolean({ description: "Dump the raw log/pane instead of the activity digest" }),
				),
			}),
			async execute(_id, params) {
				const { name, lines, raw } = params as { name: string; lines?: number; raw?: boolean };
				const config = rt.config();
				const agent = config && findAgent(config, name);
				if (!config || !agent) return text(`No such agent: ${name}`);
				const count = Math.min(Math.max(lines ?? 25, 1), 200);
				const status = readStatus(config.team, name);
				const header = [
					`# ${name} (${agent.role}, ${isAlive(config.team, name) ? "alive" : "exited"})`,
					status ? `status: ${status.state} — ${status.note ?? ""} (${status.updatedAt})` : "",
					`log: ${logPath(config.team, name)}`,
				];

				// Visible panes have no log file worth parsing; scrape the pane.
				const activity = agent.visible ? null : readActivity(config.team, name, count);
				if (!raw && activity && !activity.raw && activity.lines.length > 0) {
					return text(
						[
							...header,
							`activity: ${activityLabel(activity)}`,
							"",
							"```",
							...activity.lines,
							"```",
						]
							.filter(Boolean)
							.join("\n"),
					);
				}
				const output = capturePane(config.team, name, agent.paneId, count);
				return text(
					[...header, "", "```", output.trimEnd() || "(no output yet)", "```"]
						.filter(Boolean)
						.join("\n"),
				);
			},
		});
	}

	// --------------------------------------------------------- messaging

	pi.registerTool({
		name: "team_message",
		label: "Message agent",
		description:
			"Send a message to a specific agent by name. Report upward to your direct parent only: " +
			"mail addressed further up the chain is rerouted to your parent, which summarises for its own parent.",
		parameters: Type.Object({
			to: Type.String({ description: "Recipient agent name" }),
			content: Type.String(),
		}),
		async execute(_id, params) {
			const { to, content } = params as { to: string; content: string };
			const team = rt.team;
			if (!team) return text("No team exists yet — nothing to message.");
			const config = readTeam(team);
			const known = new Set([config?.leadName ?? "team_lead", ...(config?.agents ?? []).map((a) => a.name)]);
			if (!known.has(to)) {
				return text(`Unknown agent '${to}'. Known: ${[...known].join(", ")}`);
			}
			// Reporting is per-level: a grandchild talking straight to the lead
			// bypasses the manager that owns it and floods the top of the tree.
			const parent = rt.parent;
			if (!rt.isLead && parent && to !== parent && config && ancestorsOf(config, rt.me).includes(to)) {
				postMail(team, {
					from: rt.me,
					to: parent,
					kind: "message",
					content: `(addressed to ${to}; delivered to you as ${rt.me}'s parent — summarise upward if it matters)\n\n${withAnswer(team, content)}`,
				});
				return text(
					`Rerouted to your parent ${parent}: reports go one level up, and ${parent} summarises for ${to}.`,
				);
			}
			postMail(team, { from: rt.me, to, kind: "message", content: to === parent ? withAnswer(team, content) : content });
			return text(`Message queued for ${to}.`);
		},
	});

	pi.registerTool({
		name: "team_broadcast",
		label: "Broadcast",
		description:
			"Send a message to your own subtree and your siblings. It never goes up the chain: report to your parent with team_message.",
		parameters: Type.Object({ content: Type.String() }),
		async execute(_id, params) {
			const { content } = params as { content: string };
			const team = rt.team;
			const config = team ? readTeam(team) : null;
			if (!team || !config) return text("No team exists yet — nothing to broadcast.");
			const siblings = rt.parent ? childrenOf(config, rt.parent) : [];
			const recipients = [
				...new Set(
					[...descendantsOf(config, rt.me), ...siblings]
						.filter((a) => !a.killedAt && a.name !== rt.me)
						.map((a) => a.name),
				),
			];
			for (const to of recipients) {
				postMail(team, { from: rt.me, to, kind: "broadcast", content });
			}
			return text(`Broadcast to ${recipients.length} agent(s).`);
		},
	});

	// ------------------------------------------------- self-reporting

	pi.registerTool({
		name: "team_write_status",
		label: "Write status",
		description:
			"Write your status file so your parent can see progress without interrupting you. " +
			"Call with 'done' and an output path when your deliverable is written. " +
			"'done' is refused unless that file exists, is non-empty, and is your contract's outputPath when you have one.",
		parameters: Type.Object({
			state: StringEnum(["active", "done", "stuck", "error"] as const),
			output: Type.Optional(Type.String({ description: "Path to your deliverable" })),
			note: Type.Optional(Type.String({ description: "One-line progress note" })),
		}),
		async execute(_id, params) {
			const { state, output, note } = params as {
				state: "active" | "done" | "stuck" | "error";
				output?: string;
				note?: string;
			};
			const team = rt.team;
			if (!team) return text("No team — status not recorded.");
			if (state === "done") {
				const problem = checkDone(output, readContract(team, rt.me), rt.cwd);
				if (problem) return text(`ERROR: status NOT recorded: ${problem}`);
			}
			const recorded = output ? normalisePath(output, rt.cwd) : undefined;
			writeStatus(team, { agent: rt.me, state, output: recorded, note });
			return text(`Status recorded: ${state}${recorded ? ` → ${recorded}` : ""}`);
		},
	});

	pi.registerTool({
		name: "team_write_handoff",
		label: "Write handoff",
		description:
			"Write a handoff report before your context is recycled. Your replacement is seeded with it.",
		parameters: Type.Object({
			completedWork: Type.String(),
			pendingTasks: Type.Optional(Type.String()),
			corrections: Type.Optional(Type.String({ description: "Mistakes and lessons learned" })),
			stateRefs: Type.Optional(Type.Array(Type.String(), { description: "Relevant file paths" })),
		}),
		async execute(_id, params) {
			const team = rt.team;
			if (!team) return text("No team — handoff not recorded.");
			const report: HandoffReport = {
				agent: rt.me,
				writtenAt: new Date().toISOString(),
				...(params as Omit<HandoffReport, "agent" | "writtenAt">),
			};
			const path = writeHandoff(team, report);
			if (rt.parent) {
				postMail(team, {
					from: rt.me,
					to: rt.parent,
					kind: "message",
					content: `Handoff written to ${path}. Ready for recycling.`,
				});
			}
			return text(`Handoff written to ${path}`);
		},
	});

	if (!rt.isLead) {
		pi.registerTool({
			name: "team_attention",
			label: "Request attention",
			description:
				"Ask your direct parent for input. low = FYI, medium = need a decision soon, high = blocked.",
			parameters: Type.Object({
				level: StringEnum(["low", "medium", "high"] as const),
				question: Type.String(),
			}),
			async execute(_id, params) {
				const { level, question } = params as {
					level: "low" | "medium" | "high";
					question: string;
				};
				const team = rt.team;
				const parent = rt.parent;
				if (!team || !parent) return text("No parent to notify.");
				postAttention(team, parent, {
					from: rt.me,
					level,
					question,
					at: new Date().toISOString(),
				});
				postMail(team, {
					from: rt.me,
					to: parent,
					kind: "message",
					content: `[attention: ${level}] ${question}`,
				});
				if (level !== "low") {
					writeStatus(team, { agent: rt.me, state: "stuck", note: `awaiting parent: ${question}` });
				}
				return text(
					level === "high"
						? "Parent notified (high). Stop and wait for a reply before continuing."
						: `Parent notified (${level}).`,
				);
			},
		});
	}

	// ------------------------------------------------------- lifecycle

	if (!canManage) return;

	pi.registerTool({
		name: "team_request_shutdown",
		label: "Request shutdown",
		description:
			"Ask an agent to finish up and exit gracefully. Does not kill the process. Escalate to team_force_shutdown if it does not exit.",
		parameters: Type.Object({ name: Type.String() }),
		async execute(_id, params) {
			const { name } = params as { name: string };
			const team = rt.team;
			if (!team) return text("No team.");
			postMail(team, {
				from: rt.me,
				to: name,
				kind: "shutdown",
				content:
					"Shutdown requested. Finish your current step, write your deliverable, call team_write_status('done'), report to your parent, then stop.",
			});
			return text(`Graceful shutdown requested for ${name}.`);
		},
	});

	pi.registerTool({
		name: "team_force_shutdown",
		label: "Force shutdown",
		description:
			"Immediately kill an agent and all of its descendants. Discards unsaved work — prefer team_recycle when partial work matters.",
		parameters: Type.Object({ name: Type.String() }),
		async execute(_id, params) {
			const { name } = params as { name: string };
			const config = rt.config();
			if (!config) return text("No team.");
			const target = findAgent(config, name);
			if (!target) return text(`No such agent: ${name}`);
			const victims = [target, ...descendantsOf(config, name)];
			for (const victim of victims) {
				killAgent(config.team, victim.name, victim.paneId);
				patchAgent(config.team, victim.name, { killedAt: new Date().toISOString() });
				writeStatus(config.team, {
					agent: victim.name,
					state: "killed",
					note: `force shutdown by ${rt.me}`,
				});
			}
			return text(`Killed ${victims.map((v) => v.name).join(", ")}.`);
		},
	});

	pi.registerTool({
		name: "team_recycle",
		label: "Recycle agent",
		description:
			"Kill an agent and spawn a fresh replacement under the same name, seeded with its handoff report. " +
			"Ask the agent for team_write_handoff first so its partial work survives. Carries over the task, contract, " +
			"model, profile and the spawn's skills, extensions, contextFiles and slim.",
		parameters: Type.Object({
			name: Type.String(),
			additionalContext: Type.Optional(
				Type.String({ description: "Extra instructions or evaluator feedback for the replacement" }),
			),
		}),
		async execute(_id, params) {
			const { name, additionalContext } = params as { name: string; additionalContext?: string };
			const config = rt.config();
			if (!config) return text("No team.");
			const old = findAgent(config, name);
			if (!old) return text(`No such agent: ${name}`);

			const handoff = readHandoff(config.team, name);
			killAgent(config.team, name, old.paneId);
			patchAgent(config.team, name, { killedAt: new Date().toISOString() });
			for (const child of descendantsOf(config, name)) {
				killAgent(config.team, child.name, child.paneId);
				patchAgent(config.team, child.name, { killedAt: new Date().toISOString() });
			}

			const handoffText = handoff
				? [
						`Completed work: ${handoff.completedWork}`,
						handoff.pendingTasks ? `Pending: ${handoff.pendingTasks}` : "",
						handoff.corrections ? `Corrections: ${handoff.corrections}` : "",
						handoff.stateRefs?.length ? `State refs: ${handoff.stateRefs.join(", ")}` : "",
					]
						.filter(Boolean)
						.join("\n")
				: `No handoff was written. Last output:\n${capturePane(config.team, name, old.paneId, 40)}`;

			const result = spawnOne(rt, {
				name,
				task: old.task,
				canSpawn: old.canSpawn,
				model: old.model,
				provider: old.provider,
				thinkingLevel: old.thinkingLevel,
				profile: old.profile,
				skills: old.skills,
				extensions: old.extensions,
				contextFiles: old.contextFiles,
				slim: old.slim,
				visible: old.visible,
				cwd: old.cwd,
				gate: old.gate,
				gateExempt: old.gateExempt,
				trial: old.trial,
				routing: old.routing,
				taskContract: readContract(config.team, name) ?? undefined,
				handoff: handoffText,
				extraContext: additionalContext,
				// The replacement reports to the same manager as the original;
				// recycling a grandchild must not make it the caller's direct report.
				parent: old.parent ?? config.leadName,
			});
			return text(`Recycled ${name}.\n${result}`);
		},
	});

	pi.registerTool({
		name: "team_evaluate",
		label: "Evaluate outputs",
		description:
			"Spawn a fresh evaluator agent that grades completed agents' deliverables against their task contracts. " +
			"Run only after the whole batch reports done.",
		parameters: Type.Object({
			agents: Type.Array(Type.String(), { description: "Agent names to grade" }),
			evaluatorName: Type.Optional(Type.String()),
			additionalCriteria: Type.Optional(Type.String()),
		}),
		async execute(_id, params) {
			const { agents, evaluatorName, additionalCriteria } = params as {
				agents: string[];
				evaluatorName?: string;
				additionalCriteria?: string;
			};
			const config = rt.config();
			if (!config) return text("No team.");
			const name = evaluatorName ?? `evaluator-${Date.now().toString(36).slice(-4)}`;
			const outputPath = `${evaluationsDir(config.team)}/${name}.md`;

			const targets = agents.map((agent) => {
				const contract = readContract(config.team, agent);
				const status = readStatus(config.team, agent);
				return [
					`### ${agent}`,
					`- deliverable: ${status?.output ?? contract?.outputPath ?? "(unknown)"}`,
					contract?.evaluationCriteria?.length
						? `- criteria:\n${contract.evaluationCriteria.map((c) => `  - ${c}`).join("\n")}`
						: "- criteria: (none recorded — judge against the task description)",
					contract?.passDefinition ? `- pass: ${contract.passDefinition}` : "",
					contract?.failDefinition ? `- fail: ${contract.failDefinition}` : "",
				]
					.filter(Boolean)
					.join("\n");
			});

			const task = [
				"Grade the deliverables below against their contracts. Read each file, then judge.",
				"",
				...targets,
				additionalCriteria ? `\n### Additional criteria\n${additionalCriteria}` : "",
				"",
				"For each agent output a verdict: PASS or FAIL, the criteria that failed, and one",
				"concrete instruction that would fix it. Be objective — no praise, no hedging.",
				`Write the report as markdown to ${outputPath}.`,
			].join("\n");

			const result = spawnOne(rt, {
				name,
				task,
				canSpawn: false,
				roleOverride: "evaluator",
				taskContract: { outputPath, outputFormat: "markdown" },
			});
			return text(`Evaluator spawned.\n${result}`);
		},
	});

	pi.registerTool({
		name: "team_verify",
		label: "Verify finding",
		description:
			"Adversarially verify ONE finding before it reaches your answer. Spawns three independent " +
			"skeptics in parallel (is it correct? is it current? is the source real?), each in a fresh " +
			"empty context that never sees the worker's chat. Kept only on a 2-of-3 majority. " +
			"Blocks until the verdict is in \u2014 this is a decision point, not background work.",
		promptGuidelines: [
			"Use team_verify on load-bearing claims before you repeat them to the human, especially " +
				"numbers, citations, and anything a worker asserted about its own output.",
			"team_verify takes ONE claim per call: a compound finding can pass while hiding a defect inside it. Split it first.",
			"team_verify skeptics run with --no-extensions --no-skills --no-context-files and cannot be configured. They have " +
				"read and bash, so files, repo paths and reasoning are in reach; they have NO MCP, so a Linear ticket, Confluence page, " +
				"Slack thread, Sentry issue or web URL is not. For those, team_spawn a verifier with profile: 'verifier-mcp' " +
				"(MCP and house rules on) plus any skill it needs to read the sources, and never show it the worker's reasoning.",
		],
		parameters: Type.Object({
			finding: Type.String({
				description:
					"The claim ONLY \u2014 self-contained, no worker narrative, no confidence language.",
			}),
			sources: Type.Optional(
				Type.Array(Type.String(), {
					description: "Citations to resolve: file paths, file:line refs, or URLs",
				}),
			),
			context: Type.Optional(
				Type.String({ description: "Neutral facts the skeptics need. Never the author's argument." }),
			),
			model: Type.Optional(Type.String({ description: "Override the verifier model" })),
			provider: Type.Optional(Type.String()),
			timeoutSeconds: Type.Optional(Type.Number({ description: "Per skeptic. Default 180, max 600" })),
		}),
		async execute(_id, params) {
			const { finding, sources, context, model, provider, timeoutSeconds } = params as {
				finding: string;
				sources?: string[];
				context?: string;
				model?: string;
				provider?: string;
				timeoutSeconds?: number;
			};
			if (!finding?.trim()) return text("Refusing to verify: empty finding.");

			const verifier = resolveRuntime({ role: "worker", profile: "verifier", slim: true });
			const result = await runSkeptics({
				finding,
				sources,
				context,
				cwd: rt.cwd,
				env: spawnEnv({}),
				model: model ?? verifier.model,
				provider: provider ?? verifier.provider,
				thinkingLevel: verifier.thinkingLevel,
				timeoutMs: Math.min(Math.max(timeoutSeconds ?? 180, 20), 600) * 1000,
			});

			const rows = result.verdicts
				.map(
					(v) =>
						`| ${SKEPTIC_LABEL[v.kind]} | ${v.verdict === "pass" ? "PASS" : "FAIL"}${v.inconclusive ? " (inconclusive)" : ""} | ${v.reason.replace(/\|/g, "/")} |`,
				)
				.join("\n");
			const headline = result.passed
				? `**VERIFIED \u2014 ${result.passCount}/${result.verdicts.length} skeptics let it live.** Safe to use.`
				: result.unverified
					? `**UNVERIFIED \u2014 ${result.inconclusiveCount}/${result.verdicts.length} skeptics reached no verdict; none actually disproved it.** ` +
						`This is NOT a rejection: the checks failed, not the claim. Re-run with a longer timeoutSeconds, ` +
						`verify it yourself, or report it explicitly as unverified. Do not report it as disproved.`
					: `**REJECTED \u2014 ${result.passCount}/${result.verdicts.length} passed and ${result.verdicts.length - result.passCount - result.inconclusiveCount} actively disproved it.** Drop or fix it.`;
			return text(
				[
					headline,
					"",
					"| skeptic | verdict | reason |",
					"|---|---|---|",
					rows,
					"",
					result.passed
						? ""
						: result.unverified
							? "Say \"unverified\" to the human, never \"false\"."
							: "Do NOT repeat this claim to the human as established. Either correct it and re-verify, or state it as unverified.",
				]
					.filter(Boolean)
					.join("\n"),
			);
		},
	});

	// ------------------------------------------------- resuming sessions

	pi.registerTool({
		name: "team_ask",
		label: "Ask finished agent",
		description:
			"Ask a finished agent a follow-up question inside its own saved session, so it answers from " +
			"the context it already has. Far cheaper than re-deriving the work. Fails while the agent is running. " +
			"The reply is one-shot: a deferral, empty reply or crash is re-asked once, then reported as NO ANSWER.",
		promptGuidelines: [
			"Use team_ask instead of re-spawning when you only need a detail a finished agent already knows.",
			"A team_ask result starting with NO ANSWER is not an answer: never treat it as one. Ask again, re-spawn, or dismiss it with team_ask {name, dismiss: true}.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Finished agent to question" }),
			question: Type.Optional(
				Type.String({ description: "One focused question. It cannot see your conversation." }),
			),
			timeoutSeconds: Type.Optional(Type.Number({ description: "Per attempt. Default 120, max 600" })),
			dismiss: Type.Optional(
				Type.Boolean({ description: "Clear this agent's unanswered-ask entries instead of asking" }),
			),
		}),
		async execute(_id, params) {
			const { name, question, timeoutSeconds, dismiss } = params as {
				name: string;
				question?: string;
				timeoutSeconds?: number;
				dismiss?: boolean;
			};
			const config = rt.config();
			if (dismiss) {
				if (!config) return text("No team is running.");
				const count = dismissAsks(config.team, name);
				return text(count > 0 ? `Dismissed ${count} unanswered ask(s) to ${name}.` : `No unanswered asks to ${name}.`);
			}
			if (!question?.trim()) return text("Refusing to ask: question is empty.");
			let agent: AgentRecord | undefined = config ? findAgent(config, name) : undefined;
			if (config && !agent) {
				// Recycled out of the tree, but its session may still be resumable.
				const archived = findArchivedAgent(config.team, name);
				if (archived?.sessionId) {
					agent = {
						name: archived.name,
						role: "worker" as const,
						parent: archived.parent,
						task: archived.task,
						cwd: archived.cwd ?? config.cwd,
						canSpawn: false,
						backend: "headless" as const,
						paneId: null,
						visible: false,
						createdAt: archived.createdAt,
						killedAt: archived.reapedAt,
						sessionId: archived.sessionId,
					};
				}
			}
			if (!config || !agent) {
				return text(
					`No such agent: ${name}.` +
						(config ? ` It may have been reaped without a recorded session id — check ${teamDir(config.team)}/archive/agents.jsonl` : ""),
				);
			}

			// A worker that just reported `done` may still be flushing; wait it out.
			const check = checkResumable(config.team, agent, "inspect", { graceMs: 20000 });
			if (!check.ok) return text(check.reason as string);

			const timeoutMs = Math.min(Math.max(timeoutSeconds ?? 120, 10), 600) * 1000;
			const sessionId = check.sessionId as string;
			const asked = agent;
			const askId = startAsk(config.team, rt.me, name, question);
			const outcome = await askWithRetry(question, (prompt) =>
				runAsk({
					argv: buildResumeArgv({
						originalArgv: asked.argv ?? [process.env.PI_ORCH_PI_BIN ?? "pi"],
						sessionId,
						mode: "inspect",
						question: prompt,
					}),
					env: resumeEnv(spawnEnv({}), "inspect", {}),
					cwd: asked.cwd,
					timeoutMs,
				}),
			);
			finishAsk(config.team, askId, outcome);
			const body = outcome.output.length > 6000 ? `${outcome.output.slice(0, 6000)}\n[…truncated]` : outcome.output;
			const details = { answered: outcome.answered, reason: outcome.reason, attempts: outcome.attempts, agent: name };
			if (outcome.answered) {
				const retried = outcome.attempts > 1 ? ` after a re-ask (first reply: ${outcome.reasons[0]})` : "";
				return {
					content: [{ type: "text" as const, text: `**${name}** answered (from its own session)${retried}:\n\n${body}` }],
					details,
				};
			}
			const quoted = body.trim()
				? body
						.split("\n")
						.map((line) => `> ${line}`)
						.join("\n")
				: "> (nothing)";
			return {
				content: [
					{
						type: "text" as const,
						text: [
							`NO ANSWER: ${outcome.reason}`,
							"",
							`${name} did not answer, even after one automatic re-ask. Do not treat anything below as an answer.`,
							...outcome.reasons.map((reason, index) => `- attempt ${index + 1}: ${reason}`),
							"",
							"Last reply (NOT an answer):",
							quoted,
							"",
							`This stays in team_status as unanswered until a later team_ask to ${name} is answered, ` +
								`or you clear it with team_ask {name: "${name}", dismiss: true}.`,
						].join("\n"),
					},
				],
				details,
			};
		},
	});

	pi.registerTool({
		name: "team_open_session",
		label: "Open agent session",
		description:
			"Reopen a spawned agent's session as a real pi session. " +
			"inspect = detached observer (cannot act as the teammate); attach = become that teammate again " +
			"(same status file and mailbox); fork = branch its transcript into a new agent.",
		parameters: Type.Object({
			name: Type.String(),
			mode: StringEnum(["inspect", "attach", "fork"] as const),
			visible: Type.Optional(
				Type.Boolean({ description: "Open in a visible pane (default true)" }),
			),
		}),
		async execute(_id, params) {
			const { name, mode, visible } = params as {
				name: string;
				mode: ResumeMode;
				visible?: boolean;
			};
			return text(openAgentSession(rt, name, mode, { visible }).message);
		},
	});

	pi.registerTool({
		name: "team_await",
		label: "Await children",
		description:
			"Block until the named agents (default: all your children) reach a terminal state, then return " +
			"their outcomes and deliverable paths. This is how a manager waits: a headless agent exits when " +
			"its turn ends, so parking inside this one tool call is what keeps it alive to collect results. " +
			"Each done deliverable is checked against its contract's requiredFields; a miss, or an agent that exited " +
			"without reporting, is shown as GAP, never as done. For each done deliverable it returns the file's " +
			"'## Answer' section (up to 25 lines) and its path, or the first 20 lines with a note when there is no such section.",
		promptGuidelines: [
			"If you spawned children and must collect their results, call team_await instead of polling " +
				"team_status in a loop — polling burns your context and a headless agent may exit first.",
			"Never call team_await from the interactive lead session: it blocks the human. End your turn " +
				"instead; each child's report arrives as a message and wakes you.",
			"A GAP from team_await is not a pass. Recycle that agent once with the missing fields named; if it misses again, " +
				"report the gap as a gap. team_await never respawns anything itself.",
		],
		parameters: Type.Object({
			agents: Type.Optional(
				Type.Array(Type.String(), { description: "Agent names. Omit for all of your direct children." }),
			),
			timeoutSeconds: Type.Optional(Type.Number({ description: "Default 900, max 3600" })),
		}),
		async execute(_id, params, signal, onUpdate) {
			const { agents, timeoutSeconds } = params as { agents?: string[]; timeoutSeconds?: number };
			if (rt.isLead && rt.hasUI && process.env.PI_ORCH_ALLOW_LEAD_AWAIT !== "1") {
				return text(
					"Refused: team_await would block the interactive session the human is typing in. " +
						"End your turn now; each child's report arrives as a message and wakes you. " +
						"(Headless or scripted leads are unaffected; set PI_ORCH_ALLOW_LEAD_AWAIT=1 to override.)",
				);
			}
			const config = rt.config();
			if (!config) return text("No team is running.");
			const names =
				agents && agents.length > 0
					? agents
					: childrenOf(config, rt.me)
							.filter((a) => !a.killedAt)
							.map((a) => a.name);
			if (names.length === 0) return text("No children to wait for.");

			const deadline = Date.now() + Math.min(Math.max(timeoutSeconds ?? 900, 5), 3600) * 1000;
			const TERMINAL = new Set(["done", "error", "stuck", "killed"]);
			const settled = (): Map<string, string> => {
				const statuses = readAllStatuses(config.team);
				const fresh = readTeam(config.team) ?? config;
				const out = new Map<string, string>();
				for (const name of names) {
					const status = statuses[name];
					const state = status?.state;
					if (state && TERMINAL.has(state)) out.set(name, state);
					// Queued spawns and fresh reservations have no process yet.
					else if (state === "queued") {
						if (findAgent(fresh, name)?.killedAt) out.set(name, "killed");
						continue;
					}
					else if (state === "spawning" && Date.now() - Date.parse(status?.updatedAt ?? "") < 60_000) continue;
					// A dead process with no terminal status is finished too, just
					// badly: waiting for it forever would hang the manager.
					else if (!isAlive(config.team, name) && readStatus(config.team, name)) {
						out.set(name, "exited-without-reporting");
					}
				}
				return out;
			};

			let done = settled();
			while (done.size < names.length && Date.now() < deadline && !signal?.aborted) {
				onUpdate?.({
					content: [
						{
							type: "text",
							text: `waiting on ${names.length - done.size} of ${names.length}: ${names.filter((n) => !done.has(n)).join(", ")}`,
						},
					],
					details: {},
				});
				await new Promise((resolve) => setTimeout(resolve, 3000));
				done = settled();
			}

			const statuses = readAllStatuses(config.team);
			const gaps: string[] = [];
			const answers: string[] = [];
			const rows = names.map((name) => {
				let state = done.get(name) ?? (statuses[name]?.state === "queued" ? "still queued" : "still running");
				const status = statuses[name];
				const contract = readContract(config.team, name);
				const childCwd = findAgent(readTeam(config.team) ?? config, name)?.cwd ?? rt.cwd;
				let contractCell = contract?.requiredFields?.length ? "pending" : "—";
				if (state === "done") {
					const missing = missingFields(status?.output, contract, childCwd);
					if (missing) contractCell = missing.length === 0 ? "ok" : `missing: ${missing.join(", ")}`;
					if (missing && missing.length > 0) state = "GAP (done, fields missing)";
				} else if (state === "exited-without-reporting") {
					state = "GAP (exited without reporting)";
					contractCell = "no deliverable";
				}
				if (state.startsWith("GAP")) gaps.push(name);
				if (done.get(name) === "done" && status?.output) answers.push(answerBlock(name, status.output, childCwd));
				return `| ${name} | ${state} | ${status?.output ?? "—"} | ${contractCell.replace(/\|/g, "/")} | ${(status?.note ?? "").slice(0, 80)} |`;
			});
			const unfinished = names.filter((n) => !done.has(n));
			return text(
				[
					unfinished.length === 0
						? `All ${names.length} agent(s) finished.`
						: `Timed out with ${unfinished.length} still running: ${unfinished.join(", ")}.`,
					...(gaps.length > 0
						? [
								`GAP: ${gaps.join(", ")}. A gap is not a pass. Recycle each once with the missing fields named ` +
									"(team_recycle additionalContext); a second miss is reported as a gap. Nothing was respawned automatically.",
							]
						: []),
					"",
					"| agent | state | deliverable | contract | note |",
					"|---|---|---|---|---|",
					...rows,
					...(answers.length > 0 ? ["", "## Answers", "", answers.join("\n\n")] : []),
					"",
					"Each done deliverable's '## Answer' section is above; read the full file only for the part you need. " +
						"Do not forward raw worker output —",
					"synthesise, and pass along verification verdicts and file paths.",
				].join("\n"),
			);
		},
	});

	pi.registerTool({
		name: "team_reap",
		label: "Reap finished agents",
		description:
			"Recycle finished agents out of the tree: archives their final status and deliverable path, " +
			"then removes them so the tree and widget show current work. Live agents and agents with live " +
			"children are never reaped. Runs automatically on a timer; call it to reclaim space now.",
		parameters: Type.Object({
			olderThanMinutes: Type.Optional(
				Type.Number({ description: "Retention window. Default 10; 0 reaps every finished agent." }),
			),
			all: Type.Optional(Type.Boolean({ description: "Reap every terminal agent regardless of age" })),
		}),
		async execute(_id, params) {
			const { olderThanMinutes, all } = params as { olderThanMinutes?: number; all?: boolean };
			const config = rt.config();
			if (!config) return text("No team is running.");
			const result = reapTeam(config.team, {
				olderThanMs: Math.max(0, (olderThanMinutes ?? 10) * 60_000),
				all: all ?? olderThanMinutes === 0,
				maxAgents: maxTrackedAgents(),
			});
			if (result.reaped.length === 0) {
				return text(`Nothing to reap: ${result.kept} agent(s) are live or still within the window.`);
			}
			return text(
				[
					`Reaped ${result.reaped.length} finished agent(s): ${result.reaped.join(", ")}.`,
					`${result.kept} remain in the tree.`,
					result.archive ? `Their outcomes and deliverable paths are archived at ${result.archive}` : "",
				]
					.filter(Boolean)
					.join("\n"),
			);
		},
	});

	pi.registerTool({
		name: "team_cleanup",
		label: "Cleanup team",
		description:
			"Kill every agent and delete the team directory. Collect all deliverables BEFORE calling this.",
		parameters: Type.Object({
			keepFiles: Type.Optional(
				Type.Boolean({ description: "Keep the team directory (status, logs, evaluations)" }),
			),
		}),
		async execute(_id, params) {
			const { keepFiles } = params as { keepFiles?: boolean };
			const config = rt.config();
			if (!config) return text("No team to clean up.");
			const killed = cleanupTeam(rt, { keepFiles: keepFiles ?? false });
			return text(
				`Cleaned up team ${config.team}: killed ${killed} agent(s).` +
					(keepFiles ? ` Files kept at ${teamDir(config.team)}` : ""),
			);
		},
	});
}

// ------------------------------------------------------------- helpers

interface SpawnParams {
	name: string;
	task: string;
	canSpawn?: boolean;
	model?: string;
	provider?: string;
	thinkingLevel?: string;
	profile?: string;
	extensions?: string[];
	skills?: string[];
	contextFiles?: boolean;
	slim?: boolean;
	visible?: boolean;
	cwd?: string;
	taskContract?: TaskContract;
	gate?: GateReservation;
	gateExempt?: string;
	trial?: TrialArm;
	routing?: SpawnRouting;
	/** Internal: used by recycle/evaluate. */
	roleOverride?: Role;
	handoff?: string;
	extraContext?: string;
	/** Internal: attach under this parent instead of the caller (recycle, queue pump). */
	parent?: string;
	/** Internal: the original spawner's model, replayed by the queue pump. */
	inherit?: { model: string; provider: string };
	leadSessionId?: string;
	/** Internal: launched by the queue pump; a full cap returns `blocked`. */
	fromQueue?: boolean;
}

/**
 * Decide the child's role.
 *
 * `1-tier` flattens everything to workers. `2-tier` promotes once a parent has
 * too many direct children, so wide fan-out gets a coordination layer instead
 * of overwhelming one parent.
 */
function decideRole(rt: Runtime, params: SpawnParams, siblings: number): Role {
	if (params.roleOverride) return params.roleOverride;
	const level = orchLevel();
	if (level === "1-tier") return "worker";
	if (level === "2-tier" && siblings >= promoteThreshold()) return "orchestrator";
	return params.canSpawn ? "orchestrator" : "worker";
}

function resolveRole(
	rt: Runtime,
	params: SpawnParams,
	config: TeamConfig | null,
	parent: string,
	maxDepth: number,
): { role: Role; atDepthLimit: boolean } {
	const siblings = config ? childrenOf(config, parent).filter((a) => !a.killedAt).length : 0;
	const depth = (config ? depthOf(config, parent) : 0) + 1;
	const decided = decideRole(rt, params, siblings);
	const atDepthLimit = decided === "orchestrator" && depth >= maxDepth;
	return { role: atDepthLimit ? "worker" : decided, atDepthLimit };
}

export function isUnprofiledWorker(rt: Runtime, params: SpawnParams): boolean {
	if (params.profile || params.model || params.roleOverride || params.routing) return false;
	if (!NAME_RE.test(params.name ?? "") || !params.task?.trim()) return false;
	const config = rt.team ? readTeam(rt.team) : null;
	return resolveRole(rt, params, config, params.parent ?? rt.me, spawnLimits().maxDepth).role === "worker";
}

export async function unprofiledRouting(rt: Runtime, params: SpawnParams): Promise<SpawnRouting | undefined> {
	try {
		return isUnprofiledWorker(rt, params) ? await routeUnprofiled(params.task) : undefined;
	} catch {
		return undefined;
	}
}

export function modelLine(model: string | undefined, thinkingLevel: string | undefined, routing?: SpawnRouting): string {
	if (!model) return "";
	const routed = routing && routing.model === model ? ` (${routing.label})` : "";
	const thinking = thinkingLevel ? (routed ? `, thinking ${thinkingLevel}` : ` (${thinkingLevel})`) : "";
	return `Model: ${model}${routed}${thinking}`;
}

export function spawnOne(rt: Runtime, params: SpawnParams): string {
	return trySpawn(rt, params).message;
}

type SpawnOutcome = { kind: "spawned" | "queued" | "refused" | "blocked" | "superseded"; message: string };

/**
 * Launch one agent, or queue it when a concurrency cap is full.
 *
 * `params.parent` is set by recycle (keep the original parent) and by the
 * queue pump (which may run in a different orchestrator than the spawner).
 * With `fromQueue`, a spawn that still does not fit returns `blocked` and the
 * pump puts the entry back.
 */
function trySpawn(rt: Runtime, params: SpawnParams): SpawnOutcome {
	const refuse = (message: string): SpawnOutcome => ({ kind: "refused", message });
	if (!NAME_RE.test(params.name)) {
		return refuse(`Invalid agent name '${params.name}'. Use letters, digits, dot, dash, underscore.`);
	}
	if (!params.task?.trim()) return refuse("Refusing to spawn: task is empty.");
	const gateExempt = typeof params.gateExempt === "string" ? params.gateExempt.trim() : "";
	if (params.gate) {
		const shape = gateShapeError(params.gate);
		if (shape) return refuse(`Refused to spawn '${params.name}': ${shape}.`);
	} else if (!gateExempt) {
		const trigger = gateTrigger(params.profile, params.skills, params.task);
		if (trigger) {
			return refuse(
				`Refused to spawn '${params.name}': this '${params.profile}' spawn is a PR review gate lane (${trigger}), ` +
					"so it needs one of: gate: {state: '<absolute gate state JSON>', spawnId: '<spawn_id from " +
					"pr-gate-spawn.sh check>'}, or gateExempt: '<reason>' for a review that sits outside the gate.",
			);
		}
	}

	const team = rt.ensureTeam();
	if (params.gate) {
		const verified = runGate("verify", params.gate, params.name, team);
		if (!verified.ok) {
			return refuse(`Refused to spawn '${params.name}': gate reservation ${params.gate.spawnId} failed verify: ${verified.error}`);
		}
	}
	const config = readTeam(team);
	if (!config) return refuse("Failed to create team state.");
	const parent = params.parent ?? rt.me;

	const existing = findAgent(config, params.name);
	if (existing && !existing.killedAt && isAlive(team, params.name)) {
		return refuse(`Agent '${params.name}' is already running. Pick another name or recycle it.`);
	}
	if (
		!params.fromQueue &&
		existing &&
		!existing.killedAt &&
		readStatus(team, params.name)?.state === "queued"
	) {
		return refuse(
			`Agent '${params.name}' is already queued (position ${queuePosition(team, params.name)}). ` +
				"It starts by itself when a slot frees; do not spawn it again.",
		);
	}

	// Recycle before growing: without this a long session's tree only ever
	// gets longer, and the 41st spawn is competing with 40 headstones. The
	// queue pump retries every few seconds, so it leaves this to real spawns.
	if (!params.fromQueue) {
		try {
			reapTeam(team, { olderThanMs: reapRetentionMs(), maxAgents: maxTrackedAgents() });
		} catch {
			// Housekeeping must never block a spawn.
		}
	}

	const limits = spawnLimits();
	const depth = depthOf(config, parent) + 1;
	if (depth > limits.maxDepth) {
		return refuse(
			`Refused to spawn '${params.name}': depth cap maxDepth=${limits.maxDepth} reached — ` +
				`${parent} is already ${depth - 1} level(s) below the lead, so a child would sit at level ${depth}. ` +
				"Do this work yourself, or report back to your parent and let it decide.",
		);
	}

	const { role, atDepthLimit } = resolveRole(rt, params, config, parent, limits.maxDepth);
	const canSpawn = role === "orchestrator";
	const routing =
		params.routing && role === "worker" && !params.profile && (!params.model || params.model === params.routing.model)
			? params.routing
			: undefined;
	const slim = params.slim ?? true;
	// Interactive panes idle after finishing a turn, so they can wait for their
	// children. Headless agents run one agent loop and exit, which is right for
	// a worker but leaves a sub-orchestrator unable to collect results.
	const visible = params.visible ?? role === "orchestrator";
	const oneShot = !visible || detectBackend() === "headless";
	const cwd = params.cwd
		? isAbsolute(params.cwd)
			? params.cwd
			: resolve(config.cwd, params.cwd)
		: config.cwd;

	if (!existsSync(cwd)) return refuse(`Working directory does not exist: ${cwd}`);

	const baseline = resolveRuntime({
		role,
		model: params.model,
		provider: params.provider,
		inherit: params.inherit ?? rt.ownModel,
		thinkingLevel: params.thinkingLevel,
		profile: params.profile,
		extensions: params.extensions,
		skills: [...new Set([...(params.skills ?? []), ...defaultSkills()])],
		contextFiles: params.contextFiles,
		slim,
	});
	const settingsNow = readSettings();
	const trial = params.model
		? params.trial
		: leadTrialArm(team, params.name, {
				role,
				roleOverride: params.roleOverride,
				profileModel: params.profile ? allProfiles()[params.profile]?.model : undefined,
				baseModel: baseline.model ?? settingsNow.defaultModel,
				baseProvider: baseline.model ? baseline.provider : settingsNow.defaultProvider,
			});
	const runtime = resolveRuntime({
		role,
		model: params.model ?? trial?.model,
		provider: params.model ? params.provider : (trial?.provider ?? params.provider),
		routed: routing ? { model: routing.model, provider: routing.provider } : undefined,
		inherit: params.inherit ?? rt.ownModel,
		thinkingLevel: params.thinkingLevel,
		profile: params.profile,
		extensions: params.extensions,
		skills: [...new Set([...(params.skills ?? []), ...defaultSkills()])],
		contextFiles: params.contextFiles,
		slim,
	});

	const unresolvedSkills = [...new Set([...runtime.skills, ...runtime.profileSkills])].filter(
		(name) => !resolveSkillPath(name, cwd),
	);
	const taskContract = params.taskContract ? absoluteContract(params.taskContract, cwd) : undefined;
	const badFields = invalidRequiredFields(params.taskContract?.requiredFields);
	const spawnWarnings = [
		role === "worker" && !params.taskContract?.outputPath
			? "WARNING: no taskContract.outputPath. Nothing will check that this worker wrote a deliverable, and " +
				"team_write_status cannot hold it to a path. Give workers a taskContract with an absolute outputPath."
			: "",
		unresolvedSkills.length > 0
			? `WARNING: skill(s) not found from ${cwd}, so the agent will NOT get them: ${unresolvedSkills.join(", ")}. ` +
				"Fix the name or move the skill into ~/.pi/agent/skills (or a settings skill directory), then respawn. " +
				"A resolved skill is not proof it was read: grep the agent's log for the skill path."
			: "",
		badFields.length > 0 ? `WARNING: requiredFields entries that will never match: ${badFields.join("; ")}.` : "",
		takeModelsWarning() ?? "",
	].filter(Boolean);

	const record: AgentRecord = {
		name: params.name,
		role,
		parent,
		task: params.task,
		cwd,
		model: runtime.model,
		provider: runtime.provider,
		thinkingLevel: runtime.thinkingLevel,
		profile: params.profile,
		skills: params.skills,
		extensions: params.extensions,
		contextFiles: params.contextFiles,
		slim: params.slim,
		canSpawn,
		backend: detectBackend(),
		paneId: null,
		visible,
		createdAt: new Date().toISOString(),
		...(params.gate ? { gate: { state: params.gate.state, spawnId: params.gate.spawnId.trim() } } : {}),
		...(gateExempt ? { gateExempt } : {}),
		...(trial ? { trial } : {}),
		...(routing ? { routing } : {}),
	};

	// Count and reserve under one lock: two sub-orchestrators spawning at the
	// same moment must not both take the last slot. Liveness probes shell out
	// to `ps`, so they run before the lock; holding it for a second would make
	// other writers give up waiting.
	const probed = new Map<string, boolean>();
	for (const agent of readTeam(team)?.agents ?? []) {
		if (!agent.killedAt) probed.set(agent.name, isAlive(team, agent.name));
	}
	// Only a positive probe is trusted from before the lock: an agent that was
	// not running yet may have started since, and missing it would let two
	// spawners through the same last slot.
	const alive = (t: string, name: string): boolean => probed.get(name) === true || isAlive(t, name);
	let cap = null as CapHit | null;
	let liveSiblings = 0;
	let conflict: string | null = null;
	const reserved = updateTeam(
		team,
		(current) => {
			const statuses = readAllStatuses(team);
			// Re-check the name under the lock: the checks above ran unlocked,
			// so a concurrent spawner or pump may have taken it meanwhile.
			const prior = current.agents.find((a) => a.name === params.name);
			const priorState = prior && !prior.killedAt ? statuses[params.name]?.state : undefined;
			if (params.fromQueue && priorState !== "queued") {
				conflict = "superseded";
				return;
			}
			if (
				!params.fromQueue &&
				prior &&
				!prior.killedAt &&
				(priorState === "queued" || holdsSlot(team, prior, statuses[params.name], Date.now(), alive))
			) {
				conflict = `Agent '${params.name}' was started or queued by someone else a moment ago. Pick another name.`;
				return;
			}
			const counts = countLive(current, statuses, parent, { exclude: params.name, alive });
			liveSiblings = counts.liveChildren;
			cap = countCapHit(counts, limits, parent, team);
			if (cap && (params.fromQueue || !limits.queueSpawns)) return;
			// Status first: between the record landing and the first write there
			// is a window in which the record carries the PREVIOUS run's terminal
			// status, and a concurrent reap would archive the fresh agent on it.
			writeStatus(team, {
				agent: params.name,
				state: cap ? "queued" : "spawning",
				note: cap ? `waiting for a slot — ${cap.message}` : "process starting",
			});
			current.agents = current.agents.filter((a) => a.name !== params.name);
			current.agents.push(record);
		},
		{ required: true },
	);
	if (!reserved) return refuse(`Spawn failed for ${params.name}: could not lock the team config.`);
	const lost = conflict as string | null;
	if (lost === "superseded") return { kind: "superseded", message: "entry no longer queued" };
	if (lost) return refuse(lost);
	let gateLine = gateExempt ? `Gate exempt: ${gateExempt}` : "";
	if (params.gate) {
		const bound = runGate("bind", params.gate, params.name, team);
		if (!bound.ok) {
			updateTeam(team, (current) => {
				current.agents = current.agents.filter((a) => a.name !== params.name);
			});
			writeStatus(team, { agent: params.name, state: "error", note: "gate reservation refused" });
			return refuse(`Refused to spawn '${params.name}': gate reservation ${params.gate.spawnId} failed bind: ${bound.error}`);
		}
		gateLine = `Gate: ${params.gate.spawnId} bound (lane ${bound.detail.lane}, head ${String(bound.detail.head ?? "").slice(0, 12)}).`;
	}
	ensureDir(mailboxDir(team, params.name));
	if (canSpawn) ensureDir(attentionDir(team, params.name));

	const hit = cap;
	if (hit) {
		if (params.fromQueue) return { kind: "blocked", message: hit.message };
		if (!limits.queueSpawns) {
			return refuse(
				`Refused to spawn '${params.name}': ${hit.message}. Wait for a running agent to finish ` +
					"(team_await), then spawn again — or raise team." +
					`${hit.key} in ~/.pi/agent/settings.json.`,
			);
		}
		if (taskContract) writeContract(team, params.name, taskContract);
		const { fromQueue: _fromQueue, parent: _parent, inherit: _inherit, leadSessionId: _lead, ...replay } = params;
		try {
			enqueue(team, {
				name: params.name,
				parent,
				queuedAt: new Date().toISOString(),
				params: replay,
				inherit: params.inherit ?? rt.ownModel,
				leadSessionId: params.leadSessionId ?? rt.ownSessionId,
			});
		} catch (error) {
			updateTeam(team, (current) => {
				current.agents = current.agents.filter((a) => a.name !== params.name);
			});
			writeStatus(team, { agent: params.name, state: "error", note: "could not write its queue entry" });
			return refuse(`Spawn failed for ${params.name}: could not queue it: ${(error as Error).message}`);
		}
		return {
			kind: "queued",
			message: [
				`Queued **${params.name}** (${role}): ${hit.message}.`,
				`It starts automatically when a slot frees (queue position ${queuePosition(team, params.name)}), ` +
					"and team_await already includes it. Do NOT retry or respawn it.",
				gateLine,
				...spawnWarnings,
				atDepthLimit
					? `NOTE: it will run as a worker, not an orchestrator: at level ${depth} it is at the depth cap (maxDepth=${limits.maxDepth}).`
					: "",
			]
				.filter(Boolean)
				.join("\n"),
		};
	}

	const delaySeconds = Math.min(liveSiblings, 8) * 3;
	if (taskContract) writeContract(team, params.name, taskContract);

	const systemPrompt = buildSystemPrompt({
		team,
		agent: params.name,
		role,
		parent,
		canSpawn,
		task: params.task,
		contract: taskContract,
		handoff: params.handoff,
		extraContext: params.extraContext,
	});

	// Headless agents run in print mode: one full agent loop, then exit. That
	// matches a worker's lifecycle (do the task, report, die) and needs no tty.
	const headless = !visible;
	const argv = buildArgv({
		team,
		agent: params.name,
		systemPrompt,
		kickoff:
			"Begin the assignment in your system prompt now. Follow the completion protocol: " +
			"write your deliverable, call team_write_status('done', output), then team_message your parent.",
		model: runtime.model,
		provider: runtime.provider,
		thinkingLevel: runtime.thinkingLevel,
		extensions: runtime.extensions,
		skills: [...new Set([...runtime.skills, ...runtime.profileSkills])],
		contextFiles: runtime.contextFiles ?? defaultContextFiles(),
		cwd,
		slim,
		headless,
	});

	const env = spawnEnv({
		PI_ORCH_TEAM_NAME: team,
		PI_ORCH_AGENT_NAME: params.name,
		PI_ORCH_AGENT_ROLE: role,
		PI_ORCH_PARENT_NAME: parent,
		PI_ORCH_CAN_SPAWN: canSpawn ? "true" : "false",
	});

	let result: ReturnType<typeof spawnAgent>;
	try {
		result = spawnAgent({
			team,
			agent: params.name,
			cwd,
			argv,
			env,
			visible,
			// Stagger batches so N agents do not all hit the provider at once.
			delaySeconds,
		});
	} catch (error) {
		updateTeam(team, (current) => {
			current.agents = current.agents.filter((a) => a.name !== params.name);
		});
		writeStatus(team, { agent: params.name, state: "error", note: "spawn failed" });
		return refuse(`Spawn failed for ${params.name}: ${(error as Error).message}`);
	}
	patchAgent(team, params.name, { backend: result.backend, paneId: result.paneId });
	const trialLogError =
		trial && !params.trial
			? appendTrialLog({ team, agent: params.name, arm: trial.arm, model: trial.model, task: params.task })
			: undefined;

	// The check must land after the agent's stagger sleep, or a late-starting
	// sibling is reported as a startup crash.
	scheduleLivenessCheck(rt, team, params.name, delaySeconds * 1000, parent, record.createdAt);
	// Record which pi session this agent owns, so it can be reopened later.
	scheduleSessionCapture(team, params.name, argv, { leadSessionId: params.leadSessionId ?? rt.ownSessionId });

	// Silent convention loss is how a worker ships a PR with no Co-Authored-By
	// trailer: it never saw the repo's PR skill. Say so at spawn time.
	const looksLikeCodeWork =
		/\b(pr|pull request|commit|ticket|branch|rubocop|rspec|jest|lint|refactor|implement|fix)\b/i.test(
			params.task,
		) || /\b[A-Z]{2,5}-\d{2,6}\b/.test(params.task);
	const conventionWarning =
		looksLikeCodeWork && slim && runtime.skills.length + runtime.profileSkills.length === 0
			? "NOTE: this looks like code/PR work but no skills were passed (and no profile supplied any), and slim mode strips skill " +
				"discovery, so repo conventions (commit format, Co-Authored-By trailer, PR template) are NOT " +
				"in this agent's context. If it will commit or open a PR, respawn with " +
				"`skills: [\"my-skill\"]` (the repo's ticket-to-PR skill) and `contextFiles: true`."
			: "";

	return {
		kind: "spawned",
		message: [
			`Spawned **${params.name}** (${role}, ${result.backend}${result.backend === "headless" ? "" : visible ? ", visible pane" : ", hidden window"}).`,
			modelLine(runtime.model, runtime.thinkingLevel, routing),
			trial ? `Lead trial arm: ${trial.arm} (until ${trial.until}; pass an explicit model to opt out).` : "",
			trialLogError
				? `WARNING: the lead trial log could not be written (${trialLogError}); pi-cost-trial reports this agent from its record as UNLOGGED.`
				: "",
			gateLine,
			...spawnWarnings,
			conventionWarning,
			atDepthLimit
				? `NOTE: spawned as a worker, not an orchestrator: at level ${depth} it is at the depth cap (maxDepth=${limits.maxDepth}) and could not spawn anything.`
				: "",
			role === "orchestrator" && oneShot
				? "NOTE: this manager is headless, so its process ends when its turn does. It must call " +
					"`team_await` (one blocking call) to stay alive while its children work — polling team_status " +
					"in a loop will not keep it alive. Give it a visible pane instead if you want to watch it."
				: "",
			"It works in parallel. Do NOT sleep or poll waiting for it: end your turn now so the human keeps a responsive session. " +
				"Its report will arrive as a message and wake you automatically.",
		]
			.filter(Boolean)
			.join("\n"),
	};
}

/**
 * Start queued spawns whose slot has freed. Runs on a timer in every
 * orchestrator process of the team, so the queue drains even while the
 * original spawner is parked in team_await or has exited. Returns the names
 * started.
 */
export function pumpQueue(rt: Runtime): string[] {
	const team = rt.team;
	if (!team || !teamExists(team)) return [];
	const started: string[] = [];
	for (const entry of listQueue<SpawnParams>(team)) {
		const ticket = claim(team, entry.name);
		if (!ticket) continue;
		const config = readTeam(team);
		const record = config && findAgent(config, entry.name);
		const state = readStatus(team, entry.name)?.state;
		if (!config || !record || record.killedAt || state !== "queued") {
			ticket.finish();
			if (record?.killedAt && state === "queued") {
				writeStatus(team, { agent: entry.name, state: "killed", note: "queued spawn cancelled: killed before it started" });
			}
			continue;
		}
		const gone = parentGone(config, entry.parent);
		if (gone) {
			ticket.finish();
			patchAgent(team, entry.name, { killedAt: new Date().toISOString() });
			writeStatus(team, {
				agent: entry.name,
				state: "killed",
				note: `queued spawn cancelled: parent ${entry.parent} ${gone} before a slot freed`,
			});
			continue;
		}
		let outcome: SpawnOutcome;
		try {
			outcome = trySpawn(rt, {
				...entry.params,
				parent: entry.parent,
				inherit: entry.inherit,
				leadSessionId: entry.leadSessionId,
				fromQueue: true,
			});
		} catch (error) {
			outcome = { kind: "refused", message: (error as Error).message };
		}
		if (outcome.kind === "blocked") {
			ticket.release();
			continue;
		}
		ticket.finish();
		if (outcome.kind === "superseded") continue;
		if (outcome.kind === "spawned") {
			started.push(entry.name);
			continue;
		}
		writeStatus(team, { agent: entry.name, state: "error", note: `queued spawn failed: ${outcome.message}` });
		postMail(team, {
			from: entry.name,
			to: entry.parent,
			kind: "message",
			content: `My queued spawn could not start: ${outcome.message}`,
		});
	}
	settleOrphanedQueued(team);
	return started;
}

const ORPHAN_GRACE_MS = 60_000;

/**
 * Terminalise queued records the pump can no longer act on: killed before
 * they started (recycle or force shutdown of an ancestor), or whose queue
 * entry never landed because the spawner died between the two writes.
 * Otherwise team_await waits on them until it times out.
 */
function settleOrphanedQueued(team: string): void {
	const config = readTeam(team);
	if (!config) return;
	const statuses = readAllStatuses(team);
	const ticketed = new Set<string>();
	const dir = queueDir(team);
	if (existsSync(dir)) {
		for (const file of readdirSync(dir)) ticketed.add(file.replace(/\.json(\.claim-.*)?$/, ""));
	}
	for (const agent of config.agents) {
		const status = statuses[agent.name];
		if (status?.state !== "queued" || ticketed.has(agent.name)) continue;
		if (agent.killedAt) {
			writeStatus(team, { agent: agent.name, state: "killed", note: "queued spawn cancelled: killed before it started" });
			continue;
		}
		if (Date.now() - Date.parse(status.updatedAt) < ORPHAN_GRACE_MS) continue;
		writeStatus(team, { agent: agent.name, state: "error", note: "queued spawn lost its queue entry" });
		if (agent.parent) {
			postMail(team, {
				from: agent.name,
				to: agent.parent,
				kind: "message",
				content: "My queued spawn lost its queue entry and will not start. Spawn me again if still needed.",
			});
		}
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Why a queued child's parent can no longer receive it, or null if it can. */
function parentGone(config: TeamConfig, parent: string): string | null {
	if (parent === config.leadName) return pidAlive(config.leadPid) ? null : "exited";
	const record = findAgent(config, parent);
	if (!record) return "left the team";
	if (record.killedAt) return "was killed";
	const state = readStatus(config.team, parent)?.state;
	if (state === "done" || state === "error" || state === "killed") return `finished (${state})`;
	if (!isAlive(config.team, parent)) return "exited";
	return null;
}

const TERMINAL_STATES = new Set(["done", "error", "stuck", "killed"]);

/**
 * A process that dies immediately (bad auth, bad model, missing binary) would
 * otherwise sit in the tree as "spawning" forever. Check once and tell the
 * parent.
 *
 * "Not alive" alone does NOT mean failure: a fast headless worker can finish
 * its whole assignment in under this timeout. Treat an exit as a crash only
 * when the agent neither reported a terminal state nor reached `agent_end`.
 * Getting this wrong once overwrote a worker's `done` status with `error` and
 * reported a successful run as a spawn failure.
 */
export function scheduleLivenessCheck(
	rt: Runtime,
	team: string,
	name: string,
	startupDelayMs = 0,
	parent: string = rt.me,
	createdAt?: string,
): void {
	const timer = setTimeout(() => {
		// The team may have been cleaned up while this timer was pending;
		// writing status here would recreate the directory we just deleted.
		if (!existsSync(teamDir(team))) return;
		// A recycle may have replaced this agent since; its verdict is not ours.
		if (createdAt) {
			const current = readTeam(team);
			const record = current && findAgent(current, name);
			if (!record || record.createdAt !== createdAt) return;
		}
		const status = readStatus(team, name);
		if (status?.state === "queued") return;

		if (isAlive(team, name)) {
			if (status?.state === "spawning") {
				writeStatus(team, { agent: name, state: "active", note: "process running" });
			}
			return;
		}

		// The agent spoke for itself; never clobber its own verdict.
		if (status && TERMINAL_STATES.has(status.state)) return;

		const activity = readActivity(team, name, 12);
		if (activity.finished) {
			// Ran to completion but never called team_write_status.
			writeStatus(team, {
				agent: name,
				state: "error",
				note: "finished its turn without reporting a status",
			});
			postMail(team, {
				from: name,
				to: parent,
				kind: "message",
				content:
					`I finished my turn but never called team_write_status, so there is no recorded deliverable. ` +
					`Last activity: ${activityLabel(activity)}. Log: ${logPath(team, name)}`,
			});
			return;
		}

		writeStatus(team, { agent: name, state: "error", note: "process exited during startup" });
		// Digest, not the raw log: a JSON event stream pasted into the parent's
		// context costs thousands of tokens and says less.
		const tail = (activity.lines.length > 0 ? activity.lines : ["(log empty)"])
			.map((line) => (line.length > 160 ? `${line.slice(0, 159)}…` : line))
			.slice(-8)
			.join("\n");
		postMail(team, {
			from: name,
			to: parent,
			kind: "message",
			content: `Spawn failed: my process exited during startup.\nLog: ${logPath(team, name)}\n\n${tail}`,
		});
	}, 8000 + startupDelayMs);
	timer.unref?.();
}

export function cleanupTeam(rt: Runtime, options: { keepFiles: boolean }): number {
	const config = rt.config();
	if (!config) return 0;
	let killed = 0;
	for (const agent of [...config.agents].reverse()) {
		if (agent.killedAt) continue;
		killAgent(config.team, agent.name, agent.paneId);
		killed++;
	}
	if (!options.keepFiles) destroyTeam(config.team);
	else {
		patchAgentsKilled(config.team);
		rmSync(queueDir(config.team), { recursive: true, force: true });
	}
	rt.team = null;
	return killed;
}

function patchAgentsKilled(team: string): void {
	const config = readTeam(team);
	if (!config) return;
	for (const agent of config.agents) {
		if (!agent.killedAt) patchAgent(team, agent.name, { killedAt: new Date().toISOString() });
	}
}

/**
 * Text tree used by team_status and /team.
 *
 * Rooted at the caller (the lead sees the whole team, a sub-orchestrator its
 * own subtree) and expanded `depth` levels. A listed agent whose own team is
 * not expanded carries a rolled-up tally of it, so nothing below disappears.
 */
export function renderStatus(
	rt: Runtime,
	options: { forHuman?: boolean; depth?: number; scope?: "mine" | "team" } = {},
): string {
	const config = rt.config();
	if (!config) return "No team is running. Use team_spawn to create one.";
	const root = options.scope === "team" || rt.isLead ? config.leadName : rt.me;
	const maxDepth = Math.max(1, Math.floor(options.depth ?? Number.POSITIVE_INFINITY));
	const statuses = readAllStatuses(config.team);
	const views = buildViews(config, statuses, (name) => isAlive(config.team, name), root);
	const counts = countStates(views);
	const attention = readAttention(config.team, rt.me);
	const limits = spawnLimits();
	const caps = countLive(config, statuses, root);

	const lines: string[] = [
		`Team **${config.team}** — backend ${detectBackend()}, level ${orchLevel()}`,
		`Root: ${teamDir(config.team)}`,
		`Caps: ${caps.liveChildren}/${limits.maxChildrenPerParent} live children of ${root}, ` +
			`${countLive(config, statuses, config.leadName).liveTotal}/${limits.maxLiveAgents} live in team, ` +
			`maxDepth ${limits.maxDepth}` +
			(listQueue(config.team).length > 0 ? `, ${listQueue(config.team).length} queued` : ""),
		"",
		root === config.leadName ? `● ${config.leadName} [lead]` : `● ${root} [you — showing your subtree]`,
	];

	const shown = views.map((view, index) => ({ view, index })).filter(({ view }) => view.depth < maxDepth);
	for (const { view, index } of shown) {
		const stale =
			view.status &&
			!["done", "killed", "queued"].includes(view.state) &&
			Date.now() - Date.parse(view.status.updatedAt) > STALE_MS;
		const flags = [
			view.agent.role === "orchestrator" ? "orch" : view.agent.role,
			view.alive || view.state === "queued" ? "" : "exited",
			view.agent.visible ? "" : "headless",
			stale ? "STALE>10m" : "",
		].filter(Boolean);
		const doing =
			view.alive && !view.agent.visible
				? activityLabel(readActivity(config.team, view.agent.name, 1))
				: "";
		const below = subtreeOf(views, index);
		const rollup =
			below.length > 0 && view.depth === maxDepth - 1 ? ` [team: ${countsLine(countStates(below))}]` : "";
		lines.push(
			`${"  ".repeat(view.depth + 1)}${STATE_ICON[view.state] ?? "?"} ${view.agent.name} [${flags.join(", ")}]${rollup}` +
				(view.status?.note ? ` — ${view.status.note}` : "") +
				(doing ? ` (${doing})` : ""),
		);
		if (view.status?.output) {
			lines.push(`${"  ".repeat(view.depth + 2)}→ ${view.status.output}`);
		}
		if (view.agent.sessionId && !view.alive) {
			lines.push(
				`${"  ".repeat(view.depth + 2)}↺ session ${view.agent.sessionId.slice(0, 8)} (team_ask / team_open_session)`,
			);
		}
	}

	lines.push("", `${countsLine(counts)}  (${counts.total} tracked${root === config.leadName ? "" : " in your subtree"})`);

	const asks = visibleAsks(config.team, options.scope === "team" || options.forHuman ? undefined : rt.me);
	if (asks.length > 0) {
		lines.push("", "Asks:");
		for (const ask of asks) {
			const by = ask.by === rt.me ? "" : ` [by ${ask.by}]`;
			lines.push(`  ${askLine(ask)}${by} — "${ask.question}"`);
		}
		if (asks.some((ask) => isOwed(ask))) {
			lines.push('  (an unanswered ask clears when a later team_ask to that agent is answered, or with team_ask {name, dismiss: true})');
		}
	}

	if (attention.length > 0) {
		lines.push("", "Pending attention requests:");
		for (const request of attention) {
			lines.push(`  ⚠ [${request.level}] ${request.from}: ${request.question}`);
		}
	}

	if (!options.forHuman) {
		const done = shown.map(({ view }) => view).filter((v) => v.state === "done");
		if (done.length > 0) {
			lines.push(
				"",
				"Deliverables ready to read:",
				...done.map((v) => `  ${v.agent.name}: ${v.status?.output ?? "(no output path recorded)"}`),
			);
		}
		const archived = `${teamDir(config.team)}/archive/agents.jsonl`;
		if (existsSync(archived)) {
			lines.push(`  (earlier finished agents were reaped; their outcomes are in ${archived})`);
		}
	}
	return lines.join("\n");
}


/** Read a handoff file written by another process, for display. */
export function readHandoffText(team: string, agent: string): string | null {
	const path = `${handoffsDir(team)}/${agent}.json`;
	if (!existsSync(path)) return null;
	return readFileSync(path, "utf8");
}

/**
 * Reopen an agent's session as a real pi process.
 *
 * Shared by the `team_open_session` tool and the `/agents` overlay keys, which
 * is the point: the overlay used to be able to focus a pane and nothing else,
 * so a headless agent's transcript was unreachable without a tool call.
 *
 * Modes are identity decisions, not flags:
 *   inspect - no PI_ORCH_* at all: an observer that cannot act as the agent
 *   attach  - the agent's own identity restored: same status file and mailbox
 *   fork    - a copy of the transcript under a new agent name
 */
export function openAgentSession(
	rt: Runtime,
	name: string,
	mode: ResumeMode,
	options: { visible?: boolean } = {},
): { ok: boolean; message: string } {
	const config = rt.config();
	const agent = config && findAgent(config, name);
	if (!config || !agent) return { ok: false, message: `No such agent: ${name}` };

	const check = checkResumable(config.team, agent, mode, { graceMs: 20000 });
	if (!check.ok) return { ok: false, message: check.reason as string };
	const sessionId = check.sessionId as string;

	const resumedName = mode === "fork" ? `${name}-fork` : name;
	const argv = buildResumeArgv({
		originalArgv: agent.argv ?? [process.env.PI_ORCH_PI_BIN ?? "pi"],
		sessionId,
		mode,
	});
	const env = resumeEnv(spawnEnv({}), mode, {
		PI_ORCH_TEAM_NAME: config.team,
		PI_ORCH_AGENT_NAME: name,
		PI_ORCH_AGENT_ROLE: agent.role,
		PI_ORCH_PARENT_NAME: agent.parent ?? config.leadName,
		PI_ORCH_CAN_SPAWN: agent.canSpawn ? "true" : "false",
	});

	const wantPane = options.visible ?? true;
	if (detectBackend() === "headless" || !wantPane) {
		// No pane to open into: hand back a command the human can run.
		return {
			ok: true,
			message: [
				`No pane backend available, so run this yourself (mode: ${mode}):`,
				"",
				"```bash",
				`cd ${agent.cwd} && \\`,
				mode === "attach"
					? `PI_ORCH_NO_ADOPT=1 PI_ORCH_TEAM_NAME=${config.team} PI_ORCH_AGENT_NAME=${name} \\\n  PI_ORCH_AGENT_ROLE=${agent.role} PI_ORCH_PARENT_NAME=${agent.parent ?? config.leadName} \\\n  PI_ORCH_CAN_SPAWN=${agent.canSpawn} \\`
					: "PI_ORCH_NO_ADOPT=1 \\",
				`  ${quoteArgv(argv)}`,
				"```",
				"",
				check.sessionFile ? `Session file: ${check.sessionFile}` : "",
			]
				.filter(Boolean)
				.join("\n"),
		};
	}

	try {
		spawnAgent({
			team: config.team,
			agent: `${resumedName}-resume`,
			cwd: agent.cwd,
			argv,
			env,
			visible: true,
		});
	} catch (error) {
		return { ok: false, message: `Failed to open a pane for ${name}: ${(error as Error).message}` };
	}

	if (mode === "fork") {
		addAgent(config.team, {
			...agent,
			name: resumedName,
			createdAt: new Date().toISOString(),
			killedAt: undefined,
			sessionId: undefined,
			sessionFile: undefined,
			visible: true,
		});
	}

	return {
		ok: true,
		message: [
			`Opened **${name}**'s session in a pane (mode: ${mode}).`,
			mode === "inspect"
				? "Detached observer: it has no team identity and cannot report as this agent."
				: mode === "attach"
					? `It is ${name} again: same status file, same mailbox, parent ${agent.parent ?? config.leadName}.`
					: `Forked into **${resumedName}**; the original transcript is untouched.`,
			check.sessionFile ? `Session file: ${check.sessionFile}` : "",
		]
			.filter(Boolean)
			.join("\n"),
	};
}
