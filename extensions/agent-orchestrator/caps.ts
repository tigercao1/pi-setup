/**
 * Concurrency caps and the spawn queue.
 *
 * Every agent is a full pi process, and a sub-orchestrator that fans out to
 * eight managers that each fan out again took one laptop to ~27 processes.
 * The caps bound that in code:
 *
 *   maxChildrenPerParent  live direct children of one parent
 *   maxLiveAgents         live agents in one team (the lead is not counted)
 *   maxDepth              levels below the lead
 *
 * A spawn that hits a count cap is queued (see `queue/` in state.ts) and the
 * queue pump in every orchestrator process starts it once a slot frees. Depth
 * is structural, so hitting it refuses instead.
 */

import { existsSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { isAlive } from "./backend.ts";
import type { SpawnLimits } from "./config.ts";
import { readJson, writeAtomic } from "../_shared/fsjson.ts";
import { type AgentRecord, queueDir, type StatusReport, type TeamConfig, teamExists } from "./state.ts";

/** A reservation whose process has not written its pid yet still holds its slot this long. */
const RESERVATION_GRACE_MS = 60_000;
/** A claim left behind by a pump that crashed mid-launch is released after this. */
const STALE_CLAIM_MS = 60_000;

const NOT_RUNNING: ReadonlySet<string> = new Set(["queued", "done", "error", "killed"]);

/**
 * Does this agent occupy a slot? Finished work does not, even when its pane is
 * still open: a visible manager idles after reporting `done`, and counting it
 * would hold the slot until a human closed the pane.
 */
export function holdsSlot(
	team: string,
	agent: AgentRecord,
	status: StatusReport | undefined,
	now = Date.now(),
	alive: (team: string, name: string) => boolean = isAlive,
): boolean {
	if (agent.killedAt) return false;
	const state = status?.state;
	if (state && NOT_RUNNING.has(state)) return false;
	if (alive(team, agent.name)) return true;
	return state === "spawning" && now - Date.parse(status?.updatedAt ?? "") < RESERVATION_GRACE_MS;
}

export interface CapCounts {
	liveChildren: number;
	liveTotal: number;
}

export function countLive(
	config: TeamConfig,
	statuses: Record<string, StatusReport>,
	parent: string,
	options: { exclude?: string; alive?: (team: string, name: string) => boolean } = {},
): CapCounts {
	const now = Date.now();
	const live = config.agents.filter(
		(a) => a.name !== options.exclude && holdsSlot(config.team, a, statuses[a.name], now, options.alive),
	);
	return { liveTotal: live.length, liveChildren: live.filter((a) => a.parent === parent).length };
}

export interface CapHit {
	key: "maxChildrenPerParent" | "maxLiveAgents";
	message: string;
}

/** The first count cap a new child of `parent` would break, or null when it fits. */
export function countCapHit(counts: CapCounts, limits: SpawnLimits, parent: string, team: string): CapHit | null {
	if (counts.liveChildren >= limits.maxChildrenPerParent) {
		return {
			key: "maxChildrenPerParent",
			message: `per-parent cap maxChildrenPerParent=${limits.maxChildrenPerParent} reached: ${parent} has ${counts.liveChildren} live direct children`,
		};
	}
	if (counts.liveTotal >= limits.maxLiveAgents) {
		return {
			key: "maxLiveAgents",
			message: `team cap maxLiveAgents=${limits.maxLiveAgents} reached: ${counts.liveTotal} live agents in ${team}`,
		};
	}
	return null;
}

// ------------------------------------------------------------------ queue

export interface QueueEntry<P = unknown> {
	name: string;
	parent: string;
	queuedAt: string;
	/** The spawn parameters, replayed as-is when a slot frees. */
	params: P;
	/** The spawner's own model, so the child inherits what it would have. */
	inherit?: { model: string; provider: string };
	leadSessionId?: string;
}

const entryPath = (team: string, name: string): string => join(queueDir(team), `${name}.json`);

export function enqueue<P>(team: string, entry: QueueEntry<P>): void {
	if (!teamExists(team)) return;
	writeAtomic(entryPath(team, entry.name), entry);
}

export function dropQueued(team: string, name: string): void {
	try {
		unlinkSync(entryPath(team, name));
	} catch {
		// Already claimed or gone.
	}
}

/** Waiting entries, oldest first. Claimed entries are skipped. */
export function listQueue<P>(team: string): QueueEntry<P>[] {
	const dir = queueDir(team);
	if (!existsSync(dir)) return [];
	const out: QueueEntry<P>[] = [];
	for (const file of readdirSync(dir)) {
		const path = join(dir, file);
		if (file.includes(".json.claim-")) {
			releaseIfStale(path);
			continue;
		}
		if (!file.endsWith(".json")) continue;
		const entry = readJson<QueueEntry<P>>(path);
		if (entry) out.push(entry);
	}
	return out.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}

function releaseIfStale(claimPath: string): void {
	try {
		if (Date.now() - statSync(claimPath).mtimeMs > STALE_CLAIM_MS) {
			renameSync(claimPath, claimPath.replace(/\.claim-.*$/, ""));
		}
	} catch {
		// Someone else released or finished it.
	}
}

/**
 * Take exclusive ownership of an entry. `rename` is atomic, so when several
 * orchestrator processes pump the same queue only one of them launches it.
 */
export function claim(team: string, name: string): { release(): void; finish(): void } | null {
	const from = entryPath(team, name);
	const to = `${from}.claim-${process.pid}`;
	const now = new Date();
	try {
		// Fresh mtime before the rename, so the claim is never born stale.
		utimesSync(from, now, now);
		renameSync(from, to);
		utimesSync(to, now, now);
	} catch {
		return null;
	}
	return {
		release() {
			try {
				renameSync(to, from);
			} catch {
				// Team cleaned up meanwhile.
			}
		},
		finish() {
			try {
				unlinkSync(to);
			} catch {
				// Already gone.
			}
		},
	};
}

export function queuePosition(team: string, name: string): number {
	const index = listQueue(team).findIndex((e) => e.name === name);
	return index < 0 ? 0 : index + 1;
}
