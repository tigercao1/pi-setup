/**
 * Model-free smoke test for session-fork.
 *
 * Builds a stub ExtensionAPI per "session", so several sessions can be
 * simulated in one process the way real forks work: separate closures over one
 * shared registry on disk.
 *
 * Run with:
 *
 *   npm test
 *
 * PI_FORK_ROOT and HOME point at throwaway directories so a run never touches
 * the real registry.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(tmpdir(), `fork-smoke-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
process.env.PI_FORK_ROOT = join(root, "registry");
process.env.HOME = join(root, "home");
process.env.PI_ORCH_BACKEND = "headless";
process.env.PI_FORK_PI_BIN = "/usr/bin/true";
// A caller identity that must NEVER reach a forked child.
process.env.PI_ORCH_AGENT_NAME = "caller-agent";
process.env.PI_ORCH_TEAM_NAME = "caller-team";

const sessionFork = (await import("../index.ts")).default;
const registry = await import("../registry.ts");
const { drainEnvelopes, postEnvelope } = await import("../../_shared/mailbox.ts");

// ------------------------------------------------------------ harness

/** Every identity var a forked child is told about at spawn time. */
const FORK_ENV_KEYS = [
	"PI_FORK_SPAWN_ID",
	"PI_FORK_PARENT",
	"PI_FORK_PARENT_KEY",
	"PI_FORK_LABEL",
] as const;

function applyForkEnv(env: Record<string, string | undefined> = {}): void {
	for (const key of FORK_ENV_KEYS) delete process.env[key];
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined) process.env[key] = value;
	}
}

interface Harness {
	pi: Parameters<typeof sessionFork>[0];
	ctx: never;
	commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
	sent: Array<{ content: string; customType?: string; options?: unknown }>;
	notices: string[];
	editorText: string[];
	switched: string[];
	handlers: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
	renderers: Map<string, unknown>;
	/** Next value returned by ui.custom (the /forks overlay action). */
	nextAction: unknown;
	/** Next value returned by ui.input. */
	nextInput: string | undefined;
	/** Queued answers for ui.editor; `undefined` = the user cancelled. Empty queue echoes the prefill. */
	editorAnswers: Array<string | undefined>;
	/** Queued answers for ui.select; `undefined` = the user cancelled. Empty queue picks the first option. */
	selectAnswers: Array<string | undefined>;
	/** Every prompt shown, as `select:<title>`, `input:<title>` or `editor:<title>`. */
	prompts: string[];
	userMessages: string[];
	newSessions: Array<{ parentSession?: string }>;
	run: (command: string, args?: string) => Promise<void>;
	fire: (event: string, payload?: unknown) => Promise<void>;
}

