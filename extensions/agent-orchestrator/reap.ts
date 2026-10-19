/**
 * Recycling: getting finished agents out of the way.
 *
 * A team's agent list only ever grew. After a few batches the tree — and the
 * widget — was mostly headstones: dead agents whose work was long collected,
 * crowding out the handful still running. Cleanup removed everything or
 * nothing, so the only way to clear five corpses was to tear down the team.
 *
 * Reaping is the middle ground. An agent is reaped when it is
 *   - not alive, and
 *   - in a terminal state (done / error / stuck / killed), and
 *   - older than a retention window (so you can still see what just happened).
 *
 * Its final status, deliverable path and task are appended to
 * `<team>/archive/agents.jsonl` first. Reaping must never destroy the answer
 * to "what did that worker produce?" — that is the whole point of the run.
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import { isAlive, isSameProcess } from "./backend.ts";
import {
	type AgentRecord,
	listTeams,
	logPath,
	TEAMS_ROOT,
	readAllStatuses,
	readTeam,
	type StatusReport,
	teamDir,
	updateTeam,
} from "./state.ts";

const TERMINAL: ReadonlySet<string> = new Set(["done", "error", "stuck", "killed"]);

export interface ReapOptions {
	/** Only reap agents whose status is older than this. Default 10 minutes. */
	olderThanMs?: number;
	/** Hard cap on agents kept in the tree; oldest terminal reaped beyond it. */
	maxAgents?: number;
	/** Reap every terminal agent regardless of age. */
	all?: boolean;
}

export interface ReapResult {
	reaped: string[];
	kept: number;
	archive?: string;
}

export interface ArchivedAgent {
	name: string;
	role: string;
	parent: string | null;
	task: string;
	createdAt: string;
	reapedAt: string;
	finalState: string;
	output?: string;
	note?: string;
	sessionId?: string;
	log: string;
	cwd?: string;
}

/**
 * Look up an agent that has already been recycled out of the tree.
 *
 * Reaping removes the record a caller would normally resolve, so without this
 * `team_ask`/`team_open_session` would answer "No such agent" for a worker
 * whose session is still perfectly resumable — losing the cheapest way to
 * re-question finished work.
 */
export function findArchivedAgent(team: string, name: string): ArchivedAgent | null {
	const path = archivePath(team);
	if (!existsSync(path)) return null;
	let latest: ArchivedAgent | null = null;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (line.trim() === "") continue;
		try {
			const entry = JSON.parse(line) as ArchivedAgent;
			if (entry.name === name) latest = entry;
		} catch {
			// Skip corrupt lines rather than losing the rest of the archive.
		}
	}
	return latest;
}

export function archivePath(team: string): string {
	return join(teamDir(team), "archive", "agents.jsonl");
}

function archive(team: string, agent: AgentRecord, status: StatusReport | undefined): void {
	const path = archivePath(team);
	mkdirSync(join(path, ".."), { recursive: true });
	appendFileSync(
		path,
		`${JSON.stringify({
			name: agent.name,
			role: agent.role,
			parent: agent.parent,
			task: agent.task.slice(0, 500),
			createdAt: agent.createdAt,
			reapedAt: new Date().toISOString(),
			finalState: status?.state ?? (agent.killedAt ? "killed" : "unknown"),
			output: status?.output,
			note: status?.note,
			sessionId: agent.sessionId,
			log: logPath(team, agent.name),
			cwd: agent.cwd,
		})}\n`,
	);
}

/**
 * Remove finished agents from the live tree.
 *
 * Agents with living children are never reaped: pruning a parent would orphan
 * the subtree and lose the path back to running processes.
 */
