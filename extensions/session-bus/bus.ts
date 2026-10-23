/**
 * A file-backed bus for passing context between pi sessions.
 *
 * Layout under `~/.pi/agent/session-bus/`:
 *   registry/<key>.json   one per session that has ever announced itself
 *   inbox/<key>/*.json    envelopes waiting for that session
 *   acks/<message-id>.json  written by the receiver when it injects a message
 *
 * Files rather than a socket, deliberately: the most useful message is the one
 * you leave for a session that is not running — "when you next open the
 * payments repo, here is what I found". A socket can only reach a live peer.
 *
 * The payload discipline is the important part. Shipping a session's raw
 * context into another session is exactly the cost this tooling exists to
 * avoid, so a message carries a short note plus *references* (file paths, a
 * session id), and the receiver pulls what it actually needs.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { postEnvelope, drainEnvelopes, watchEnvelopes, type Envelope } from "../_shared/mailbox.ts";
import { readJson, writeAtomic } from "../_shared/fsjson.ts";

export const BUS_ROOT = process.env.PI_BUS_ROOT ?? join(homedir(), ".pi", "agent", "session-bus");
export const registryDir = (): string => join(BUS_ROOT, "registry");
export const inboxRoot = (): string => join(BUS_ROOT, "inbox");
export const ackRoot = (): string => join(BUS_ROOT, "acks");

/** How long after its last heartbeat a session is still considered live. */
const HEARTBEAT_STALE_MS = 90_000;
/** Registry entries older than this are pruned. */
const REGISTRY_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** Inline text is clamped: send pointers, not payloads. */
export const MAX_NOTE_CHARS = 4000;
export const NOTE_PREVIEW_CHARS = 1500;
export const NOTES_DIR = join(BUS_ROOT, "notes");
/** Acks nobody collected are pruned after a day. */
const ACK_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How a live receiver injects a message.
 *
 * - `queue`: held for the receiver's next prompt (pi `nextTurn`); never starts a turn.
 * - `steer`: a user message delivered like one typed while the receiver runs: after its
 *   current assistant turn and that turn's tool calls, before its next model call. An idle
 *   receiver starts a turn with it. Never aborts the current run.
 */
export type Delivery = "queue" | "steer";

export interface SessionEntry {
	/** This session instance. Changes every time pi restarts. */
	key: string;
	/**
	 * Stable mail address, derived from the working directory.
	 *
	 * Mail must survive a restart: you are writing to "my payments session",
	 * not to one process. Addressing by session id orphaned every queued
	 * message the moment the target restarted with a fresh id.
	 */
	address: string;
	/** Human-friendly alias, defaulting to the directory name. */
	alias: string;
	cwd: string;
	pid: number;
	startedAt: string;
	lastSeen: string;
}

/**
 * A context hand-off. Conforms to the shared Envelope shape so it can reuse
 * the proven mailbox plumbing; the bus-specific fields live in `meta`.
 */
export interface BusMessage extends Envelope {
	kind: "context";
	meta?: {
		fromAlias?: string;
		fromCwd?: string;
		/** Files the receiver can read on demand — the preferred payload. */
		paths?: string[];
		/** A pi session the receiver can question with `pi --session <id>`. */
		sessionRef?: string;
		/** How the receiver should inject it. Absent on mail from older senders. */
		delivery?: Delivery;
		/** Legacy flag, still written for receivers running an older bus: true means `steer`. */
		wake?: boolean;
	};
}

export interface SendInput {
	note: string;
	paths?: string[];
	sessionRef?: string;
	delivery?: Delivery;
	/** Alias for `delivery: "steer"`. An explicit `delivery` wins. */
	wake?: boolean;
}

export const resolveDelivery = (input: { delivery?: Delivery; wake?: boolean }): Delivery =>
	input.delivery ?? "steer";

export const deliveryOf = (message: BusMessage): Delivery =>
	resolveDelivery({ delivery: message.meta?.delivery, wake: message.meta?.wake });

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export const isLive = (entry: SessionEntry): boolean =>
	pidAlive(entry.pid) && Date.now() - Date.parse(entry.lastSeen) < HEARTBEAT_STALE_MS;

export interface RunningSession {
	pid: number;
	cwd: string;
	/** True when this process is a spawned orchestrator agent, not a session. */
	isAgent: boolean;
}

