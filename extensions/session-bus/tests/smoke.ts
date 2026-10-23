/**
 * session-bus smoke test. Two simulated sessions exchange context, including
 * the case that motivated a file-backed bus: the target is not running.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "session-bus-"));
process.env.PI_BUS_ROOT = root;

const bus = await import("../bus.ts");
const { default: sessionBus } = await import("../index.ts");

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

const mk = (key: string, alias: string, cwd: string, pid = process.pid) =>
	bus.announce({ key, address: bus.addressFor(cwd), alias, cwd, pid, startedAt: new Date().toISOString() });
const alpha = mk("aaaa1111", "payments", "/repo/payments");
const beta = mk("bbbb2222", "bakery", "/repo/bakery");

await test("sessions announce themselves and are discoverable", () => {
	const all = bus.listSessions();
	assert.equal(all.length, 2);
	assert.ok(all.every((e) => bus.isLive(e)), "both are live (this pid)");
});

await test("targets resolve by alias, directory, and id prefix", () => {
	assert.equal(bus.resolveTarget("bakery", alpha).entry?.key, beta.key);
	assert.equal(bus.resolveTarget("/repo/bakery", alpha).entry?.key, beta.key);
	assert.equal(bus.resolveTarget("bbbb", alpha).entry?.key, beta.key);
	assert.equal(bus.resolveTarget("bakery", alpha).entry?.alias, "bakery");
	// You cannot send to yourself, and a miss reports the alternatives.
	const miss = bus.resolveTarget("nope", alpha);
	assert.ok(!miss.entry);
	assert.ok((miss.candidates ?? []).length >= 1, "offers candidates");
});

await test("a dead session still accepts mail, delivered on its next start", () => {
	const offline = bus.announce({ key: "cccc3333", address: bus.addressFor("/repo/old"), alias: "archived", cwd: "/repo/old", pid: 2147480000, startedAt: new Date().toISOString() });
	assert.equal(bus.isLive(offline), false);
	bus.send(offline, alpha, { note: "look at this when you return", paths: ["/tmp/x.md"] });
	assert.equal(bus.pendingCount(offline.address), 1, "queued rather than dropped");
	const mail = bus.receive(offline.address);
	assert.equal(mail.length, 1);
	assert.equal(mail[0]!.content, "look at this when you return");
	assert.equal(bus.pendingCount(offline.address), 0, "drained exactly once");
});

await test("messages carry references, and a huge note travels whole as a file", async () => {
	const huge = "x".repeat(bus.MAX_NOTE_CHARS + 500) + "THE-END";
	bus.send(beta, alpha, {
		note: huge,
		paths: ["/tmp/finding.md"],
		sessionRef: alpha.key,
	});
	const [mail] = bus.receive(beta.address);
	assert.ok(mail, "delivered");
	assert.ok(mail!.content.length <= bus.NOTE_PREVIEW_CHARS + 300, "inline part is a preview");
	assert.match(mail!.content, /preview only\. The full note/);
	const [file, ...rest] = mail!.meta?.paths ?? [];
	assert.deepEqual(rest, ["/tmp/finding.md"], "caller's paths kept after the note file");
	const { readFileSync } = await import("node:fs");
	assert.equal(readFileSync(file!, "utf8"), `${huge}\n`, "nothing is lost");
	assert.equal(mail!.meta?.sessionRef, alpha.key);
	const rendered = bus.formatMessage(mail!);
	assert.match(rendered, /from @payments/);
	assert.match(rendered, /\/tmp\/finding.md/);
	assert.match(rendered, /pi --session aaaa1111/, "tells the receiver how to question the sender");
});

await test("identity never comes from the inherited PI_SESSION_FILE", async () => {
	// A pi launched from inside another pi inherits PI_SESSION_FILE pointing at
	// its PARENT. Observed: two sessions in different repos both registered
	// under one key, the second overwriting the first.
	process.env.PI_SESSION_FILE = "/tmp/example-home/.pi/agent/sessions/--repo--/2026_PARENTID-1111.jsonl";
	assert.equal(bus.sessionKey("my-own-id"), "my-own-id", "the manager's id wins");
	assert.match(bus.sessionKey(undefined), /^pid-\d+$/, "fall back to this process, never the parent");
	assert.notEqual(bus.sessionKey(undefined), "PARENTID-1111");
	delete process.env.PI_SESSION_FILE;
});

await test("two sessions in different directories get distinct registry entries", () => {
	const a = mk("key-one", "repo-a", "/repo/a");
	const b = mk("key-two", "repo-b", "/repo/b");
	const keys = bus.listSessions().map((e) => e.key);
	assert.ok(keys.includes(a.key) && keys.includes(b.key), "both survive; neither overwrites the other");
	assert.equal(new Set(keys).size, keys.length, "no duplicate keys");
});

await test("mail survives the target restarting with a new session id", async () => {
	// The live failure: beta restarted, got a fresh session id, and the mail
	// queued for its previous id was orphaned. Addressing is per DIRECTORY.
	const first = mk("run-one", "worktree", "/repo/worktree");
	bus.send(first, alpha, { note: "read this when you come back" });
	assert.equal(bus.pendingCount(first.address), 1);
	// Same directory, brand-new session id — a restart.
	const second = mk("run-two", "worktree", "/repo/worktree");
	assert.equal(second.address, first.address, "address is stable across restarts");
	const mail = bus.receive(second.address);
	assert.equal(mail.length, 1, "the restarted session still gets it");
	assert.equal(mail[0]!.content, "read this when you come back");
});

await test("one row per directory, preferring the live session", () => {
	mk("dead-1", "dupe", "/repo/dupe", 2147480000);
	const live = mk("live-1", "dupe", "/repo/dupe");
	const rows = bus.listAddresses().filter((e) => e.cwd === "/repo/dupe");
	assert.equal(rows.length, 1, "restarts do not pile up as separate targets");
	assert.equal(rows[0]!.key, live.key, "the live session represents the address");
});

await test("discovery finds running pi processes, not just registered ones", () => {
	// The registry only knows sessions that STARTED after this extension was
	// installed. On a real machine that was 3 of 28 — everything else was
	// invisible and unsendable.
	const running = bus.discoverRunning();
	// This process is not pi, so the result may legitimately be empty in CI;
	// what must hold is the shape and the self-exclusion.
	for (const proc of running) {
		assert.ok(Number.isFinite(proc.pid) && proc.pid > 0);
		assert.notEqual(proc.pid, process.pid, "never lists itself");
		assert.equal(typeof proc.cwd, "string");
		assert.equal(typeof proc.isAgent, "boolean");
	}
	// Registered-but-not-running sessions still appear as targets.
	const offline = mk("disc-1", "quiet", "/repo/quiet", 2147480000);
	const targets = bus.listAddresses();
	const found = targets.find((t) => t.address === offline.address);
	assert.ok(found, "a registered session is always a target");
	assert.equal(found!.running, 0);
	assert.equal(bus.isReachable(found!), false);
});

await test("a running session without the bus is offered, but flagged", () => {
	// Sending is still useful — the mail waits — but the human must know it
	// will not land until that session restarts or reloads.
	const targets = bus.listAddresses();
	for (const t of targets) {
		if (!t.busAware) {
			assert.ok(t.running > 0, "only discovered processes lack the bus");
			assert.equal(bus.isReachable(t), true, "reachable as a place, even without the bus");
		}
	}
	const registered = targets.find((t) => t.busAware);
	assert.ok(registered, "registered sessions are marked bus-aware");
});

await test("the interactive flow hands the agent enough to gather context itself", () => {
	// The human picks a session and says what to send; the session that HAS the
	// context decides which files and findings that means.
	const target = mk("t-1", "payments api", "/repo/payments-api");
	const prompt = bus.buildSendPrompt(target, "the currency formatting decision and what it touches");
	assert.match(prompt, /session_send/, "names the tool to call");
	assert.match(prompt, /to="repo-payments-api"/, "pins the resolved address, not a guess");
	assert.match(prompt, /the currency formatting decision and what it touches/, "carries the human's intent");
	assert.match(prompt, /paths/, "asks for file references");
	assert.match(prompt, /only in this conversation/, "asks it to surface context that has no file");
	assert.match(prompt, /shareSession/, "offers follow-up questioning");
	assert.match(prompt, /not a transcript/, "guards against dumping context");
	assert.match(prompt, /currently live/, "tells the agent whether the target is running");

	const offline = mk("t-2", "old", "/repo/old", 2147480000);
	assert.match(
		bus.buildSendPrompt(offline, "x"),
		/offline; it will receive this when it next starts/,
		"an offline target is not a reason to refuse",
	);
});

type Handler = (e: unknown, c: unknown) => unknown;
type ToolResult = { content: Array<{ text: string }>; details?: Record<string, unknown> };
type Tool = { execute: (id: string, p: unknown, signal?: AbortSignal) => Promise<ToolResult> };

/**
 * A stand-in for one pi session with the extension loaded. `sendUserMessage`
 * follows pi's documented semantics: idle starts a turn (and the user message
 * enters the conversation at once), busy queues it as steering, entering the
 * conversation only when `finishStep()` is called.
 */