function harness(options: {
	sessionId: string;
	sessionFile?: string;
	name?: string;
	cwd?: string;
	env?: Record<string, string | undefined>;
}): Harness {
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const renderers = new Map<string, unknown>();
	const sent: Harness["sent"] = [];
	const notices: string[] = [];
	const editorText: string[] = [];
	const switched: string[] = [];

	const state = { nextAction: null as unknown, nextInput: undefined as string | undefined };
	const editorAnswers: Array<string | undefined> = [];
	const selectAnswers: Array<string | undefined> = [];
	const prompts: string[] = [];
	const userMessages: string[] = [];
	const newSessions: Array<{ parentSession?: string }> = [];

	const ui = {
		notify: (message: string) => notices.push(message),
		setStatus: () => {},
		setWidget: () => {},
		setEditorText: (text: string) => editorText.push(text),
		confirm: async () => true,
		input: async (title: string) => {
			prompts.push(`input:${title}`);
			return state.nextInput;
		},
		custom: async () => state.nextAction,
		editor: async (title: string, prefill = "") => {
			prompts.push(`editor:${title}`);
			return editorAnswers.length > 0 ? editorAnswers.shift() : prefill;
		},
		select: async (title: string, options: string[]) => {
			prompts.push(`select:${title}`);
			return selectAnswers.length > 0 ? selectAnswers.shift() : options[0];
		},
	};

	const sessionManager = {
		getSessionId: () => options.sessionId,
		getSessionFile: () => options.sessionFile,
		getBranch: () => [
			{ type: "message", message: { role: "user", content: "go" } },
			{
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "I finished the thing." }] },
			},
		],
	};

	const ctx = {
		cwd: options.cwd ?? root,
		hasUI: true,
		ui,
		sessionManager,
		waitForIdle: async () => {},
		model: { provider: "anthropic", id: "claude-test" },
		modelRegistry: { complete: async () => ({ stopReason: "stop", content: [] }) },
		newSession: async (opts: { parentSession?: string; withSession?: (fresh: unknown) => Promise<void> }) => {
			newSessions.push({ parentSession: opts.parentSession });
			await opts.withSession?.({
				ui,
				sendUserMessage: async (text: string) => {
					userMessages.push(text);
				},
			});
			return { cancelled: false };
		},
		switchSession: async (path: string) => {
			switched.push(path);
			return { cancelled: false };
		},
	} as unknown as never;

	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand(name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.set(name, definition);
		},
		registerMessageRenderer(type: string, renderer: unknown) {
			renderers.set(type, renderer);
		},
		sendMessage(message: { content: string; customType?: string }, opts?: unknown) {
			sent.push({ ...message, options: opts });
		},
		getSessionName: () => options.name,
		getThinkingLevel: () => "high",
		sendUserMessage: (text: string) => {
			userMessages.push(text);
		},
	} as unknown as Parameters<typeof sessionFork>[0];

	// Identity is env-based, so each simulated session runs with its own
	// PI_FORK_* set. Restoring to a captured "previous" value is wrong here:
	// harnesses interleave, and one would restore another's leaked value. Reset
	// to the pristine baseline instead.
	const withEnv = async <T>(fn: () => Promise<T> | T): Promise<T> => {
		applyForkEnv(options.env);
		try {
			return await fn();
		} finally {
			applyForkEnv({});
		}
	};

	const h: Harness = {
		pi,
		ctx,
		commands,
		sent,
		notices,
		editorText,
		switched,
		handlers,
		renderers,
		get nextAction() {
			return state.nextAction;
		},
		set nextAction(value: unknown) {
			state.nextAction = value;
		},
		editorAnswers,
		selectAnswers,
		prompts,
		userMessages,
		newSessions,
		get nextInput() {
			return state.nextInput;
		},
		set nextInput(value: string | undefined) {
			state.nextInput = value;
		},
		run: async (command, args = "") => {
			const definition = commands.get(command);
			assert.ok(definition, `command /${command} is not registered`);
			await withEnv(() => definition.handler(args, ctx));
		},
		fire: async (event, payload = {}) => {
			await withEnv(async () => {
				for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
			});
		},
	};

	applyForkEnv(options.env);
	sessionFork(pi);
	applyForkEnv({});
	return h;
}

let failures = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
	try {
		await fn();
		console.log(`  ok  ${name}`);
	} catch (error) {
		failures++;
		console.log(`FAIL  ${name}\n      ${(error as Error).message}`);
	}
}

const sessionFileFor = (id: string): string => {
	const path = join(root, "sessions", `2026-01-01_${id}.jsonl`);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, "");
	return path;
};

// --------------------------------------------------------------- tests

console.log("registration");

const parentId = "aaaaaaaa-1111-2222-3333-444444444444";
const parentFile = sessionFileFor(parentId);
const parent = harness({ sessionId: parentId, sessionFile: parentFile, name: "main work" });

await test("registers commands and the mail renderer", async () => {
	for (const name of ["fork-pane", "fork-back", "forks"]) {
		assert.ok(parent.commands.has(name), `missing /${name}`);
	}
	assert.ok(parent.renderers.has("fork-message"), "fork-message renderer registered");
});

await test("session_start registers this session", async () => {
	await parent.fire("session_start", { reason: "startup" });
	const record = registry.findBySessionId(parentId);
	assert.ok(record, "a record exists for the current session");
	assert.equal(record!.key, `s-${parentId}`);
	assert.equal(record!.pid, process.pid);
	assert.equal(record!.name, "main work");
	assert.equal(record!.sessionFile, parentFile);
	assert.ok(!record!.parentKey, "a root session has no parent");
});

console.log("forking out");