/**
 * Find running pi processes from the OS.
 *
 * The registry alone only knows sessions that STARTED after this extension
 * was installed — on a machine with long-lived sessions that is a small
 * minority (measured: registry knew 3, the OS had 28). Discovery therefore
 * starts from `pgrep`, and the registry only enriches what it finds.
 *
 * Note pi's argv is literally `pi`, so match the process name exactly; a
 * `pgrep -f bin/pi` finds nothing.
 */
export function discoverRunning(): RunningSession[] {
	let pids: number[];
	try {
		pids = execFileSync("pgrep", ["-x", "pi"], { encoding: "utf8" })
			.split("\n")
			.map((line) => Number.parseInt(line.trim(), 10))
			.filter((pid) => Number.isFinite(pid) && pid !== process.pid);
	} catch {
		return []; // no pi processes, or pgrep unavailable
	}

	const out: RunningSession[] = [];
	for (const pid of pids) {
		let cwd = "";
		try {
			const lines = execFileSync("lsof", ["-a", "-d", "cwd", "-p", String(pid), "-Fn"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).split("\n");
			cwd = lines.find((l) => l.startsWith("n"))?.slice(1) ?? "";
		} catch {
			continue;
		}
		if (!cwd) continue;
		// Spawned team agents are pi processes too; they are not places a human
		// sends context to, so keep them out of the target list.
		let isAgent = false;
		try {
			const env = execFileSync("ps", ["-Eww", "-p", String(pid)], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			});
			isAgent = /PI_ORCH_AGENT_NAME=\S/.test(env);
		} catch {
			isAgent = false;
		}
		out.push({ pid, cwd, isAgent });
	}
	return out;
}

/** A filesystem-safe, collision-free address for a working directory. */
export function addressFor(cwd: string): string {
	return cwd.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "root";
}

/**
 * A mailbox for one session rather than its directory.
 *
 * Needed when several sessions share a directory: the directory address cannot
 * tell them apart, and a session can never reach a sibling in its own folder.
 * Keyed by session id, which `pi --continue` / `--session` preserve, so it
 * survives a resume (but not a brand-new session in that directory).
 */
export const sessionAddressFor = (key: string): string => `s-${addressFor(key)}`;

export function announce(entry: Omit<SessionEntry, "lastSeen">): SessionEntry {
	const full: SessionEntry = { ...entry, lastSeen: new Date().toISOString() };
	mkdirSync(registryDir(), { recursive: true });
	writeAtomic(join(registryDir(), `${entry.key}.json`), full);
	return full;
}

export function listSessions(): SessionEntry[] {
	const dir = registryDir();
	if (!existsSync(dir)) return [];
	const out: SessionEntry[] = [];
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".json")) continue;
		const entry = readJson<SessionEntry>(join(dir, file));
		if (!entry) continue;
		// Forget sessions nobody has heard from in a fortnight.
		if (Date.now() - Date.parse(entry.lastSeen) > REGISTRY_TTL_MS) {
			rmSync(join(dir, file), { force: true });
			continue;
		}
		out.push(entry);
	}
	return out.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

export interface ResolveResult {
	entry?: Target;
	/** Populated when the target is ambiguous, so the caller can disambiguate. */
	candidates?: Target[];
	error?: string;
}

/**
 * Resolve a human-typed target to one session.
 *
 * Accepts a session key (full or prefix), an alias, or a cwd path. Live
 * sessions win over dead ones with the same alias — addressing "the payments
 * session" should mean the one running now, not last week's.
 */