function fakeSession(opts: { name: string; cwd: string; key: string; idle?: boolean }) {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, Tool>();
	const custom: Array<{ content: string; options: { deliverAs?: string; triggerTurn?: boolean } }> = [];
	const user: Array<{ content: string; options: { deliverAs?: string } }> = [];
	const steeringQueue: string[] = [];
	const state = { idle: opts.idle ?? true, aborts: 0, turnsStarted: 0 };
	const emit = async (name: string, event: unknown) => {
		for (const h of handlers.get(name) ?? []) await h(event, ctx);
	};
	const pi = {
		on: (e: string, h: Handler) => handlers.set(e, [...(handlers.get(e) ?? []), h]),
		registerTool: (d: { name: string }) => tools.set(d.name, d as never),
		registerCommand: () => {},
		getSessionName: () => opts.name,
		sendMessage: (m: { content: string }, o: unknown) => custom.push({ content: m.content, options: (o ?? {}) as never }),
		sendUserMessage: (content: string, o: unknown) => {
			user.push({ content, options: (o ?? {}) as never });
			if (state.idle) {
				state.turnsStarted++;
				state.idle = false;
				void emit("message_start", { message: { role: "user", content: [{ type: "text", text: content }] } });
			} else steeringQueue.push(content);
		},
	} as unknown as Parameters<typeof sessionBus>[0];
	const ctx = {
		cwd: opts.cwd,
		hasUI: false,
		ui: { notify() {} },
		isIdle: () => state.idle,
		abort: () => state.aborts++,
		sessionManager: { getSessionId: () => opts.key },
	};
	sessionBus(pi);
	return {
		state,
		custom,
		user,
		tools,
		emit,
		start: () => emit("session_start", { reason: "startup" }),
		stop: () => emit("session_shutdown", {}),
		finishStep: async () => {
			for (const text of steeringQueue.splice(0)) {
				await emit("message_start", { message: { role: "user", content: [{ type: "text", text }] } });
			}
		},
	};
}

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 4000) => {
	const end = Date.now() + ms;
	while (!cond() && Date.now() < end) await settle(50);
};