let forkKey = "";
await test("/fork-pane hands back a runnable command on the headless backend", async () => {
	parent.notices.length = 0;
	await parent.run("fork-pane", "try approach B");
	const message = parent.notices.join("\n");
	assert.match(message, /No pane backend available/, `unexpected notice: ${message}`);
	assert.match(message, /--fork/, "the command must fork, not resume");
	assert.match(message, new RegExp(parentId), "the command must name the source session");
	assert.match(message, /--name/, "forks are named so /resume can find them");
	assert.match(message, /PI_FORK_PARENT=/, "the child must be told who its parent is");

	const forks = registry.listRecords().filter((r) => r.parentKey === `s-${parentId}`);
	assert.equal(forks.length, 1, "one stub record for the fork");
	forkKey = forks[0]!.key;
	assert.equal(forks[0]!.label, "try approach B");
	assert.equal(forks[0]!.sessionId, undefined, "the child's session id is not known yet");
	assert.ok(forks[0]!.argv?.includes("--fork"));
});

await test("a fork never inherits orchestrator identity", async () => {
	const record = registry.readRecord(forkKey)!;
	const flat = JSON.stringify(record);
	assert.ok(!flat.includes("caller-agent"), "PI_ORCH_AGENT_NAME must not reach the child");
	assert.ok(!flat.includes("caller-team"), "PI_ORCH_TEAM_NAME must not reach the child");
	const notice = parent.notices.join("\n");
	assert.ok(!notice.includes("caller-agent"), "identity must not appear in the command either");
	assert.match(notice, /PI_ORCH_NO_ADOPT=1/, "the child must be barred from adopting a team");
});

await test("--tab and --window pick a layout without changing the command", async () => {
	parent.notices.length = 0;
	await parent.run("fork-pane", "--tab side quest");
	const forks = registry.listRecords().filter((r) => r.label === "side quest");
	assert.equal(forks.length, 1);
	assert.match(parent.notices.join("\n"), /--fork/);
	registry.forgetRecord(forks[0]!.key);
});

await test("/fork-pane with nothing typed asks where to open, then for a label", async () => {
	parent.prompts.length = 0;
	parent.selectAnswers.push("New tab");
	parent.nextInput = "picked label";
	await parent.run("fork-pane");
	parent.nextInput = undefined;
	assert.deepEqual(parent.prompts, ["select:Open the fork where?", "input:Label for the fork (Enter for none)"]);
	const forks = registry.listRecords().filter((r) => r.label === "picked label");
	assert.equal(forks.length, 1);
	registry.forgetRecord(forks[0]!.key);
});

await test("/fork-pane with a typed flag and label asks nothing", async () => {
	parent.prompts.length = 0;
	await parent.run("fork-pane", "--window typed label");
	assert.deepEqual(parent.prompts, []);
	const forks = registry.listRecords().filter((r) => r.label === "typed label");
	assert.equal(forks.length, 1);
	registry.forgetRecord(forks[0]!.key);
});

await test("cancelling the /fork-pane selection forks nothing", async () => {
	const before = registry.listRecords().length;
	parent.selectAnswers.push(undefined);
	await parent.run("fork-pane", "never forked");
	assert.equal(registry.listRecords().length, before);
	assert.match(parent.notices.at(-1) ?? "", /cancelled/i);
});

console.log("the forked child");

const childId = "bbbbbbbb-1111-2222-3333-444444444444";
const childFile = sessionFileFor(childId);
let child: Harness;

await test("the child claims its stub record and keeps the parent link", async () => {
	child = harness({
		sessionId: childId,
		sessionFile: childFile,
		name: "main work ⑂ try approach B",
		env: {
			PI_FORK_SPAWN_ID: forkKey,
			PI_FORK_PARENT: parentId,
			PI_FORK_PARENT_KEY: `s-${parentId}`,
			PI_FORK_LABEL: "try approach B",
		},
	});
	await child.fire("session_start", { reason: "startup" });
	const record = registry.readRecord(forkKey)!;
	assert.equal(record.sessionId, childId, "the stub is filled in, not duplicated");
	assert.equal(record.parentKey, `s-${parentId}`);
	assert.equal(record.parentSessionId, parentId);
	assert.equal(registry.listRecords().length, 2, "no duplicate record for the child");
});

