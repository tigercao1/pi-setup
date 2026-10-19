/**
 * Terminal panes as a process backend.
 *
 * Extracted from agent-orchestrator/backend.ts so that anything wanting to put
 * a pi process on screen — spawned teammates, forked sessions — shares one
 * implementation, one set of quirks, and one security posture.
 *
 * Three strategies, picked automatically:
 *
 *   tmux     - split-window / new-window -d. Best UX.
 *   iterm2   - AppleScript splits, tabs or windows on macOS iTerm2. Visible only.
 *   headless - detached child process, output tee'd to a log file.
 *              Always available; the fallback when there is no multiplexer.
 *
 * Liveness and kills go through a pid file rather than the pane handle: the
 * spawned shell writes its own pid before exec'ing, so a single code path works
 * for every backend even when a pane outlives its process (or vice versa).
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Backend = "tmux" | "iterm2" | "headless";

/** Where a visible process should land. Ignored by the headless backend. */
export type Where = "split-v" | "split-h" | "tab" | "window";

export interface PaneRequest {
	/** Absolute path of the pid file this process must write. */
	pidFile: string;
	cwd: string;
	/** argv for the process, e.g. ["pi", "--session", "…"]. */
	argv: string[];
	env: Record<string, string>;
	/** Visible pane vs. background/hidden window. */
	visible: boolean;
	/** Layout for visible processes. Default: "split-v". */
	where?: Where;
	/** Append stdout/stderr here. Required for headless, optional otherwise. */
	logFile?: string;
	/** Seconds to sleep before exec — staggers large batches. */
	delaySeconds?: number;
	/** Window/tab title, when the backend can set one. */
	title?: string;
}

export interface PaneResult {
	backend: Backend;
	paneId: string | null;
	pidFile: string;
}

// ------------------------------------------------------------ detection