export function reapTeam(team: string, options: ReapOptions = {}): ReapResult {
	// A pending timer must not recreate a directory that cleanup just removed.
	if (!existsSync(teamDir(team))) return { reaped: [], kept: 0 };
	const config = readTeam(team);
	if (!config) return { reaped: [], kept: 0 };
	const olderThanMs = options.olderThanMs ?? 10 * 60 * 1000;
	const statuses = readAllStatuses(team);
	const now = Date.now();

	const hasLiveDescendant = (name: string): boolean => {
		const children = config.agents.filter((a) => a.parent === name);
		return children.some(
			(child) =>
				(!child.killedAt && isAlive(team, child.name)) || hasLiveDescendant(child.name),
		);
	};

	/** A status written before the record was created belongs to a previous
	 *  agent of the same name; it says nothing about this one. */
	const statusIsStale = (agent: AgentRecord, status: StatusReport | undefined): boolean => {
		if (!status) return false;
		const written = Date.parse(status.updatedAt);
		const created = Date.parse(agent.createdAt);
		return Number.isFinite(written) && Number.isFinite(created) && written < created;
	};

	const candidates = config.agents.filter((agent) => {
		if (!agent.killedAt && isAlive(team, agent.name)) return false;
		const status = statuses[agent.name];
		if (statusIsStale(agent, status)) return false;
		const state = status?.state ?? (agent.killedAt ? "killed" : "spawning");
		if (!TERMINAL.has(state)) return false;
		if (hasLiveDescendant(agent.name)) return false;
		if (options.all) return true;
		const stamp = status ? Date.parse(status.updatedAt) : Date.parse(agent.createdAt);
		return now - stamp >= olderThanMs;
	});

	// Over the cap, reap the oldest terminal agents even inside the window:
	// an unbounded tree is worse than losing sight of an old success.
	let toReap = candidates;
	if (!options.all && options.maxAgents !== undefined && config.agents.length > options.maxAgents) {
		const overflow = config.agents.length - options.maxAgents;
		const byAge = [...config.agents]
			.filter((agent) => {
				if (!agent.killedAt && isAlive(team, agent.name)) return false;
				const state = statuses[agent.name]?.state ?? (agent.killedAt ? "killed" : "spawning");
				return TERMINAL.has(state) && !hasLiveDescendant(agent.name);
			})
			.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
			.slice(0, overflow);
		const names = new Set([...candidates.map((a) => a.name), ...byAge.map((a) => a.name)]);
		toReap = config.agents.filter((a) => names.has(a.name));
	}

	if (toReap.length === 0) return { reaped: [], kept: config.agents.length };

	// Re-decide under the lock. The scan above ran on an unlocked snapshot, so
	// a concurrent spawn could have added a live child beneath an agent we just
	// classified as terminal — reaping it would orphan a running process.
	const names = new Set(toReap.map((a) => a.name));
	const actuallyReaped: AgentRecord[] = [];
	updateTeam(
		team,
		(cfg) => {
			const liveUnder = (name: string): boolean =>
			cfg.agents.some(
				(child) =>
					child.parent === name &&
					((!child.killedAt && isAlive(team, child.name)) || liveUnder(child.name)),
			);
		const confirmed = cfg.agents.filter(
			(agent) =>
				names.has(agent.name) &&
				!(!agent.killedAt && isAlive(team, agent.name)) &&
				!liveUnder(agent.name),
		);
		if (confirmed.length === 0) return;
		// Archive before removal: a failed archive write must abort the reap
		// rather than silently delete the record of a deliverable.
		// Re-read status under the lock: an agent respawned under the same name
		// during the scan must not be reaped on the strength of a stale verdict.
		const statusNow = readAllStatuses(team);
		const stillTerminal = confirmed.filter((agent) => {
			const status = statusNow[agent.name];
			if (statusIsStale(agent, status)) return false;
			const state = status?.state ?? (agent.killedAt ? "killed" : "spawning");
			return TERMINAL.has(state);
		});
		if (stillTerminal.length === 0) return;
		for (const agent of stillTerminal) archive(team, agent, statusNow[agent.name]);
		const confirmedNames = new Set(stillTerminal.map((a) => a.name));
		cfg.agents = cfg.agents.filter((a) => !confirmedNames.has(a.name));
		actuallyReaped.push(...stillTerminal);
		},
		// Housekeeping must never run unlocked: a lost update here would drop a
		// concurrently spawned agent from the tree and orphan its process.
		{ required: true },
	);

	return {
		reaped: actuallyReaped.map((a) => a.name),
		kept: readTeam(team)?.agents.length ?? 0,
		archive: actuallyReaped.length > 0 ? archivePath(team) : undefined,
	};
}