await test("the child is told once that it is a fork", async () => {
	const kickoffs = child.sent.filter((m) => m.content.includes("forked session"));
	assert.equal(kickoffs.length, 1, `expected one kickoff note, got ${kickoffs.length}`);
	assert.match(kickoffs[0]!.content, /try approach B/);
	assert.match(kickoffs[0]!.content, /fork-back/, "it must know how to report back");
	// A reload/resume in the same pane must not repeat it.
	await child.fire("session_start", { reason: "resume" });
	assert.equal(child.sent.filter((m) => m.content.includes("forked session")).length, 1);
});

console.log("forking back");

await test("/fork-back queues a handback for the parent", async () => {
	child.notices.length = 0;
	await child.run("fork-back", "approach B works, see /tmp/b.md");
	const mail = drainEnvelopes(registry.mailRoot(), `s-${parentId}`);
	assert.equal(mail.length, 1, "one handback queued for the parent");
	assert.equal(mail[0]!.kind, "handback");
	assert.match(mail[0]!.content, /approach B works/);
	assert.equal((mail[0] as { meta?: { sessionId?: string } }).meta?.sessionId, childId);
	assert.match(child.notices.join("\n"), /Handback sent to main work/);
});

await test("/fork-back with no message falls back to the last assistant text", async () => {
	await child.run("fork-back");
	const mail = drainEnvelopes(registry.mailRoot(), `s-${parentId}`);
	assert.equal(mail.length, 1);
	assert.match(mail[0]!.content, /I finished the thing/);
});

await test("/fork-back with nothing typed asks how to deliver, whether to exit, then for a message", async () => {
	child.prompts.length = 0;
	child.selectAnswers.push("Deliver quietly, without starting a turn", "Stay in this session");
	child.editorAnswers.push("typed in the prompt");
	await child.run("fork-back");
	assert.deepEqual(
		child.prompts.map((p) => p.split(" ")[0]),
		["select:How", "select:After", "editor:Message"],
	);
	const mail = drainEnvelopes(registry.mailRoot(), `s-${parentId}`);
	assert.equal(mail.length, 1);
	assert.equal(mail[0]!.content, "typed in the prompt");
	assert.equal((mail[0] as { meta?: { turn?: boolean } }).meta?.turn, false);
});

await test("/fork-back with a typed flag and message asks nothing", async () => {
	child.prompts.length = 0;
	await child.run("fork-back", "--turn all typed");
	assert.deepEqual(child.prompts, []);
	assert.equal(drainEnvelopes(registry.mailRoot(), `s-${parentId}`).length, 1);
});

await test("cancelling the /fork-back message sends nothing", async () => {
	child.editorAnswers.push(undefined);
	await child.run("fork-back");
	assert.equal(drainEnvelopes(registry.mailRoot(), `s-${parentId}`).length, 0);
	assert.match(child.notices.at(-1) ?? "", /cancelled/i);
});

await test("a handback is clamped so it cannot flood the parent's context", async () => {
	await child.run("fork-back", "x".repeat(9000));
	const mail = drainEnvelopes(registry.mailRoot(), `s-${parentId}`);
	assert.ok(mail[0]!.content.length < 5000, `content was ${mail[0]!.content.length} chars`);
	assert.match(mail[0]!.content, /truncated/);
});

await test("the parent turns a handback into a message in its own session", async () => {
	parent.sent.length = 0;
	parent.notices.length = 0;
	postEnvelope(registry.mailRoot(), {
		to: `s-${parentId}`,
		from: forkKey,
		kind: "handback",
		content: "branch B is faster",
		meta: { name: "fork B", sessionId: childId, turn: false },
	} as never);
	await new Promise((resolve) => setTimeout(resolve, 2600));
	const delivered = parent.sent.filter((m) => m.content.includes("branch B is faster"));
	assert.equal(delivered.length, 1, `expected delivery, got ${JSON.stringify(parent.sent)}`);
	assert.match(delivered[0]!.content, /handback from fork B/);
	assert.equal((delivered[0]!.options as { triggerTurn?: boolean }).triggerTurn, false);
	assert.ok(
		parent.notices.some((n) => n.includes("handback from fork B")),
		"arrival is also signalled in the UI, since the human was looking elsewhere",
	);
});

