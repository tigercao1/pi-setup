/**
 * team_ask: one-shot questions into a finished agent's saved session.
 *
 * A resumed `pi -p` turn cannot "report back later": whatever the final text
 * says is all the caller ever gets. So the question is framed as final, the
 * reply is checked for non-answers (crash, timeout, empty, a promise instead
 * of an answer), a failure is re-asked once, and every ask is recorded so an
 * answer still owed stays visible.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readJson, writeAtomic } from "../_shared/fsjson.ts";
import { teamDir, withTeamLock } from "./state.ts";

export interface AskRun {
	stdout: string;
	stderr: string;
	code: number | null;
	signal: string | null;
	timedOut: boolean;
	timeoutMs: number;
	/** Set when the process could not be started at all. */
	spawnError?: string;
}

export type Verdict = { answered: true } | { answered: false; reason: string };

export const ONE_SHOT_HEADER = "[team_ask — one-shot reply]";

export function wrapQuestion(question: string): string {
	return [
		ONE_SHOT_HEADER,
		"This question was asked into your closed session. There is no later turn: you cannot report back, " +
			"nobody will see work done after this reply, and no message you send later will arrive.",
		"Do any work you need now, inside this turn, then put the complete answer in this reply.",
		"Never reply with a plan, a status update, or a promise to follow up.",
		"",
		"Question:",
		question,
	].join("\n");
}

export function strictReask(question: string, reason: string, previous: string): string {
	const quoted = previous.trim()
		? clipText(previous.trim(), 600)
				.split("\n")
				.map((line) => `> ${line}`)
				.join("\n")
		: "> (nothing)";
	return [
		`${ONE_SHOT_HEADER} SECOND AND LAST ATTEMPT`,
		`Your previous reply to this question was not an answer (${reason}). It said:`,
		quoted,
		"",
		"That reply is all the caller received. There is no later turn and no way to report back. " +
			"Do the work now, with tools if you need them, and finish this turn with the answer itself.",
		"Do not describe what you will do, and do not promise a follow-up. " +
			"If you truly cannot answer, reply with `CANNOT ANSWER: <why>`.",
		"",
		"Question:",
		question,
	].join("\n");
}

const clipText = (value: string, max: number): string =>
	value.length > max ? `${value.slice(0, max)}…` : value;

const PROMISES: RegExp[] = [
	/\b(?:i'll|i will|i'm going to|i am going to|i'm about to|let me)\s+(?:now\s+|then\s+)?(?:go\s+)?(?:and\s+)?(?:return|report|get back|follow up|circle back|come back|check back|send|share|post|update you|let you know|ping)\b[^.\n]*/i,
	/\b(?:i've|i have|i just)\s+(?:now\s+|just\s+)?(?:started|kicked off|begun|launched|spawned|initiated|queued|set off)\b[^.\n]*/i,
	/\bwill\s+(?:report|get|circle|come|check)\s+back\b[^.\n]*/i,
	/\b(?:stand by|standby|hang tight|bear with me|working on it)\b[^.\n]*/i,
];

const DEFERRAL_SHORT_LIMIT = 1500;

/** The promise phrase that makes a reply a deferral, or null. */
export function findDeferral(reply: string): string | null {
	const text = reply.replace(/[\u2018\u2019]/g, "'").trim();
	if (!text) return null;
	const paragraphs = text.split(/\n\s*\n/);
	const last = paragraphs[paragraphs.length - 1] ?? "";
	const scope = text.length <= DEFERRAL_SHORT_LIMIT ? text : last;
	for (const pattern of PROMISES) {
		const match = scope.match(pattern);
		if (match) return clipText(match[0].trim(), 80);
	}
	return null;
}

const tail = (value: string, max = 200): string => {
	const flat = value.trim().replace(/\s+/g, " ");
	return flat.length > max ? `…${flat.slice(-max)}` : flat;
};

export function classifyReply(run: AskRun): Verdict {
	if (run.spawnError) return { answered: false, reason: `could not start pi: ${run.spawnError}` };
	if (run.timedOut) return { answered: false, reason: `timed out after ${Math.round(run.timeoutMs / 1000)}s` };
	if (run.code === null && run.signal) return { answered: false, reason: `killed by ${run.signal}` };
	if (run.code !== 0) {
		const detail = tail(run.stderr) || tail(run.stdout);
		return { answered: false, reason: `pi exited with code ${run.code}${detail ? `: ${detail}` : ""}` };
	}
	if (!run.stdout.trim()) return { answered: false, reason: "empty reply" };
	const deferral = findDeferral(run.stdout);
	if (deferral) return { answered: false, reason: `deferred: "${deferral}"` };
	return { answered: true };
}

const ANSI = /\x1b\][^\x07]*\x07|\x1b\[[0-9;?]*[A-Za-z]/g;

/** Run one resumed one-shot turn without blocking the caller's event loop. */
export function runAsk(options: {
	argv: string[];
	env: Record<string, string>;
	cwd: string;
	timeoutMs: number;
}): Promise<AskRun> {
	const [bin, ...args] = options.argv;
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		const finish = (run: Omit<AskRun, "stdout" | "stderr" | "timedOut" | "timeoutMs">): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				stdout: stdout.replace(ANSI, "").trim(),
				stderr: stderr.replace(ANSI, "").trim(),
				timedOut,
				timeoutMs: options.timeoutMs,
				...run,
			});
		};
		const child = spawn(bin as string, args, {
			cwd: options.cwd,
			// NOT spread from process.env: see stripOrchIdentity.
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const cap = 8 * 1024 * 1024;
		child.stdout.on("data", (chunk: Buffer) => {
			if (stdout.length < cap) stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < cap) stderr += chunk.toString("utf8");
		});
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 2000).unref?.();
		}, options.timeoutMs);
		child.on("error", (error) => finish({ code: null, signal: null, spawnError: error.message }));
		child.on("close", (code, signal) => finish({ code, signal }));
	});
}

