// Model-free smoke test for lead-output-cap: node --experimental-strip-types tests/smoke.ts

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capToolResult, createLeadOutputCap, DEFAULTS, isOrchestratorWorker, parseSettings, pruneOutputs } from "../index.ts";

let failures = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
	try {
		await fn();
		console.log(`  ok  ${name}`);
	} catch (error) {
		failures++;
		console.log(`  FAIL ${name}\n${(error as Error).stack}`);
	}
}

type Handler = (event: unknown, ctx: unknown) => unknown;

function load(options: { env?: NodeJS.ProcessEnv; settings?: unknown } = {}) {
	const agentDir = mkdtempSync(join(tmpdir(), "lead-cap-"));
	if (options.settings !== undefined) {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ leadOutputCap: options.settings }));
	}
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on: (name: string, handler: Handler) => {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			return () => {};
		},
	};
	createLeadOutputCap({ agentDir, env: options.env ?? {} })(pi as never);
	const fire = async (name: string, event: unknown, mode = "tui") => {
		const ctx = { mode, sessionManager: { getSessionId: () => "sess-123" } };
		let out: unknown;
		for (const handler of handlers.get(name) ?? []) out = await handler(event, ctx);
		return out as { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown } | undefined;
	};
	return { agentDir, handlers, fire };
}

const bigText = (lines: number, width = 80) =>
	Array.from({ length: lines }, (_, i) => `line ${i + 1} ${"x".repeat(width)}`).join("\n");

const event = (over: Record<string, unknown> = {}) => ({
	type: "tool_result",
	toolCallId: "call_abc",
	toolName: "bash",
	input: { command: "cat big" },
	content: [{ type: "text", text: bigText(500) }],
	isError: false,
	details: undefined,
	...over,
});

await test("a large result is saved in full and replaced by head, tail, size and path", async () => {
	const { agentDir, fire } = load();
	const original = bigText(500);
	const out = await fire("tool_result", event());
	const text = out?.content?.[0]?.text ?? "";
	const saved = join(agentDir, "run", "outputs", "sess-123", "call_abc.txt");
	assert.equal(readFileSync(saved, "utf8"), original);
	assert.match(text, /^line 1 /);
	assert.match(text, /\nline 40 x+\n… \[440 lines omitted\] …\nline 481 /);
	assert.match(text, /line 500 x+\n/);
	assert.ok(!text.includes("line 41 "));
	assert.ok(text.includes(saved));
	assert.match(text, /500 lines/);
	assert.match(text, /KB/);
	assert.match(text, /offset\/limit/);
	assert.ok(Buffer.byteLength(text) < Buffer.byteLength(original));
});

await test("a result under the threshold passes through untouched", async () => {
	const { fire } = load();
	assert.equal(await fire("tool_result", event({ content: [{ type: "text", text: bigText(20) }] })), undefined);
});

await test("the threshold and line counts come from settings.leadOutputCap", async () => {
	const { fire } = load({ settings: { thresholdBytes: 100, headLines: 2, tailLines: 1 } });
	const out = await fire("tool_result", event({ content: [{ type: "text", text: bigText(5) }] }));
	const text = out?.content?.[0]?.text ?? "";
	assert.match(text, /^line 1 x+\nline 2 x+\n… \[2 lines omitted\] …\nline 5 x+\n/);
});

await test("orchestrator workers get no handler at all", () => {
	const { handlers } = load({ env: { PI_ORCH_AGENT_NAME: "w1", PI_ORCH_TEAM_NAME: "t" } });
	assert.equal(handlers.size, 0);
	assert.equal(isOrchestratorWorker({ PI_ORCH_ALLOW_LEAD_AWAIT: "1" }), false);
});

await test("print and json modes are left alone; rpc and tui are capped", async () => {
	const { fire } = load();
	assert.equal(await fire("tool_result", event(), "print"), undefined);
	assert.equal(await fire("tool_result", event(), "json"), undefined);
	assert.ok(await fire("tool_result", event(), "rpc"));
});

