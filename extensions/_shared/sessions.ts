/**
 * Locating, replaying and questioning saved pi sessions.
 *
 * Extracted from agent-orchestrator/resume.ts. Nothing here knows about teams
 * or agents: a session is addressed by its UUID, and everything else is derived
 * from the argv that produced it.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isPidAlive, readPidFile } from "./pane.ts";
import { sleepSync } from "./fsjson.ts";

/** inspect/attach reuse the file; fork branches it. */
export type ResumeMode = "inspect" | "attach" | "fork";

export const sessionRoots = (): string[] =>
	[process.env.PI_ORCH_SESSION_DIR, join(homedir(), ".pi", "agent", "sessions")].filter(
		(path): path is string => typeof path === "string" && path.length > 0,
	);

/**
 * The session UUID a pi process announced on the first line of its JSON log.
 * Interactive panes log human text, so this returns null for them — callers
 * must have another source (e.g. the process registering itself).
 */
export function readSessionIdFromLog(logFile: string): string | null {
	if (!existsSync(logFile)) return null;
	// The session line is first; read a bounded prefix rather than the whole log.
	const head = readFileSync(logFile, "utf8").slice(0, 4096).split("\n");
	for (const line of head) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line) as { type?: string; id?: string };
			if (event.type === "session" && typeof event.id === "string") return event.id;
		} catch {
			return null;
		}
		break; // Only the first non-empty line is ever the session header.
	}
	return null;
}

/** Locate `<root>/<cwd-slug>/<iso>_<uuid>.jsonl` for a session id. */
export function findSessionFile(sessionId: string): string | null {
	for (const root of sessionRoots()) {
		if (!existsSync(root)) continue;
		for (const dir of readdirSync(root)) {
			const full = join(root, dir);
			let entries: string[];
			try {
				entries = readdirSync(full);
			} catch {
				continue;
			}
			const hit = entries.find((name) => name.includes(sessionId) && name.endsWith(".jsonl"));
			if (hit) return join(full, hit);
		}
	}
	return null;
}

/** Every saved session file, newest first. */
export function listSessionFiles(limit = 200): string[] {
	const files: Array<{ path: string; mtime: number }> = [];
	for (const root of sessionRoots()) {
		if (!existsSync(root)) continue;
		for (const dir of readdirSync(root)) {
			let entries: string[];
			try {
				entries = readdirSync(join(root, dir));
			} catch {
				continue;
			}
			for (const name of entries) {
				if (!name.endsWith(".jsonl")) continue;
				const path = join(root, dir, name);
				try {
					files.push({ path, mtime: statSync(path).mtimeMs });
				} catch {
					// Deleted between readdir and stat.
				}
			}
		}
	}
	return files
		.sort((a, b) => b.mtime - a.mtime)
		.slice(0, limit)
		.map((file) => file.path);
}

/** The UUID in a session file's name, which is also its session id. */
export function sessionIdFromFile(path: string): string | null {
	const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(path);
	return match ? (match[1] as string) : null;
}

/**
 * Find a session by its display name (`--name` / `/name`).
 *
 * This is the fallback for processes that never wrote a JSON session header —
 * notably interactive panes, which log human text. agent-orchestrator launches
 * every agent with `--name "<team>:<agent>"`, so a visible teammate is still
 * findable. Bounded to the `limit` most recently touched sessions so a large
 * session store cannot turn this into a full-disk scan.
 */
export function findSessionByName(
	name: string,
	limit = 200,
): { sessionId: string; sessionFile: string } | null {
	const needle = `"name":${JSON.stringify(name)}`;
	for (const path of listSessionFiles(limit)) {
		let text: string;
		try {
			// Names live in `session_info` entries, which pi appends early.
			text = readFileSync(path, "utf8").slice(0, 65536);
		} catch {
			continue;
		}
		if (!text.includes(needle)) continue;
		const sessionId = sessionIdFromFile(path);
		if (sessionId) return { sessionId, sessionFile: path };
	}
	return null;
}

