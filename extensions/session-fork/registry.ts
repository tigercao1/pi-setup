/**
 * The fork registry: a directory of live and past pi sessions.
 *
 *   ~/.pi/session-forks/
 *     sessions/<key>.json      one record per session (see ForkRecord)
 *     mail/<key>/*.json        handbacks addressed to that session
 *     logs/<key>.{pid,log}     pid file + output of sessions we spawned
 *
 * Why a registry at all: pi already saves every session, but nothing tells a
 * second process *which* session is which, where its pane is, whether it is
 * still alive, or which session it was forked from. Without that, "fork into a
 * pane" and "fork back" cannot address each other.
 *
 * Records are self-registered: every pi that loads this extension writes its
 * own record on session_start and refreshes it on a heartbeat. The only record
 * a process writes for someone else is the stub written at spawn time, which
 * the child then fills in (its session UUID does not exist until it starts).
 *
 * A dead record is not garbage — it is exactly what `/forks` reopens. Pruning
 * therefore keys off "the session file is gone" or age, never off liveness.
 */

import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureDir, readJson, writeAtomic } from "../_shared/fsjson.ts";
import { isPidAlive, readPidFile } from "../_shared/pane.ts";

export interface ForkRecord {
	/** Stable registry key: the spawn id for forks we launched, else `s-<uuid>`. */
	key: string;
	/** pi session UUID. Absent only for a stub whose process has not started. */
	sessionId?: string;
	/** Absolute path of the saved session, once it exists on disk. */
	sessionFile?: string;
	/** `/name` value, when the session has one. */
	name?: string;
	/** Why this fork exists, from `/fork-pane <label>`. */
	label?: string;
	cwd: string;
	pid?: number;
	/** Written by the spawned shell; the liveness source for forks we launched. */
	pidFile?: string;
	/** Output log for headless forks. */
	logFile?: string;
	backend?: string;
	/** tmux pane id or iTerm2 session id, for focus/capture/kill. */
	paneId?: string;
	/** Registry key of the session this one was forked from. */
	parentKey?: string;
	/** Session UUID of the parent, kept for records whose parent key is gone. */
	parentSessionId?: string;
	/** Launcher used, replayed when reopening. */
	piBin?: string;
	/** Exact argv we spawned, replayed when reopening. */
	argv?: string[];
	createdAt: string;
	lastSeenAt: string;
	/** Set by the session's own shutdown hook. Absent after a crash. */
	exitedAt?: string;
	/** True once the fork kickoff note has been injected, so it happens once. */
	announced?: boolean;
	/** Brief a /handoff-pane successor starts from. */
	handoffFile?: string;
	/** `go` submits the brief as the first prompt; `draft` leaves it in the editor. */
	handoffMode?: "go" | "draft";
	/** True once the successor has consumed its brief, so a reopen does not resend it. */
	handoffConsumed?: boolean;
}

export const forksRoot = (): string =>
	process.env.PI_FORK_ROOT ?? join(homedir(), ".pi", "session-forks");

export const sessionsDir = (): string => join(forksRoot(), "sessions");
export const mailRoot = (): string => join(forksRoot(), "mail");
export const logsDir = (): string => join(forksRoot(), "logs");

export const recordPath = (key: string): string => join(sessionsDir(), `${key}.json`);
export const pidFileFor = (key: string): string => join(logsDir(), `${key}.pid`);
export const logFileFor = (key: string): string => join(logsDir(), `${key}.log`);

export const readRecord = (key: string): ForkRecord | null =>
	readJson<ForkRecord>(recordPath(key));

export function writeRecord(record: ForkRecord): ForkRecord {
	writeAtomic(recordPath(record.key), record);
	return record;
}

/**
 * Read-modify-write a record.
 *
 * Unlocked on purpose: a record has one steady-state writer (the session it
 * describes). The only contention window is the moment after a spawn, where the
 * parent's stub and the child's first registration overlap; both merge into the
 * same shape, so a lost update costs at most one heartbeat.
 */
export function patchRecord(key: string, patch: Partial<ForkRecord>): ForkRecord | null {
	const current = readRecord(key);
	if (!current) return null;
	return writeRecord({ ...current, ...patch });
}

export function listRecords(): ForkRecord[] {
	const dir = sessionsDir();
	if (!existsSync(dir)) return [];
	const out: ForkRecord[] = [];
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".json") || file.endsWith(".tmp")) continue;
		const record = readJson<ForkRecord>(join(dir, file));
		if (record?.key) out.push(record);
	}
	return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export const findBySessionId = (sessionId: string): ForkRecord | null =>
	listRecords().find((r) => r.sessionId === sessionId) ?? null;

export function forgetRecord(key: string): void {
	rmSync(recordPath(key), { force: true });
}

/**
 * Is the process behind this record still running?
 *
 * The pid file is authoritative for forks we spawned (the shell writes it
 * before exec, so it covers startup); `record.pid` covers sessions that
 * registered themselves.
 */
export function isRecordAlive(record: ForkRecord): boolean {
	const fromFile = record.pidFile ? readPidFile(record.pidFile) : null;
	if (fromFile !== null) return isPidAlive(fromFile);
	return isPidAlive(record.pid ?? null);
}

/** Records whose parent is `key`. */
export const childrenOf = (records: ForkRecord[], key: string): ForkRecord[] =>
	records.filter((r) => r.parentKey === key);

const DAY_MS = 86_400_000;

/**
 * Drop records that can never be reopened.
 *
 * Two cases only: a spawn that never produced a session (dead process, no
 * session id) after an hour, and a session whose file no longer exists after
 * `maxAgeDays`. Everything else stays reachable from `/forks` forever, which is
 * the whole point of the registry.
 */
export function pruneRecords(options: { maxAgeDays?: number; now?: number } = {}): number {
	const maxAge = (options.maxAgeDays ?? 30) * DAY_MS;
	const now = options.now ?? Date.now();
	let dropped = 0;
	for (const record of listRecords()) {
		const age = now - Date.parse(record.lastSeenAt || record.createdAt);
		const alive = isRecordAlive(record);
		if (alive) continue;
		const failedSpawn = !record.sessionId && age > 3_600_000;
		const fileGone =
			!!record.sessionId &&
			age > maxAge &&
			(!record.sessionFile || !existsSync(record.sessionFile));
		if (failedSpawn || fileGone) {
			forgetRecord(record.key);
			dropped++;
		}
	}
	return dropped;
}

/** Human label for a record: name, else label, else short session id. */
export function describeRecord(record: ForkRecord): string {
	if (record.name) return record.name;
	if (record.label) return record.label;
	if (record.sessionId) return record.sessionId.slice(0, 8);
	return record.key;
}

/** Tail of a spawned fork's log file, for the overlay's peek. */
export function tailLog(record: ForkRecord, lines: number): string | null {
	const path = record.logFile ?? (record.key ? logFileFor(record.key) : null);
	if (!path || !existsSync(path)) return null;
	const text = readFileSync(path, "utf8");
	if (!text.trim()) return null;
	return text.split("\n").slice(-lines).join("\n");
}

export function ensureRegistryDirs(): void {
	ensureDir(sessionsDir());
	ensureDir(mailRoot());
	ensureDir(logsDir());
}