await test("a handback triggers a turn by default — control transfer must wake the parent", async () => {
	parent.sent.length = 0;
	postEnvelope(registry.mailRoot(), {
		to: `s-${parentId}`,
		from: forkKey,
		kind: "handback",
		content: "default-turn handback",
		meta: { name: "fork C", sessionId: childId },
	} as never);
	await new Promise((resolve) => setTimeout(resolve, 2600));
	const delivered = parent.sent.filter((m) => m.content.includes("default-turn handback"));
	assert.equal(delivered.length, 1, "delivered exactly once");
	assert.equal(
		(delivered[0]!.options as { triggerTurn?: boolean }).triggerTurn,
		true,
		"a handback with no explicit turn flag must still wake the parent",
	);
});

await test("a plain message stays opt-in and does not spend a turn", async () => {
	parent.sent.length = 0;
	postEnvelope(registry.mailRoot(), {
		to: `s-${parentId}`,
		from: forkKey,
		kind: "message",
		content: "just a note",
		meta: { name: "fork C", sessionId: childId },
	} as never);
	await new Promise((resolve) => setTimeout(resolve, 2600));
	const delivered = parent.sent.filter((m) => m.content.includes("just a note"));
	assert.equal(delivered.length, 1);
	assert.equal((delivered[0]!.options as { triggerTurn?: boolean }).triggerTurn, false);
});

await test("/fork-back --no-turn opts out of the handback default", async () => {
	await child.run("fork-back", "--no-turn quiet result");
	const mail = drainEnvelopes(registry.mailRoot(), `s-${parentId}`);
	assert.equal(mail.length, 1);
	assert.equal((mail[0] as { meta?: { turn?: boolean } }).meta?.turn, false);
});


await test("--turn asks the parent to act immediately", async () => {
	parent.sent.length = 0;
	await child.run("fork-back", "--turn please review /tmp/b.md");
	await new Promise((resolve) => setTimeout(resolve, 2600));
	const delivered = parent.sent.filter((m) => m.content.includes("please review"));
	assert.equal(delivered.length, 1);
	assert.equal((delivered[0]!.options as { triggerTurn?: boolean }).triggerTurn, true);
});

await test("a fork with no parent says so instead of failing silently", async () => {
	const orphan = harness({ sessionId: "cccccccc-0000-0000-0000-000000000000" });
	await orphan.fire("session_start", { reason: "startup" });
	orphan.notices.length = 0;
	await orphan.run("fork-back", "hello?");
	assert.match(orphan.notices.join("\n"), /No parent session recorded/);
});

console.log("/forks actions");

await test("become refuses a session that another process is running", async () => {
	parent.notices.length = 0;
	parent.nextAction = { type: "become", record: registry.readRecord(forkKey) };
	await parent.run("forks");
	assert.equal(parent.switched.length, 0, "must not switch into a live session");
	assert.match(parent.notices.join("\n"), /running in another process/);
});

await test("become switches into a session whose process is gone", async () => {
	registry.patchRecord(forkKey, { pid: 999999, exitedAt: new Date().toISOString() });
	parent.notices.length = 0;
	parent.nextAction = { type: "become", record: registry.readRecord(forkKey) };
	await parent.run("forks");
	assert.deepEqual(parent.switched, [childFile]);
});

await test("open reopens a dead session under the same registry key", async () => {
	parent.notices.length = 0;
	parent.nextAction = { type: "open", record: registry.readRecord(forkKey) };
	await parent.run("forks");
	const message = parent.notices.join("\n");
	assert.match(message, /--session/, "reopening resumes, it does not fork");
	assert.match(message, new RegExp(childId));
	assert.ok(registry.readRecord(forkKey), "the record keeps its key");
});

await test("copy puts a runnable command in the editor", async () => {
	parent.editorText.length = 0;
	parent.nextAction = { type: "copy", record: registry.readRecord(forkKey) };
	await parent.run("forks");
	assert.equal(parent.editorText.length, 1);
	assert.match(parent.editorText[0]!, /--session/);
});

await test("message sends mail to any session, not just the parent", async () => {
	parent.nextInput = "check the other branch too";
	parent.nextAction = { type: "message", record: registry.readRecord(forkKey) };
	await parent.run("forks");
	const mail = drainEnvelopes(registry.mailRoot(), forkKey);
	assert.equal(mail.length, 1);
	assert.match(mail[0]!.content, /check the other branch/);
	assert.equal((mail[0] as { meta?: { turn?: boolean } }).meta?.turn, true);
});