export function resolveTarget(target: string, self?: Pick<SessionEntry, "key" | "address">): ResolveResult {
	const all = listTargets(self, { expandOthers: true });
	if (all.length === 0) return { error: "No other pi sessions have announced themselves yet." };
	const needle = target.trim();
	if (needle === "") return { error: "No target given.", candidates: all };

	// A full session id means that one session, wherever it runs. This is the reply
	// address printed on every delivered message, so it must resolve even when the
	// sender is the only session in its folder and has no session row.
	const liveSessions = listSessions().filter((e) => isLive(e) && e.key !== self?.key);
	const exactSession = liveSessions.find((e) => e.key === needle);
	if (exactSession) return { entry: asSessionTarget(exactSession) };

	const exact = all.filter(
		(e) => e.key === needle || e.address === needle || e.alias === needle || e.cwd === needle,
	);
	const exactOne = exact.length > 1 ? exact.filter((e) => e.kind === "directory") : exact;
	const fuzzy =
		exactOne.length > 0
			? exactOne
			: all.filter(
					(e) =>
						e.key.startsWith(needle) ||
						e.alias.toLowerCase().includes(needle.toLowerCase()) ||
						basename(e.cwd) === needle,
				);
	if (fuzzy.length === 0) {
		const byPrefix = needle.length >= 8 ? liveSessions.filter((e) => e.key.startsWith(needle)) : [];
		if (byPrefix.length === 1) return { entry: asSessionTarget(byPrefix[0]!) };
		return { error: `No session matches "${target}".`, candidates: all };
	}
	if (fuzzy.length === 1) return { entry: fuzzy[0] };

	const byKey = fuzzy.filter((e) => e.kind === "session" && e.key.startsWith(needle));
	if (byKey.length === 1) return { entry: byKey[0] };
	const directories = fuzzy.filter((e) => e.kind === "directory");
	if (directories.length === 1 && byKey.length === 0) return { entry: directories[0] };

	const live = fuzzy.filter(isLive);
	if (live.length === 1) return { entry: live[0] };
	return { error: `"${target}" matches ${fuzzy.length} sessions.`, candidates: fuzzy };
}

export function send(
	to: SessionEntry,
	from: { key: string; alias: string; cwd: string },
	input: SendInput,
): BusMessage {
	let note = input.note;
	let paths = input.paths;
	if (note.length > MAX_NOTE_CHARS) {
		const file = join(NOTES_DIR, `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.md`);
		mkdirSync(NOTES_DIR, { recursive: true });
		writeFileSync(file, `${input.note}\n`);
		note = `${input.note.slice(0, NOTE_PREVIEW_CHARS)}\n\n[…preview only. The full note (${input.note.length} characters) is in ${file}. Read it before acting.]`;
		paths = [file, ...(input.paths ?? [])];
	}
	return postEnvelope<BusMessage>(inboxRoot(), {
		// Addressed to the place, not the process: survives the target restarting.
		to: to.address,
		from: from.key,
		kind: "context",
		content: note,
		meta: {
			fromAlias: from.alias,
			fromCwd: from.cwd,
			paths,
			sessionRef: input.sessionRef,
			delivery: resolveDelivery(input),
			wake: resolveDelivery(input) === "steer",
		},
	});
}

/**
 * What the receiver did with a message, written when it injects it.
 *
 * - `queued`: held for its next prompt.
 * - `steered`: it was mid-run; queued as steering, seen after its current step.
 * - `started`: it was idle; a turn was started with the message.
 * - `deferred`: it was compacting; it will steer the message once that finishes.
 *
 * `seenAt` is set when the message actually enters the receiver's conversation.
 */
export type AckStatus = "queued" | "steered" | "started" | "deferred";

export interface DeliveryAck {
	id: string;
	status: AckStatus;
	delivery: Delivery;
	receiverKey: string;
	receiverAlias: string;
	receiverCwd: string;
	at: string;
	seenAt?: string;
}

const ackPath = (id: string): string => join(ackRoot(), `${id}.json`);

export function writeAck(ack: Omit<DeliveryAck, "at"> & { at?: string }): void {
	writeAtomic(ackPath(ack.id), { ...ack, at: ack.at ?? new Date().toISOString() });
}

export const readAck = (id: string): DeliveryAck | null => readJson<DeliveryAck>(ackPath(id));

export function markSeen(id: string): void {
	const ack = readAck(id);
	if (ack && !ack.seenAt) writeAck({ ...ack, seenAt: new Date().toISOString() });
}

export function removeAck(id: string): void {
	rmSync(ackPath(id), { force: true });
}

export function pruneAcks(maxAgeMs = ACK_TTL_MS): void {
	const dir = ackRoot();
	if (!existsSync(dir)) return;
	for (const file of readdirSync(dir)) {
		try {
			if (Date.now() - statSync(join(dir, file)).mtimeMs > maxAgeMs) rmSync(join(dir, file), { force: true });
		} catch {
			// Removed by another session meanwhile.
		}
	}
}

/**
 * Wait briefly for the receiver's ack.
 *
 * Returns as soon as there is a settled answer. A `started` ack is only settled
 * once the receiver confirms the message entered its conversation, so the
 * caller can say "started a turn" truthfully; otherwise the latest ack (or null)
 * is returned at the deadline.
 */
