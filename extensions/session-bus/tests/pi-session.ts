/**
 * session-bus against a real pi AgentSession (faux model, no network, temp dirs).
 *
 * The smoke test checks what the extension asks pi to do; this checks that pi
 * then does what we promise the sender: a steering note lands after the
 * receiver's current tool call and before its next model call, without
 * aborting the run; an idle receiver starts a turn; queued mail starts nothing.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "session-bus-pi-"));
process.env.PI_BUS_ROOT = join(root, "bus");

const bus = await import("../bus.ts");
const { default: sessionBus } = await import("../index.ts");
const piSdk = await import("@earendil-works/pi-coding-agent");
const piAi = await import("@earendil-works/pi-ai");
const { Type } = await import("typebox");

let failures = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
	try {
		await fn();
		console.log(`  ok  ${name}`);
	} catch (error) {
		failures++;
		console.log(`FAIL  ${name}\n      ${(error as Error).stack ?? (error as Error).message}`);
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 6000) => {
	const end = Date.now() + ms;
	while (!cond() && Date.now() < end) await sleep(50);
	return cond();
};

type Ctx = { messages: Array<{ role: string; content: unknown }> };
const textOf = (m: { content: unknown }): string =>
	typeof m.content === "string"
		? m.content
		: Array.isArray(m.content)
			? m.content.map((c: { type?: string; text?: string }) => (c.type === "text" ? c.text : "")).join("\n")
			: "";

async function receiver(name: string) {
	const cwd = mkdtempSync(join(root, `${name}-`));
	const agentDir = join(root, `${name}-agent`);
	const faux = piAi.fauxProvider({ provider: `faux-${name}`, models: [{ id: "m" }] });
	const modelRuntime = await piSdk.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.setRuntimeApiKey(`faux-${name}`, "test");
	const slowToolDone: string[] = [];
	const loader = new piSdk.DefaultResourceLoader({
		cwd,
		agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [
			sessionBus,
			(pi) => {
				pi.registerTool({
					name: "slow",
					label: "slow",
					description: "waits",
					parameters: Type.Object({ ms: Type.Number() }),
					async execute(_id, params, signal) {
						await sleep((params as { ms: number }).ms);
						slowToolDone.push(signal?.aborted ? "aborted" : "completed");
						return { content: [{ type: "text", text: "slow done" }], details: undefined };
					},
				});
			},
		],
	} as never);
	await loader.reload();
	const { session } = await piSdk.createAgentSession({
		cwd,
		agentDir,
		model: faux.getModel(),
		thinkingLevel: "off",
		modelRuntime,
		resourceLoader: loader,
		sessionManager: piSdk.SessionManager.inMemory(cwd),
		settingsManager: piSdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
	} as never);
	await session.bindExtensions({});
	const key = session.sessionManager.getSessionId();
	const entry = bus.listSessions().find((e) => e.key === key);
	assert.ok(entry, "receiver registered on the bus");
	return { session, faux, key, entry: entry!, slowToolDone };
}

const sender = { key: "sender-0001", alias: "sender", cwd: "/repo/sender" };

await test("idle receiver: a steer note starts a turn, as a user message, and is confirmed", async () => {
	const r = await receiver("idle");
	const seen: string[] = [];
	r.faux.setResponses([
		(ctx: Ctx) => {
			seen.push(...ctx.messages.filter((m) => m.role === "user").map(textOf));
			return piAi.fauxAssistantMessage("got it");
		},
	]);
	const target = { ...r.entry, address: bus.sessionAddressFor(r.key) };
	const m = bus.send(target, sender, { note: "IDLE-NOTE", delivery: "steer" });
	const ack = await bus.waitForAck(m.id, { timeoutMs: 6000 });
	assert.equal(ack?.status, "started");
	assert.ok(ack?.seenAt, "turn confirmed");
	await until(() => r.session.isIdle && seen.length > 0);
	assert.ok(seen.some((t) => t.includes("IDLE-NOTE")), "the model received the note as a user message");
	assert.ok(seen.some((t) => t.includes('session_send({ to: "sender-0001"')), "with reply instructions");
	r.session.dispose();
});

await test("busy receiver: a steer note waits for the current tool call, lands before the next model call, nothing aborted", async () => {
	const r = await receiver("busy");
	const calls: string[][] = [];
	r.faux.setResponses([
		(ctx: Ctx) => {
			calls.push(ctx.messages.map((m) => `${m.role}:${textOf(m).slice(0, 40)}`));
			return piAi.fauxAssistantMessage(piAi.fauxToolCall("slow", { ms: 1500 }), { stopReason: "toolUse" });
		},
		(ctx: Ctx) => {
			calls.push(ctx.messages.map((m) => `${m.role}:${textOf(m).includes("BUSY-NOTE") ? "BUSY-NOTE" : textOf(m).slice(0, 40)}`));
			return piAi.fauxAssistantMessage("done");
		},
	]);
	const run = r.session.prompt("start working");
	await until(() => calls.length === 1);
	await sleep(200);
	const target = { ...r.entry, address: bus.sessionAddressFor(r.key) };
	const m = bus.send(target, sender, { note: "BUSY-NOTE", wake: true });
	const ack = await bus.waitForAck(m.id, { timeoutMs: 4000 });
	assert.equal(ack?.status, "steered");
	assert.ok(!ack?.seenAt, "not in context while the tool is still running");
	assert.ok(
		r.session.getSteeringMessages().some((t: string) => t.includes("BUSY-NOTE")),
		"shown in the receiver's queued-steering list, like a typed steer",
	);
	await run;
	assert.deepEqual(r.slowToolDone, ["completed"], "the running tool call was not aborted");
	assert.equal(calls.length, 2);
	const second = calls[1]!;
	const toolIdx = second.findIndex((s) => s.startsWith("toolResult:"));
	const noteIdx = second.findIndex((s) => s === "user:BUSY-NOTE");
	assert.ok(toolIdx >= 0 && noteIdx > toolIdx, `note after the tool result: ${JSON.stringify(second)}`);
	assert.ok(bus.readAck(m.id)?.seenAt, "confirmed once it entered the conversation");
	r.session.dispose();
});

await test("queue: nothing starts, the note rides along with the next prompt", async () => {
	const r = await receiver("queue");
	const seen: string[][] = [];
	r.faux.setResponses([
		(ctx: Ctx) => {
			seen.push(ctx.messages.map((m) => `${m.role}:${textOf(m).includes("QUEUE-NOTE") ? "QUEUE-NOTE" : ""}`));
			return piAi.fauxAssistantMessage("ok");
		},
	]);
	const target = { ...r.entry, address: bus.sessionAddressFor(r.key) };
	const m = bus.send(target, sender, { note: "QUEUE-NOTE", delivery: "queue" });
	const ack = await bus.waitForAck(m.id, { timeoutMs: 4000 });
	assert.equal(ack?.status, "queued");
	await sleep(500);
	assert.equal(r.faux.state.callCount, 0, "no turn started");
	await r.session.prompt("hello");
	assert.ok(seen[0]!.some((s) => s.endsWith(":QUEUE-NOTE")), JSON.stringify(seen[0]));
	r.session.dispose();
});

rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "\nall session-bus pi-session tests passed" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
