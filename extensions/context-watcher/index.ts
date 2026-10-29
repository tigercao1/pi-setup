import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface WatcherConfig {
	enabled: boolean;
	warnTokens: number;
	suggestTokens: number;
	factsScript: string;
	startTimeoutMs: number;
}

export const DEFAULT_CONFIG: WatcherConfig = {
	enabled: true,
	warnTokens: 200_000,
	suggestTokens: 250_000,
	factsScript: join(homedir(), ".pi/agent/bin/pi-pause-facts"),
	startTimeoutMs: 60_000,
};

const STATUS_KEY = "context-watcher";
const RECALL_SKILL = join(homedir(), ".pi/agent/skills/recall/SKILL.md");
const WORKER_ENV_KEYS = ["PI_ORCH_AGENT_NAME", "PI_ORCH_TEAM_NAME", "PI_ORCH_AGENT_ROLE", "PI_ORCH_PARENT_NAME"];

const positive = (value: unknown, fallback: number): number =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;

export function readConfig(raw: unknown): WatcherConfig {
	const section = (raw && typeof raw === "object" ? (raw as Record<string, unknown>).contextWatcher : undefined) as
		| Record<string, unknown>
		| undefined;
	if (!section || typeof section !== "object") return { ...DEFAULT_CONFIG };
	const warnTokens = positive(section.warnTokens, DEFAULT_CONFIG.warnTokens);
	const suggestTokens = Math.max(warnTokens, positive(section.suggestTokens, DEFAULT_CONFIG.suggestTokens));
	return {
		enabled: section.enabled !== false,
		warnTokens,
		suggestTokens,
		factsScript:
			typeof section.factsScript === "string" && section.factsScript.trim()
				? section.factsScript.replace(/^~(?=\/)/, homedir())
				: DEFAULT_CONFIG.factsScript,
		startTimeoutMs: positive(section.startTimeoutMs, DEFAULT_CONFIG.startTimeoutMs),
	};
}

function loadSettings(pi: ExtensionAPI): unknown {
	try {
		return pi.getSettings();
	} catch {
		try {
			return JSON.parse(readFileSync(join(homedir(), ".pi/agent/settings.json"), "utf8"));
		} catch {
			return undefined;
		}
	}
}

export function isWorkerEnv(env: NodeJS.ProcessEnv): boolean {
	return WORKER_ENV_KEYS.some((key) => Boolean(env[key]));
}

export function shouldWatch(mode: string, env: NodeJS.ProcessEnv): boolean {
	return mode === "tui" && !isWorkerEnv(env);
}

interface CostRates {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	tiers?: Array<CostRates & { inputTokensAbove: number }>;
}

export function perCallCost(model: unknown, tokens: number): { warm: number; cold: number } | undefined {
	const cost = (model as { cost?: CostRates } | undefined)?.cost;
	if (!cost || typeof cost.cacheRead !== "number") return undefined;
	let rates: CostRates = cost;
	let matched = -1;
	for (const tier of cost.tiers ?? []) {
		if (tokens > tier.inputTokensAbove && tier.inputTokensAbove > matched) {
			rates = tier;
			matched = tier.inputTokensAbove;
		}
	}
	if (!rates.cacheRead && !rates.cacheWrite && !rates.input) return undefined;
	return {
		warm: (tokens * (rates.cacheRead || rates.input)) / 1_000_000,
		cold: (tokens * (rates.cacheWrite || rates.input)) / 1_000_000,
	};
}

