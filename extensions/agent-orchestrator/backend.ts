/**
 * Team-flavoured wrapper over the shared pane backend.
 *
 * The mechanics (tmux/iTerm2/headless, pid files, 0600 env files, capture,
 * focus, kill) live in `_shared/pane.ts` so the fork-session extension uses the
 * same implementation. What stays here is the team vocabulary: agents are
 * addressed by `(team, agent)`, their pid files and logs live under the team
 * directory, and a missing pane falls back to the agent's log file.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	capturePaneText,
	detectBackend,
	focusPane,
	isPidAlive,
	killPane,
	ownPaneId,
	quoteArgv,
	readPidFile,
	shq,
	spawnPane,
	tmuxSession,
} from "../_shared/pane.ts";
import type { Backend } from "./state.ts";
import { logPath, teamDir } from "./state.ts";

export { detectBackend, focusPane, ownPaneId, quoteArgv, shq, tmuxSession };

export interface SpawnRequest {
	team: string;
	agent: string;
	cwd: string;
	/** argv for the agent process, e.g. ["pi", "--model", ...]. */
	argv: string[];
	env: Record<string, string>;
	/** Visible pane vs. background/hidden window. */
	visible: boolean;
	/** Seconds to sleep before exec — staggers large batches. */
	delaySeconds?: number;
}

export interface SpawnResult {
	backend: Backend;
	paneId: string | null;
	pidFile: string;
}

export const pidFilePath = (team: string, agent: string): string =>
	join(teamDir(team), "logs", `${agent}.pid`);

export function spawnAgent(request: SpawnRequest): SpawnResult {
	const pidFile = pidFilePath(request.team, request.agent);
	mkdirSync(join(pidFile, ".."), { recursive: true });
	const log = logPath(request.team, request.agent);
	// Truncate: a recycled agent reusing this name must not inherit the previous
	// run's session header (which would make team_ask resume the dead process's
	// session) or its `agent_end` (which would make the new run look finished).
	writeFileSync(log, "");

	const result = spawnPane({
		pidFile,
		cwd: request.cwd,
		argv: request.argv,
		env: request.env,
		visible: request.visible,
		where: "split-v",
		logFile: log,
		delaySeconds: request.delaySeconds,
		title: request.agent,
	});
	return { backend: result.backend as Backend, paneId: result.paneId, pidFile: result.pidFile };
}

export const readPid = (team: string, agent: string): number | null =>
	readPidFile(pidFilePath(team, agent));

/**
 * Process start time (epoch ms) via `ps`, cached briefly.
 *
 * Pids are recycled. A team from two weeks ago can name a pid that now belongs
 * to an unrelated process — which made abandoned teams look permanently alive
 * and made `killAgent` a loaded gun aimed at whatever inherited the number.
 */
const startTimeCache = new Map<number, { at: number; started: number | null }>();

export function processStartedAt(pid: number): number | null {
	const cached = startTimeCache.get(pid);
	if (cached && Date.now() - cached.at < 2000) return cached.started;
	let started: number | null = null;
	try {
		const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		const parsed = out ? Date.parse(out) : Number.NaN;
		started = Number.isFinite(parsed) ? parsed : null;
	} catch {
		started = null;
	}
	startTimeCache.set(pid, { at: Date.now(), started });
	return started;
}

/**
 * Is `pid` still the process we recorded at `recordedAtMs`? A process that
 * started after we wrote the record cannot be the one we recorded.
 */
export function isSameProcess(pid: number, recordedAtMs: number, slackMs = 60_000): boolean {
	const started = processStartedAt(pid);
	if (started === null) return false;
	return started <= recordedAtMs + slackMs;
}

export function isAlive(team: string, agent: string): boolean {
	const pid = readPid(team, agent);
	if (!isPidAlive(pid)) return false;
	let recordedAt: number;
	try {
		recordedAt = statSync(pidFilePath(team, agent)).mtimeMs;
	} catch {
		return true; // nothing to compare against; trust the signal check
	}
	return isSameProcess(pid as number, recordedAt);
}

/** SIGTERM the agent process, then close its pane if the backend has one. */
export const killAgent = (team: string, agent: string, paneId: string | null): void => {
	// Verify identity first: killing a recycled pid would terminate an
	// unrelated process. The pane is still closed either way.
	if (!isAlive(team, agent)) {
		// Process is gone (or its pid was recycled): close the pane only.
		// An empty pidFile path makes killPane skip the signal step.
		killPane("", paneId);
		return;
	}
	killPane(pidFilePath(team, agent), paneId);
};

/** Last `lines` lines of an agent's output, for diagnostics. */
export function capturePane(
	team: string,
	agent: string,
	paneId: string | null,
	lines: number,
): string {
	const live = capturePaneText(paneId, lines);
	if (live !== null) return live;
	const log = logPath(team, agent);
	if (!existsSync(log)) return "(no output captured)";
	return readFileSync(log, "utf8").split("\n").slice(-lines).join("\n");
}