export async function waitForAck(
	id: string,
	options: { timeoutMs: number; pollMs?: number; signal?: AbortSignal },
): Promise<DeliveryAck | null> {
	const deadline = Date.now() + options.timeoutMs;
	let latest: DeliveryAck | null = null;
	for (;;) {
		latest = readAck(id) ?? latest;
		if (latest && (latest.status !== "started" || latest.seenAt)) return latest;
		if (Date.now() >= deadline || options.signal?.aborted) return latest;
		await new Promise((r) => setTimeout(r, options.pollMs ?? 100));
	}
}

/** True while the message is still waiting in its inbox, unread. */
export const isPending = (message: BusMessage): boolean =>
	existsSync(join(inboxRoot(), message.to, `${message.id}.json`));

/** Put a drained message back, unchanged, so the next reader gets it. */
export function requeue(message: BusMessage): void {
	writeAtomic(join(inboxRoot(), message.to, `${message.id}.json`), message);
}

export const receive = (address: string): BusMessage[] =>
	drainEnvelopes<BusMessage>(inboxRoot(), address);

export const watchInbox = (address: string, onMail: (mail: BusMessage[]) => void): (() => void) =>
	watchEnvelopes<BusMessage>(inboxRoot(), address, onMail);

/**
 * One row per address, preferring a live session.
 *
 * Restarts leave a trail of dead entries for the same directory; showing all
 * of them turns "send to payments" into a disambiguation puzzle.
 */
export interface Target extends SessionEntry {
	/** `directory` mail goes to whichever session there reads it; `session` mail to exactly one. */
	kind: "directory" | "session";
	/** Live pi processes in this directory right now. */
	running: number;
	/**
	 * False when no process here has the bus loaded. Mail still queues, but it
	 * is only delivered after that session restarts or reloads.
	 */
	busAware: boolean;
}

/**
 * Everywhere you could send context: running pi processes (from the OS) union
 * registered sessions (from the bus), collapsed to one row per directory.
 */
export function listAddresses(): Target[] {
	const byAddress = new Map<string, Target>();

	for (const entry of listSessions()) {
		const current = byAddress.get(entry.address);
		const asTarget: Target = { ...entry, kind: "directory", running: 0, busAware: true };
		if (!current) byAddress.set(entry.address, asTarget);
		else if (isLive(entry) && !isLive(current)) byAddress.set(entry.address, { ...asTarget, running: current.running });
	}

	for (const proc of discoverRunning()) {
		if (proc.isAgent) continue;
		const address = addressFor(proc.cwd);
		const existing = byAddress.get(address);
		if (existing) {
			existing.running += 1;
			existing.pid = proc.pid;
			existing.cwd = proc.cwd;
		} else {
			byAddress.set(address, {
				kind: "directory",
				key: `proc-${proc.pid}`,
				address,
				alias: basename(proc.cwd) || proc.cwd,
				cwd: proc.cwd,
				pid: proc.pid,
				startedAt: new Date().toISOString(),
				lastSeen: new Date().toISOString(),
				running: 1,
				busAware: false,
			});
		}
	}

	return [...byAddress.values()].sort((a, b) => {
		if (a.running !== b.running) return b.running - a.running;
		return b.lastSeen.localeCompare(a.lastSeen);
	});
}

/**
 * Everything THIS session can send to.
 *
 * Directory rows for every other directory, plus one row per live session in
 * this session's own directory (and, with `expandOthers`, in any directory
 * holding more than one session). Without the session rows, a sibling session in the same folder is
 * invisible: its directory address is this session's own address.
 */
export function listTargets(
	self?: Pick<SessionEntry, "key" | "address">,
	options: { expandOthers?: boolean } = {},
): Target[] {
	const directories = listAddresses();
	const liveSessions = listSessions().filter((e) => isLive(e) && e.key !== self?.key);
	const perDirectory = new Map<string, SessionEntry[]>();
	for (const entry of liveSessions) {
		perDirectory.set(entry.address, [...(perDirectory.get(entry.address) ?? []), entry]);
	}

	const out: Target[] = [];
	for (const dir of directories) {
		const siblings = perDirectory.get(dir.address) ?? [];
		const isOwn = dir.address === self?.address;
		if (!isOwn) out.push(dir);
		if (!isOwn && (siblings.length < 2 || !options.expandOthers)) continue;
		for (const entry of siblings) {
			out.push({
				...entry,
				kind: "session",
				address: sessionAddressFor(entry.key),
				alias: entry.alias,
				running: 1,
				busAware: true,
			});
		}
	}
	return out;
}