await test("kill refuses to kill the session you are in", async () => {
	parent.notices.length = 0;
	parent.nextAction = { type: "kill", record: registry.findBySessionId(parentId) };
	await parent.run("forks");
	assert.match(parent.notices.join("\n"), /Refusing to kill this session/);
});

console.log("registry hygiene");

await test("a session that switches away retires its old record", async () => {
	const moved = harness({
		sessionId: "dddddddd-0000-0000-0000-000000000000",
		env: { PI_FORK_SPAWN_ID: forkKey },
	});
	await moved.fire("session_start", { reason: "resume" });
	const old = registry.readRecord(forkKey)!;
	assert.equal(old.sessionId, childId, "the fork's record still describes the fork");
	assert.ok(old.exitedAt, "and is marked as no longer running here");
	const fresh = registry.findBySessionId("dddddddd-0000-0000-0000-000000000000");
	assert.ok(fresh, "the new session gets its own record");
	assert.equal(fresh!.key, "s-dddddddd-0000-0000-0000-000000000000");
});

await test("prune drops failed spawns but keeps reopenable sessions", async () => {
	const stale = new Date(Date.now() - 7200_000).toISOString();
	registry.writeRecord({
		key: "fork-never-started",
		cwd: root,
		createdAt: stale,
		lastSeenAt: stale,
	});
	const keptKey = registry.findBySessionId(parentId)!.key;
	const dropped = registry.pruneRecords();
	assert.ok(dropped >= 1, "the failed spawn is dropped");
	assert.equal(registry.readRecord("fork-never-started"), null);
	assert.ok(registry.readRecord(keptKey), "a session with a transcript is never pruned");
	assert.ok(registry.readRecord(forkKey), "a dead fork stays reopenable");
});

await test("session_shutdown marks the record as exited", async () => {
	await parent.fire("session_shutdown", {});
	const record = registry.findBySessionId(parentId)!;
	assert.ok(record.exitedAt, "exitedAt is set");
	assert.equal(record.pid, undefined);
});

await test("registry files are plain JSON another process can read", () => {
	const dir = registry.sessionsDir();
	const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
	assert.ok(files.length > 0);
	for (const file of files) JSON.parse(readFileSync(join(dir, file), "utf8"));
});

await test("/fork-back leaves turn unset so the receiver applies the kind default", async () => {
	await child.run("fork-back", "ordinary result");
	const mail = drainEnvelopes(registry.mailRoot(), `s-${parentId}`);
	assert.equal(mail.length, 1);
	assert.ok(
		!("turn" in ((mail[0] as { meta?: Record<string, unknown> }).meta ?? {})),
		"turn must be absent, not false, or the kind default can never apply",
	);
});

await test("an envelope is claimed before it is read, so two readers cannot both deliver it", () => {
	const address = `s-dup-${process.pid}`;
	postEnvelope(registry.mailRoot(), {
		to: address,
		from: forkKey,
		kind: "handback",
		content: "exactly once",
	} as never);
	const first = drainEnvelopes(registry.mailRoot(), address);
	const second = drainEnvelopes(registry.mailRoot(), address);
	assert.equal(first.length, 1, "first reader gets it");
	assert.equal(second.length, 0, "second reader gets nothing");
});

console.log("handoff");

const handoffParent = harness({ sessionId: "aaaaaaaa-0000-4000-8000-00000000aaaa", sessionFile: join(root, "manager.jsonl"), name: "manager" });
await handoffParent.fire("session_start");