export function formatTokens(tokens: number): string {
	return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(2)}M` : `${Math.round(tokens / 1000)}k`;
}

const money = (value: number) => `$${value < 1 ? value.toFixed(3) : value.toFixed(2)}`;

export function statusText(tokens: number, model: unknown, suggest: boolean): string {
	const parts = [`ctx ${formatTokens(tokens)}`];
	const cost = perCallCost(model, tokens);
	if (cost) parts.push(`~${money(cost.warm)}/call (${money(cost.cold)} cache-cold)`);
	if (suggest) parts.push("/fresh");
	return parts.join(" · ");
}

export type Level = "none" | "warn" | "suggest";

export interface WatchState {
	level: Level;
	suggested: boolean;
}

export function step(
	state: WatchState,
	tokens: number,
	config: Pick<WatcherConfig, "warnTokens" | "suggestTokens">,
): { state: WatchState; notify: boolean } {
	if (tokens < config.warnTokens) return { state: { level: "none", suggested: false }, notify: false };
	if (tokens < config.suggestTokens) return { state: { level: "warn", suggested: state.suggested }, notify: false };
	return { state: { level: "suggest", suggested: true }, notify: !state.suggested };
}

export interface PauseFacts {
	resumePath?: string;
	topic?: string;
}

export function parseFacts(markdown: string): PauseFacts {
	const resume = markdown.match(/^- RESUME\.md: (\/\S+)\s*$/m)?.[1];
	const topic = markdown.match(/^- Topic: (.+?)\s*$/m)?.[1];
	return { resumePath: resume, topic };
}

export function resumeFromReply(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const matches = [...text.matchAll(/^\s*`?RESUME:\s*`?(none\b|[^`\s]+)`?.*$/gm)];
	return matches.at(-1)?.[1];
}

export function topicFromResume(text: string): string | undefined {
	return text.match(/^#\s*Resume:\s*(.+?)\s*$/m)?.[1];
}

export function pauseMessage(facts: string, resumePath: string | undefined): string {
	return [
		"Pause for /fresh: write the pause note so a fresh session can pick the work up.",
		"",
		`Finish the current atomic step or back out of it, and start nothing new. Then follow the Pause section of the recall skill (${RECALL_SKILL}): tell running workers to checkpoint, make the wip commit, write RESUME.md, append the ledger row.`,
		"The facts below come from pi-pause-facts. Copy them verbatim into RESUME.md; fill in only the goal, done and verified (each with its evidence), not yet verified, next step, key files and gotchas. If you make the wip commit, run `pi-pause-facts` again after it and copy that output instead.",
		"",
		resumePath
			? `Write RESUME.md at ${resumePath}.`
			: "No mission folder was found: write RESUME.md in the plans topic folder you choose (absolute path).",
		"End your reply with exactly one line `RESUME: <absolute path to RESUME.md>`, or `RESUME: none` and the reason if you could not write it.",
		"",
		facts.trim(),
	].join("\n");
}

export function seedMessage(topic: string, resumePath: string, previousSession: string | undefined): string {
	const lines = [`/skill:recall resume ${topic}`, "", `RESUME.md: ${resumePath}`];
	if (previousSession) lines.push(`Previous session: ${previousSession}`);
	return lines.join("\n");
}

interface AssistantLike {
	role?: string;
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
}

function messageText(message: AssistantLike): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: string; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

export interface RunOutcome {
	aborted: boolean;
	assistants: AssistantLike[];
}

export type PauseVerdict = { ok: true; resumePath: string } | { ok: false; why: string };

export function judgePause(outcome: RunOutcome, startedAt: number): PauseVerdict {
	if (outcome.aborted) return { ok: false, why: "the pause turn was aborted" };
	const final = outcome.assistants.at(-1);
	if (!final) return { ok: false, why: "the pause turn produced no assistant reply" };
	if (final.stopReason === "error" || final.stopReason === "aborted") {
		const detail = final.errorMessage ? `: ${final.errorMessage}` : "";
		return { ok: false, why: `the pause turn ended with stopReason ${final.stopReason}${detail}` };
	}
	const named = resumeFromReply(outcome.assistants.map(messageText).join("\n"));
	if (!named) return { ok: false, why: "the agent named no RESUME.md path (expected a `RESUME: <path>` line)" };
	if (named === "none") return { ok: false, why: "the agent answered `RESUME: none` (it could not write the pause note)" };
	if (!isAbsolute(named)) return { ok: false, why: `RESUME.md path is not absolute: ${named}` };
	if (!existsSync(named)) return { ok: false, why: `RESUME.md not found at ${named}` };
	const stat = statSync(named);
	if (stat.mtimeMs < startedAt) {
		return { ok: false, why: `RESUME.md at ${named} was not written after /fresh started` };
	}
	return { ok: true, resumePath: named };
}

interface RunWaiter {
	started: Promise<void>;
	settled: Promise<RunOutcome>;
	markStarted(): void;
	markEnded(messages: unknown): void;
	markSettled(aborted: boolean): void;
}

function runWaiter(): RunWaiter {
	let markStarted = () => {};
	let resolveSettled = (_outcome: RunOutcome) => {};
	let assistants: AssistantLike[] = [];
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	const settled = new Promise<RunOutcome>((resolve) => {
		resolveSettled = resolve;
	});
	return {
		started,
		settled,
		markStarted,
		markEnded(messages) {
			if (!Array.isArray(messages)) return;
			const found = (messages as AssistantLike[]).filter((m) => m?.role === "assistant");
			if (found.length) assistants = found;
		},
		markSettled(aborted) {
			resolveSettled({ aborted, assistants });
		},
	};
}

const nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function settleFully(ctx: ExtensionCommandContext): Promise<void> {
	for (let i = 0; i < 50; i++) {
		await ctx.waitForIdle();
		await nextTick();
		if (ctx.isIdle() && !ctx.hasPendingMessages()) return;
	}
}

async function startedWithin(started: Promise<void>, ms: number): Promise<boolean> {
	let timer: NodeJS.Timeout | undefined;
	const expired = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), ms);
	});
	try {
		return await Promise.race([started.then(() => true as const), expired]);
	} finally {
		clearTimeout(timer);
	}
}

export default function contextWatcher(pi: ExtensionAPI) {
	let config: WatcherConfig = { ...DEFAULT_CONFIG };
	let state: WatchState = { level: "none", suggested: false };
	let waiter: RunWaiter | undefined;
	let freshRunning = false;
	let oldSessionShutDown = false;

	const clear = (ctx: ExtensionContext) => {
		state = { level: "none", suggested: false };
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	};

	pi.on("session_start", (_event, ctx) => {
		config = readConfig(loadSettings(pi));
		clear(ctx);
	});

	pi.on("turn_end", (_event, ctx) => {
		if (!config.enabled || !shouldWatch(ctx.mode, process.env)) return;
		const tokens = ctx.getContextUsage()?.tokens;
		if (typeof tokens !== "number") return;
		const result = step(state, tokens, config);
		state = result.state;
		ctx.ui.setStatus(STATUS_KEY, state.level === "none" ? undefined : statusText(tokens, ctx.model, state.level === "suggest"));
		if (result.notify) {
			ctx.ui.notify(
				`Context is ${formatTokens(tokens)} tokens (over ${formatTokens(config.suggestTokens)}). Run /fresh to write the pause note and continue in a fresh session.`,
				"warning",
			);
		}
	});

	pi.on("agent_start", () => {
		waiter?.markStarted();
	});

	pi.on("agent_end", (event) => {
		waiter?.markEnded((event as { messages?: unknown }).messages);
	});

	pi.on("agent_settled", (event) => {
		waiter?.markSettled(Boolean((event as { aborted?: boolean }).aborted));
	});

	pi.on("session_shutdown", () => {
		if (freshRunning) oldSessionShutDown = true;
	});

	pi.registerCommand("fresh", {
		description: "Write the pause note (recall) and continue in a fresh session seeded with 'resume <topic>'",
		handler: async (_args, ctx) => {
			const fail = (why: string) => ctx.ui.notify(`/fresh stopped, this session is unchanged: ${why}`, "error");
			if (ctx.mode !== "tui") return fail("it needs interactive mode");
			if (isWorkerEnv(process.env)) return fail("this is an orchestrator worker; use team_write_handoff");
			if (freshRunning) return fail("a /fresh is already running");
			freshRunning = true;
			oldSessionShutDown = false;
			let switching = false;
			let sessionFile: string | undefined;
			let resumePath = "";
			const recovery = () =>
				[
					sessionFile ? `Old session: ${sessionFile} (reopen it with \`pi --session ${sessionFile}\` or /resume).` : "",
					resumePath ? `Pause note: ${resumePath}.` : "",
				]
					.filter(Boolean)
					.join(" ");
			const report = (target: { ui: { notify(message: string, level?: "info" | "warning" | "error"): void } }, text: string) => {
				try {
					target.ui.notify(text, "error");
				} catch {
					process.stderr.write(`${text}\n`);
				}
			};
			try {
				if (!ctx.isIdle()) {
					ctx.ui.notify("/fresh waits for the current turn to finish.", "info");
					await settleFully(ctx);
				}
				sessionFile = ctx.sessionManager.getSessionFile();
				const sessionId = ctx.sessionManager.getSessionId();
				const tokens = ctx.getContextUsage()?.tokens;
				const args = ["--cwd", ctx.cwd, "--session-id", sessionId, "--pid", String(process.pid)];
				if (sessionFile) args.push("--session-file", sessionFile);
				if (typeof tokens === "number") args.push("--context-tokens", String(tokens));
				if (!existsSync(config.factsScript)) return fail(`facts script not found at ${config.factsScript}`);
				const facts = await pi.exec(config.factsScript, args, { timeout: 90_000, cwd: ctx.cwd });
				if (facts.code !== 0 || !facts.stdout.trim()) {
					return fail(`pi-pause-facts exited ${facts.code}: ${(facts.stderr || facts.stdout).trim().split("\n")[0] ?? ""}`);
				}
				const parsed = parseFacts(facts.stdout);
				const current = runWaiter();
				waiter = current;
				const startedAt = Date.now();
				pi.sendUserMessage(pauseMessage(facts.stdout, parsed.resumePath));
				if (!(await startedWithin(current.started, config.startTimeoutMs))) return fail("the pause turn did not start");
				const outcome = await current.settled;
				waiter = undefined;
				const verdict = judgePause(outcome, startedAt);
				if (!verdict.ok) return fail(verdict.why);
				await settleFully(ctx);
				resumePath = verdict.resumePath;
				const topic = topicFromResume(readFileSync(resumePath, "utf8")) ?? parsed.topic ?? "the paused work";
				const seed = seedMessage(topic, resumePath, sessionFile);

				ctx.ui.notify(`/fresh: switching to a new session. ${recovery()}`, "info");
				switching = true;
				const result = await ctx.newSession({
					parentSession: sessionFile,
					withSession: async (fresh) => {
						try {
							fresh.ui.notify(`Fresh session from ${resumePath}`, "info");
							await fresh.sendUserMessage(seed, { expandPromptTemplates: true });
						} catch (error) {
							const why = error instanceof Error ? error.message : String(error);
							report(
								fresh,
								`/fresh: the new session started but the resume message failed: ${why}. Resume by hand: /skill:recall resume ${topic} with RESUME.md ${resumePath}. ${recovery()}`,
							);
						}
					},
				});
				if (!result) {
					report(ctx, `/fresh: the new session failed to start. ${recovery()}`);
				} else if (result.cancelled) {
					fail("the new session was cancelled");
				}
			} catch (error) {
				const why = error instanceof Error ? error.message : String(error);
				if (!switching) {
					report(ctx, `/fresh stopped, this session is unchanged: ${why}`);
				} else if (oldSessionShutDown) {
					report(ctx, `/fresh: the old session was closed but the new one failed to start: ${why}. ${recovery()}`);
				} else {
					report(ctx, `/fresh: the session switch failed before the old session closed: ${why}. ${recovery()}`);
				}
			} finally {
				waiter = undefined;
				freshRunning = false;
			}
		},
	});
}
