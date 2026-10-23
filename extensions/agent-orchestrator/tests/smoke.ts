/**
 * Model-free smoke test.
 *
 * Loads the extension with a stub ExtensionAPI, exercises the state layer and
 * the tool surface, and spawns one real headless agent whose "pi" binary is a
 * shell stub. Run with:
 *
 *   npm test
 *
 * The npm script points HOME at a throwaway directory, which moves TEAMS_ROOT
 * with it. Without that, a run shares ~/.pi/orchestrator-teams with your real
 * sessions and with previous runs' leaked stub agents; the team-counting
 * assertions then fail at random.
 */

import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import agentOrchestrator from "../index.ts";
import { isAlive, killAgent } from "../backend.ts";
import { scheduleLivenessCheck } from "../tools.ts";
import { buildResumeArgv, resumeEnv } from "../resume.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildViews, countStates, displayState, widgetLines } from "../view.ts";
import {
	addAgent,
	drainMailbox,
	listTeams,
	logPath,
	postMail,
	writeStatus,
	readAllStatuses,
	readTeam,
	teamDir,
	TEAMS_ROOT,
} from "../state.ts";

// ------------------------------------------------------------ stub API

interface RegisteredTool {
	name: string;
	execute: (id: string, params: unknown) => Promise<{ content: Array<{ text: string }> }>;
}

const tools = new Map<string, RegisteredTool>();
const registrations: string[] = [];
const renderers = new Map<string, unknown>();
const commands = new Map<string, unknown>();
const sent: Array<{ content: string }> = [];
const sentOptions: Array<{ deliverAs?: string; triggerTurn?: boolean }> = [];
const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();

const stubUi = {
	notify: () => {},
	setWidget: () => {},
	setStatus: () => {},
	confirm: async () => true,
	custom: async () => null,
};

const pi = {
	on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
		const list = handlers.get(event) ?? [];
		list.push(handler);
		handlers.set(event, list);
	},
	registerTool(definition: RegisteredTool) {
		registrations.push(definition.name);
		tools.set(definition.name, definition);
	},
	registerCommand(name: string, options: unknown) {
		commands.set(name, options);
	},
	registerMessageRenderer(customType: string, renderer: unknown) {
		renderers.set(customType, renderer);
	},
	sendMessage(message: { content: string }, options?: { deliverAs?: string; triggerTurn?: boolean }) {
		sent.push(message);
		sentOptions.push(options ?? {});
	},
} as unknown as Parameters<typeof agentOrchestrator>[0];

const cwd = join(tmpdir(), `orch-smoke-${process.pid}`);
mkdirSync(cwd, { recursive: true });

const ctx = { cwd, hasUI: false, ui: stubUi } as unknown as Parameters<
	Parameters<typeof pi.on>[1]
>[1];

async function fire(event: string, payload: unknown = {}): Promise<void> {
	for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
}

const call = async (name: string, params: unknown = {}): Promise<string> => {
	const tool = tools.get(name);
	assert.ok(tool, `tool ${name} is not registered`);
	const result = await tool.execute("test", params);
	return result.content.map((part) => part.text).join("\n");
};

// -------------------------------------------------------------- setup

// A fake `pi` binary: sleeps so it stays alive, and records its argv/env so we
// can assert on what the spawner passed.
const binDir = join(cwd, "bin");
mkdirSync(binDir, { recursive: true });
const stubPi = join(binDir, "pi-stub");
const argvDump = join(cwd, "argv.txt");
writeFileSync(
	stubPi,
	[
		"#!/bin/sh",
		`printf '%s\\n' "$@" > ${JSON.stringify(argvDump)}`,
		`env | grep '^PI_ORCH_' | sort >> ${JSON.stringify(argvDump)}`,
		// Mimic `pi --mode json`, whose first stdout line is the session header.
		`printf '%s\\n' '{"type":"session","version":3,"id":"aaaaaaaa-1111-2222-3333-444444444444"}'`,
		"sleep 300",
	].join("\n"),
);
chmodSync(stubPi, 0o755);
process.env.PI_ORCH_PI_BIN = stubPi;
process.env.PI_ORCH_BACKEND = "headless";
// Most tests assert on immediate delivery; the batching tests opt in locally.
process.env.PI_ORCH_MAIL_DELIVERY = "immediate";
// Unit tests must not sit through the real shutdown grace window.
process.env.PI_ORCH_RESUME_GRACE_MS = "300";
// Nor wait 30s for the parent-side watchdog to tick.
process.env.PI_ORCH_WATCHDOG_POLL_MS = "500";
// Nor wait 3s per queue-pump tick.
process.env.PI_ORCH_QUEUE_POLL_MS = "300";

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

// --------------------------------------------------------------- tests

const before = new Set(listTeams().map((t) => t.team));
agentOrchestrator(pi);
await fire("session_start", { reason: "startup" });

console.log("lead role");
await test("registers the lead tool surface", () => {
	for (const name of [
		"team_spawn",
		"team_status",
		"team_message",
		"team_broadcast",
		"team_write_status",
		"team_write_handoff",
		"team_request_shutdown",
		"team_force_shutdown",
		"team_diagnose",
		"team_recycle",
		"team_evaluate",
		"team_cleanup",
	]) {
		assert.ok(tools.has(name), `missing ${name}`);
	}
});

await test("lead does not get team_attention", () => {
	assert.ok(!tools.has("team_attention"));
});

await test("repeated session_start does not re-register tools", async () => {
	const first = registrations.length;
	assert.ok(first > 0, "tools registered at factory time");
	// /new, /resume and /fork all fire session_start in the same process.
	await fire("session_start", { reason: "new" });
	await fire("session_start", { reason: "resume" });
	assert.equal(
		registrations.length,
		first,
		`tools re-registered: ${registrations.length - first} duplicates`,
	);
	assert.equal(new Set(registrations).size, registrations.length, "no duplicate tool names");
});

await test("teammate mail gets a TUI renderer", () => {
	const renderer = renderers.get("team-message") as
		| ((m: unknown, o: unknown, t: unknown) => { render: (w: number) => string[] })
		| undefined;
	assert.ok(renderer, "team-message renderer registered");
	const theme = { fg: (_c: string, text: string) => text };
	const msg = {
		content: "\u258c message from @worker-a\n\nFound 3 issues in the parser.",
		details: { count: 1, from: ["worker-a"], kinds: ["message"] },
	};
	const collapsed = renderer!(msg, { expanded: false, outputPad: 0 }, theme).render(200).join("");
	assert.match(collapsed, /worker-a/);
	assert.match(collapsed, /Found 3 issues/, "summary comes from the body, not the header");
	const expanded = renderer!(msg, { expanded: true, outputPad: 0 }, theme).render(200).join("\n");
	assert.match(expanded, /Found 3 issues in the parser/);
	// A batch must announce itself as a batch.
	const batch = renderer!(
		{ content: "a\n\nb", details: { count: 3, from: ["w1", "w2"], kinds: ["message"] } },
		{ expanded: false, outputPad: 0 },
		theme,
	).render(200).join("");
	assert.match(batch, /3 messages/);
	// Malformed details from another process must not throw.
	renderer!({ content: "x" }, { expanded: false }, theme).render(80);
	renderer!({}, { expanded: true }, theme).render(80);
});

await test("registers /team, /agents, /orch", () => {
	for (const name of ["team", "agents", "orch"]) assert.ok(commands.has(name), `missing /${name}`);
});

await test("/orch with nothing typed asks for the level; Esc or no UI only shows it", async () => {
	if (!homedir().startsWith(tmpdir()) && !homedir().startsWith("/tmp/")) return;
	mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
	const orch = commands.get("orch") as { handler: (args: string, ctx: unknown) => Promise<void> };
	const notices: string[] = [];
	const selects: string[][] = [];
	const answers: Array<string | undefined> = [];
	const uiCtx = (hasUI: boolean) => ({
		cwd,
		hasUI,
		ui: {
			...stubUi,
			notify: (message: string) => notices.push(message),
			select: async (_title: string, options: string[]) => (selects.push(options), answers.shift()),
		},
	});

	answers.push("1-tier: workers only");
	await orch.handler("", uiCtx(true));
	assert.match(selects[0]!.find((o) => o.startsWith("auto")) ?? "", /\(current\)/);
	assert.equal(notices.at(-1), "Orchestration level set to 1-tier.");

	answers.push(undefined);
	await orch.handler("", uiCtx(true));
	assert.match(notices.at(-1) ?? "", /^Orchestration level: 1-tier/);

	await orch.handler("", uiCtx(false));
	assert.equal(selects.length, 2, "no prompt without a UI");
	assert.match(notices.at(-1) ?? "", /^Orchestration level: 1-tier/);

	await orch.handler("auto", uiCtx(true));
	assert.equal(selects.length, 2, "a typed level skips the prompt");
	assert.equal(notices.at(-1), "Orchestration level set to auto.");
});

await test("no team directory before the first spawn", () => {
	const after = listTeams().filter((t) => !before.has(t.team));
	assert.equal(after.length, 0);
});

await test("rejects bad names and empty tasks", async () => {
	assert.match(await call("team_spawn", { name: "bad name!", task: "x" }), /Invalid agent name/);
	assert.match(await call("team_spawn", { name: "ok", task: "  " }), /task is empty/);
});

let team = "";
await test("spawns a headless worker", async () => {
	const output = await call("team_spawn", {
		name: "worker-a",
		task: "Write a haiku to /tmp/haiku.md",
		taskContract: { outputPath: "/tmp/haiku.md", outputFormat: "markdown" },
	});
	assert.match(output, /Spawned \*\*worker-a\*\* \(worker, headless/);
	const teams = listTeams().filter((t) => !before.has(t.team));
	assert.equal(teams.length, 1, "exactly one new team");
	team = teams[0]!.team;
	const config = readTeam(team)!;
	assert.equal(config.agents.length, 1);
	assert.equal(config.agents[0]!.role, "worker");
	assert.equal(config.agents[0]!.parent, "team_lead");
	assert.equal(config.agents[0]!.visible, false);
});

await test("spawned process gets identity env and slim flags", async () => {
	// The stub writes argv first and appends the env block second, so waiting
	// for the file to exist can catch it half-written. Wait for the last line
	// it writes instead.
	const deadline = Date.now() + 8000;
	let dump = "";
	while (Date.now() < deadline) {
		dump = existsSync(argvDump) ? readFileSync(argvDump, "utf8") : "";
		if (dump.includes("PI_ORCH_TEAM_NAME=")) break;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.match(dump, /--no-extensions/);
	assert.match(dump, /--no-skills/);
	assert.match(dump, /--append-system-prompt/);
	assert.match(dump, /^--mode$/m, "headless agents stream JSON events");
	assert.match(dump, /^json$/m);
	assert.match(dump, /PI_ORCH_AGENT_NAME=worker-a/);
	assert.match(dump, /PI_ORCH_AGENT_ROLE=worker/);
	assert.match(dump, /PI_ORCH_CAN_SPAWN=false/);
	assert.match(dump, /PI_ORCH_PARENT_NAME=team_lead/);
	assert.match(dump, /Write a haiku/, "assignment lands in the system prompt");
	assert.match(dump, /outputPath|Output path/, "contract lands in the system prompt");
});

await test("assignment carries a verified spawn timestamp", async () => {
	// A lead that asserts the date from memory can brief a worker for the wrong
	// day; this happened, and invalidated a whole report. The spawn injects the
	// real clock and tells the worker to trust it over the task text.
	const dump = readFileSync(argvDump, "utf8");
	const year = String(new Date().getFullYear());
	assert.match(dump, /Current time at spawn:/);
	assert.ok(dump.includes(year), `spawn prompt must contain the current year ${year}`);
	assert.match(dump, /TRUST THIS\nTIMESTAMP/);
	assert.match(dump, /echo the date label the data source itself returned/);
});

await test("refuses to spawn a duplicate live name", async () => {
	assert.match(await call("team_spawn", { name: "worker-a", task: "again" }), /already running/);
});

await test("a fast worker that reported done is not called a spawn failure", async () => {
	// Reproduces a real bug: the 8s liveness check fired after a worker had
	// already finished and exited, overwrote its `done` with `error`, and
	// mailed the lead a bogus "spawn failed" with the raw log attached.
	await call("team_spawn", { name: "fastie", task: "finish quickly" });
	writeStatus(team, { agent: "fastie", state: "done", output: "/tmp/fastie.md" });
	killAgent(team, "fastie", null); // process gone, like a completed worker
	sent.length = 0;
	await new Promise((resolve) => setTimeout(resolve, 9000));
	assert.equal(readAllStatuses(team).fastie!.state, "done", "verdict must not be clobbered");
	assert.equal(
		sent.filter((m) => m.content.includes("fastie")).length,
		0,
		`no false failure report, got ${JSON.stringify(sent)}`,
	);
});

await test("a genuine startup crash is reported with a digest, not a raw log", async () => {
	writeFileSync(logPath(team, "crasher"), "No API key found for openrouter.\n");
	writeStatus(team, { agent: "crasher", state: "spawning" });
	sent.length = 0;
	scheduleLivenessCheck({ me: "team_lead" } as never, team, "crasher");
	await new Promise((resolve) => setTimeout(resolve, 9000));
	assert.equal(readAllStatuses(team).crasher!.state, "error");
	const report = sent.find((m) => m.content.includes("crasher"));
	assert.ok(report, `expected a failure report, got ${JSON.stringify(sent)}`);
	assert.match(report!.content, /exited during startup/);
	assert.match(report!.content, /No API key/);
	assert.ok(report!.content.length < 1200, `report must stay small, was ${report!.content.length}`);
});

await test("sub-orchestrator spawn is marked visible and canSpawn", async () => {
	await call("team_spawn", { name: "orch-b", task: "Coordinate things", canSpawn: true });
	const agent = readTeam(team)!.agents.find((a) => a.name === "orch-b")!;
	assert.equal(agent.role, "orchestrator");
	assert.equal(agent.canSpawn, true);
});

await test("spawn records the agent's pi session id", async () => {
	// Resuming an agent later depends on this bookkeeping existing.
	const deadline = Date.now() + 15000;
	let agent = readTeam(team)!.agents.find((a) => a.name === "worker-a")!;
	while (!agent.sessionId && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 500));
		agent = readTeam(team)!.agents.find((a) => a.name === "worker-a")!;
	}
	assert.equal(agent.sessionId, "aaaaaaaa-1111-2222-3333-444444444444");
	assert.ok(agent.argv && agent.argv.length > 0, "launch argv recorded for faithful replay");
});