export interface AskOutcome {
	answered: boolean;
	/** Why the last attempt was not an answer (answered: false), or why a re-ask was needed. */
	reason?: string;
	attempts: number;
	reasons: string[];
	output: string;
}

/** Ask, check, and re-ask once on a non-answer. */
export async function askWithRetry(
	question: string,
	run: (prompt: string) => Promise<AskRun>,
): Promise<AskOutcome> {
	const reasons: string[] = [];
	let prompt = wrapQuestion(question);
	let last: AskRun | undefined;
	for (let attempt = 1; attempt <= 2; attempt++) {
		last = await run(prompt);
		const verdict = classifyReply(last);
		if (verdict.answered) {
			return { answered: true, reason: reasons[0], attempts: attempt, reasons, output: last.stdout };
		}
		reasons.push(verdict.reason);
		prompt = strictReask(question, verdict.reason, last.stdout);
	}
	return {
		answered: false,
		reason: reasons[reasons.length - 1],
		attempts: 2,
		reasons,
		output: last?.stdout ?? "",
	};
}

// ------------------------------------------------------------ the record

export interface AskRecord {
	id: string;
	by: string;
	agent: string;
	question: string;
	startedAt: string;
	finishedAt?: string;
	attempts?: number;
	answered?: boolean;
	reason?: string;
	resolvedAt?: string;
	dismissedAt?: string;
}

const MAX_RECORDS = 50;
/** Longer than two attempts at the 600s max: anything older was abandoned. */
const ABANDONED_MS = 2 * 600_000 + 60_000;

export const asksPath = (team: string): string => `${teamDir(team)}/asks.json`;

export function readAsks(team: string): AskRecord[] {
	if (!existsSync(asksPath(team))) return [];
	return readJson<AskRecord[]>(asksPath(team)) ?? [];
}

function updateAsks(team: string, fn: (asks: AskRecord[]) => void): void {
	if (!existsSync(teamDir(team))) return;
	withTeamLock(team, () => {
		const asks = readAsks(team);
		fn(asks);
		writeAtomic(asksPath(team), asks.slice(-MAX_RECORDS));
	});
}

const summarise = (question: string): string => clipText(question.trim().replace(/\s+/g, " "), 120);

export function startAsk(team: string, by: string, agent: string, question: string): string {
	const id = randomUUID();
	updateAsks(team, (asks) => {
		asks.push({ id, by, agent, question: summarise(question), startedAt: new Date().toISOString() });
	});
	return id;
}

export function finishAsk(team: string, id: string, outcome: AskOutcome): void {
	const now = new Date().toISOString();
	updateAsks(team, (asks) => {
		const record = asks.find((a) => a.id === id);
		if (!record) return;
		Object.assign(record, {
			finishedAt: now,
			attempts: outcome.attempts,
			answered: outcome.answered,
			reason: outcome.answered ? undefined : outcome.reason,
		});
		if (!outcome.answered) return;
		for (const earlier of asks) {
			if (earlier.agent === record.agent && earlier.id !== id && isOwed(earlier)) earlier.resolvedAt = now;
		}
	});
}

/** Dismiss every owed ask to `agent`; returns how many. */
export function dismissAsks(team: string, agent: string): number {
	let count = 0;
	const now = new Date().toISOString();
	updateAsks(team, (asks) => {
		for (const ask of asks) {
			if (ask.agent === agent && isOwed(ask)) {
				ask.dismissedAt = now;
				count++;
			}
		}
	});
	return count;
}

const isAbandoned = (ask: AskRecord, now: number): boolean =>
	!ask.finishedAt && now - Date.parse(ask.startedAt) > ABANDONED_MS;

/** Still owes the caller an answer: failed (or abandoned), not resolved, not dismissed. */
export function isOwed(ask: AskRecord, now = Date.now()): boolean {
	if (ask.resolvedAt || ask.dismissedAt) return false;
	if (ask.finishedAt) return ask.answered === false;
	return isAbandoned(ask, now);
}

/** Owed asks plus in-flight ones, optionally only those made by `by`. */
export function visibleAsks(team: string, by?: string): AskRecord[] {
	const now = Date.now();
	return readAsks(team).filter(
		(ask) => (by === undefined || ask.by === by) && (isOwed(ask, now) || (!ask.finishedAt && !isAbandoned(ask, now))),
	);
}

export function askLine(ask: AskRecord, now = Date.now()): string {
	if (!ask.finishedAt && !isAbandoned(ask, now)) return `… ask → ${ask.agent}: waiting for answer`;
	const reason = ask.finishedAt ? (ask.reason ?? "no answer") : "abandoned (caller exited mid-ask)";
	return `⚠ ask → ${ask.agent}: no answer (${reason})`;
}