await test("an explicit small read range is exempt; a whole-file read is capped", async () => {
	const { fire } = load();
	const small = event({ toolName: "read", input: { path: "/x", offset: 10, limit: 300 } });
	assert.equal(await fire("tool_result", small), undefined);
	const wide = event({ toolName: "read", input: { path: "/x", offset: 10, limit: 2000 } });
	assert.ok(await fire("tool_result", wide));
	assert.ok(await fire("tool_result", event({ toolName: "read", input: { path: "/x" } })));
});

await test("image results, listed tools and nested calls are exempt", async () => {
	const { fire } = load({ settings: { exemptTools: ["team_await"] } });
	const image = event({ content: [{ type: "text", text: bigText(500) }, { type: "image", data: "AAA", mimeType: "image/png" }] });
	assert.equal(await fire("tool_result", image), undefined);
	assert.equal(await fire("tool_result", event({ toolName: "team_await" })), undefined);
	assert.equal(await fire("tool_result", event({ parentToolCallId: "p1", toolCallId: "p1/1" })), undefined);
});

await test("errors under 32 KB are exempt, larger errors are capped", async () => {
	const { fire } = load();
	const mid = bigText(300);
	assert.ok(Buffer.byteLength(mid) > 16384 && Buffer.byteLength(mid) < 32768);
	assert.equal(await fire("tool_result", event({ isError: true, content: [{ type: "text", text: mid }] })), undefined);
	const out = await fire("tool_result", event({ isError: true, content: [{ type: "text", text: bigText(400) }] }));
	assert.ok(out?.content?.[0]?.text?.includes("lead-output-cap"));
});

await test("non-error text with failure markers is exempt up to the failure limit", async () => {
	const { fire } = load();
	const lines = bigText(150).split("\n");
	lines[70] = "Traceback (most recent call last):";
	const text = lines.join("\n");
	assert.ok(Buffer.byteLength(text) > 8192 && Buffer.byteLength(text) < 32768);
	assert.equal(await fire("tool_result", event({ content: [{ type: "text", text }] })), undefined);
	assert.ok(await fire("tool_result", event({ content: [{ type: "text", text: bigText(150) }] })));
});