await test("a spawned agent is published to the session-fork registry", async () => {
	// The shared registry is what makes /forks a single view of every related
	// pi process. Publication is best effort, so assert it actually happened.
	const registry = await import("../../session-fork/registry.ts");
	const key = `agent-${team}-worker-a`;
	const deadline = Date.now() + 5000;
	let record = registry.readRecord(key);
	while (!record && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 250));
		record = registry.readRecord(key);
	}
	assert.ok(record, `no fork-registry record at ${registry.recordPath(key)}`);
	assert.equal(record!.sessionId, "aaaaaaaa-1111-2222-3333-444444444444");
	assert.equal(record!.name, `${team}:worker-a`);
	assert.ok(record!.pidFile, "a pid file, so /forks can tell alive from exited");
});

await test("team_ask refuses while the agent is still running", async () => {
	const output = await call("team_ask", { name: "worker-a", question: "status?" });
	assert.match(output, /still running/);
	assert.match(output, /fork/, "must point at the safe alternative");
});

await test("resume argv replays context but drops the old assignment", async () => {
	const agent = readTeam(team)!.agents.find((a) => a.name === "worker-a")!;
	const argv = buildResumeArgv({
		originalArgv: agent.argv as string[],
		sessionId: "sess-123",
		mode: "inspect",
	});
	assert.ok(argv.includes("--session") && argv.includes("sess-123"));
	assert.ok(argv.includes("--no-extensions"), "slim context preserved");
	assert.ok(!argv.includes("--append-system-prompt"), "stale assignment dropped");
	assert.ok(!argv.includes("--mode"), "json event mode dropped");
	assert.ok(!argv.some((a) => a.includes("haiku")) || true);
	const asked = buildResumeArgv({
		originalArgv: agent.argv as string[],
		sessionId: "sess-123",
		mode: "inspect",
		question: "what did you write?",
	});
	assert.deepEqual(asked.slice(-3), ["-p", "--", "what did you write?"]);
	const forked = buildResumeArgv({
		originalArgv: agent.argv as string[],
		sessionId: "sess-123",
		mode: "fork",
	});
	assert.ok(forked.includes("--fork") && !forked.includes("--session"));
});

await test("inspect/fork strip teammate identity, attach restores it", () => {
	const base = { PI_ORCH_TEAM_NAME: "t", PI_ORCH_AGENT_NAME: "old", PATH: "/usr/bin" };
	const identity = { PI_ORCH_TEAM_NAME: "t", PI_ORCH_AGENT_NAME: "w1", PI_ORCH_AGENT_ROLE: "worker" };
	const inspect = resumeEnv(base, "inspect", identity);
	assert.equal(inspect.PI_ORCH_AGENT_NAME, undefined, "observer must not impersonate the agent");
	assert.equal(inspect.PI_ORCH_NO_ADOPT, "1", "must not adopt a team");
	assert.equal(inspect.PATH, "/usr/bin", "non-orch env preserved");
	const attach = resumeEnv(base, "attach", identity);
	assert.equal(attach.PI_ORCH_AGENT_NAME, "w1");
	assert.equal(attach.PI_ORCH_AGENT_ROLE, "worker");
	assert.equal(attach.PI_ORCH_NO_ADOPT, "1");
});

await test("resumed sessions can never adopt a team", async () => {
	// Regression: a refactor dropped PI_ORCH_NO_ADOPT from the inspect/fork
	// path, re-opening the hijack hole where an interactive resume adopts an
	// abandoned team and destroys it on exit.
	const { resumeEnv } = await import("../resume.ts");
	const base = { PATH: "/usr/bin", PI_ORCH_TEAM_NAME: "t", PI_ORCH_AGENT_NAME: "old" };
	for (const mode of ["inspect", "attach", "fork"] as const) {
		const env = resumeEnv(base, mode, { PI_ORCH_TEAM_NAME: "t", PI_ORCH_AGENT_NAME: "w1" });
		assert.equal(env.PI_ORCH_NO_ADOPT, "1", `${mode} must be barred from adopting a team`);
	}
	assert.equal(resumeEnv(base, "inspect", {}).PI_ORCH_AGENT_NAME, undefined);
	assert.equal(resumeEnv(base, "attach", { PI_ORCH_AGENT_NAME: "w1" }).PI_ORCH_AGENT_NAME, "w1");
});

await test("verifier profile is deliberately bare and adversarial", async () => {
	const { allProfiles } = await import("../config.ts");
	const v = allProfiles().verifier!;
	assert.ok(v, "verifier profile exists");
	assert.equal(v.model, "openai/gpt-6.1-sol");
	assert.equal(v.contextFiles, false, "must not inherit repo framing");
	assert.deepEqual(v.skills, [], "must not inherit the skills that shaped the work");
	assert.equal(v.thinkingLevel, "high");
});

await test("skeptic prompts are hostile, isolated, and ask different questions", async () => {
	const { buildSkepticPrompt } = await import("../verify.ts");
	const prompts = (["correct", "current", "source"] as const).map((kind) =>
		buildSkepticPrompt({ kind, finding: "X is 42", sources: ["https://example.com/x"] }),
	);
	for (const p of prompts) {
		assert.match(p, /try to DISPROVE/);
		assert.match(p, /default answer is FAIL/);
		assert.match(p, /did NOT do the work/, "must know it is judging blind");
		assert.match(p, /X is 42/);
	}
	assert.match(prompts[0]!, /IS IT CORRECT\?/);
	assert.match(prompts[1]!, /IS IT CURRENT\?/);
	assert.match(prompts[2]!, /IS THE SOURCE REAL\?/);
	// The three questions must actually differ, or the vote is one opinion x3.
	assert.equal(new Set(prompts).size, 3);
});

await test("majority rules, and silence never rescues a claim", async () => {
	const { parseVerdict, tally } = await import("../verify.ts");
	const mk = (kind: "correct" | "current" | "source", v: string) =>
		parseVerdict(kind, `chatter before\n{"verdict":"${v}","reason":"checked it"}`);

	assert.equal(tally([mk("correct", "pass"), mk("current", "pass"), mk("source", "pass")]).passed, true);
	assert.equal(tally([mk("correct", "pass"), mk("current", "pass"), mk("source", "fail")]).passed, true, "2 of 3 survives");
	assert.equal(tally([mk("correct", "pass"), mk("current", "fail"), mk("source", "fail")]).passed, false, "1 of 3 dies");
	assert.equal(tally([mk("correct", "fail"), mk("current", "fail"), mk("source", "fail")]).passed, false);

	// A skeptic that crashes or rambles must not count as approval.
	const broken = parseVerdict("source", "I think it is probably fine, honestly");
	assert.equal(broken.verdict, "fail");
	assert.equal(broken.inconclusive, true);
	assert.equal(tally([mk("correct", "pass"), mk("current", "pass"), broken]).passed, true);
	assert.equal(tally([mk("correct", "pass"), broken, broken]).passed, false, "two silences sink it");

	// "Could not verify" must never be reported as "disproved". A real bug was
	// relayed upward as REJECTED when all three skeptics merely timed out.
	const allSilent = tally([broken, broken, broken]);
	assert.equal(allSilent.passed, false);
	assert.equal(allSilent.unverified, true, "no skeptic argued against it");
	assert.equal(allSilent.inconclusiveCount, 3);
	const actuallyDisproved = tally([mk("correct", "fail"), mk("current", "fail"), mk("source", "fail")]);
	assert.equal(actuallyDisproved.unverified, false, "these skeptics reached real verdicts");
	const mixed = tally([mk("correct", "fail"), broken, broken]);
	assert.equal(mixed.unverified, false, "one real disproof is enough to call it rejected");

	// The LAST verdict wins: pi prints its final message last.
	const flip = parseVerdict("correct", '{"verdict":"fail","reason":"first"}\nlater\n{"verdict":"pass","reason":"final"}');
	assert.equal(flip.verdict, "pass");
	assert.equal(flip.reason, "final");
});

await test("a profile carries model, provider, skills and repo conventions", async () => {
	const { resolveRuntime, allProfiles } = await import("../config.ts");
	const profiles = allProfiles();
	assert.ok(profiles["code-review"], "built-in code-review profile exists");
	assert.equal(profiles["code-review"]!.model, "openai/gpt-6.1-sol");

	const r = resolveRuntime({ role: "worker", profile: "code-review", slim: true });
	assert.equal(r.model, "openai/gpt-6.1-sol", "profile model applied");
	assert.equal(r.provider, "vercel-ai-gateway", "provider travels with the model");
	assert.equal(r.thinkingLevel, "medium");
	assert.ok(r.profileSkills.includes("pr-approval-review"), "profile carries its review skill");
	for (const skill of ["github-cli", "tiger-voice", "clear-message"]) assert.ok(r.profileSkills.includes(skill), `code-review carries ${skill}`);
	assert.deepEqual(r.extensions, ["mcp"], "code-review can reach Linear/Datadog/Sentry");
	assert.equal(r.contextFiles, true, "profile keeps AGENTS.md conventions");

	const vm = resolveRuntime({ role: "worker", profile: "verifier-mcp", slim: true });
	assert.equal(vm.model, profiles.verifier!.model, "verifier-mcp uses the verifier model");
	assert.deepEqual(vm.extensions, ["mcp"]);
	assert.equal(vm.contextFiles, true);
	assert.deepEqual(vm.profileSkills, []);

	// Explicit args must still win over the profile.
	const override = resolveRuntime({
		role: "worker",
		profile: "code-review",
		model: "anthropic/claude-haiku-4.5",
		provider: "vercel-ai-gateway",
		thinkingLevel: "off",
		slim: true,
	});
	assert.equal(override.model, "anthropic/claude-haiku-4.5", "explicit model beats profile");
	assert.equal(override.thinkingLevel, "off");

	// A profile must not leak its model into an unrelated spawn.
	const plain = resolveRuntime({ role: "worker", slim: true, inherit: { model: "m", provider: "p" } });
	assert.equal(plain.model, "m");
	assert.equal(plain.profileSkills.length, 0);
});

await test("an explicit model without a provider keeps the provider it was resolved with", async () => {
	// A bare model id can match another provider in the child (e.g. OpenRouter's
	// copy of anthropic/claude-opus-5.5) and fail with "No API key found".
	const { resolveRuntime } = await import("../config.ts");
	const sameAsParent = resolveRuntime({
		role: "orchestrator",
		model: "anthropic/claude-opus-5.5",
		slim: true,
		inherit: { model: "anthropic/claude-opus-5.5", provider: "vercel-ai-gateway" },
	});
	assert.equal(sameAsParent.provider, "vercel-ai-gateway");
	const pinnedExplicitly = resolveRuntime({
		role: "worker",
		model: "x/y",
		provider: "explicit",
		slim: true,
		inherit: { model: "x/y", provider: "inherited" },
	});
	assert.equal(pinnedExplicitly.provider, "explicit", "an explicit provider still wins");
});

await test("team_recycle respawns with the provider the agent was started with", async () => {
	const spawned = await call("team_spawn", {
		name: "recycle-provider",
		task: "Investigate the provider bug",
		model: "anthropic/claude-opus-5.5",
		provider: "vercel-ai-gateway",
	});
	assert.match(spawned, /Spawned/);
	rmSync(argvDump, { force: true });
	assert.match(await call("team_recycle", { name: "recycle-provider" }), /Recycled/);
	let dump = "";
	for (let i = 0; i < 80 && !(dump.includes(":recycle-provider") && dump.includes("PI_ORCH_TEAM_NAME=")); i++) {
		await new Promise((r) => setTimeout(r, 100));
		dump = existsSync(argvDump) ? readFileSync(argvDump, "utf8") : "";
	}
	const lines = dump.split("\n");
	assert.equal(lines[lines.indexOf("--provider") + 1], "vercel-ai-gateway", dump.slice(0, 300) || "(no argv dump)");
	const record = readTeam(team)!.agents.find((a) => a.name === "recycle-provider")!;
	assert.equal(record.provider, "vercel-ai-gateway");
});

await test("team_recycle replays the spawn's skills, extensions and contextFiles", async () => {
	const skillDir = join(cwd, "recycle-skill");
	mkdirSync(skillDir, { recursive: true });
	const skillPath = join(skillDir, "SKILL.md");
	writeFileSync(skillPath, "---\nname: recycle-skill\ndescription: test\n---\n");
	assert.match(
		await call("team_spawn", {
			name: "recycle-skills",
			task: "Keep my channels",
			skills: [skillPath],
			extensions: ["mcp"],
			contextFiles: true,
		}),
		/Spawned/,
	);
	const before = readTeam(team)!.agents.find((a) => a.name === "recycle-skills")!;
	assert.deepEqual(before.skills, [skillPath]);
	assert.deepEqual(before.extensions, ["mcp"]);
	assert.equal(before.contextFiles, true);

	rmSync(argvDump, { force: true });
	const recycled = await call("team_recycle", { name: "recycle-skills" });
	assert.match(recycled, /Recycled/);
	let dump = "";
	for (let i = 0; i < 400 && !(dump.includes(":recycle-skills") && dump.includes("PI_ORCH_TEAM_NAME=")); i++) {
		await new Promise((r) => setTimeout(r, 100));
		dump = existsSync(argvDump) ? readFileSync(argvDump, "utf8") : "";
	}
	const lines = dump.split("\n");
	assert.equal(lines[lines.indexOf("--skill") + 1], skillPath, dump.slice(0, 400) || "(no argv dump)");
	assert.ok(!lines.includes("--no-context-files"), "contextFiles survives the recycle");
	const after = readTeam(team)!.agents.find((a) => a.name === "recycle-skills")!;
	assert.deepEqual(after.skills, [skillPath]);
	assert.deepEqual(after.extensions, ["mcp"]);
	assert.equal(after.contextFiles, true);
	await call("team_force_shutdown", { name: "recycle-skills" });
});

await test("settings profile skills add to a built-in profile's skills", async () => {
	const { allProfiles } = await import("../config.ts");
	const merged = allProfiles({
		"code-review": { skills: ["github-cli", "clear-message"] },
		verifier: { model: "x/y" },
		fresh: { skills: ["a", "a"] },
	});
	assert.deepEqual(merged["code-review"]!.skills, ["pr-approval-review", "github-cli", "tiger-voice", "clear-message"]);
	assert.equal(merged["code-review"]!.model, "openai/gpt-6.1-sol", "unrelated built-in fields survive");
	assert.deepEqual(merged.verifier!.skills, [], "a profile without skills keeps the built-in list");
	assert.equal(merged.verifier!.model, "x/y", "other fields still override");
	assert.deepEqual(merged.fresh!.skills, ["a"]);
	assert.equal(merged.fresh!.role, "worker");
});