/**
 * Rebuild a launch command for a resumed or forked session.
 *
 * Derived from the original argv so the new process keeps the same model,
 * provider and slim context. Reopening a slim worker under the user's full
 * settings would give the same transcript to a materially different agent.
 */
export function buildSessionArgv(options: {
	originalArgv: string[];
	sessionId: string;
	mode: ResumeMode;
	/** One-shot question; implies print mode. */
	question?: string;
	/** Extra flags appended before the session selector, e.g. ["--name", "x"]. */
	extraArgs?: string[];
}): string[] {
	const original = options.originalArgv;
	const bin = original[0] ?? process.env.PI_ORCH_PI_BIN ?? "pi";
	const out: string[] = [bin];

	for (let i = 1; i < original.length; i++) {
		const arg = original[i] as string;
		// The assignment already lives in the saved session's system prompt.
		if (arg === "--append-system-prompt") {
			i++;
			continue;
		}
		// Replaced below by the mode/question we were asked for.
		if (arg === "--mode") {
			i++;
			continue;
		}
		if (arg === "-p") continue;
		// A resumed session keeps its own recorded name.
		if ((arg === "--name" || arg === "-n") && options.extraArgs?.includes("--name")) {
			i++;
			continue;
		}
		// Everything after `--` was the original kickoff prompt.
		if (arg === "--") break;
		out.push(arg);
	}

	for (const extra of options.extraArgs ?? []) out.push(extra);
	out.push(options.mode === "fork" ? "--fork" : "--session", options.sessionId);
	if (options.question !== undefined) out.push("-p", "--", options.question);
	return out;
}

/**
 * An agent writes `status: done` mid-turn and then keeps running for a few
 * seconds (final message, shutdown, flushing its session file). Refusing to
 * resume during that window is technically correct and practically useless,
 * so wait for the process to actually exit.
 */
export function waitForPidExit(pidFile: string, timeoutMs: number): boolean {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isPidAlive(readPidFile(pidFile))) return true;
		sleepSync(250);
	}
	return !isPidAlive(readPidFile(pidFile));
}

/** Run a one-shot question against a saved session and return its answer. */
export function askSession(options: {
	argv: string[];
	env: Record<string, string>;
	cwd: string;
	timeoutMs: number;
}): { ok: boolean; output: string } {
	const [bin, ...args] = options.argv;
	try {
		const stdout = execFileSync(bin as string, args, {
			cwd: options.cwd,
			// NOT spread from process.env: a caller with its own orchestrator
			// identity would otherwise hand it to the child, which would then
			// claim the caller's mailbox and status file.
			env: options.env,
			timeout: options.timeoutMs,
			encoding: "utf8",
			maxBuffer: 8 * 1024 * 1024,
		});
		// Strip terminal escape sequences pi emits even in print mode.
		return {
			ok: true,
			output: stdout.replace(/\x1b\][^\x07]*\x07|\x1b\[[0-9;?]*[A-Za-z]/g, "").trim(),
		};
	} catch (error) {
		const err = error as { stdout?: string; stderr?: string; message: string };
		return {
			ok: false,
			output: (err.stdout || err.stderr || err.message || "").toString().trim(),
		};
	}
}

/**
 * Strip every orchestrator identity variable from an env.
 *
 * A process that inherits `PI_ORCH_*` believes it is that teammate: it writes
 * that agent's status file, claims its mailbox, and — as a lead — can adopt and
 * then destroy a live team on exit. Any process that is NOT meant to be a
 * teammate must be scrubbed. `PI_ORCH_NO_ADOPT` is the opt-out flag itself and
 * `PI_ORCH_PI_BIN` is only a binary path, so both survive.
 */
export function stripOrchIdentity(env: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = { ...env, PI_ORCH_NO_ADOPT: "1" };
	for (const key of Object.keys(out)) {
		if (key.startsWith("PI_ORCH_") && key !== "PI_ORCH_NO_ADOPT" && key !== "PI_ORCH_PI_BIN") {
			delete out[key];
		}
	}
	return out;
}