/**
 * Delete team directories left by leads that are gone.
 *
 * A crashed or force-quit lead leaves its whole directory behind; after a few
 * weeks `~/.pi/orchestrator-teams` is mostly archaeology. Never touches a team
 * whose lead process is alive or that still has a live agent, so a concurrent
 * session is safe.
 */
/** True if any pid file under the directory names a living process. */
function hasLivePid(dir: string): boolean {
	const logs = join(dir, "logs");
	let entries: string[];
	try {
		entries = readdirSync(logs);
	} catch {
		return false;
	}
	for (const file of entries) {
		if (!file.endsWith(".pid")) continue;
		try {
			const pid = Number.parseInt(readFileSync(join(logs, file), "utf8").trim(), 10);
			if (!Number.isFinite(pid)) continue;
			process.kill(pid, 0);
			return true;
		} catch {
			// Unreadable or dead: not a reason to keep the directory.
		}
	}
	return false;
}

/** Newest of: createdAt, config mtime, any status file mtime. */
function lastActivityMs(team: string, createdAt: string): number {
	let newest = Date.parse(createdAt);
	if (!Number.isFinite(newest)) newest = 0;
	const probe = (path: string): void => {
		try {
			newest = Math.max(newest, statSync(path).mtimeMs);
		} catch {
			// Missing paths simply do not contribute.
		}
	};
	probe(join(teamDir(team), "config.json"));
	const statuses = join(teamDir(team), "status");
	try {
		for (const file of readdirSync(statuses)) probe(join(statuses, file));
	} catch {
		// No status dir: fall back to what we have.
	}
	probe(archivePath(team));
	return newest;
}

export function sweepTeams(options: {
	olderThanMs: number;
	keepTeam?: string | null;
	dryRun?: boolean;
}): { removed: string[]; skipped: number } {
	const removed: string[] = [];
	let skipped = 0;
	const now = Date.now();

	// Directories whose config.json is missing or corrupt never appear in
	// listTeams(), so they would sit on disk forever. Handle them by mtime,
	// and only when no pid file in them belongs to a living process.
	try {
		const known = new Set(listTeams().map((c) => c.team));
		for (const entry of readdirSync(TEAMS_ROOT)) {
			if (known.has(entry) || (options.keepTeam && entry === options.keepTeam)) continue;
			const dir = join(TEAMS_ROOT, entry);
			let stats: ReturnType<typeof statSync>;
			try {
				stats = statSync(dir);
			} catch {
				continue;
			}
			if (!stats.isDirectory()) continue;
			if (now - stats.mtimeMs < options.olderThanMs) {
				skipped++;
				continue;
			}
			if (hasLivePid(dir)) {
				skipped++;
				continue;
			}
			if (!options.dryRun) rmSync(dir, { recursive: true, force: true });
			removed.push(entry);
		}
	} catch {
		// TEAMS_ROOT may not exist yet.
	}

	for (const config of listTeams()) {
		if (options.keepTeam && config.team === options.keepTeam) continue;
		// Verified against the recorded creation time, so a recycled pid cannot
		// keep an abandoned team alive forever.
		const leadAlive = (() => {
			try {
				process.kill(config.leadPid, 0);
			} catch {
				return false;
			}
			const createdAt = Date.parse(config.createdAt);
			return Number.isFinite(createdAt) ? isSameProcess(config.leadPid, createdAt) : true;
		})();
		const agentAlive = config.agents.some((a) => !a.killedAt && isAlive(config.team, a.name));
		// Age by last activity, not creation: a months-old team that produced
		// results yesterday still holds unread deliverables.
		const age = now - lastActivityMs(config.team, config.createdAt);
		if (leadAlive || agentAlive || !Number.isFinite(age) || age < options.olderThanMs) {
			skipped++;
			continue;
		}
		if (!options.dryRun) {
			const dir = teamDir(config.team);
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
		removed.push(config.team);
	}
	return { removed, skipped };
}