await test("delivery: steer by default, queue on request, wake as an alias for steer", () => {
	assert.equal(bus.resolveDelivery({}), "steer");
	assert.equal(bus.resolveDelivery({ wake: true }), "steer");
	assert.equal(bus.resolveDelivery({ delivery: "steer" }), "steer");
	assert.equal(bus.resolveDelivery({ delivery: "queue", wake: true }), "queue", "explicit delivery wins");
	const sent = bus.send(beta, alpha, { note: "w", wake: true });
	assert.equal(sent.meta?.delivery, "steer");
	assert.equal(sent.meta?.wake, true, "older receivers still see wake");
	bus.receive(beta.address);
	const legacy = { ...sent, meta: { ...sent.meta, delivery: undefined } } as typeof sent;
	assert.equal(bus.deliveryOf(legacy), "steer", "mail from an older sender with wake:true steers");
});

await test("queue mail is shown at the next prompt, starts nothing, and is acked as queued", async () => {
	const r = fakeSession({ name: "q-recv", cwd: "/repo/q-recv", key: "q-recv-0001", idle: false });
	await r.start();
	const m = bus.send(mk("q-recv-0001", "q-recv", "/repo/q-recv"), alpha, { note: "normal priority", delivery: "queue" });
	await until(() => r.custom.length > 0);
	assert.equal(r.custom.length, 1);
	assert.equal(r.custom[0]!.options.deliverAs, "nextTurn", "must not start a turn");
	assert.ok(!r.custom[0]!.options.triggerTurn);
	assert.equal(r.user.length, 0);
	assert.equal(bus.readAck(m.id)?.status, "queued");
	assert.equal(r.state.aborts, 0);
	await r.stop();
});