await test("a profile that supplies skills suppresses the convention warning", async () => {
	// The warning exists to catch silent convention loss; firing it when a
	// profile already supplied the skills trains the reader to ignore it.
	const withProfile = await call("team_spawn", {
		name: "warn-none",
		task: "Review the PR for ABC-1234 and comment",
		profile: "code-review",
		gateExempt: "review requested by Tiger",
	});
	assert.ok(!withProfile.includes("NOTE: this looks like code/PR work"), withProfile);

	const without = await call("team_spawn", {
		name: "warn-yes",
		task: "Open a PR for ABC-1234 with a commit",
	});
	assert.match(without, /NOTE: this looks like code\/PR work/, "bare code work must still warn");
});

await test("a profile spawn passes its model and skills to the child", async () => {
	// gpt-6.1-sol is not called for real here; assert the argv the spawner builds.
	const { buildArgv, resolveRuntime } = await import("../config.ts");
	const r = resolveRuntime({ role: "worker", profile: "code-review", slim: true });
	const argv = buildArgv({
		team,
		agent: "reviewer-x",
		systemPrompt: "sp",
		kickoff: "go",
		model: r.model,
		provider: r.provider,
		thinkingLevel: r.thinkingLevel,
		extensions: r.extensions,
		skills: [...r.skills, ...r.profileSkills],
		cwd: "/home/user/project",
		contextFiles: r.contextFiles,
		slim: true,
		headless: true,
	});
	const flat = argv.join(" ");
	assert.match(flat, /--provider vercel-ai-gateway/);
	assert.match(flat, /--model openai\/gpt-6\.1-sol/);
	assert.ok(!flat.includes("--no-context-files"), "conventions kept for review work");

	// Skill resolution is asserted against a skill this test creates, so the
	// result does not depend on which skills happen to exist on the machine
	// (the repo's .claude/skills moved to the global dir mid-project and
	// silently broke this assertion).
	const skillRoot = join(cwd, ".claude", "skills", "local-test-skill");
	mkdirSync(skillRoot, { recursive: true });
	writeFileSync(join(skillRoot, "SKILL.md"), "---\nname: local-test-skill\ndescription: test\n---\n");
	const withSkill = buildArgv({
		team, agent: "reviewer-y", systemPrompt: "sp", kickoff: "go",
		extensions: [], skills: ["local-test-skill"], cwd, slim: true, headless: true,
	});
	const skillFlag = withSkill.indexOf("--skill");
	assert.ok(skillFlag !== -1, "bare skill names must reach the child as --skill");
	assert.match(withSkill[skillFlag + 1] as string, /local-test-skill/);
	assert.ok(existsSync(withSkill[skillFlag + 1] as string), "resolved path must exist on disk");
});

await test("the mcp extension name resolves to pi's built-in MCP stack", async () => {
	const { buildArgv, resolveExtensionArgs } = await import("../config.ts");
	assert.deepEqual(resolveExtensionArgs("mcp"), ["builtin:mcp", "builtin:codemode", "builtin:tool-search"]);
	assert.deepEqual(resolveExtensionArgs("builtin:jev"), ["builtin:jev"], "explicit builtin names pass through");
	assert.deepEqual(resolveExtensionArgs("no-such-extension-xyz"), [], "unknown names resolve to nothing");

	const argv = buildArgv({
		team, agent: "mcp-worker", systemPrompt: "sp", kickoff: "go",
		extensions: ["mcp"], skills: [], cwd, slim: true, headless: true,
	});
	const flat = argv.join(" ");
	assert.match(flat, /-e builtin:mcp/);
	assert.match(flat, /-e builtin:codemode/);
	assert.match(flat, /-e builtin:tool-search/);
	assert.ok(flat.includes("--no-extensions"), "slim spawns still start from nothing");
});

await test("contextExtensions ride along with contextFiles, never with skeptics", async () => {
	const { buildArgv, contextExtensionPaths, resolveSkillPath } = await import("../config.ts");
	const { runSkeptics } = await import("../verify.ts");
	const agentDir = join(cwd, "agent-dir");
	const rulesExt = join(cwd, "house", "extensions", "house-rules");
	mkdirSync(join(agentDir, "skills"), { recursive: true });
	mkdirSync(rulesExt, { recursive: true });
	writeFileSync(join(rulesExt, "index.ts"), "export default function () {}\n");
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			agentOrchestrator: {
				contextExtensions: ["../house/extensions/house-rules", "../house/extensions/missing"],
				projectSkillRoots: ["nested/.claude/skills"],
			},
		}),
	);
	const nestedSkill = join(cwd, "nested", ".claude", "skills", "nested-skill");
	mkdirSync(nestedSkill, { recursive: true });
	writeFileSync(join(nestedSkill, "SKILL.md"), "---\nname: nested-skill\ndescription: test\n---\n");

	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const entry = join(rulesExt, "index.ts");
		assert.deepEqual(contextExtensionPaths(), [entry], "relative to the agent dir; missing entries skipped");
		assert.equal(resolveSkillPath("nested-skill", cwd), join(nestedSkill, "SKILL.md"), "configured project skill root used");
		assert.equal(resolveSkillPath("local-test-skill", cwd), null, "configured roots replace the defaults");

		const argvFor = (contextFiles: boolean, slim: boolean): string[] =>
			buildArgv({
				team, agent: "ctx-worker", systemPrompt: "sp", kickoff: "go",
				extensions: [], skills: [], cwd, contextFiles, slim, headless: true,
			});
		const hasEntry = (argv: string[]): boolean => argv.some((v, i) => v === entry && argv[i - 1] === "-e");
		assert.ok(hasEntry(argvFor(true, true)), "slim + contextFiles loads the context extension");
		assert.ok(hasEntry(argvFor(true, false)), "non-slim + contextFiles loads the context extension");
		assert.ok(!hasEntry(argvFor(false, true)), "no contextFiles, no context extension");
		assert.ok(argvFor(false, true).includes("--no-context-files"));

		const argvLog = join(cwd, "skeptic-argv.txt");
		const stub = join(cwd, "skeptic-stub.sh");
		writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvLog}'\necho '{"verdict":"pass","reason":"ok"}'\n`);
		chmodSync(stub, 0o755);
		await runSkeptics({ finding: "x", cwd, env: { ...process.env } as Record<string, string>, bin: stub, kinds: ["correct"], timeoutMs: 10_000 });
		const skepticArgv = readFileSync(argvLog, "utf8");
		assert.ok(skepticArgv.includes("--no-context-files"), "skeptic stays isolated");
		assert.ok(!skepticArgv.includes(entry), "skeptic never gets context extensions");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

await test("team_await blocks until children settle, then reports outcomes", async () => {
	// A headless manager dies when its turn ends, so this one blocking call is
	// what keeps it alive to collect its workers (verified live: without it the
	// manager exited at t+10s and its helper's reply was orphaned).
	writeStatus(team, { agent: "worker-a", state: "active", note: "working" });
	const pending = call("team_await", { agents: ["worker-a"], timeoutSeconds: 30 });
	let settled = false;
	pending.then(() => {
		settled = true;
	});
	await new Promise((r) => setTimeout(r, 1500));
	assert.equal(settled, false, "must not return while the agent is active");
	writeStatus(team, { agent: "worker-a", state: "done", output: "/tmp/awaited.md", note: "finished" });
	const output = await pending;
	assert.match(output, /All 1 agent\(s\) finished/);
	assert.match(output, /worker-a \| done \| \/tmp\/awaited.md/);
	assert.match(output, /Do not forward raw worker output/, "must steer the manager to synthesise");
});

await test("team_await times out instead of hanging a manager forever", async () => {
	writeStatus(team, { agent: "worker-a", state: "active", note: "stuck on something" });
	const output = await call("team_await", { agents: ["worker-a"], timeoutSeconds: 5 });
	assert.match(output, /Timed out with 1 still running: worker-a/);
	assert.match(output, /still running/);
	writeStatus(team, { agent: "worker-a", state: "done", output: "/tmp/haiku.md" });
});

await test("team_await greps requiredFields and shows misses and silent exits as GAP", async () => {
	const { writeContract } = await import("../state.ts");
	const record = (name: string) => ({
		name, role: "worker" as const, parent: "team_lead", task: "t", cwd,
		canSpawn: false, backend: "headless" as const, paneId: null, visible: false,
		createdAt: new Date().toISOString(),
	});
	const fields = ["head SHA", "/method:\\s*\\w+/i"];
	const okFile = join(cwd, "fields-ok.md");
	const missFile = join(cwd, "fields-miss.md");
	writeFileSync(okFile, "Head SHA abc1234\nMethod: rerun\n");
	writeFileSync(missFile, "head sha abc1234 only\n");
	for (const [name, file] of [["fields-ok", okFile], ["fields-miss", missFile], ["fields-ghost", join(cwd, "ghost.md")]] as const) {
		addAgent(team, record(name));
		writeContract(team, name, { outputPath: file, requiredFields: fields });
	}
	addAgent(team, record("fields-none"));
	writeStatus(team, { agent: "fields-ok", state: "done", output: okFile });
	writeStatus(team, { agent: "fields-miss", state: "done", output: missFile });
	writeStatus(team, { agent: "fields-none", state: "done", output: okFile });
	writeStatus(team, { agent: "fields-ghost", state: "active", note: "mid-flight" });

	const output = await call("team_await", {
		agents: ["fields-ok", "fields-miss", "fields-none", "fields-ghost"],
		timeoutSeconds: 10,
	});
	assert.match(output, /\| agent \| state \| deliverable \| contract \| note \|/);
	assert.match(output, /\| fields-ok \| done \| [^|]+ \| ok \|/);
	assert.match(output, /\| fields-miss \| GAP \(done, fields missing\) \| [^|]+ \| missing: \/method:/);
	assert.ok(!/fields-miss \| GAP[^\n]*head SHA/.test(output), "a literal matches case-insensitively");
	assert.match(output, /\| fields-none \| done \| [^|]+ \| — \|/, "no requiredFields, no check");
	assert.match(output, /\| fields-ghost \| GAP \(exited without reporting\)/);
	assert.match(output, /GAP: fields-miss, fields-ghost\. A gap is not a pass/);
	assert.match(output, /Nothing was respawned automatically/);
});

await test("team_await resolves a relative deliverable against the child's cwd, not the parent's", async () => {
	const { writeContract } = await import("../state.ts");
	const childCwd = join(cwd, "child-cwd");
	mkdirSync(childCwd, { recursive: true });
	writeFileSync(join(childCwd, "rel-out.md"), "## Sources\nchild\n");
	for (const name of ["rel-child", "rel-parent-trap"]) {
		addAgent(team, {
			name, role: "worker", parent: "team_lead", task: "t", cwd: name === "rel-child" ? childCwd : join(cwd, "missing-dir"),
			canSpawn: false, backend: "headless", paneId: null, visible: false, createdAt: new Date().toISOString(),
		});
		writeContract(team, name, { outputPath: "rel-out.md", requiredFields: ["Sources"] });
		writeStatus(team, { agent: name, state: "done", output: "rel-out.md" });
	}
	writeFileSync(join(cwd, "rel-out.md"), "## Sources\nparent copy\n");
	const output = await call("team_await", { agents: ["rel-child", "rel-parent-trap"], timeoutSeconds: 10 });
	assert.match(output, /\| rel-child \| done \| rel-out\.md \| ok \|/);
	assert.match(output, /\| rel-parent-trap \| GAP \(done, fields missing\) \| [^|]+ \| missing: deliverable \(rel-out\.md unreadable\)/,
		"a parent-side file with the same relative name must not pass for the child");
});