let handoffKey = "";
await test("/handoff-pane writes a brief of summary + your instructions and spawns a fresh session", async () => {
	handoffParent.nextAction = "## Goal\nShip the invite flow.";
	await handoffParent.run("handoff-pane", "build the lessons page next");
	const stub = registry
		.listRecords()
		.find((r: { key: string; parentSessionId?: string }) => r.key.startsWith("handoff-") && r.parentSessionId === "aaaaaaaa-0000-4000-8000-00000000aaaa");
	assert.ok(stub, "a handoff stub record exists");
	handoffKey = stub.key;
	assert.equal(stub.handoffMode, "go");
	assert.equal(stub.handoffConsumed, false);
	const brief = readFileSync(stub.handoffFile, "utf8");
	assert.match(brief, /Ship the invite flow/);
	assert.match(brief, /## From the user\n\nbuild the lessons page next/);
	const argv: string[] = stub.argv;
	assert.ok(!argv.includes("--fork") && !argv.includes("--session"), "a handoff is a fresh session, not a fork");
	assert.deepEqual(argv.slice(1, 5), ["--model", "anthropic/claude-test", "--thinking", "high"]);
	assert.ok(handoffParent.notices.at(-1)?.includes("run this yourself"), "headless prints a runnable command");
});

await test("the successor submits the brief as its first prompt, exactly once", async () => {
	const child = harness({ sessionId: "bbbbbbbb-0000-4000-8000-00000000bbbb", env: { PI_FORK_SPAWN_ID: handoffKey } });
	await child.fire("session_start");
	assert.equal(child.userMessages.length, 1);
	assert.match(child.userMessages[0] as string, /build the lessons page next/);
	assert.equal(child.sent.length, 0, "no fork kickoff note for a handoff");
	await child.fire("session_start");
	assert.equal(child.userMessages.length, 1, "a reopen does not resend the brief");
});

await test("--draft leaves the brief in the successor's editor", async () => {
	handoffParent.nextAction = "## Goal\nDraft me.";
	await handoffParent.run("handoff-pane", "--draft review the cache design");
	const stub = registry
		.listRecords()
		.filter((r: { key: string }) => r.key.startsWith("handoff-") && r.key !== handoffKey)
		.find((r: { handoffMode?: string }) => r.handoffMode === "draft");
	assert.ok(stub);
	const child = harness({ sessionId: "cccccccc-0000-4000-8000-00000000cccc", env: { PI_FORK_SPAWN_ID: stub.key } });
	await child.fire("session_start");
	assert.equal(child.userMessages.length, 0);
	assert.match(child.editorText.at(-1) ?? "", /review the cache design/);
});

await test("cancelling the brief review spawns nothing", async () => {
	const before = registry.listRecords().length;
	handoffParent.nextAction = "## Goal\nNever sent.";
	handoffParent.editorAnswers.push(undefined);
	await handoffParent.run("handoff-pane", "do a thing");
	assert.equal(registry.listRecords().length, before);
	assert.match(handoffParent.notices.at(-1) ?? "", /cancelled/i);
});

await test("--here replaces this session in place and sends the brief", async () => {
	handoffParent.nextAction = "## Goal\nIn place.";
	await handoffParent.run("handoff-pane", "--here continue here");
	assert.equal(handoffParent.newSessions.at(-1)?.parentSession, join(root, "manager.jsonl"));
	assert.match(handoffParent.userMessages.at(-1) ?? "", /continue here/);
});

await test("/handoff-pane with nothing typed asks where, how to start, then for instructions", async () => {
	handoffParent.prompts.length = 0;
	handoffParent.nextAction = "## Goal\nPicked.";
	handoffParent.selectAnswers.push("Replace this session in this pane", "Leave the brief in its editor for me to submit");
	handoffParent.editorAnswers.push("continue the spike");
	const sessions = handoffParent.newSessions.length;
	const messages = handoffParent.userMessages.length;
	await handoffParent.run("handoff-pane");
	assert.deepEqual(
		handoffParent.prompts.map((p) => p.split(" ")[0]),
		["select:Open", "select:When", "editor:What", "editor:Review"],
	);
	assert.equal(handoffParent.newSessions.length, sessions + 1, "replaced in place");
	assert.equal(handoffParent.userMessages.length, messages, "a draft is not submitted");
	assert.match(handoffParent.editorText.at(-1) ?? "", /continue the spike/);
});

await test("/handoff-pane: submitting the instructions empty still writes a brief", async () => {
	const before = registry.listRecords().length;
	handoffParent.nextAction = "## Goal\nNo extra instructions.";
	handoffParent.editorAnswers.push("");
	await handoffParent.run("handoff-pane");
	assert.equal(registry.listRecords().length, before + 1);
	assert.ok(handoffParent.notices.at(-1)?.includes("run this yourself"));
});

// ------------------------------------------------------------- teardown

assert.ok(existsSync(registry.forksRoot()));
rmSync(root, { recursive: true, force: true });

console.log(failures === 0 ? "\nall smoke tests passed" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