function hasBinary(name: string): boolean {
	try {
		execFileSync("command", ["-v", name], { shell: "/bin/sh", stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

let cachedBackend: Backend | null = null;

export function detectBackend(): Backend {
	if (cachedBackend) return cachedBackend;
	if (process.env.PI_ORCH_BACKEND) {
		cachedBackend = process.env.PI_ORCH_BACKEND as Backend;
		return cachedBackend;
	}
	if (process.env.TMUX && hasBinary("tmux")) cachedBackend = "tmux";
	else if (process.platform === "darwin" && process.env.TERM_PROGRAM === "iTerm.app")
		cachedBackend = "iterm2";
	else cachedBackend = "headless";
	return cachedBackend;
}

/** For tests and callers that change PI_ORCH_BACKEND at runtime. */
export function resetBackendCache(): void {
	cachedBackend = null;
}

export function tmuxSession(): string | undefined {
	if (!process.env.TMUX) return undefined;
	try {
		return execFileSync("tmux", ["display-message", "-p", "#{session_name}"], {
			encoding: "utf8",
		}).trim();
	} catch {
		return undefined;
	}
}

/**
 * The pane id of the *current* process, so a child can focus its parent again.
 *
 * iTerm2 exports `w0t0p0:<UUID>` but AppleScript's `id of session` is the UUID
 * alone, so normalise to the UUID — otherwise focusPane silently never matches.
 */
export function ownPaneId(): string | null {
	const backend = detectBackend();
	if (backend === "tmux") return process.env.TMUX_PANE ?? null;
	if (backend === "iterm2") {
		const raw = process.env.ITERM_SESSION_ID;
		if (!raw) return null;
		const uuid = raw.includes(":") ? (raw.split(":").pop() as string) : raw;
		return uuid || null;
	}
	return null;
}

// -------------------------------------------------------------- helpers

/** POSIX single-quote quoting. */
export function shq(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function appleQuote(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** A copy-pasteable rendering of an argv, for the headless fallback path. */
export function quoteArgv(argv: string[]): string {
	return argv.map((part) => (/[\s"'$`\\]/.test(part) ? JSON.stringify(part) : part)).join(" ");
}

/**
 * Build the shell one-liner a pane runs.
 *
 * The pid file is written by the shell itself (`$$`) and then `exec` replaces
 * that shell with the target, so the recorded pid is the real process.
 */
function shellCommand(request: PaneRequest, log?: string): string {
	// Env goes through a 0600 file that the child deletes after sourcing, so API
	// keys never appear in the pane's command line or in `ps` output.
	const envFile = `${request.pidFile.replace(/\.pid$/, "")}.env`;
	mkdirSync(join(envFile, ".."), { recursive: true });
	const body = Object.entries(request.env)
		.map(([key, value]) => `${key}=${shq(value)}`)
		.join("\n");
	writeFileSync(envFile, `${body}\n`, { mode: 0o600 });

	const argv = request.argv.map(shq).join(" ");
	// Write the pid BEFORE the stagger sleep. The shell keeps this pid through
	// `exec`, so recording it early makes the process observably alive for its
	// whole startup. Sleeping first made staggered siblings look dead to the
	// liveness check, which then reported a bogus crash.
	const parts = [`cd ${shq(request.cwd)}`, `echo $$ > ${shq(request.pidFile)}`];
	if (request.delaySeconds && request.delaySeconds > 0) {
		parts.push(`sleep ${Math.round(request.delaySeconds)}`);
	}
	parts.push(`set -a`, `. ${shq(envFile)}`, `set +a`, `rm -f ${shq(envFile)}`);
	const exec = `exec ${argv}`;
	parts.push(log ? `${exec} >> ${shq(log)} 2>&1` : exec);
	return parts.join(" && ");
}

// ---------------------------------------------------------------- spawn

/** Exported so tests can compile the generated AppleScript without running it. */
export function itermScript(command: string, where: Where, title?: string): string {
	const open =
		where === "tab"
			? [
					"  tell current window",
					"    set newSession to (create tab with default profile)'s current session",
					"  end tell",
				]
			: where === "window"
				? ["  set newSession to (create window with default profile)'s current session"]
				: [
						"  tell current session of current tab of current window",
						where === "split-h"
							? "    set newSession to (split horizontally with default profile)"
							: "    set newSession to (split vertically with default profile)",
						"  end tell",
					];
	return [
		'tell application "iTerm2"',
		...open,
		title ? `  tell newSession to set name to ${appleQuote(title)}` : "",
		`  tell newSession to write text ${appleQuote(command)}`,
		"  return id of newSession",
		"end tell",
	]
		.filter(Boolean)
		.join("\n");
}

export function spawnPane(request: PaneRequest): PaneResult {
	const backend = detectBackend();
	const where = request.where ?? "split-v";
	mkdirSync(join(request.pidFile, ".."), { recursive: true });

	if (backend === "tmux") {
		const command = shellCommand(request, request.visible ? undefined : request.logFile);
		const args = request.visible
			? where === "tab" || where === "window"
				? ["new-window", "-c", request.cwd, "-P", "-F", "#{pane_id}"]
				: [
						"split-window",
						"-d",
						where === "split-h" ? "-v" : "-h",
						"-c",
						request.cwd,
						"-P",
						"-F",
						"#{pane_id}",
					]
			: ["new-window", "-d", "-c", request.cwd, "-P", "-F", "#{pane_id}"];
		// `-n` is a new-window option; split-window rejects it.
		if (request.title && args[0] === "new-window") args.push("-n", request.title);
		const paneId = execFileSync("tmux", [...args, "/bin/sh", "-c", command], {
			encoding: "utf8",
		}).trim();
		return { backend, paneId, pidFile: request.pidFile };
	}

	if (backend === "iterm2" && request.visible) {
		const command = shellCommand(request, undefined);
		const paneId = execFileSync(
			"osascript",
			["-e", itermScript(command, where, request.title)],
			{ encoding: "utf8" },
		).trim();
		return { backend, paneId, pidFile: request.pidFile };
	}

	// Headless: detached child, stdio to the log file.
	const log = request.logFile;
	const fd = log ? openSync(log, "a") : "ignore";
	const command = shellCommand(request, undefined);
	const child: ChildProcess = spawn("/bin/sh", ["-c", command], {
		cwd: request.cwd,
		detached: true,
		stdio: ["ignore", fd as never, fd as never],
		env: { ...process.env, ...request.env },
	});
	child.unref();
	if (child.pid) writeFileSync(request.pidFile, `${child.pid}\n`);
	return {
		backend: "headless",
		paneId: child.pid ? `pid:${child.pid}` : null,
		pidFile: request.pidFile,
	};
}

// ------------------------------------------------------- liveness / kill

export function readPidFile(pidFile: string): number | null {
	if (!existsSync(pidFile)) return null;
	const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
	return Number.isFinite(pid) ? pid : null;
}

export function isPidAlive(pid: number | null): boolean {
	if (pid === null) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export const isPaneAlive = (pidFile: string): boolean => isPidAlive(readPidFile(pidFile));

/** SIGTERM the process, then close its pane if the backend has one. */
export function killPane(pidFile: string, paneId: string | null): void {
	const pid = readPidFile(pidFile);
	if (pid !== null) {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// Already gone.
		}
	}
	if (!paneId) return;
	const backend = detectBackend();
	try {
		if (backend === "tmux") {
			execFileSync("tmux", ["kill-pane", "-t", paneId], { stdio: "ignore" });
		} else if (backend === "iterm2" && !paneId.startsWith("pid:")) {
			execFileSync("osascript", ["-e", itermForEach(paneId, ["        close s"])], {
				stdio: "ignore",
			});
		}
	} catch {
		// Pane already closed.
	}
}

/**
 * `repeat` boilerplate for "do X to the iTerm2 session with this id".
 * Exported for the same reason as itermScript: AppleScript fails at runtime,
 * so the tests compile it instead.
 */
export function itermForEach(paneId: string, body: string[]): string {
	return [
		'tell application "iTerm2"',
		"  repeat with w in windows",
		"    repeat with t in tabs of w",
		"      repeat with s in sessions of t",
		`        if id of s is ${appleQuote(paneId)} then`,
		...body,
		"        end if",
		"      end repeat",
		"    end repeat",
		"  end repeat",
		"end tell",
	].join("\n");
}

// -------------------------------------------------------------- capture

/**
 * Live screen contents of a pane, or null when the backend cannot read it.
 * Callers fall back to their own log files.
 */
export function capturePaneText(paneId: string | null, lines: number): string | null {
	if (!paneId || paneId.startsWith("pid:")) return null;
	const backend = detectBackend();
	if (backend === "tmux") {
		try {
			return execFileSync("tmux", ["capture-pane", "-p", "-t", paneId, "-S", `-${lines}`], {
				encoding: "utf8",
			});
		} catch {
			return null;
		}
	}
	if (backend === "iterm2") {
		try {
			const text = execFileSync(
				"osascript",
				["-e", itermForEach(paneId, ["          return text of s"])],
				{ encoding: "utf8" },
			);
			// `text of session` returns the whole screen, bottom-padded with blank
			// lines; drop the padding before taking the tail.
			const rows = text.split("\n").map((row) => row.replace(/\s+$/, ""));
			while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
			return rows.slice(-lines).join("\n");
		} catch {
			return null;
		}
	}
	return null;
}

/** Bring a pane into view. Best effort; tmux and iTerm2 only. */
export function focusPane(paneId: string | null): boolean {
	if (!paneId || paneId.startsWith("pid:")) return false;
	const backend = detectBackend();
	try {
		if (backend === "tmux") {
			execFileSync("tmux", ["select-window", "-t", paneId], { stdio: "ignore" });
			execFileSync("tmux", ["select-pane", "-t", paneId], { stdio: "ignore" });
			return true;
		}
		if (backend === "iterm2") {
			execFileSync(
				"osascript",
				[
					"-e",
					itermForEach(paneId, ["          select w", "          select t", "          select s"]),
				],
				{ stdio: "ignore" },
			);
			return true;
		}
	} catch {
		return false;
	}
	return false;
}