function asSessionTarget(entry: SessionEntry): Target {
	return { ...entry, kind: "session", address: sessionAddressFor(entry.key), running: 1, busAware: true };
}

/** Live if the bus says so, or if a pi process is running there. */
export const isReachable = (t: Target): boolean => t.running > 0 || isLive(t);

/** Printed under every delivered message; the receiver matches it to confirm the message reached its conversation. */
export const messageMarker = (id: string): string => `(session-bus message ${id})`;

/** Render one message for display in the receiving session. */
export function formatMessage(message: BusMessage, index?: number): string {
	const age = Math.round((Date.now() - Date.parse(message.sentAt)) / 60_000);
	const when = Number.isFinite(age) && age > 1 ? `${age}m ago` : "just now";
	const meta = message.meta ?? {};
	const lines = [
		`✉ from @${meta.fromAlias ?? message.from}${index !== undefined ? ` (${index})` : ""}` +
			` — another pi session (${message.from}${meta.fromCwd ? `, ${meta.fromCwd}` : ""}) · ${when}`,
		`Not typed by the user here. Reply with session_send({ to: "${message.from}", note: "…" }); an answer in this chat does not reach the sender.`,
		"",
		message.content,
	];
	if (meta.paths?.length) {
		lines.push("", "Referenced files (read them if relevant):", ...meta.paths.map((p) => `  - ${p}`));
	}
	if (meta.sessionRef) {
		lines.push(
			"",
			`Sender's session: ${meta.sessionRef}`,
			`  Question it directly: pi --session ${meta.sessionRef} -p "<question>"`,
		);
	}
	lines.push("", messageMarker(message.id));
	return lines.join("\n");
}

/**
 * The instruction handed to this session's agent after the human picks a
 * target and describes what to send.
 *
 * The point of routing through the agent rather than posting the raw text: the
 * human says "send them the rounding decision", and the session that HAS that
 * context is the one that should work out which files and findings that means.
 */
export function buildSendPrompt(target: SessionEntry, request: string): string {
	return [
		`Send context to another pi session using the session_send tool.`,
		"",
		`Target: to="${target.address}" (${target.alias} — ${target.cwd}, currently ${isLive(target) ? "live" : "offline; it will receive this when it next starts"}).`,
		"",
		`What I want them to have: ${request}`,
		"",
		"Work out what that actually means from THIS session's context:",
		"- Which concrete files should they read? Pass those as `paths` (absolute, and only ones that exist).",
		"- What do they need to know that lives only in this conversation? Put that in `note`, in your own words.",
		"- Set `shareSession: true` if they may need to ask this session follow-up questions.",
		"",
		"Keep `note` short and specific — conclusions, decisions and gotchas, not a transcript.",
		"Send references over pasted content. Then tell me in one line what you sent.",
	].join("\n");
}

/** Best-effort count of queued messages, for status display. */
export function pendingCount(key: string): number {
	const dir = join(inboxRoot(), key);
	if (!existsSync(dir)) return 0;
	try {
		return readdirSync(dir).filter((f) => f.endsWith(".json")).length;
	} catch {
		return 0;
	}
}

/** True when the path exists and is readable — used to warn on dead references. */
export function pathExists(path: string): boolean {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * NEVER derive this session's identity from `PI_SESSION_FILE`.
 *
 * That variable describes the pi process that spawned us. A pi launched from
 * inside another pi (a bash tool call, a worker) inherits it and would
 * register under its PARENT's id — observed: two sessions in different repos
 * both claimed one registry entry, the second silently overwriting the first.
 * `ctx.sessionManager.getSessionId()` is the only self-describing source.
 */
export function sessionKey(fromManager: string | undefined): string {
	if (fromManager && fromManager.trim() !== "") return fromManager;
	// Ephemeral sessions (--no-session) have no id; stay unique per process.
	return `pid-${process.pid}`;
}

export function readFileSafe(path: string, maxChars: number): string | null {
	try {
		const text = readFileSync(path, "utf8");
		return text.length > maxChars ? `${text.slice(0, maxChars)}\n[…truncated]` : text;
	} catch {
		return null;
	}
}
