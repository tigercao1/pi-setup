/**
 * Per-process identity and lazily-created team state.
 *
 * A spawned agent learns who it is from `PI_ORCH_*` env vars. A process with no
 * such vars is the lead. The lead does not create a team directory until it
 * actually spawns something, so a normal pi session leaves no trace.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { detectBackend, isAlive, tmuxSession } from "./backend.ts";
import { EXT_DIR } from "./config.ts";
import {
	createTeam,
	listTeams,
	newTeamName,
	readTeam,
	writeTeam,
	type Role,
	type TeamConfig,
	writeStatus,
} from "./state.ts";

export interface Runtime {
	readonly role: Role;
	readonly me: string;
	readonly parent: string | null;
	readonly canSpawn: boolean;
	readonly isLead: boolean;
	/** True once a session_start reported an interactive UI for this process. */
	hasUI: boolean;
	/** Team name, or null when the lead has not spawned anything yet. */
	team: string | null;
	/** Working directory; set from the session's cwd on every session_start. */
	cwd: string;
	/**
	 * Bind to a session's cwd. Called on every session_start (including
	 * reload/new/resume), which is also when a lead may re-adopt a live team.
	 */
	attach(cwd: string, options?: { hasUI?: boolean }): void;
	/**
	 * True only when this process created the team, or deliberately adopted an
	 * abandoned one. Ownership gates destructive cleanup: a process that merely
	 * stumbled onto someone else's team must never kill it.
	 */
	owns: boolean;
	/** Create-or-reuse the team directory. Lead only. */
	ensureTeam(): string;
	config(): TeamConfig | null;
	/** This agent's own model, inherited by children unless overridden. */
	ownModel?: { model: string; provider: string };
	/**
	 * This process's pi session id, when it has one. Used to hang spawned
	 * agents off the right node in the session-fork registry's tree.
	 */
	ownSessionId?: string;
	pi: ExtensionAPI;
	/** Cleanup callbacks registered by the mailbox watcher, widget, etc. */
	disposers: Array<() => void>;
	extDir: string;
}

/**
 * Built once per process, in the extension factory.
 *
 * Identity comes from env vars, which are available before any session
 * exists. That lets tools register exactly once, instead of re-registering on
 * every session_start (`/new`, `/resume`, `/fork` all fire it) and racking up
 * `team_spawn:1`, `team_spawn:2` duplicates.
 */
export function createRuntime(pi: ExtensionAPI): Runtime {
	const envTeam = process.env.PI_ORCH_TEAM_NAME ?? null;
	const me = process.env.PI_ORCH_AGENT_NAME ?? "team_lead";
	const role = (process.env.PI_ORCH_AGENT_ROLE as Role | undefined) ?? "lead";
	const parent = process.env.PI_ORCH_PARENT_NAME ?? null;
	const canSpawn = role === "lead" || process.env.PI_ORCH_CAN_SPAWN === "true";

	const runtime: Runtime = {
		role,
		me,
		parent,
		canSpawn,
		isLead: role === "lead",
		hasUI: false,
		team: envTeam,
		cwd: process.cwd(),
		owns: false,
		attach(cwd: string, options?: { hasUI?: boolean }): void {
			runtime.cwd = cwd;
			runtime.hasUI = options?.hasUI === true;
			if (!runtime.isLead) return;
			if (runtime.team && readTeam(runtime.team)) return;
			// Resumed sessions opt out entirely: an observer must never take over.
			if (process.env.PI_ORCH_NO_ADOPT === "1") return;
			// Adoption is deliberately hard to trigger. A one-shot `pi -p` in the
			// same directory once adopted a running team and cascade-killed it on
			// exit, so require an interactive session AND a dead previous lead.
			if (options?.hasUI !== true) return;
			const adopted = findReattachableTeam(cwd);
			if (!adopted) return;
			runtime.team = adopted;
			runtime.owns = true;
			const config = readTeam(adopted);
			if (config) {
				config.leadPid = process.pid;
				writeTeam(config);
			}
		},
		ensureTeam(): string {
			if (runtime.team && readTeam(runtime.team)) return runtime.team;
			const team = newTeamName();
			createTeam({
				team,
				leadName: me,
				cwd: runtime.cwd,
				backend: detectBackend(),
				tmuxSession: tmuxSession(),
				leadPid: process.pid,
			});
			writeStatus(team, { agent: me, state: "active", note: "lead session" });
			runtime.team = team;
			runtime.owns = true;
			return team;
		},
		config: () => (runtime.team ? readTeam(runtime.team) : null),
		pi,
		disposers: [],
		extDir: EXT_DIR,
	};
	return runtime;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Adopt a team abandoned by a dead lead, so a restart does not leave orphaned
 * agents invisible.
 *
 * Requires the previous lead process to be GONE. Without that check, a second
 * concurrent pi session in the same directory takes over a team it did not
 * create — and then kills it on exit.
 */
function findReattachableTeam(cwd: string): string | null {
	const session = tmuxSession();
	for (const config of listTeams()) {
		if (config.leadPid === process.pid) return config.team;
		if (pidAlive(config.leadPid)) continue; // someone else is still running it
		const live = config.agents.filter((a) => !a.killedAt && isAlive(config.team, a.name));
		if (live.length === 0) continue;
		const sameSession = session !== undefined && config.tmuxSession === session;
		if (sameSession || config.cwd === cwd) return config.team;
	}
	return null;
}