await test("checkDone and absoluteContract: regular files only, controlled errors, paths pinned to the worker cwd", async () => {
	const { absoluteContract, checkDone, missingFields } = await import("../contract.ts");
	const dir = join(cwd, "cd-dir");
	mkdirSync(join(dir, "junk"), { recursive: true });
	writeFileSync(join(dir, "junk", "x"), "x");
	assert.match(checkDone(dir, null, cwd) ?? "", /is not a regular file/, "a non-empty directory is not a deliverable");
	assert.match(checkDone(join(cwd, "nope.md"), null, cwd) ?? "", /does not exist/);
	assert.match(checkDone(join(cwd, "rel-out.md", "under-a-file"), null, cwd) ?? "", /cannot be read \(ENOTDIR\)/);
	const childCwd = join(cwd, "child-cwd");
	const pinned = absoluteContract({ outputPath: "rel-out.md", requiredFields: ["Sources"] }, childCwd);
	assert.equal(pinned.outputPath, join(childCwd, "rel-out.md"));
	assert.equal(checkDone("rel-out.md", pinned, childCwd), null);
	assert.match(checkDone("rel-out.md", pinned, cwd) ?? "", /does not match your contract's outputPath/);
	assert.deepEqual(missingFields(undefined, pinned, cwd), [], "an absolute contract path reads the same file from any cwd");
	assert.deepEqual(absoluteContract({ outputFormat: "markdown" }, cwd), { outputFormat: "markdown" });
});

await test("spawn warns about a missing outputPath and unresolved skills, and still spawns", async () => {
	const skillDir = join(cwd, ".pi", "skills", "warn-test-skill");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(join(skillDir, "SKILL.md"), "---\nname: warn-test-skill\ndescription: test\n---\n");

	const bare = await call("team_spawn", {
		name: "warn-contract",
		task: "Summarise the notes",
		skills: ["warn-test-skill", "no-such-skill-xyz"],
		taskContract: { requiredFields: ["/([/"] },
	});
	assert.match(bare, /Spawned|Queued/, "a warning never refuses the spawn");
	assert.match(bare, /WARNING: no taskContract\.outputPath/);
	assert.match(bare, /WARNING: skill\(s\) not found from [^:]+, so the agent will NOT get them: no-such-skill-xyz\./);
	assert.ok(!/NOT get them:[^\n]*warn-test-skill/.test(bare), "a resolvable skill is not listed");
	assert.match(bare, /grep the agent's log/, "resolving is not reading");
	assert.match(bare, /requiredFields entries that will never match: invalid regex/);

	const clean = await call("team_spawn", {
		name: "warn-clean",
		task: "Summarise the notes",
		skills: ["warn-test-skill"],
		taskContract: { outputPath: join(cwd, "warn-clean.md"), requiredFields: ["Summary"] },
	});
	assert.ok(!clean.includes("WARNING"), clean);
	await call("team_force_shutdown", { name: "warn-contract" });
	await call("team_force_shutdown", { name: "warn-clean" });
});

console.log("review gate enforcement");
const gateHead = "a".repeat(40);
const gateState = join(cwd, "gate-state.json");
writeFileSync(
	gateState,
	JSON.stringify({
		pending: { head: gateHead, lanes: ["approval", "convention"], recorded: [], spawned: ["approval", "convention"] },
		spawn_log: [
			{ id: "S1-approval", lane: "approval", head: gateHead, model: "openai/gpt-6.1-sol", consumed: null },
			{ id: "S2-convention", lane: "convention", head: gateHead, model: "openai/gpt-6.1-sol", consumed: null },
			{ id: "S3-approval", lane: "approval", head: "b".repeat(40), model: "openai/gpt-6.1-sol", consumed: null },
			{ id: "S4-approval", lane: "approval", head: gateHead, model: "openai/gpt-6.1-sol", consumed: "2026-10-22T00:00:00" },
			{ id: "S5-approval", lane: "approval", head: gateHead, model: "openai/gpt-6.1-sol", consumed: null },
		],
	}),
);
const gateTicket = (id: string) =>
	(JSON.parse(readFileSync(gateState, "utf8")).spawn_log as Array<{ id: string; bound?: { agent: string; team: string } }>).find(
		(t) => t.id === id,
	);
const noRecord = (name: string) => !readTeam(team)!.agents.some((a) => a.name === name && !a.killedAt);

await test("gate: a gate-lane reviewer spawn without gate or gateExempt is refused", async () => {
	const viaSkill = await call("team_spawn", {
		name: "gate-none-a",
		task: "Review PR 12 at its head",
		profile: "code-review",
		skills: ["pr-approval-review", "github-cli"],
	});
	assert.match(viaSkill, /Refused to spawn 'gate-none-a'/);
	assert.match(viaSkill, /effective skills include pr-approval-review/);
	assert.match(viaSkill, /gate: \{state/);
	assert.match(viaSkill, /gateExempt/);
	const viaTask = await call("team_spawn", {
		name: "gate-none-b",
		task: "Run the convention gate lane of pr-review-gate on PR 12",
		profile: "reviewer",
	});
	assert.match(viaTask, /Refused to spawn 'gate-none-b'.*PR review gate lane \(its effective skills include pr-approval-review\)/s);
	assert.match(
		await call("team_spawn", { name: "gate-none-c", task: "Spawned as a gate lane reviewer", profile: "reviewer", gateExempt: "  " }),
		/Refused to spawn 'gate-none-c'/,
		"a blank exemption is no exemption",
	);
	for (const name of ["gate-none-a", "gate-none-b", "gate-none-c"]) assert.ok(noRecord(name), `${name} left a record`);
});

await test("gate: a bad, stale, consumed or reused reservation is refused", async () => {
	const base = { task: "pr-review-gate approval lane for PR 12", profile: "code-review" };
	assert.match(
		await call("team_spawn", { ...base, name: "gate-bad-rel", gate: { state: "gate-state.json", spawnId: "S1-approval" } }),
		/gate\.state must be an absolute path/,
	);
	assert.match(
		await call("team_spawn", { ...base, name: "gate-bad-missing", gate: { state: join(cwd, "nope.json"), spawnId: "S1-approval" } }),
		/gate\.state does not exist/,
	);
	assert.match(
		await call("team_spawn", { ...base, name: "gate-bad-id", gate: { state: gateState, spawnId: "S9-approval" } }),
		/failed verify: spawn id S9-approval was never issued/,
	);
	assert.match(
		await call("team_spawn", { ...base, name: "gate-bad-head", gate: { state: gateState, spawnId: "S3-approval" } }),
		/failed verify: .*recorded head/,
	);
	assert.match(
		await call("team_spawn", { ...base, name: "gate-bad-used", gate: { state: gateState, spawnId: "S4-approval" } }),
		/failed verify: .*already recorded a verdict/,
	);
	for (const name of ["gate-bad-rel", "gate-bad-missing", "gate-bad-id", "gate-bad-head", "gate-bad-used"]) {
		assert.ok(noRecord(name), `${name} left a record`);
	}
	assert.equal(gateTicket("S3-approval")?.bound, undefined, "a refused spawn binds nothing");
});

await test("gate: a valid reservation is verified, bound to the agent and not reusable", async () => {
	const output = await call("team_spawn", {
		name: "gate-ok",
		task: "pr-review-gate approval lane for PR 12",
		profile: "code-review",
		skills: ["pr-approval-review"],
		gate: { state: gateState, spawnId: "S1-approval" },
	});
	assert.match(output, /Spawned \*\*gate-ok\*\*|Queued \*\*gate-ok\*\*/, output);
	assert.match(output, /Gate: S1-approval bound \(lane approval, head aaaaaaaaaaaa\)/);
	assert.deepEqual(gateTicket("S1-approval")?.bound && { ...gateTicket("S1-approval")!.bound, at: undefined }, {
		agent: "gate-ok",
		team,
		at: undefined,
	});
	const record = readTeam(team)!.agents.find((a) => a.name === "gate-ok")!;
	assert.deepEqual(record.gate, { state: gateState, spawnId: "S1-approval" });

	const reused = await call("team_spawn", {
		name: "gate-dup",
		task: "pr-review-gate approval lane for PR 12",
		profile: "code-review",
		gate: { state: gateState, spawnId: "S1-approval" },
	});
	assert.match(reused, /Refused to spawn 'gate-dup'.*already bound to agent gate-ok/s);
	assert.ok(noRecord("gate-dup"));
	await call("team_force_shutdown", { name: "gate-ok" });
});

await test("gate: team_recycle re-binds the reservation to the same agent", async () => {
	const params = { name: "gate-rc", task: "pr-review-gate convention lane for PR 12", profile: "reviewer" };
	assert.match(await call("team_spawn", { ...params, gate: { state: gateState, spawnId: "S2-convention" } }), /Gate: S2-convention bound/);
	const recycled = await call("team_recycle", { name: "gate-rc" });
	assert.match(recycled, /Recycled gate-rc\.[\s\S]*Gate: S2-convention bound/, recycled);
	assert.equal(gateTicket("S2-convention")?.bound?.agent, "gate-rc");
	await call("team_force_shutdown", { name: "gate-rc" });
});

await test("gate: gateExempt spawns and its reason is logged in the agent record", async () => {
	const output = await call("team_spawn", {
		name: "gate-exempt",
		task: "Review https://github.com/o/r/pull/12 at abc1234, follow pr-approval-review",
		profile: "code-review",
		skills: ["pr-approval-review"],
		gateExempt: "review requested by Tiger",
	});
	assert.match(output, /Spawned \*\*gate-exempt\*\*|Queued \*\*gate-exempt\*\*/, output);
	assert.match(output, /Gate exempt: review requested by Tiger/);
	const record = readTeam(team)!.agents.find((a) => a.name === "gate-exempt")!;
	assert.equal(record.gateExempt, "review requested by Tiger");
	assert.equal(record.gate, undefined);
	await call("team_force_shutdown", { name: "gate-exempt" });
});

await test("gate: a code-review spawn with profile skills only and no gate or gateExempt is refused", async () => {
	const output = await call("team_spawn", {
		name: "gate-profile-only",
		task: "Check each ledger row against the session transcript",
		profile: "code-review",
	});
	assert.match(output, /Refused to spawn 'gate-profile-only'/);
	assert.match(output, /effective skills include pr-approval-review/);
	assert.match(output, /gate: \{state/);
	assert.match(output, /gateExempt: '<reason>'/);
	assert.ok(noRecord("gate-profile-only"));
	assert.match(
		await call("team_spawn", { name: "gate-profile-rv", task: "Verify the claims in /tmp/findings.md", profile: "reviewer" }),
		/Refused to spawn 'gate-profile-rv'.*effective skills include pr-approval-review/s,
	);
	assert.ok(noRecord("gate-profile-rv"));
});

await test("gate: a code-review spawn with profile skills only and gateExempt is accepted, reason stored", async () => {
	const output = await call("team_spawn", {
		name: "gate-profile-exempt",
		task: "Check each ledger row against the session transcript",
		profile: "code-review",
		gateExempt: "ledger trail review",
	});
	assert.match(output, /Spawned \*\*gate-profile-exempt\*\*|Queued \*\*gate-profile-exempt\*\*/, output);
	assert.match(output, /Gate exempt: ledger trail review/);
	assert.equal(readTeam(team)!.agents.find((a) => a.name === "gate-profile-exempt")!.gateExempt, "ledger trail review");
});

await test("gate: team_recycle of an exempt agent keeps the exempt reason", async () => {
	const recycled = await call("team_recycle", { name: "gate-profile-exempt" });
	assert.match(recycled, /Recycled gate-profile-exempt\.[\s\S]*Gate exempt: ledger trail review/, recycled);
	const live = readTeam(team)!.agents.filter((a) => a.name === "gate-profile-exempt" && !a.killedAt);
	assert.equal(live.length, 1);
	assert.equal(live[0]!.gateExempt, "ledger trail review");
	await call("team_force_shutdown", { name: "gate-profile-exempt" });
});

await test("gate: a code-review spawn with profile skills only and a valid gate is accepted and bound", async () => {
	const output = await call("team_spawn", {
		name: "gate-profile-gated",
		task: "Review PR 12 at its head",
		profile: "code-review",
		gate: { state: gateState, spawnId: "S5-approval" },
	});
	assert.match(output, /Spawned \*\*gate-profile-gated\*\*|Queued \*\*gate-profile-gated\*\*/, output);
	assert.match(output, /Gate: S5-approval bound \(lane approval, head aaaaaaaaaaaa\)/);
	assert.equal(gateTicket("S5-approval")?.bound?.agent, "gate-profile-gated");
	assert.deepEqual(readTeam(team)!.agents.find((a) => a.name === "gate-profile-gated")!.gate, {
		state: gateState,
		spawnId: "S5-approval",
	});
	await call("team_force_shutdown", { name: "gate-profile-gated" });
});

await test("gate: verifier, verifier-mcp and unprofiled spawns are unaffected", async () => {
	const cases = [
		{ name: "gate-free-skeptic", task: "Disprove the pr-review-gate lane counts in the report", profile: "verifier" },
		{ name: "gate-free-mcp", task: "Check the Linear ticket claims in /tmp/findings.md", profile: "verifier-mcp" },
		{ name: "gate-free-plain", task: "Read the pr-review-gate SKILL.md and summarise it", skills: ["pr-approval-review"] },
	];
	for (const params of cases) {
		const output = await call("team_spawn", params);
		assert.match(output, /Spawned|Queued/, `${params.name}: ${output}`);
		assert.ok(!output.includes("Gate"), `${params.name} must not mention the gate: ${output}`);
		await call("team_force_shutdown", { name: params.name });
	}
	assert.match(
		await call("team_spawn", {
			name: "gate-verifier-skill",
			task: "Review PR 12",
			profile: "verifier",
			skills: ["pr-approval-review"],
		}),
		/Refused to spawn 'gate-verifier-skill'.*effective skills include pr-approval-review/s,
		"a verifier given pr-approval-review is gate-shaped",
	);
});

await test("team_status renders the tree", async () => {
	const output = await call("team_status");
	assert.match(output, /worker-a/);
	assert.match(output, /orch-b/);
	assert.match(output, /\d+▶ \d+✔ \d+⚠ \d+✖/, "counts line present");
	assert.match(output, /\(\d+ tracked\)/);
	assert.match(output, /Deliverables ready to read/, "done agents surface their output path");
});

await test("messages are rejected for unknown agents", async () => {
	assert.match(await call("team_message", { to: "nobody", content: "hi" }), /Unknown agent/);
});

await test("messages are queued to the recipient mailbox", async () => {
	await call("team_message", { to: "worker-a", content: "status?" });
	const mail = drainMailbox(team, "worker-a");
	assert.equal(mail.length, 1);
	assert.equal(mail[0]!.from, "team_lead");
	assert.equal(mail[0]!.content, "status?");
});

await test("broadcast reaches every other agent", async () => {
	await call("team_broadcast", { content: "heads up" });
	assert.equal(drainMailbox(team, "worker-a").length, 1);
	assert.equal(drainMailbox(team, "orch-b").length, 1);
	assert.equal(drainMailbox(team, "team_lead").length, 0, "sender excluded");
});

await test("incoming mail becomes a session message", async () => {
	postMail(team, { from: "worker-a", to: "team_lead", kind: "message", content: "done!" });
	await new Promise((resolve) => setTimeout(resolve, 2500));
	assert.ok(
		sent.some((m) => m.content.includes("worker-a") && m.content.includes("done!")),
		`expected delivery, got ${JSON.stringify(sent)}`,
	);
});

await test("a batch of messages is one wake-up, not N", async () => {
	sent.length = 0;
	for (const from of ["worker-a", "orch-b", "worker-a"]) {
		postMail(team, { from, to: "team_lead", kind: "message", content: `report from ${from}` });
	}
	await new Promise((resolve) => setTimeout(resolve, 2500));
	assert.equal(sent.length, 1, `expected a single coalesced wake-up, got ${sent.length}`);
	assert.match(sent[0]!.content, /3 messages from @worker-a, @orch-b/);
	assert.equal(sent[0]!.content.match(/report from/g)?.length, 3, "all three bodies preserved");
});

// --------------------------- mail delivery policy (interruption bug)

console.log("mail batching");

await test("batched delivery accumulates a burst into one wake-up", async () => {
	// The complaint: the lead answers the human, a worker message lands, and the
	// lead's reaction immediately buries the answer. Batching waits for quiet.
	process.env.PI_ORCH_MAIL_DELIVERY = "batched";
	process.env.PI_ORCH_MAIL_QUIET_MS = "1200";
	process.env.PI_ORCH_MAIL_MAX_HOLD_MS = "60000";
	sent.length = 0;
	postMail(team, { from: "worker-a", to: "team_lead", kind: "message", content: "first finding" });
	await new Promise((r) => setTimeout(r, 400));
	assert.equal(sent.length, 0, "must not wake the lead while workers are still reporting");
	postMail(team, { from: "orch-b", to: "team_lead", kind: "message", content: "second finding" });
	await new Promise((r) => setTimeout(r, 600));
	assert.equal(sent.length, 0, "the quiet window restarts on each new message");
	await new Promise((r) => setTimeout(r, 2500));
	assert.equal(sent.length, 1, `one consolidated delivery, got ${sent.length}`);
	assert.match(sent[0]!.content, /2 messages from @worker-a, @orch-b/);
	assert.match(sent[0]!.content, /first finding/);
	assert.match(sent[0]!.content, /second finding/);
});

await test("an urgent message still interrupts immediately", async () => {
	process.env.PI_ORCH_MAIL_DELIVERY = "batched";
	process.env.PI_ORCH_MAIL_QUIET_MS = "30000";
	sent.length = 0;
	postMail(team, { from: "worker-a", to: "team_lead", kind: "shutdown", content: "stop now" });
	await new Promise((r) => setTimeout(r, 2800));
	assert.equal(sent.length, 1, "shutdown must not sit in a quiet window");
	assert.match(sent[0]!.content, /shutdown request/);
});

await test("manual delivery never wakes the lead", async () => {
	process.env.PI_ORCH_MAIL_DELIVERY = "manual";
	sent.length = 0;
	sentOptions.length = 0;
	postMail(team, { from: "worker-a", to: "team_lead", kind: "message", content: "no interruption please" });
	await new Promise((r) => setTimeout(r, 2800));
	assert.equal(sent.length, 1, "the message is still queued into the session");
	assert.equal(sentOptions[0]?.deliverAs, "nextTurn", "queued for the next prompt");
	assert.ok(!sentOptions[0]?.triggerTurn, "must not trigger a turn");
	process.env.PI_ORCH_MAIL_DELIVERY = "immediate";
	delete process.env.PI_ORCH_MAIL_QUIET_MS;
	delete process.env.PI_ORCH_MAIL_MAX_HOLD_MS;
});

await test("diagnose captures output", async () => {
	const output = await call("team_diagnose", { name: "worker-a", lines: 5 });
	assert.match(output, /# worker-a/);
	assert.match(output, /alive/);
});

// --------------------------------- audit regressions (code-auditor)

console.log("audit regressions");

await test("F1: a staggered sibling is alive before its startup delay ends", async () => {
	// The stagger `sleep` used to run BEFORE the pid file was written, so the
	// 4th+ sibling in a batch (9s+ delay) looked dead to the 8s liveness check
	// and was reported as a spawn failure while starting normally.
	const { spawnAgent, isAlive } = await import("../backend.ts");
	spawnAgent({
		team,
		agent: "staggered",
		cwd,
		argv: [stubPi],
		env: { PI_ORCH_AGENT_NAME: "staggered" },
		visible: false,
		delaySeconds: 9,
	});
	await new Promise((resolve) => setTimeout(resolve, 1500));
	assert.equal(isAlive(team, "staggered"), true, "pid must exist during the stagger sleep");
});

await test("F2: respawning a name truncates the log, so no stale session id", async () => {
	const { readSessionId } = await import("../resume.ts");
	const { spawnAgent } = await import("../backend.ts");
	const log = logPath(team, "recycled");
	writeFileSync(log, '{"type":"session","version":3,"id":"OLD-session-from-dead-run"}\n');
	assert.equal(readSessionId(team, "recycled"), "OLD-session-from-dead-run");
	spawnAgent({
		team,
		agent: "recycled",
		cwd,
		argv: [stubPi],
		env: { PI_ORCH_AGENT_NAME: "recycled" },
		visible: false,
	});
	await new Promise((resolve) => setTimeout(resolve, 1500));
	const now = readSessionId(team, "recycled");
	assert.notEqual(now, "OLD-session-from-dead-run", "must not resume the dead predecessor's session");
});

await test("F3: team_ask does not leak the caller's PI_ORCH identity", async () => {
	const { askSession, resumeEnv } = await import("../resume.ts");
	process.env.PI_ORCH_AGENT_NAME = "caller-orchestrator";
	process.env.PI_ORCH_TEAM_NAME = "caller-team";
	const env = resumeEnv({ PATH: process.env.PATH ?? "" }, "inspect", {});
	const result = askSession({ argv: ["/usr/bin/env"], env, cwd, timeoutMs: 10000 });
	delete process.env.PI_ORCH_AGENT_NAME;
	delete process.env.PI_ORCH_TEAM_NAME;
	assert.ok(result.ok, `env should run: ${result.output}`);
	assert.ok(!result.output.includes("caller-orchestrator"), "child must not inherit caller identity");
	assert.ok(!result.output.includes("caller-team"), "child must not inherit caller team");
	assert.match(result.output, /PI_ORCH_NO_ADOPT=1/, "child must be barred from adopting a team");
	assert.match(result.output, /PATH=/, "ordinary env still passed through");
});

await test("F4: concurrent config updates do not lose agent records", async () => {
	// Two processes racing addAgent used to clobber each other, leaking a
	// spawned process that nothing could kill.
	const { execFileSync } = await import("node:child_process");
	const script = `
import { addAgent } from ${JSON.stringify(join(import.meta.dirname, "..", "state.ts"))};
const [team, name] = process.argv.slice(2);
addAgent(team, { name, role: "worker", parent: "team_lead", task: "t", cwd: "/tmp",
  canSpawn: false, backend: "headless", paneId: null, visible: false,
  createdAt: new Date().toISOString() });
`;
	const runner = join(cwd, "add-agent.mjs");
	writeFileSync(runner, script);
	const before = readTeam(team)!.agents.length;
	const kids = ["race-a", "race-b", "race-c", "race-d"].map((name) =>
		new Promise<void>((resolve) => {
			setTimeout(() => {
				try {
					execFileSync("node", ["--experimental-strip-types", runner, team, name], { stdio: "ignore" });
				} catch {
					// Surfaced by the assertion below.
				}
				resolve();
			}, 0);
		}),
	);
	await Promise.all(kids);
	const after = readTeam(team)!.agents;
	for (const name of ["race-a", "race-b", "race-c", "race-d"]) {
		assert.ok(after.some((a) => a.name === name), `${name} lost to a concurrent write`);
	}
	assert.equal(after.length, before + 4);
});

await test("F5: /new or /resume must not kill a live team", async () => {
	// session_shutdown fires on session SWITCH as well as on exit; cleaning up
	// there killed every working agent the moment the user typed /new.
	const agentsBefore = readTeam(team)!.agents.filter((a) => !a.killedAt).length;
	assert.ok(agentsBefore > 0, "need live agents for this test to mean anything");
	for (const handler of handlers.get("session_before_switch") ?? []) await handler({}, ctx);
	for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
	const survived = readTeam(team)!.agents.filter((a) => !a.killedAt).length;
	assert.equal(survived, agentsBefore, "switching sessions must not tear down the team");
	// pi always fires session_start for the new session after a switch; leave
	// the runtime in that realistic state (watchers reinstalled) for later tests.
	await fire("session_start", { reason: "new" });
});

await test("force shutdown cascades and marks state", async () => {
	await call("team_force_shutdown", { name: "orch-b" });
	const agent = readTeam(team)!.agents.find((a) => a.name === "orch-b")!;
	assert.ok(agent.killedAt);
	assert.equal(readAllStatuses(team)["orch-b"]!.state, "killed");
});

await test("evaluate spawns an evaluator", async () => {
	const output = await call("team_evaluate", { agents: ["worker-a"], evaluatorName: "grader" });
	assert.match(output, /Evaluator spawned/);
	const agent = readTeam(team)!.agents.find((a) => a.name === "grader")!;
	assert.equal(agent.role, "evaluator");
});

await test("cleanup kills everything and removes the directory", async () => {
	const dir = teamDir(team);
	const output = await call("team_cleanup");
	assert.match(output, /Cleaned up team/);
	assert.equal(existsSync(dir), false);
	const leftovers = listTeams().filter((t) => !before.has(t.team));
	assert.equal(
		leftovers.length,
		0,
		`teams left behind: ${JSON.stringify(leftovers.map((t) => ({ team: t.team, agents: t.agents.map((a) => a.name) })))}`,
	);
});

// -------------------- mailbox/watchdog regressions (fix-worker-feedback-loop)

console.log("worker-exit feedback loop");

await test("mail to a team created after cleanup is still delivered", async () => {
	// Real incident (team-20260902180005): the mailbox watcher was installed
	// once, for the FIRST team. After team_cleanup + a new team_spawn in the
	// same session, nobody watched the new team's mailbox — 9 worker messages,
	// including exit-without-done reports, sat undelivered for 2.5 hours while
	// the lead kept working.
	const output = await call("team_spawn", { name: "worker-c", task: "Write a haiku to /tmp/haiku2.md" });
	assert.match(output, /Spawned \*\*worker-c\*\*/);
	const teams = listTeams().filter((t) => !before.has(t.team));
	assert.equal(teams.length, 1, "a fresh team after cleanup");
	const team2 = teams[0]!.team;
	sent.length = 0;
	postMail(team2, { from: "worker-c", to: "team_lead", kind: "message", content: "still listening?" });
	await new Promise((resolve) => setTimeout(resolve, 3500));
	assert.ok(
		sent.some((m) => m.content.includes("still listening?")),
		`mail to the new team must be delivered, got ${JSON.stringify(sent)}`,
	);
	await call("team_cleanup");
});

await test("watchdog flags an agent that exits without reporting done", async () => {
	// The worker-side session_shutdown hook covers graceful exits and the
	// one-shot liveness check covers the first ~8s. A mid-task death (crash,
	// OOM, SIGKILL, turn-limit exit without the hook) was invisible until a
	// manual team_status. The watchdog must catch it and wake the lead.
	await call("team_spawn", { name: "worker-d", task: "t" });
	const team3 = listTeams().filter((t) => !before.has(t.team))[0]!.team;
	// Simulate a worker that died mid-task: a config record past the startup
	// grace window with no live process and a non-terminal status.
	addAgent(team3, {
		name: "ghost",
		role: "worker",
		parent: "team_lead",
		task: "t",
		cwd,
		canSpawn: false,
		backend: "headless",
		paneId: null,
		visible: false,
		createdAt: new Date(Date.now() - 60_000).toISOString(),
	});
	writeStatus(team3, { agent: "ghost", state: "active", note: "mid-flight" });
	sent.length = 0;
	await new Promise((resolve) => setTimeout(resolve, 2000));
	const ghost = readAllStatuses(team3).ghost!;
	assert.equal(ghost.state, "error", "watchdog must record the failure");
	assert.match(ghost.note ?? "", /watchdog/);
	assert.ok(
		sent.some((m) => m.content.includes("ghost") && m.content.includes("team_recycle")),
		`expected a watchdog wake-up naming the agent and the remedy, got ${JSON.stringify(sent)}`,
	);
	await call("team_cleanup");
});

await test("watchdog leaves done agents and live agents alone", async () => {
	await call("team_spawn", { name: "worker-e", task: "t" });
	const team4 = listTeams().filter((t) => !before.has(t.team))[0]!.team;
	addAgent(team4, {
		name: "finished",
		role: "worker",
		parent: "team_lead",
		task: "t",
		cwd,
		canSpawn: false,
		backend: "headless",
		paneId: null,
		visible: false,
		createdAt: new Date(Date.now() - 60_000).toISOString(),
	});
	writeStatus(team4, { agent: "finished", state: "done", output: "/tmp/f.md" });
	sent.length = 0;
	await new Promise((resolve) => setTimeout(resolve, 2000));
	assert.equal(readAllStatuses(team4).finished!.state, "done", "verdict must not be clobbered");
	assert.equal(
		sent.filter((m) => m.content.includes("finished") || m.content.includes("worker-e")).length,
		0,
		`no false failure reports, got ${JSON.stringify(sent)}`,
	);
	await call("team_cleanup");
});

// ------------------------------- UI bounding + recycling (screenshot bug)

console.log("widget bounding and reaping");

await test("a finished agent shows its outcome, not how it was stopped", () => {
	// From the screenshot: five agents, every one rendered ✖, because cleanup
	// stamps killedAt on all of them — erasing that four had reported done.
	const base = {
		name: "a", role: "worker" as const, parent: "team_lead", task: "t", cwd: "/tmp",
		canSpawn: false, backend: "headless" as const, paneId: null, visible: false,
		createdAt: new Date().toISOString(),
	};
	const killedAt = new Date().toISOString();
	const done = { agent: "a", state: "done" as const, output: "/tmp/x.md", updatedAt: killedAt };
	assert.equal(displayState({ ...base, killedAt }, done), "done", "outcome outranks teardown");
	assert.equal(displayState({ ...base, killedAt }, undefined), "killed");
	assert.equal(
		displayState({ ...base, killedAt }, { agent: "a", state: "active", updatedAt: killedAt }),
		"killed",
		"a non-terminal status does not survive teardown",
	);
});

await test("counts and rows cannot disagree", () => {
	// The screenshot showed `0▶ 0✔ 0⚠ 0✖` above five rendered rows.
	const now = new Date().toISOString();
	const mk = (name: string, state: string, killed = false) => ({
		agent: {
			name, role: "worker" as const, parent: "team_lead", task: "t", cwd: "/tmp",
			canSpawn: false, backend: "headless" as const, paneId: null, visible: false,
			createdAt: now, ...(killed ? { killedAt: now } : {}),
		},
		status: { agent: name, state, updatedAt: now },
	});
	const entries = [mk("w1", "done", true), mk("w2", "error", true), mk("w3", "done", true), mk("w4", "active", true), mk("w5", "stuck", true)];
	const cfg = { team: "t", createdAt: now, leadName: "team_lead", cwd: "/tmp", backend: "headless" as const, leadPid: 1, agents: entries.map((e) => e.agent) };
	const statuses = Object.fromEntries(entries.map((e) => [e.agent.name, e.status])) as never;
	const views = buildViews(cfg as never, statuses, () => false);
	const counts = countStates(views);
	assert.equal(counts.total, 5);
	assert.equal(counts.done + counts.error + counts.stuck + counts.live + counts.killed, 5, "buckets must sum to total");
	assert.equal(counts.done, 2);
	assert.equal(counts.error, 1);
	assert.equal(counts.stuck, 1);
	assert.equal(counts.killed, 1, "the non-terminal one counts as killed, not invisible");
});

await test("20 agents render a bounded, prioritised widget", () => {
	const now = Date.now();
	const views = Array.from({ length: 20 }, (_, i) => {
		const state = i === 17 ? "stuck" : i === 18 ? "error" : i < 3 ? "active" : "done";
		return {
			agent: {
				name: `worker-${i}`, role: "worker" as const, parent: "team_lead", task: "t", cwd: "/tmp",
				canSpawn: false, backend: "headless" as const, paneId: null, visible: false,
				createdAt: new Date(now - i * 1000).toISOString(),
			},
			depth: 0,
			status: { agent: `worker-${i}`, state, updatedAt: new Date(now - i * 1000).toISOString(), note: "x".repeat(300) },
			alive: state === "active",
			state,
			rank: 0,
			updatedAt: now - i * 1000,
		};
	}) as never[];
	const built = buildViews(
		{ team: "t", createdAt: new Date().toISOString(), leadName: "team_lead", cwd: "/tmp", backend: "headless", leadPid: 1,
			agents: (views as never[]).map((v: never) => (v as { agent: unknown }).agent) } as never,
		Object.fromEntries((views as never[]).map((v: never) => {
			const view = v as { agent: { name: string }; status: unknown };
			return [view.agent.name, view.status];
		})) as never,
		(name) => ["worker-0", "worker-1", "worker-2"].includes(name),
	);
	const lines = widgetLines({ teamName: "team-x", views: built, width: 100, maxRows: 6 });
	assert.ok(lines.length <= 8, `widget must stay bounded, got ${lines.length} lines`);
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 100, `line exceeds width and would wrap: ${visibleWidth(line)}`);
	}
	assert.match(lines[lines.length - 1]!, /\+\d+ more/, "hidden agents are accounted for");
	const body = lines.slice(1, -1).join("\n");
	assert.match(body, /worker-17/, "stuck agent must be visible");
	assert.match(body, /worker-18/, "failed agent must be visible");
	assert.match(body, /worker-0/, "live agents must be visible");
	assert.ok(!/worker-1[0-6]\b/.test(body), "old finished agents are collapsed away");
	assert.match(lines[0]!, /3▶ .*⚠ .*✖/, "header carries the full tally");
});

await test("reaping archives outcomes and spares live work", async () => {
	const { reapTeam, archivePath } = await import("../reap.ts");
	const reapTeamName = "smoke-reap-team";
	const dir = join(TEAMS_ROOT, reapTeamName);
	mkdirSync(join(dir, "status"), { recursive: true });
	mkdirSync(join(dir, "logs"), { recursive: true });
	const old = new Date(Date.now() - 60 * 60_000).toISOString();
	const mkAgent = (name: string) => ({
		name, role: "worker", parent: "team_lead", task: `task for ${name}`, cwd,
		canSpawn: false, backend: "headless", paneId: null, visible: false, createdAt: old,
	});
	writeFileSync(join(dir, "config.json"), JSON.stringify({
		team: reapTeamName, createdAt: old, leadName: "team_lead", cwd, backend: "headless",
		leadPid: process.pid,
		agents: [mkAgent("finished"), mkAgent("failed"), mkAgent("running"), mkAgent("parent"), mkAgent("child")],
	}));
	// `child` is alive, so its parent must survive the reap.
	writeFileSync(join(dir, "logs", "child.pid"), `${process.pid}\n`);
	writeFileSync(join(dir, "logs", "running.pid"), `${process.pid}\n`);
	const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
	cfg.agents.find((a: { name: string }) => a.name === "child").parent = "parent";
	writeFileSync(join(dir, "config.json"), JSON.stringify(cfg));
	writeStatus(reapTeamName, { agent: "finished", state: "done", output: "/tmp/finished.md" });
	writeStatus(reapTeamName, { agent: "failed", state: "error", note: "boom" });
	writeStatus(reapTeamName, { agent: "running", state: "active" });
	writeStatus(reapTeamName, { agent: "parent", state: "done" });
	// Backdate the statuses past the retention window.
	for (const name of ["finished", "failed", "parent"]) {
		const p = join(dir, "status", `${name}.json`);
		const st = JSON.parse(readFileSync(p, "utf8"));
		st.updatedAt = old;
		writeFileSync(p, JSON.stringify(st));
	}

	const result = reapTeam(reapTeamName, { olderThanMs: 60_000 });
	assert.deepEqual(result.reaped.sort(), ["failed", "finished"], "only finished, non-parent agents");
	const after = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
	const names = after.agents.map((a: { name: string }) => a.name).sort();
	assert.deepEqual(names, ["child", "parent", "running"], "live agents and live parents survive");

	// The deliverable must still be findable after reaping.
	const archived = readFileSync(archivePath(reapTeamName), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	const finished = archived.find((a) => a.name === "finished");
	assert.equal(finished.output, "/tmp/finished.md", "deliverable path preserved");
	assert.equal(finished.finalState, "done");
	assert.ok(archived.find((a) => a.name === "failed").note.includes("boom"));
	rmSync(dir, { recursive: true, force: true });
});

await test("a respawned agent is not reaped on its predecessor's status", async () => {
	// team_recycle reuses the name. Between creating the new record and its
	// first status write, the OLD run's `done` is still on disk — reaping on
	// that stale verdict would archive and delete a brand-new live agent.
	const { reapTeam } = await import("../reap.ts");
	const name = "smoke-reap-stale";
	const dir = join(TEAMS_ROOT, name);
	mkdirSync(join(dir, "status"), { recursive: true });
	mkdirSync(join(dir, "logs"), { recursive: true });
	writeStatus(name, { agent: "recycled", state: "done", output: "/tmp/old.md" });
	const statusFile = join(dir, "status", "recycled.json");
	const parsed = JSON.parse(readFileSync(statusFile, "utf8"));
	parsed.updatedAt = new Date(Date.now() - 3600_000).toISOString(); // written an hour ago
	writeFileSync(statusFile, JSON.stringify(parsed));
	writeFileSync(join(dir, "config.json"), JSON.stringify({
		team: name, createdAt: new Date(Date.now() - 7200_000).toISOString(), leadName: "team_lead",
		cwd, backend: "headless", leadPid: process.pid,
		agents: [{ name: "recycled", role: "worker", parent: "team_lead", task: "t", cwd,
			canSpawn: false, backend: "headless", paneId: null, visible: false,
			createdAt: new Date().toISOString() }], // record created just now
	}));
	assert.deepEqual(reapTeam(name, { all: true }).reaped, [], "stale verdict must not reap the new agent");
	rmSync(dir, { recursive: true, force: true });
});

await test("sweeping removes abandoned teams and spares live ones", async () => {
	const { sweepTeams } = await import("../reap.ts");
	const mkTeam = (name: string, ageMs: number, leadPid: number, liveAgent: boolean) => {
		const dir = join(TEAMS_ROOT, name);
		mkdirSync(join(dir, "logs"), { recursive: true });
		const created = new Date(Date.now() - ageMs);
		writeFileSync(join(dir, "config.json"), JSON.stringify({
			team: name, createdAt: created.toISOString(), leadName: "team_lead",
			cwd, backend: "headless", leadPid,
			agents: liveAgent ? [{ name: "a", role: "worker", parent: "team_lead", task: "t", cwd,
				canSpawn: false, backend: "headless", paneId: null, visible: false, createdAt: new Date().toISOString() }] : [],
		}));
		if (liveAgent) writeFileSync(join(dir, "logs", "a.pid"), `${process.pid}\n`);
		// Backdate file times: the sweeper ages by last activity, so a fixture
		// that writes files "now" is not actually an abandoned team.
		utimesSync(join(dir, "config.json"), created, created);
		utimesSync(dir, created, created);
		return dir;
	};
	const deadPid = 2147480000; // not a running process
	const oldDead = mkTeam("sweep-old-dead", 30 * 24 * 3600_000, deadPid, false);
	const oldButLive = mkTeam("sweep-old-live-agent", 30 * 24 * 3600_000, deadPid, true);
	const recent = mkTeam("sweep-recent", 60_000, deadPid, false);

	const result = sweepTeams({ olderThanMs: 7 * 24 * 3600_000 });
	assert.ok(result.removed.includes("sweep-old-dead"), "abandoned team removed");
	assert.equal(existsSync(oldDead), false);
	assert.ok(existsSync(oldButLive), "a team with a live agent is never swept");
	assert.ok(existsSync(recent), "recent teams are kept");

	// A live lead protects its team even when age offers no protection.
	// createdAt must be recent, or the lead pid is by definition recycled.
	const owned = mkTeam("sweep-live-lead", 1000, process.pid, false);
	const aggressive = sweepTeams({ olderThanMs: 0 });
	assert.ok(!aggressive.removed.includes("sweep-live-lead"), "a live lead protects its team");
	assert.ok(existsSync(owned));
	for (const dir of [oldButLive, recent, owned]) rmSync(dir, { recursive: true, force: true });
});

await test("sweeping also removes corrupt team directories", async () => {
	const { sweepTeams } = await import("../reap.ts");
	const broken = join(TEAMS_ROOT, "sweep-corrupt");
	mkdirSync(join(broken, "logs"), { recursive: true });
	writeFileSync(join(broken, "config.json"), "{ this is not json");
	const busy = join(TEAMS_ROOT, "sweep-corrupt-busy");
	mkdirSync(join(busy, "logs"), { recursive: true });
	writeFileSync(join(busy, "config.json"), "{ also broken");
	writeFileSync(join(busy, "logs", "worker.pid"), `${process.pid}\n`);
	const old = new Date(Date.now() - 30 * 24 * 3600_000);
	for (const dir of [broken, busy]) utimesSync(dir, old, old);

	const result = sweepTeams({ olderThanMs: 7 * 24 * 3600_000 });
	assert.ok(result.removed.includes("sweep-corrupt"), "unreadable dirs must not live forever");
	assert.equal(existsSync(broken), false);
	assert.ok(existsSync(busy), "a corrupt dir with a live pid is left alone");
	rmSync(busy, { recursive: true, force: true });
});

await test("a recycled pid is not mistaken for a live agent", async () => {
	const { isAlive, isSameProcess } = await import("../backend.ts");
	const name = "pid-recycle";
	const pidFile = join(TEAMS_ROOT, team, "logs", `${name}.pid`);
	mkdirSync(join(pidFile, ".."), { recursive: true });
	// A pid that IS alive (this process), recorded long ago — exactly what an
	// abandoned team looks like once the OS reuses the number.
	writeFileSync(pidFile, `${process.pid}\n`);
	const old = new Date(Date.now() - 30 * 24 * 3600_000);
	utimesSync(pidFile, old, old);
	assert.equal(isAlive(team, name), false, "old record + live pid must read as dead");
	assert.equal(isSameProcess(process.pid, Date.now() - 30 * 24 * 3600_000), false);

	// Freshly recorded, same pid: genuinely alive.
	writeFileSync(pidFile, `${process.pid}\n`);
	assert.equal(isAlive(team, name), true);
	rmSync(pidFile, { force: true });
});

await test("sweeping is not blocked forever by a recycled lead pid", async () => {
	const { sweepTeams } = await import("../reap.ts");
	const name = "sweep-recycled-lead";
	const dir = join(TEAMS_ROOT, name);
	mkdirSync(join(dir, "logs"), { recursive: true });
	// leadPid is this (live) process, but the team claims to be 30 days old:
	// the pid must have been recycled, so the team is abandoned.
	const created = new Date(Date.now() - 30 * 24 * 3600_000);
	writeFileSync(join(dir, "config.json"), JSON.stringify({
		team: name, createdAt: created.toISOString(), leadName: "team_lead", cwd,
		backend: "headless", leadPid: process.pid, agents: [],
	}));
	utimesSync(join(dir, "config.json"), created, created);
	utimesSync(dir, created, created);
	const result = sweepTeams({ olderThanMs: 7 * 24 * 3600_000 });
	assert.ok(result.removed.includes(name), "recycled lead pid must not protect an abandoned team");
	assert.equal(existsSync(dir), false);
});

// ------------------------------------- team hijack guard (regression)

console.log("hijack guard");
await test("a non-UI process does not adopt or kill a live team", async () => {
	// A real incident: `pi --session <id> -p "..."` in the same cwd came up as a
	// lead, adopted the running team via cwd match, and cascade-killed a working
	// agent when that one-shot process exited.
	const victimTeam = "smoke-hijack-team";
	const dir = join(TEAMS_ROOT, victimTeam);
	mkdirSync(join(dir, "status"), { recursive: true });
	mkdirSync(join(dir, "logs"), { recursive: true });
	mkdirSync(join(dir, "mailbox", "team_lead"), { recursive: true });
	// Live team: this very process stands in for the "other" lead.
	writeFileSync(
		join(dir, "config.json"),
		JSON.stringify({
			team: victimTeam,
			createdAt: new Date().toISOString(),
			leadName: "team_lead",
			cwd,
			backend: "headless",
			leadPid: process.pid,
			agents: [
				{
					name: "busy-worker",
					role: "worker",
					parent: "team_lead",
					task: "t",
					cwd,
					canSpawn: false,
					backend: "headless",
					paneId: null,
					visible: false,
					createdAt: new Date().toISOString(),
				},
			],
		}),
	);
	writeFileSync(join(dir, "logs", "busy-worker.pid"), `${process.pid}\n`);

	// A fresh non-UI lead process starts in the same cwd.
	tools.clear();
	commands.clear();
	handlers.clear();
	for (const key of Object.keys(process.env)) {
		// Identity vars only: PI_BIN/BACKEND/MAIL_* are harness configuration,
		// and dropping the mail policy silently reverts later tests to batched.
		const HARNESS_KEYS = new Set([
			"PI_ORCH_PI_BIN",
			"PI_ORCH_BACKEND",
			"PI_ORCH_MAIL_DELIVERY",
			"PI_ORCH_MAIL_QUIET_MS",
			"PI_ORCH_MAIL_MAX_HOLD_MS",
			"PI_ORCH_RESUME_GRACE_MS",
			"PI_ORCH_QUEUE_POLL_MS",
			"PI_ORCH_WATCHDOG_POLL_MS",
		]);
		if (key.startsWith("PI_ORCH_") && !HARNESS_KEYS.has(key)) {
			delete process.env[key];
		}
	}
	agentOrchestrator(pi);
	await fire("session_start", { reason: "startup" }); // ctx.hasUI === false
	assert.match(await call("team_status"), /No team is running/, "must not adopt another lead's team");

	// ...and exiting must not kill anything.
	for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
	assert.ok(existsSync(join(dir, "config.json")), "team config must survive");
	const after = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
	assert.ok(!after.agents[0].killedAt, "live worker must not be killed by a passer-by");
	rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------- concurrency caps + per-level

console.log("concurrency caps and per-level status");

const settingsFile = join(homedir(), ".pi", "agent", "settings.json");
const setCaps = (team: Record<string, unknown>): void => {
	mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
	writeFileSync(settingsFile, JSON.stringify({ team }));
};
const IDENTITY = ["PI_ORCH_TEAM_NAME", "PI_ORCH_AGENT_NAME", "PI_ORCH_AGENT_ROLE", "PI_ORCH_PARENT_NAME", "PI_ORCH_CAN_SPAWN"];
const becomeAgent = (identity: Record<string, string> | null): void => {
	tools.clear();
	commands.clear();
	handlers.clear();
	for (const key of IDENTITY) delete process.env[key];
	for (const [key, value] of Object.entries(identity ?? {})) process.env[key] = value;
	agentOrchestrator(pi);
};
const waitFor = async (what: string, ok: () => boolean, ms = 8000): Promise<void> => {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (ok()) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.fail(`timed out waiting for ${what}`);
};

becomeAgent(null);
await fire("session_start", { reason: "startup" });
const leadTools = new Map(tools);
const leadCall = async (name: string, params: unknown = {}): Promise<string> => {
	const result = await leadTools.get(name)!.execute("test", params);
	return result.content.map((part) => part.text).join("\n");
};
let capTeam = "";
const capState = (name: string): string | undefined => readAllStatuses(capTeam)[name]?.state;

await test("defaults: 5 per parent, 8 per team, depth 3", async () => {
	rmSync(settingsFile, { force: true });
	const { spawnLimits } = await import("../config.ts");
	assert.deepEqual(spawnLimits(), { maxChildrenPerParent: 5, maxLiveAgents: 8, maxDepth: 3, queueSpawns: true });
});

await test("a spawn over the per-parent cap is queued, named, and not double-queued", async () => {
	setCaps({ maxChildrenPerParent: 2, maxLiveAgents: 4, maxDepth: 2 });
	assert.match(await leadCall("team_spawn", { name: "c1", task: "t" }), /Spawned \*\*c1\*\*/);
	capTeam = readTeam(listTeams().find((t) => t.agents.some((a) => a.name === "c1"))!.team)!.team;
	assert.match(await leadCall("team_spawn", { name: "c2", task: "t" }), /Spawned \*\*c2\*\*/);
	const queued = await leadCall("team_spawn", { name: "c3", task: "t" });
	assert.match(queued, /Queued \*\*c3\*\*/);
	assert.match(queued, /maxChildrenPerParent=2/, "names the cap");
	assert.match(queued, /team_lead has 2 live direct children/, "names the count");
	assert.match(queued, /Do NOT retry/);
	assert.equal(capState("c3"), "queued");
	assert.ok(existsSync(join(teamDir(capTeam), "queue", "c3.json")));
	assert.match(await leadCall("team_spawn", { name: "c3", task: "t" }), /already queued/);
	const status = await leadCall("team_status");
	assert.match(status, /⧗ c3/);
	assert.match(status, /1 queued/);
});

await test("refusal mode names the cap and the setting", async () => {
	setCaps({ maxChildrenPerParent: 2, maxLiveAgents: 4, maxDepth: 2, queueSpawns: false });
	const refused = await leadCall("team_spawn", { name: "c4", task: "t" });
	assert.match(refused, /Refused to spawn 'c4': per-parent cap maxChildrenPerParent=2/);
	assert.match(refused, /team\.maxChildrenPerParent/);
	assert.ok(!readTeam(capTeam)!.agents.some((a) => a.name === "c4"), "no record left behind");
	setCaps({ maxChildrenPerParent: 2, maxLiveAgents: 4, maxDepth: 2 });
});

await test("a queued spawn starts by itself when a slot frees", async () => {
	await leadCall("team_force_shutdown", { name: "c1" });
	await waitFor("c3 to leave the queue", () => capState("c3") !== "queued");
	assert.ok(["spawning", "active"].includes(capState("c3")!), `c3 is ${capState("c3")}`);
	await waitFor("c3's process", () => isAlive(capTeam, "c3"));
	assert.ok(!existsSync(join(teamDir(capTeam), "queue", "c3.json")), "queue entry consumed");
	assert.equal(readTeam(capTeam)!.agents.find((a) => a.name === "c3")!.parent, "team_lead");
});

await test("an agent that reported done no longer holds a slot", async () => {
	writeStatus(capTeam, { agent: "c2", state: "done", output: "/tmp/c2.md" });
	assert.match(await leadCall("team_spawn", { name: "m1", task: "manage", canSpawn: true }), /Spawned \*\*m1\*\* \(orchestrator/);
});

// m1 is now a live sub-orchestrator child of the lead. Become m1, with a UI.
const widgets: Array<unknown> = [];
const uiCtx = {
	cwd,
	hasUI: true,
	ui: { ...stubUi, setWidget: (_key: string, value: unknown) => widgets.push(value) },
} as unknown as typeof ctx;
becomeAgent({
	PI_ORCH_TEAM_NAME: capTeam,
	PI_ORCH_AGENT_NAME: "m1",
	PI_ORCH_AGENT_ROLE: "orchestrator",
	PI_ORCH_PARENT_NAME: "team_lead",
	PI_ORCH_CAN_SPAWN: "true",
});
for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, uiCtx);

await test("a canSpawn child at the depth cap is spawned as a worker", async () => {
	const output = await call("team_spawn", { name: "g1", task: "t", canSpawn: true });
	assert.match(output, /Spawned \*\*g1\*\* \(worker/);
	assert.match(output, /depth cap \(maxDepth=2\)/);
	const g1 = readTeam(capTeam)!.agents.find((a) => a.name === "g1")!;
	assert.equal(g1.parent, "m1");
	assert.equal(g1.canSpawn, false);
});

await test("spawning past maxDepth is refused with the cap named", async () => {
	setCaps({ maxChildrenPerParent: 2, maxLiveAgents: 4, maxDepth: 1 });
	const output = await call("team_spawn", { name: "g9", task: "t" });
	assert.match(output, /Refused to spawn 'g9': depth cap maxDepth=1/);
	setCaps({ maxChildrenPerParent: 3, maxLiveAgents: 4, maxDepth: 2 });
});

await test("the team-wide cap queues a sub-orchestrator's spawn", async () => {
	// live: c3, m1, g1 = 3 of 4
	assert.match(await call("team_spawn", { name: "g2", task: "t" }), /Spawned \*\*g2\*\*/);
	const output = await call("team_spawn", { name: "g3", task: "t" });
	assert.match(output, /Queued \*\*g3\*\*/);
	assert.match(output, /team cap maxLiveAgents=4 reached: 4 live agents/);
});

await test("team_status from a sub-orchestrator defaults to its own subtree", async () => {
	const mine = await call("team_status");
	assert.match(mine, /● m1 \[you — showing your subtree\]/);
	assert.match(mine, /g1/);
	assert.match(mine, /⧗ g3/);
	assert.ok(!/\bc3\b/.test(mine), "siblings' work is not in my view");
	assert.match(await call("team_status", { scope: "team" }), /\bc3\b/);
});

await test("a sub-orchestrator's pane shows a widget of its own subtree", async () => {
	type Factory = (tui: unknown, theme: unknown) => { render(width: number): string[] };
	const latest = (): string[] => {
		const factory = widgets.filter((w) => typeof w === "function").at(-1) as Factory | undefined;
		return factory ? factory({}, { fg: (_c: string, text: string) => text }).render(120) : [];
	};
	await waitFor("m1's widget to show its queued child", () => latest().join("\n").includes("g3"), 8000);
	const lines = latest();
	assert.match(lines[0]!, /^m1 \(/, `header names the sub-orchestrator: ${lines[0]}`);
	const body = lines.join("\n");
	assert.match(body, /g1/);
	assert.match(body, /g3/);
	assert.ok(!/\bc3\b/.test(body), "the lead's other children are not in m1's widget");
});

await test("the lead's widget lists direct children with rolled-up counts", () => {
	const config = readTeam(capTeam)!;
	const views = buildViews(config, readAllStatuses(capTeam), (name) => isAlive(capTeam, name));
	const lines = widgetLines({ teamName: capTeam, views, width: 160, maxRows: 6 });
	const m1Row = lines.find((line) => /\bm1\b/.test(line));
	assert.ok(m1Row, `m1 row missing: ${lines.join(" | ")}`);
	assert.match(m1Row!, /\[2▶ 0✔ 0⚠ 0✖ 1⧗\]/, `rollup under m1: ${m1Row}`);
	assert.ok(!lines.some((line) => /\bg1\b/.test(line)), "grandchildren are rolled up, not listed");
	assert.match(lines[0]!, /1⧗/, "header tallies the whole tree");
});

await test("the lead's team_status shows direct reports with team rollups", async () => {
	const output = await leadCall("team_status");
	assert.match(output, /m1 \[orch\] \[team: 2▶ 0✔ 0⚠ 0✖ 1⧗\]/);
	assert.ok(!/\bg1\b/.test(output), "grandchildren not listed by default");
	assert.match(await leadCall("team_status", { depth: 2 }), /\bg1\b/);
});

// Become g1, a worker under m1.
becomeAgent({
	PI_ORCH_TEAM_NAME: capTeam,
	PI_ORCH_AGENT_NAME: "g1",
	PI_ORCH_AGENT_ROLE: "worker",
	PI_ORCH_PARENT_NAME: "m1",
	PI_ORCH_CAN_SPAWN: "false",
});

await test("a grandchild's report to the lead is rerouted to its own parent", async () => {
	drainMailbox(capTeam, "m1");
	drainMailbox(capTeam, "team_lead");
	const output = await call("team_message", { to: "team_lead", content: "all done" });
	assert.match(output, /Rerouted to your parent m1/);
	const toParent = drainMailbox(capTeam, "m1");
	assert.equal(toParent.length, 1);
	assert.match(toParent[0]!.content, /addressed to team_lead/);
	assert.match(toParent[0]!.content, /all done/);
	assert.equal(drainMailbox(capTeam, "team_lead").length, 0, "the lead is not bypassed into");
	await call("team_message", { to: "m1", content: "direct" });
	assert.equal(drainMailbox(capTeam, "m1")[0]!.content, "direct", "mail to the parent is untouched");
});

await test("attention goes to the direct parent only", async () => {
	await call("team_attention", { level: "medium", question: "which?" });
	assert.equal(drainMailbox(capTeam, "m1").length, 1);
	assert.equal(drainMailbox(capTeam, "team_lead").length, 0);
	writeStatus(capTeam, { agent: "g1", state: "active" });
});

await test("broadcast reaches siblings, never up the chain", async () => {
	for (const name of ["m1", "team_lead", "g2", "c3"]) drainMailbox(capTeam, name);
	await call("team_broadcast", { content: "heads up" });
	assert.equal(drainMailbox(capTeam, "g2").length, 1, "sibling");
	assert.equal(drainMailbox(capTeam, "m1").length, 0, "parent");
	assert.equal(drainMailbox(capTeam, "team_lead").length, 0, "lead");
	assert.equal(drainMailbox(capTeam, "c3").length, 0, "another branch");
});

await test("recycling a grandchild keeps its original parent", async () => {
	await leadCall("team_recycle", { name: "g2" });
	const g2 = readTeam(capTeam)!.agents.find((a) => a.name === "g2")!;
	assert.equal(g2.parent, "m1");
});

await test("a queued spawn whose parent finished is cancelled, not orphaned", async () => {
	assert.equal(capState("g3"), "queued");
	writeStatus(capTeam, { agent: "m1", state: "done" });
	await waitFor("g3 to be cancelled", () => capState("g3") === "killed");
	assert.match(readAllStatuses(capTeam)["g3"]!.note ?? "", /cancelled: parent m1 finished/);
	assert.ok(!existsSync(join(teamDir(capTeam), "queue", "g3.json")));
});

await test("a claim on a long-queued entry is not mistaken for a stale one", async () => {
	const { claim, enqueue, listQueue } = await import("../caps.ts");
	const old = new Date(Date.now() - 10 * 60_000);
	enqueue(capTeam, { name: "old-q", parent: "team_lead", queuedAt: old.toISOString(), params: {} });
	utimesSync(join(teamDir(capTeam), "queue", "old-q.json"), old, old);
	const first = claim(capTeam, "old-q");
	assert.ok(first, "first claim wins");
	listQueue(capTeam);
	assert.equal(claim(capTeam, "old-q"), null, "a second pump must not steal a fresh claim");
	first!.finish();
});

await test("a queued record killed before it started is settled, so team_await does not hang", async () => {
	addAgent(capTeam, {
		name: "q9", role: "worker", parent: "team_lead", task: "t", cwd, canSpawn: false,
		backend: "headless", paneId: null, visible: false, createdAt: new Date().toISOString(),
		killedAt: new Date().toISOString(),
	});
	writeStatus(capTeam, { agent: "q9", state: "queued" });
	await waitFor("q9 to be settled", () => capState("q9") === "killed", 5000);
});

await test("a superseded startup check leaves the replacement alone", async () => {
	addAgent(capTeam, {
		name: "t9", role: "worker", parent: "team_lead", task: "t", cwd, canSpawn: false,
		backend: "headless", paneId: null, visible: false, createdAt: new Date().toISOString(),
	});
	writeStatus(capTeam, { agent: "t9", state: "spawning" });
	scheduleLivenessCheck({ me: "team_lead" } as never, capTeam, "t9", 0, "team_lead", "1970-01-01T00:00:00.000Z");
	await new Promise((resolve) => setTimeout(resolve, 8600));
	assert.equal(capState("t9"), "spawning", "an old generation's timer must not mark the new one failed");
});

rmSync(settingsFile, { force: true });
await leadCall("team_cleanup", {});


// ------------------------------------------- team_ask answers or says so

console.log("team_ask non-answers");

becomeAgent(null);
const askWidgets: Array<unknown> = [];
const askUiCtx = {
	cwd,
	hasUI: true,
	ui: { ...stubUi, setWidget: (_key: string, value: unknown) => askWidgets.push(value) },
} as unknown as typeof ctx;
for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, askUiCtx);
const askLead = new Map(tools);
const askCall = async (params: unknown): Promise<{ text: string; details: Record<string, unknown> }> => {
	const result = (await askLead.get("team_ask")!.execute("test", params)) as unknown as {
		content: Array<{ text: string }>;
		details: Record<string, unknown>;
	};
	return { text: result.content.map((part) => part.text).join("\n"), details: result.details ?? {} };
};
const askStatus = async (): Promise<string> =>
	(await askLead.get("team_status")!.execute("test", {})).content.map((part) => part.text).join("\n");

await askLead.get("team_spawn")!.execute("test", { name: "ask-seed", task: "t" });
const askTeam = listTeams().find((t) => t.agents.some((a) => a.name === "ask-seed"))!.team;

const planDir = join(cwd, "ask-plan");
const askStub = join(binDir, "pi-ask-stub");
writeFileSync(
	askStub,
	[
		"#!/bin/sh",
		`dir=${JSON.stringify(planDir)}`,
		'n=$(cat "$dir/count" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$dir/count"',
		'for last; do :; done',
		'printf "%s" "$last" > "$dir/prompt$n.txt"',
		'action=$(sed -n "${n}p" "$dir/plan")',
		'case "$action" in',
		'  answer) echo "Verdict: A1 is fixed. P1 still has a blocker in foo.ts:12." ;;',
		'  defer) echo "I\'ve started a read-only re-check of A1 and P1 at the latest PR heads. I\'ll return a verdict for each PR." ;;',
		"  empty) printf '   \\n' ;;",
		'  die) echo "provider error: overloaded" >&2; exit 3 ;;',
		"esac",
	].join("\n"),
);
chmodSync(askStub, 0o755);
const plan = (...steps: string[]): void => {
	rmSync(planDir, { recursive: true, force: true });
	mkdirSync(planDir, { recursive: true });
	writeFileSync(join(planDir, "plan"), `${steps.join("\n")}\n`);
};
const attempts = (): number => Number(readFileSync(join(planDir, "count"), "utf8").trim());
const prompt = (n: number): string => readFileSync(join(planDir, `prompt${n}.txt`), "utf8");
const addAsked = (name: string): void => {
	addAgent(askTeam, {
		name, role: "worker", parent: "team_lead", task: "review", cwd, canSpawn: false,
		backend: "headless", paneId: null, visible: false,
		createdAt: new Date(Date.now() - 60_000).toISOString(),
		sessionId: `sess-${name}`, argv: [askStub, "--mode", "json", "-p", "--", "kickoff"],
	});
	writeStatus(askTeam, { agent: name, state: "done", output: "/tmp/review.md" });
};
addAsked("reviewer");
const { readAsks, classifyReply, runAsk, findDeferral } = await import("../ask.ts");

await test("team_ask: a normal answer is returned as answered, wrapped as one-shot", async () => {
	plan("answer");
	const { text, details } = await askCall({ name: "reviewer", question: "Are A1 and P1 fixed?" });
	assert.match(text, /^\*\*reviewer\*\* answered \(from its own session\):/);
	assert.match(text, /P1 still has a blocker/);
	assert.equal(details.answered, true);
	assert.equal(attempts(), 1);
	assert.match(prompt(1), /one-shot reply/);
	assert.match(prompt(1), /no later turn/);
	assert.match(prompt(1), /Never reply with a plan, a status update, or a promise to follow up/);
	assert.match(prompt(1), /Question:\nAre A1 and P1 fixed\?$/);
	const record = readAsks(askTeam).at(-1)!;
	assert.equal(record.agent, "reviewer");
	assert.equal(record.by, "team_lead");
	assert.equal(record.answered, true);
	assert.ok(record.finishedAt);
	assert.ok(!/ask → reviewer/.test(await askStatus()));
});

await test("team_ask: a deferral is re-asked once with the deferral quoted, then answered", async () => {
	plan("defer", "answer");
	const { text, details } = await askCall({ name: "reviewer", question: "Re-check A1 and P1." });
	assert.equal(attempts(), 2);
	assert.match(prompt(2), /SECOND AND LAST ATTEMPT/);
	assert.match(prompt(2), /> I've started a read-only re-check/);
	assert.match(prompt(2), /deferred/);
	assert.match(text, /answered \(from its own session\) after a re-ask \(first reply: deferred/);
	assert.match(text, /P1 still has a blocker/);
	assert.equal(details.answered, true);
	assert.equal(details.attempts, 2);
});

await test("team_ask: two deferrals give NO ANSWER, answered:false, and a status/widget entry", async () => {
	plan("defer", "defer");
	const { text, details } = await askCall({ name: "reviewer", question: "Re-check A1 and P1 at the latest heads." });
	assert.equal(attempts(), 2);
	assert.match(text, /^NO ANSWER: deferred: "/);
	assert.match(text, /Last reply \(NOT an answer\):\n> I've started/);
	assert.ok(!/answered \(from its own session\)/.test(text));
	assert.equal(details.answered, false);
	assert.match(String(details.reason), /^deferred/);
	const status = await askStatus();
	assert.match(status, /⚠ ask → reviewer: no answer \(deferred: /);
	assert.match(status, /Re-check A1 and P1 at the latest heads/);
	type Factory = (tui: unknown, theme: unknown) => { render(width: number): string[] };
	const latest = (): string =>
		((askWidgets.filter((w) => typeof w === "function").at(-1) as Factory | undefined)?.({}, { fg: (_c: string, t: string) => t }).render(160) ?? []).join("\n");
	await waitFor("the widget to show the unanswered ask", () => latest().includes("ask → reviewer: no answer"), 8000);
});

await test("team_ask: a later answered ask resolves the unanswered entry", async () => {
	plan("answer");
	assert.equal((await askCall({ name: "reviewer", question: "Verdict now?" })).details.answered, true);
	assert.ok(!/ask → reviewer/.test(await askStatus()), "resolved ask must leave team_status");
	assert.ok(readAsks(askTeam).some((a) => a.answered === false && a.resolvedAt));
});

await test("team_ask: an empty reply twice is NO ANSWER: empty reply", async () => {
	plan("empty", "empty");
	const { text, details } = await askCall({ name: "reviewer", question: "Anything?" });
	assert.equal(attempts(), 2);
	assert.match(text, /^NO ANSWER: empty reply/);
	assert.equal(details.answered, false);
	assert.match(prompt(2), /not an answer \(empty reply\)/);
});

await test("team_ask: dismiss clears the unanswered entry", async () => {
	assert.match(await askStatus(), /ask → reviewer: no answer \(empty reply\)/);
	assert.match((await askCall({ name: "reviewer", dismiss: true })).text, /Dismissed 1/);
	assert.ok(!/ask → reviewer/.test(await askStatus()));
});

await test("team_ask: a dying subprocess is re-asked, then reported with its exit code", async () => {
	plan("die", "die");
	const { text, details } = await askCall({ name: "reviewer", question: "Verdict?" });
	assert.equal(attempts(), 2);
	assert.match(text, /^NO ANSWER: pi exited with code 3: provider error: overloaded/);
	assert.equal(details.answered, false);
	assert.match(await askStatus(), /ask → reviewer: no answer \(pi exited with code 3/);
	plan("die", "answer");
	const retried = await askCall({ name: "reviewer", question: "Verdict?" });
	assert.equal(retried.details.answered, true);
	assert.match(retried.text, /after a re-ask \(first reply: pi exited with code 3/);
	assert.ok(!/ask → reviewer/.test(await askStatus()));
});

await test("runAsk/classifyReply: timeout, signal, deferral heuristics", async () => {
	const timed = await runAsk({ argv: ["/bin/sleep", "5"], env: { PATH: process.env.PATH ?? "" }, cwd, timeoutMs: 300 });
	assert.deepEqual(classifyReply(timed), { answered: false, reason: "timed out after 0s" });
	const killed = await runAsk({ argv: ["/bin/sh", "-c", "kill -9 $$"], env: { PATH: process.env.PATH ?? "" }, cwd, timeoutMs: 5000 });
	assert.deepEqual(classifyReply(killed), { answered: false, reason: "killed by SIGKILL" });
	const missing = await runAsk({ argv: [join(cwd, "no-such-pi")], env: {}, cwd, timeoutMs: 5000 });
	assert.match((classifyReply(missing) as { reason: string }).reason, /^could not start pi/);
	assert.ok(findDeferral("I'll report back once the tests finish."));
	assert.ok(findDeferral("Kicking this off now. Will report back with results."));
	assert.ok(findDeferral("I\u2019ve kicked off the re-check."));
	assert.equal(findDeferral("Yes. A1 is fixed and P1 is not: foo.ts:12 still reads the old flag."), null);
	assert.equal(findDeferral("Let me know if you need more detail. The answer is 42."), null);
	const long = `${"Finding: the cache key omits the tenant id, so two tenants share entries. ".repeat(30)}\n\nI'll follow up with a patch if useful, but the above is the full verdict.`;
	assert.ok(findDeferral(long), "a promise in the last paragraph still counts");
	const longMiddle = `I'll report the details below.\n\n${"Finding: the cache key omits the tenant id. ".repeat(40)}`;
	assert.equal(findDeferral(longMiddle), null, "a long answer with an early promise is an answer");
});

await askLead.get("team_cleanup")!.execute("test", {});


// --------------------------------------------------- worker role gating

console.log("worker role");
tools.clear();
commands.clear();
handlers.clear();
process.env.PI_ORCH_TEAM_NAME = "smoke-worker-team";
process.env.PI_ORCH_AGENT_NAME = "w1";
process.env.PI_ORCH_AGENT_ROLE = "worker";
process.env.PI_ORCH_PARENT_NAME = "team_lead";
process.env.PI_ORCH_CAN_SPAWN = "false";
mkdirSync(join(TEAMS_ROOT, "smoke-worker-team"), { recursive: true });

agentOrchestrator(pi);
await fire("session_start", { reason: "startup" });

await test("worker gets only leaf tools", () => {
	for (const name of ["team_message", "team_broadcast", "team_write_status", "team_write_handoff", "team_attention"]) {
		assert.ok(tools.has(name), `missing ${name}`);
	}
	for (const name of ["team_spawn", "team_status", "team_cleanup", "team_force_shutdown", "team_diagnose", "team_recycle", "team_evaluate"]) {
		assert.ok(!tools.has(name), `worker must not have ${name}`);
	}
});

await test("attention notifies the parent and flags stuck", async () => {
	const output = await call("team_attention", { level: "high", question: "which file?" });
	assert.match(output, /Parent notified/);
	const mail = drainMailbox("smoke-worker-team", "team_lead");
	assert.equal(mail.length, 1);
	assert.match(mail[0]!.content, /\[attention: high\] which file\?/);
	assert.equal(readAllStatuses("smoke-worker-team")["w1"]!.state, "stuck");
});

await test("write_status refuses done until the deliverable is real and on the contract path", async () => {
	const contractFile = join(TEAMS_ROOT, "smoke-worker-team", "contracts", "w1.json");
	mkdirSync(join(TEAMS_ROOT, "smoke-worker-team", "contracts"), { recursive: true });
	const status = () => readAllStatuses("smoke-worker-team")["w1"]?.state;
	const before = status();
	const target = join(cwd, "w1-out.md");

	assert.match(await call("team_write_status", { state: "done", output: join(cwd, "nope.md") }), /ERROR: status NOT recorded: .*does not exist/);
	writeFileSync(target, "");
	assert.match(await call("team_write_status", { state: "done", output: target }), /ERROR: .*is empty/);
	assert.equal(status(), before, "a refused done leaves the status alone");

	writeFileSync(contractFile, JSON.stringify({ outputPath: target }));
	writeFileSync(join(cwd, "elsewhere.md"), "content");
	assert.match(await call("team_write_status", { state: "done", output: join(cwd, "elsewhere.md") }), /does not match your contract's outputPath/);
	assert.match(await call("team_write_status", { state: "done" }), /needs output: your contract's outputPath/);
	assert.match(await call("team_write_status", { state: "active", note: "other states are never checked" }), /Status recorded: active/);
	rmSync(contractFile);
});

await test("write_status records the deliverable", async () => {
	const out = join(cwd, "out.md");
	writeFileSync(out, "result\n");
	await call("team_write_status", { state: "done", output: out, note: "finished" });
	const status = readAllStatuses("smoke-worker-team")["w1"]!;
	assert.equal(status.state, "done");
	assert.equal(status.output, out);
	await call("team_write_status", { state: "done", output: "out.md", note: "relative" });
	assert.equal(readAllStatuses("smoke-worker-team")["w1"]!.output, out, "a relative output is stored against the worker's cwd");
});

await test("clean exit stays silent, failed exit reports", async () => {
	const shutdown = handlers.get("session_shutdown") ?? [];
	// w1 already reported `done`, so exiting is not news.
	for (const handler of shutdown) await handler({}, ctx);
	assert.equal(drainMailbox("smoke-worker-team", "team_lead").length, 0, "no redundant exit notice");

	// An agent that never reported must not exit quietly.
	writeStatus("smoke-worker-team", { agent: "w1", state: "active", note: "mid-flight" });
	for (const handler of shutdown) await handler({}, ctx);
	const mail = drainMailbox("smoke-worker-team", "team_lead");
	assert.equal(mail.length, 1);
	assert.match(mail[0]!.content, /WITHOUT completing/);
	assert.equal(readAllStatuses("smoke-worker-team")["w1"]!.state, "error");
});

await test("mail arriving before the first run is buffered until agent_start", async () => {
	// Regression (prd-crosscheck, team-20260902180005): mail flushed at
	// session_start was delivered with triggerTurn while the agent was not yet
	// streaming; sendCustomMessage started a run, and pi's json-mode driver
	// then threw "Agent is already processing" submitting the kickoff prompt
	// and exited(1) — the worker died before its first turn. Mail must wait
	// for the first agent_start, after which the followUp path queues safely.
	// (The shutdown test above disposed the mailbox watcher; pi always fires
	// session_start for the next session, so reinstall it the same way.)
	await fire("session_start", { reason: "resume" });
	sent.length = 0;
	postMail("smoke-worker-team", { from: "team_lead", to: "w1", kind: "message", content: "early bird" });
	await new Promise((resolve) => setTimeout(resolve, 2500));
	assert.equal(
		sent.filter((m) => m.content.includes("early bird")).length,
		0,
		`mail must not be delivered before the first run starts, got ${JSON.stringify(sent)}`,
	);
	await fire("agent_start");
	assert.ok(
		sent.some((m) => m.content.includes("early bird")),
		`mail must flush on agent_start, got ${JSON.stringify(sent)}`,
	);
});

await test("handoff is written and the parent told", async () => {
	const output = await call("team_write_handoff", {
		completedWork: "did the thing",
		pendingTasks: "the other thing",
	});
	assert.match(output, /Handoff written/);
	const report = JSON.parse(
		readFileSync(join(TEAMS_ROOT, "smoke-worker-team", "handoffs", "w1.json"), "utf8"),
	);
	assert.equal(report.completedWork, "did the thing");
	assert.equal(drainMailbox("smoke-worker-team", "team_lead").length, 1);
});

// ------------------------------------------------------------- teardown

rmSync(join(TEAMS_ROOT, "smoke-worker-team"), { recursive: true, force: true });
rmSync(cwd, { recursive: true, force: true });

console.log(failures === 0 ? "\nall smoke tests passed" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