await test("a large error keeps its middle failure lines with context in the excerpt", async () => {
	const { fire } = load();
	const lines = bigText(1000).split("\n");
	lines[499] = "FAIL spec/widget_spec.rb:42 expected 3 got 4";
	lines[700] = "Error: connect ECONNREFUSED";
	const out = await fire("tool_result", event({ isError: true, content: [{ type: "text", text: lines.join("\n") }] }));
	const text = out?.content?.[0]?.text ?? "";
	assert.match(text, /\n500: FAIL spec\/widget_spec\.rb:42 expected 3 got 4\n/);
	assert.match(text, /\n498: line 498 x+\n499: line 499 x+\n500: FAIL/);
	assert.match(text, /\n501: line 501 x+\n502: line 502 x+\n/);
	assert.match(text, /\n701: Error: connect ECONNREFUSED\n/);
	assert.match(text, /\nline 40 x+\n… \[457 lines omitted\] …\n\[lines matching failure markers/);
	assert.ok(!text.includes("503: "));
});

await test("saved outputs are private: dirs 0700, files 0600", async () => {
	const { agentDir, fire } = load();
	await fire("tool_result", event({ structuredContent: { token: "fake-secret" } }));
	const outputs = join(agentDir, "run", "outputs");
	const session = join(outputs, "sess-123");
	assert.equal(statSync(outputs).mode & 0o777, 0o700);
	assert.equal(statSync(session).mode & 0o777, 0o700);
	assert.equal(statSync(join(session, "call_abc.txt")).mode & 0o777, 0o600);
	assert.equal(statSync(join(session, "call_abc.structured.json")).mode & 0o777, 0o600);
});

await test("secret-bearing tools are never saved and pass through", async () => {
	const { agentDir, fire } = load({ settings: { secretTools: ["vault_read", "mcp__secrets__*"] } });
	assert.equal(await fire("tool_result", event({ toolName: "vault_read" })), undefined);
	assert.equal(await fire("tool_result", event({ toolName: "mcp__secrets__get", toolCallId: "c2" })), undefined);
	assert.equal(existsSync(join(agentDir, "run", "outputs", "sess-123")), false);
	assert.ok(await fire("tool_result", event({ toolName: "mcp__other__get", toolCallId: "c3" })));
});

await test("session start prunes saved outputs older than retentionDays", async () => {
	const { agentDir, fire } = load({ settings: { retentionDays: 7 } });
	const oldDir = join(agentDir, "run", "outputs", "old-session");
	mkdirSync(oldDir, { recursive: true });
	writeFileSync(join(oldDir, "a.txt"), "old");
	const eightDays = new Date(Date.now() - 8 * 86_400_000);
	utimesSync(join(oldDir, "a.txt"), eightDays, eightDays);
	const keepDir = join(agentDir, "run", "outputs", "recent");
	mkdirSync(keepDir, { recursive: true });
	writeFileSync(join(keepDir, "b.txt"), "new");
	await fire("session_start", { type: "session_start" });
	assert.equal(existsSync(oldDir), false);
	assert.equal(existsSync(join(keepDir, "b.txt")), true);
	assert.equal(pruneOutputs(join(agentDir, "run", "outputs"), 0), 0);
});

await test("structuredContent is replaced with a pointer and saved beside the text", async () => {
	const { agentDir, fire } = load();
	const out = await fire("tool_result", event({ structuredContent: { rows: [1, 2, 3] } }));
	const pointer = (out?.structuredContent as { leadOutputCap: { savedPath: string; structuredPath: string; truncated: boolean } })
		.leadOutputCap;
	assert.equal(pointer.truncated, true);
	assert.equal(pointer.savedPath, join(agentDir, "run", "outputs", "sess-123", "call_abc.txt"));
	assert.deepEqual(JSON.parse(readFileSync(pointer.structuredPath, "utf8")), { rows: [1, 2, 3] });
	const plain = await fire("tool_result", event({ toolCallId: "call_plain" }));
	assert.equal(plain && "structuredContent" in plain, false);
});

await test("bash's own full-output path is named; tool call ids are made file-safe", () => {
	const dir = mkdtempSync(join(tmpdir(), "lead-cap-"));
	const out = capToolResult(
		event({ toolCallId: "a/b:c", details: { fullOutputPath: "/tmp/pi-bash-1.log" } }) as never,
		{ settings: DEFAULTS, outputsDir: dir, sessionId: "s" },
	);
	assert.ok(existsSync(join(dir, "s", "a_b_c.txt")));
	assert.match(out?.content?.[0] && "text" in out.content[0] ? out.content[0].text : "", /\/tmp\/pi-bash-1\.log/);
});

await test("very long lines are clipped in the excerpt but kept whole in the file", () => {
	const dir = mkdtempSync(join(tmpdir(), "lead-cap-"));
	const text = Array.from({ length: 5 }, () => "y".repeat(5000)).join("\n");
	const out = capToolResult(event({ content: [{ type: "text", text }] }) as never, {
		settings: DEFAULTS,
		outputsDir: dir,
		sessionId: "s",
	});
	const summary = out?.content?.[0] && "text" in out.content[0] ? out.content[0].text : "";
	assert.ok(summary.length < 4000);
	assert.match(summary, /…\[\+4600 chars\]/);
	assert.equal(readFileSync(join(dir, "s", "call_abc.txt"), "utf8"), text);
});

await test("leadOutputCap: false or enabled: false turns it off", async () => {
	assert.equal(parseSettings(false).enabled, false);
	const { fire } = load({ settings: { enabled: false } });
	assert.equal(await fire("tool_result", event()), undefined);
});

await test("an unwritable outputs dir leaves the result untouched", () => {
	const out = capToolResult(event() as never, { settings: DEFAULTS, outputsDir: "/dev/null/nope", sessionId: "s" });
	assert.equal(out, undefined);
});

if (failures > 0) {
	console.log(`\n${failures} test(s) failed`);
	process.exit(1);
}
console.log("\nall lead-output-cap smoke tests passed");
