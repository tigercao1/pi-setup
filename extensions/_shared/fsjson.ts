/**
 * Crash-safe JSON on disk.
 *
 * Shared by every file-backed registry in these extensions (team state, fork
 * registry, mailboxes). Separate processes read these files while others write
 * them, so writes go through temp-file + rename and reads never throw.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function ensureDir(dir: string): void {
	mkdirSync(dir, { recursive: true });
}

/** Write via temp file + rename so readers never observe a half-written file. */
export function writeAtomic(path: string, data: unknown): void {
	ensureDir(join(path, ".."));
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
	renameSync(tmp, path);
}

export function readJson<T>(path: string): T | null {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		// Missing, truncated, or mid-rename. Callers treat this as "no data yet".
		return null;
	}
}

/** Block this thread briefly without spawning a process. */
export function sleepSync(ms: number): void {
	const buffer = new Int32Array(new SharedArrayBuffer(4));
	Atomics.wait(buffer, 0, 0, ms);
}