await test("steer to a busy receiver queues a steering user message and never aborts", async () => {
	const r = fakeSession({ name: "s-busy", cwd: "/repo/s-busy", key: "s-busy-0001", idle: false });
	await r.start();
	const m = bus.send(mk("s-busy-0001", "s-busy", "/repo/s-busy"), alpha, { note: "please steer", delivery: "steer" });
	await until(() => r.user.length > 0);
	assert.equal(r.user.length, 1);
	assert.equal(r.user[0]!.options.deliverAs, "steer");
	assert.equal(r.custom.length, 0, "a visible user message, not a hidden custom one");
	assert.match(r.user[0]!.content, /from @payments/);
	assert.match(r.user[0]!.content, /aaaa1111/, "names the sender's session");
	assert.match(r.user[0]!.content, /\/repo\/payments/, "names the sender's directory");
	assert.match(r.user[0]!.content, /session_send\(\{ to: "aaaa1111"/, "says how to reply");
	assert.equal(r.state.turnsStarted, 0);
	assert.equal(r.state.aborts, 0, "the current run is left alone");
	const ack = bus.readAck(m.id);
	assert.equal(ack?.status, "steered");
	assert.equal(ack?.receiverKey, "s-busy-0001");
	assert.ok(!ack?.seenAt, "not seen until the current step ends");
	await r.finishStep();
	assert.ok(bus.readAck(m.id)?.seenAt, "seen once it enters the conversation");
	await r.stop();
});

await test("steer to an idle receiver starts a turn and confirms it", async () => {
	const r = fakeSession({ name: "s-idle", cwd: "/repo/s-idle", key: "s-idle-0001", idle: true });
	await r.start();
	const m = bus.send(mk("s-idle-0001", "s-idle", "/repo/s-idle"), alpha, { note: "wake up", wake: true });
	await until(() => r.user.length > 0);
	assert.equal(r.state.turnsStarted, 1, "idle receiver starts a turn");
	assert.equal(bus.readAck(m.id)?.status, "started");
	await until(() => Boolean(bus.readAck(m.id)?.seenAt), 1000);
	assert.ok(bus.readAck(m.id)?.seenAt);
	await r.stop();
});

await test("steer during a manual compaction waits for it to end", async () => {
	const r = fakeSession({ name: "s-comp", cwd: "/repo/s-comp", key: "s-comp-0001", idle: false });
	await r.start();
	await r.emit("session_before_compact", { reason: "manual" });
	const m = bus.send(mk("s-comp-0001", "s-comp", "/repo/s-comp"), alpha, { note: "after compaction", delivery: "steer" });
	await until(() => bus.readAck(m.id) !== null);
	assert.equal(bus.readAck(m.id)?.status, "deferred");
	assert.equal(r.user.length, 0, "pi rejects prompts during compaction, so hold it");
	r.state.idle = true;
	await r.emit("session_compact", { reason: "manual" });
	assert.equal(r.user.length, 1, "delivered once compaction ends");
	assert.equal(bus.readAck(m.id)?.status, "started");
	await r.stop();
});

await test("mail left while away is delivered at startup by its own mode", async () => {
	const target = mk("away-0001", "away", "/repo/away");
	bus.send(target, alpha, { note: "left queued", delivery: "queue" });
	bus.send(target, alpha, { note: "left steering", delivery: "steer" });
	const r = fakeSession({ name: "away", cwd: "/repo/away", key: "away-0001", idle: true });
	await r.start();
	assert.equal(r.custom.length, 1);
	assert.match(r.custom[0]!.content, /arrived while this session was away/);
	assert.match(r.custom[0]!.content, /left queued/);
	assert.equal(r.user.length, 1);
	assert.match(r.user[0]!.content, /left steering/);
	await r.stop();
});

await test("session_send reports what the receiver actually did", async () => {
	process.env.PI_BUS_ACK_WAIT_MS = "4000";
	const sender = fakeSession({ name: "sender", cwd: "/repo/ack-sender", key: "01aa0000-sender" });
	const idle = fakeSession({ name: "idle-recv", cwd: "/repo/ack-idle", key: "01bb0000-idle" , idle: true });
	const busy = fakeSession({ name: "busy-recv", cwd: "/repo/ack-busy", key: "01cc0000-busy", idle: false });
	await sender.start();
	await idle.start();
	await busy.start();
	const tool = sender.tools.get("session_send")!;
	const say = async (p: Record<string, unknown>) => (await tool.execute("t", p)).content[0]!.text;

	const steered = await say({ to: "01cc0000-busy", note: "n", delivery: "steer" });
	assert.match(steered, /Delivered as steering/, steered);
	assert.match(steered, /after its current step/);
	assert.doesNotMatch(steered, /interrupted now/);
	assert.equal(busy.state.aborts, 0);

	const started = await say({ to: "01bb0000-idle", note: "n", wake: true });
	assert.match(started, /was idle; started a turn/, started);

	const queued = await say({ to: "01cc0000-busy", note: "n", delivery: "queue" });
	const byDefault = await say({ to: "01bb0000-idle", note: "n" });
	assert.match(byDefault, /started a turn|Delivered as steering/, `steer is the default: ${byDefault}`);
	assert.match(queued, /queued: it will see the note with its next prompt/, queued);

	// Registered and live, but nobody is reading the inbox: say so, do not claim delivery.
	mk("01dd0000-silent", "silent", "/repo/ack-silent");
	process.env.PI_BUS_ACK_WAIT_MS = "300";
	const silent = await say({ to: "01dd0000-silent", note: "n", delivery: "steer" });
	assert.match(silent, /Not picked up within/, silent);
	assert.match(silent, /still in the receiver's inbox/);
	assert.match(silent, /as steering/);

	// Drained by a receiver that does not ack (an older session-bus): never claim it is still queued.
	const legacyTarget = mk("01dd1111-legacy", "legacy", "/repo/ack-legacy");
	const legacyReader = setInterval(() => bus.receive(bus.sessionAddressFor(legacyTarget.key)), 20);
	const legacy = await say({ to: "01dd1111-legacy", note: "n", delivery: "steer" });
	clearInterval(legacyReader);
	assert.match(legacy, /did not acknowledge/, legacy);
	assert.match(legacy, /not confirmed/);

	// An offline target is not waited on.
	bus.announce({ key: "01ee0000-gone", address: bus.addressFor("/repo/ack-gone"), alias: "gone", cwd: "/repo/ack-gone", pid: 2147480000, startedAt: new Date().toISOString() });
	const offline = await say({ to: "/repo/ack-gone", note: "n" });
	assert.match(offline, /offline: queued until it next starts/, offline);
	delete process.env.PI_BUS_ACK_WAIT_MS;
	for (const s of [sender, idle, busy]) await s.stop();
});

await test("the reply address on a delivered note resolves to that one session", () => {
	const solo = mk("01ff0000-solo-sender", "solo", "/repo/solo");
	const me = mk("01ff1111-me", "me", "/repo/me");
	const exact = bus.resolveTarget(solo.key, me).entry;
	assert.equal(exact?.kind, "session");
	assert.equal(exact?.address, bus.sessionAddressFor(solo.key));
});

await test("a sibling session in the same directory is listed and reachable on its own", () => {
	const here = "/repo/shared";
	const me = mk("dddd4444", "planning", here);
	const sibling = mk("eeee5555", "invite rollout", here);
	const targets = bus.listTargets(me);
	const row = targets.find((t) => t.key === sibling.key && t.kind === "session");
	assert.ok(row, "sibling appears as a session row");
	assert.ok(!targets.some((t) => t.key === me.key && t.kind === "session"), "never lists itself");
	assert.ok(!targets.some((t) => t.kind === "directory" && t.address === me.address), "own directory row hidden");

	const resolved = bus.resolveTarget("eeee", me);
	assert.equal(resolved.entry?.kind, "session");
	assert.equal(resolved.entry?.address, bus.sessionAddressFor(sibling.key));
	bus.send(resolved.entry!, me, { note: "for the sibling only" });
	assert.equal(bus.pendingCount(me.address), 0, "not dropped into the shared directory inbox");
	const mail = bus.receive(bus.sessionAddressFor(sibling.key));
	assert.equal(mail[0]?.content, "for the sibling only");
});

await test("a busy directory elsewhere lists each session, and the bare name still means the directory", () => {
	const there = "/repo/busy";
	mk("ffff6666", "one", there);
	mk("gggg7777", "two", there);
	const sender = mk("hhhh8888", "sender", "/repo/elsewhere");
	const collapsed = bus.listTargets(sender);
	assert.equal(collapsed.filter((t) => t.cwd === there).length, 1, "one folder row by default");
	assert.equal(collapsed.find((t) => t.cwd === there)?.running, 0, "registry-only test sessions, no OS processes");
	const targets = bus.listTargets(sender, { expandOthers: true });
	assert.equal(targets.filter((t) => t.cwd === there && t.kind === "session").length, 2);
	assert.equal(bus.resolveTarget("/repo/busy", sender).entry?.kind, "directory");
	assert.equal(bus.resolveTarget("gggg", sender).entry?.key, "gggg7777");
});

await test("the extension watches its own session inbox as well as its directory", async () => {
	const delivered: string[] = [];
	const handlers: Record<string, (e: unknown, c: unknown) => Promise<void>> = {};
	const pi = {
		on: (name: string, fn: (e: unknown, c: unknown) => Promise<void>) => (handlers[name] = fn),
		registerTool: () => {},
		registerCommand: () => {},
		sendMessage: (m: { content: string }) => delivered.push(m.content),
		getSessionName: () => "watcher",
	};
	const key = "iiii9999";
	bus.send(
		{ ...mk("tmp-target", "x", "/repo/watch"), address: bus.sessionAddressFor(key) },
		{ key: "zz", alias: "zz", cwd: "/z" },
		{ note: "queued for one session", delivery: "queue" },
	);
	sessionBus(pi as never);
	await handlers.session_start!({}, { cwd: "/repo/watch", sessionManager: { getSessionId: () => key } });
	assert.ok(delivered.some((d) => d.includes("queued for one session")), "delivered on start");
	await handlers.session_shutdown!({}, {});
});


await test("session_send asks the human first: additions travel, cancel stops it, no UI skips it", async () => {
	process.env.PI_BUS_ACK_WAIT_MS = "2000";
	const sender = fakeSession({ name: "asker", cwd: "/repo/ask-sender", key: "01ab0000-asker" });
	const recv = fakeSession({ name: "ask-recv", cwd: "/repo/ask-recv", key: "01ac0000-recv", idle: true });
	await sender.start();
	await recv.start();
	const tool = sender.tools.get("session_send")!;
	const asked: string[] = [];
	const ctxSaying = (answer: string | undefined) => ({
		hasUI: true,
		ui: { input: async (title: string) => (asked.push(title), answer) },
	});

	const cancelled = await tool.execute("t", { to: "01ac0000-recv", note: "do not send me" }, undefined, undefined, ctxSaying("cancel"));
	assert.match(cancelled.content[0]!.text, /Not sent: the user cancelled/);
	assert.equal(recv.user.length, 0, "nothing delivered");
	assert.match(asked[0]!, /Sending to ask-recv: "do not send me"\. Anything else they should know\?/);

	await tool.execute("t", { to: "01ac0000-recv", note: "the plan" }, undefined, undefined, ctxSaying("  also check ABC-5643  "));
	await until(() => recv.user.length > 0);
	assert.match(recv.user[0]!.content, /the plan/);
	assert.match(recv.user[0]!.content, /From the user, added before sending: also check ABC-5643/);

	await tool.execute("t", { to: "01ac0000-recv", note: "as is" }, undefined, undefined, ctxSaying(undefined));
	await until(() => recv.user.length > 1);
	assert.doesNotMatch(recv.user[1]!.content, /added before sending/, "Enter, Esc or timeout sends as is");

	const before = asked.length;
	await tool.execute("t", { to: "01ac0000-recv", note: "headless" }, undefined, undefined, { hasUI: false });
	assert.equal(asked.length, before, "a headless session is never asked");
	delete process.env.PI_BUS_ACK_WAIT_MS;
	for (const s of [sender, recv]) await s.stop();
});

const labels = await import("../labels.ts");

await test("picker rows keep the fork marker and id visible on a narrow terminal", () => {
	const row = labels.formatRow(
		{ state: "●", alias: "🔧 resolve skill collisions and YAML error ⑂ yji0", id: "01a1265e", detail: "~/files/garden-api" },
		40,
	);
	assert.ok(row.includes("⑂yji0"), row);
	assert.ok(row.includes("01a1265e"), row);
	assert.ok(labels.displayWidth(row) <= 40, `fits: ${labels.displayWidth(row)} ${row}`);
	assert.ok(row.includes("…"), "name shortened, not the marker");
});

await test("non-fork names are not mistaken for forks, and CJK width counts double", () => {
	assert.deepEqual(labels.splitName("garden-api"), { name: "garden-api" });
	assert.deepEqual(labels.splitName("✉️ Plan invite ⑂ 9nim"), { name: "✉️ Plan invite", fork: "9nim" });
	assert.equal(labels.displayWidth("雪季"), 4);
	assert.ok(labels.displayWidth(labels.truncate("教练账户已开通邀请邮件", 9)) <= 9);
});

const pickerMod = await import("../picker.ts");

await test("the picker shows a fixed window that scrolls with the cursor", () => {
	const rows = Array.from({ length: 30 }, (_, i) => ({ state: "●", alias: `session ${i}`, id: `id${i}` }));
	let picked: number | undefined = -1;
	const picker = new pickerMod.Picker("Send to", rows, (i) => (picked = i), undefined, () => 30);
	const shown = (lines: string[]) => lines.filter((l) => /session \d+/.test(l));
	assert.equal(shown(picker.render(80)).length, 12, "window height is capped");
	for (let i = 0; i < 15; i++) picker.handleInput("\x1b[B");
	const lines = picker.render(80);
	assert.ok(lines.some((l) => l.startsWith("→") && l.includes("session 15")), "cursor row visible");
	assert.ok(!shown(lines).some((l) => l.includes("session 0 ")), "top rows scrolled away");
	assert.ok(lines.some((l) => l.includes("↑") && l.includes("more")), "says how many are above");
	picker.handleInput("\r");
	assert.equal(picked, 15);
});

await test("typing filters the picker; escape clears, then cancels", () => {
	const rows = [
		{ state: "●", alias: "🔧 resolve skill collisions ⑂ yji0", id: "01a1265e", search: "/home/user/files/garden-api" },
		{ state: "●", alias: "run garden portal", id: "01a12652", search: "/home/user/files/garden-portal" },
	];
	let picked: number | undefined = -1;
	const picker = new pickerMod.Picker("Send to", rows, (i) => (picked = i), undefined, () => 30);
	for (const ch of "portal") picker.handleInput(ch);
	assert.ok(picker.render(80).some((l) => l.startsWith("→") && l.includes("run garden portal")));
	picker.handleInput("\x1b");
	assert.equal(picked, -1, "first escape only clears the filter");
	picker.handleInput("\x1b");
	assert.equal(picked, undefined, "second escape cancels");
});

rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "\nall session-bus tests passed" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
