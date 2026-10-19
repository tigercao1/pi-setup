/**
 * Opening a spawned agent's session as a first-class pi session.
 *
 * Every agent already persists one: `buildArgv` never passes `--no-session`,
 * and the session's UUID is the first line of the agent's own JSON log
 * (`{"type":"session","id":"…"}`). So resuming needs no new storage — only
 * bookkeeping (which session belongs to which agent), faithful flag replay,
 * and a decision about identity.
 *
 * Session mechanics (finding files, replaying argv, one-shot asks) live in
 * `_shared/sessions.ts`; this file is the team-aware half.
 *
 * Identity is the subtle part. `PI_ORCH_*` env vars are what make a process a
 * teammate, so:
 *
 *   inspect - no identity vars: a detached observer. Cannot report to the team.
 *   attach  - original identity restored: it IS that teammate again, writing
 *             the same status file and owning the same mailbox.
 *   fork    - a fresh identity on a copy of the transcript.
 *
 * Every resumed process gets `PI_ORCH_NO_ADOPT=1`. Without it an interactive
 * resume could adopt an abandoned team and then destroy it on exit, which is
 * exactly the failure that killed a working agent once already.
 */

import { existsSync } from "node:fs";
import {
	buildSessionArgv,
	findSessionByName,
	findSessionFile,
	readSessionIdFromLog,
	type ResumeMode,
	stripOrchIdentity,
	waitForPidExit,
} from "../_shared/sessions.ts";
import { isAlive, pidFilePath } from "./backend.ts";
import { publishAgent } from "./fork-link.ts";
import { logPath, patchAgent, readTeam, teamDir } from "./state.ts";

export { askSession, findSessionFile } from "../_shared/sessions.ts";
export type { ResumeMode } from "../_shared/sessions.ts";

/** The session UUID an agent's process announced on its first log line. */
export const readSessionId = (team: string, agent: string): string | null =>
	readSessionIdFromLog(logPath(team, agent));

/**
 * Record the session on the agent once its process has announced it.
 *
 * Best effort by design: a missing session id degrades to "not resumable yet",
 * never to an error.
 */
export function scheduleSessionCapture(
	team: string,
	agent: string,
	argv: string[],
	options: { leadSessionId?: string } = {},
): void {
	let attempts = 0;
	const tick = (): void => {
		if (!existsSync(teamDir(team))) return; // team cleaned up mid-flight
		attempts++;
		const sessionId = readSessionId(team, agent);
		if (sessionId) {
			const sessionFile = findSessionFile(sessionId) ?? undefined;
			patchAgent(team, agent, { sessionId, sessionFile, argv });
			// Make the agent visible to `/forks` as a child of this session.
			const record = readTeam(team)?.agents.find((a) => a.name === agent);
			if (record) {
				void publishAgent({
					team,
					agent: record,
					sessionId,
					sessionFile,
					argv,
					leadSessionId: options.leadSessionId,
				});
			}
			return;
		}
		if (attempts < 8) {
			const timer = setTimeout(tick, 2000);
			timer.unref?.();
		} else {
			patchAgent(team, agent, { argv });
		}
	};
	const timer = setTimeout(tick, 1500);
	timer.unref?.();
}

/** Rebuild a launch command for a resumed session. */
export function buildResumeArgv(options: {
	originalArgv: string[];
	sessionId: string;
	mode: ResumeMode;
	/** One-shot question; implies print mode. */
	question?: string;
}): string[] {
	return buildSessionArgv(options);
}

export interface ResumeCheck {
	ok: boolean;
	reason?: string;
	sessionId?: string;
	sessionFile?: string;
}

/**
 * An agent writes `status: done` mid-turn and then keeps running for a few
 * seconds. Refusing to resume during that window is technically correct and
 * practically useless, so wait for the process to actually exit.
 */
export function resumeGraceMs(requested: number): number {
	const override = Number.parseInt(process.env.PI_ORCH_RESUME_GRACE_MS ?? "", 10);
	return Number.isFinite(override) ? override : requested;
}

export const waitForExit = (team: string, agent: string, timeoutMs: number): boolean =>
	waitForPidExit(pidFilePath(team, agent), timeoutMs);

/** Shared guards for every resume path. */
export function checkResumable(
	team: string,
	agent: { name: string; sessionId?: string; sessionFile?: string; visible: boolean },
	mode: ResumeMode,
	options: { graceMs?: number } = {},
): ResumeCheck {
	let sessionId = agent.sessionId ?? readSessionId(team, agent.name) ?? undefined;
	let foundFile: string | undefined;
	if (!sessionId) {
		// Visible/interactive agents log human text, so there is no JSON session
		// header to read. They are still launched with `--name "<team>:<agent>"`,
		// so look the session up by that name before giving up — otherwise every
		// sub-orchestrator (always visible) would be permanently unresumable.
		const byName = findSessionByName(`${team}:${agent.name}`);
		if (byName) {
			sessionId = byName.sessionId;
			foundFile = byName.sessionFile;
			patchAgent(team, agent.name, { sessionId, sessionFile: foundFile });
		}
	}
	if (!sessionId) {
		return {
			ok: false,
			reason:
				`No session id recorded for '${agent.name}' and no saved session named ` +
				`'${team}:${agent.name}'. Check ${logPath(team, agent.name)}, or resume manually ` +
				"with `pi -r`.",
		};
	}
	// Two processes writing one session file corrupts it.
	if (mode !== "fork" && isAlive(team, agent.name)) {
		const exited = waitForExit(team, agent.name, resumeGraceMs(options.graceMs ?? 0));
		if (!exited) {
			return {
				ok: false,
				reason:
					`'${agent.name}' is still running. Wait for it to finish, or use mode "fork" to branch ` +
					`from its transcript without touching the live session.`,
				sessionId,
			};
		}
	}

	// The session file appears on disk later than the session id does, so
	// resolve it lazily and backfill the record once it exists.
	let sessionFile = foundFile ?? agent.sessionFile;
	if (!sessionFile || !existsSync(sessionFile)) {
		sessionFile = findSessionFile(sessionId) ?? undefined;
		if (sessionFile) patchAgent(team, agent.name, { sessionFile });
	}
	return { ok: true, sessionId, sessionFile };
}

/** Env for a resumed process. Identity is what decides inspect vs attach. */
export function resumeEnv(
	base: Record<string, string>,
	mode: ResumeMode,
	identity: Record<string, string>,
): Record<string, string> {
	if (mode === "attach") return { ...base, PI_ORCH_NO_ADOPT: "1", ...identity };
	// inspect/fork: strip teammate identity so the process cannot act as this
	// agent. NO_ADOPT must survive that strip — without it an interactive
	// inspect session can adopt an abandoned team and destroy it on exit.
	return { ...stripOrchIdentity(base), PI_ORCH_NO_ADOPT: "1" };
}
