/**
 * A file-backed mailbox between independent pi processes.
 *
 * Extracted from agent-orchestrator/state.ts. Addresses are opaque strings —
 * an agent name in a team, a session UUID between forks — and each gets a
 * directory under `root`. Messages are files, deleted once delivered, so
 * delivery is at-most-once per reader and survives a restart of either side.
 */

import { existsSync, readdirSync, renameSync, statSync, unlinkSync, watch } from "node:fs";
import { join } from "node:path";
import { ensureDir, readJson, writeAtomic } from "./fsjson.ts";

/** A claim is abandoned if its owner died between rename and unlink. */
const STALE_CLAIM_MS = 5 * 60_000;

export interface Envelope {
	id: string;
	from: string;
	to: string;
	kind: string;
	content: string;
	sentAt: string;
	/** Sender-defined payload; readers must treat every field as optional. */
	meta?: Record<string, unknown>;
}

export const addressDir = (root: string, address: string): string => join(root, address);

let counter = 0;

export function postEnvelope<T extends Envelope>(
	root: string,
	mail: Omit<T, "id" | "sentAt"> & { to: string },
): T {
	const id = `${Date.now()}-${process.pid}-${counter++}`;
	const full = { ...mail, id, sentAt: new Date().toISOString() } as T;
	writeAtomic(join(addressDir(root, mail.to), `${id}.json`), full);
	return full;
}

/**
 * Read and delete everything addressed to `address`.
 *
 * Each file is **claimed by rename before it is read**. `rename` is atomic on
 * POSIX, so when two readers race — two pi processes watching the same address,
 * or a duplicated watcher registration — exactly one wins and the loser skips
 * the file entirely. Reading first and unlinking afterwards would let both
 * readers deliver the same envelope, which is how a handback gets shown twice.
 */
export function drainEnvelopes<T extends Envelope>(root: string, address: string): T[] {
	const dir = addressDir(root, address);
	if (!existsSync(dir)) return [];
	const out: T[] = [];
	for (const file of readdirSync(dir).sort()) {
		if (file.includes(".claim-")) {
			sweepStaleClaim(join(dir, file));
			continue;
		}
		if (!file.endsWith(".json") || file.endsWith(".tmp")) continue;
		const claimed = join(dir, `${file}.claim-${process.pid}-${counter++}`);
		try {
			renameSync(join(dir, file), claimed);
		} catch {
			continue; // another reader claimed it first
		}
		const mail = readJson<T>(claimed);
		if (mail) out.push(mail);
		try {
			unlinkSync(claimed);
		} catch {
			// Swept later by STALE_CLAIM_MS rather than retried here.
		}
	}
	return out;
}

function sweepStaleClaim(path: string): void {
	try {
		if (Date.now() - statSync(path).mtimeMs > STALE_CLAIM_MS) unlinkSync(path);
	} catch {
		// Gone already, or not ours to clean up.
	}
}

/** Peek without consuming — for status displays. */
export function countEnvelopes(root: string, address: string): number {
	const dir = addressDir(root, address);
	if (!existsSync(dir)) return 0;
	return readdirSync(dir).filter(
		(f) => f.endsWith(".json") && !f.endsWith(".tmp") && !f.includes(".claim-"),
	).length;
}

/**
 * Deliver mail to `address` as it arrives.
 *
 * fs.watch is the fast path; the interval is a safety net for editors, network
 * filesystems, and platforms where watch events are unreliable.
 */
export function watchEnvelopes<T extends Envelope>(
	root: string,
	address: string,
	onMail: (mail: T[]) => void,
	pollMs = 2000,
): () => void {
	const dir = addressDir(root, address);
	ensureDir(dir);

	let stopped = false;
	let draining = false;
	const flush = (): void => {
		// `draining` matters only if `onMail` ever yields; drain itself is sync.
		if (stopped || draining) return;
		draining = true;
		try {
			const mail = drainEnvelopes<T>(root, address);
			if (mail.length > 0) onMail(mail);
		} finally {
			draining = false;
		}
	};

	let watcher: ReturnType<typeof watch> | null = null;
	try {
		watcher = watch(dir, () => flush());
	} catch {
		watcher = null;
	}
	const timer = setInterval(flush, pollMs);
	timer.unref?.();
	flush();

	return () => {
		stopped = true;
		watcher?.close();
		clearInterval(timer);
	};
}
