// Model-free smoke test for context-watcher: node --experimental-strip-types tests/smoke.ts

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mod = await import("../index.ts");
const contextWatcher = mod.default;

for (const key of ["PI_ORCH_AGENT_NAME", "PI_ORCH_TEAM_NAME", "PI_ORCH_AGENT_ROLE", "PI_ORCH_PARENT_NAME"]) {
	delete process.env[key];
}

let failures = 0;
async function test(name: string, body: () => Promise<void> | void) {
	try {
		await body();
		console.log(`ok - ${name}`);
	} catch (error) {
		failures += 1;
		console.log(`not ok - ${name}`);
		console.log(error);
	}
}

const opus = {
	provider: "stub",
	id: "opus",
	cost: {
		input: 5,
		output: 25,
		cacheRead: 0.5,
		cacheWrite: 6.25,
		tiers: [{ input: 10, output: 37.5, cacheRead: 1, cacheWrite: 12.5, inputTokensAbove: 200_000 }],
	},
};

type Entry = { type: string; message?: { role: string; content: unknown } };

interface HarnessOptions {
	mode?: string;
	settings?: unknown;
	tokens?: number | null;
	factsStdout?: string;
	factsCode?: number;
	onUserMessage?: (text: string, h: Harness) => Promise<void> | void;
	cancelNewSession?: boolean;
	newSessionFailure?: "beforeShutdown" | "afterShutdown" | "seed" | "fatal";
}

interface Harness {
	statuses: Array<string | undefined>;
	notices: Array<{ message: string; level?: string }>;
	userMessages: string[];
	execCalls: Array<{ command: string; args: string[] }>;
	newSessions: Array<{ parentSession?: string }>;
	freshMessages: Array<{ text: string; options?: unknown }>;
	freshNotices: string[];
	entries: Entry[];
	setTokens(tokens: number | null): void;
	fire(event: string, payload?: unknown): Promise<void>;
	run(name: string, args?: string): Promise<void>;
	assistantSays(text: string, stopReason?: string, errorMessage?: string): void;
	runMessages: Array<Record<string, unknown>>;
	stderr: string[];
	idle: boolean;
}

function harness(options: HarnessOptions = {}): Harness {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	let tokens: number | null = options.tokens ?? 0;
	const h = {
		statuses: [] as Array<string | undefined>,
		notices: [] as Array<{ message: string; level?: string }>,
		userMessages: [] as string[],
		execCalls: [] as Array<{ command: string; args: string[] }>,
		newSessions: [] as Array<{ parentSession?: string }>,
		freshMessages: [] as Array<{ text: string; options?: unknown }>,
		freshNotices: [] as string[],
		entries: [] as Entry[],
		runMessages: [] as Array<Record<string, unknown>>,
		stderr: [] as string[],
		idle: true,
	} as Harness;

	let stale = false;
	const ui = {
		setStatus: (_key: string, text: string | undefined) => h.statuses.push(text),
		notify: (message: string, level?: string) => {
			if (stale) throw new Error("This extension ctx is stale after session replacement");
			h.notices.push({ message, level });
		},
	};
	const ctx = {
		mode: options.mode ?? "tui",
		hasUI: true,
		cwd: "/tmp/repo",
		ui,
		model: opus,
		sessionManager: {
			getSessionFile: () => "/tmp/sessions/old.jsonl",
			getSessionId: () => "old-session-id",
			getBranch: () => h.entries,
		},
		getContextUsage: () => ({ tokens, contextWindow: 1_000_000, percent: tokens === null ? null : tokens / 10_000 }),
		isIdle: () => h.idle,
		hasPendingMessages: () => false,
		waitForIdle: async () => {},
		newSession: async (opts: { parentSession?: string; withSession?: (fresh: unknown) => Promise<void> }) => {
			h.newSessions.push({ parentSession: opts.parentSession });
			if (options.cancelNewSession) return { cancelled: true };
			if (options.newSessionFailure === "beforeShutdown") throw new Error("cannot create session file");
			await h.fire("session_shutdown", { type: "session_shutdown", reason: "new" });
			stale = true;
			if (options.newSessionFailure === "afterShutdown") throw new Error("runtime startup failed");
			if (options.newSessionFailure === "fatal") return undefined;
			await opts.withSession?.({
				ui: { notify: (message: string) => h.freshNotices.push(message) },
				sendUserMessage: async (text: string, sendOptions?: unknown) => {
					if (options.newSessionFailure === "seed") throw new Error("no model selected");
					h.freshMessages.push({ text, options: sendOptions });
				},
			});
			return { cancelled: false };
		},
	};

	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand(name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.set(name, definition);
		},
		getSettings: () => options.settings ?? {},
		exec: async (command: string, args: string[]) => {
			h.execCalls.push({ command, args });
			return { stdout: options.factsStdout ?? "", stderr: "boom", code: options.factsCode ?? 0, killed: false };
		},
		sendUserMessage(text: string) {
			h.userMessages.push(text);
			setTimeout(async () => {
				h.idle = false;
				await h.fire("agent_start", { type: "agent_start" });
				h.runMessages = [{ role: "user", content: text }];
				await options.onUserMessage?.(text, h);
				await h.fire("agent_end", { type: "agent_end", messages: h.runMessages });
				h.idle = true;
				await h.fire("agent_settled", { type: "agent_settled", aborted: false });
			}, 5);
		},
	} as unknown as Parameters<typeof contextWatcher>[0];

	contextWatcher(pi);

	h.setTokens = (next) => {
		tokens = next;
	};
	h.fire = async (event, payload = {}) => {
		for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
	};
	h.run = async (name, args = "") => {
		await commands.get(name)?.handler(args, ctx);
	};
	h.assistantSays = (text, stopReason = "stop", errorMessage) => {
		const message = { role: "assistant", content: [{ type: "text", text }], stopReason, errorMessage };
		h.entries.push({ type: "message", message });
		h.runMessages.push(message);
	};
	return h;
}

const lastStatus = (h: Harness) => h.statuses.at(-1);
const warnings = (h: Harness) => h.notices.filter((n) => n.level === "warning");

await test("config defaults and overrides", () => {
	assert.deepEqual(
		{ ...mod.readConfig(undefined), factsScript: "" },
		{ ...mod.DEFAULT_CONFIG, factsScript: "" },
	);
	const custom = mod.readConfig({ contextWatcher: { warnTokens: 150_000, suggestTokens: 180_000, enabled: false } });
	assert.equal(custom.warnTokens, 150_000);
	assert.equal(custom.suggestTokens, 180_000);
	assert.equal(custom.enabled, false);
	assert.equal(mod.readConfig({ contextWatcher: { warnTokens: 300_000, suggestTokens: 100_000 } }).suggestTokens, 300_000);
	assert.equal(mod.readConfig({ contextWatcher: { warnTokens: "x" } }).warnTokens, 200_000);
});

await test("per-call cost uses the model's tier above 200k", () => {
	const low = mod.perCallCost(opus, 100_000);
	assert.ok(low);
	assert.equal(low.warm.toFixed(3), "0.050");
	const high = mod.perCallCost(opus, 260_000);
	assert.ok(high);
	assert.equal(high.warm.toFixed(2), "0.26");
	assert.equal(high.cold.toFixed(2), "3.25");
	assert.equal(mod.perCallCost({ id: "free" }, 260_000), undefined);
});

await test("status line at 200k, /fresh suggested once at 250k", async () => {
	const h = harness();
	await h.fire("session_start");
	h.setTokens(150_000);
	await h.fire("turn_end");
	assert.equal(lastStatus(h), undefined);
	h.setTokens(210_000);
	await h.fire("turn_end");
	assert.match(lastStatus(h) ?? "", /^ctx 210k · ~\$0\.210\/call \(\$2\.63 cache-cold\)$/);
	assert.equal(warnings(h).length, 0);
	h.setTokens(260_000);
	await h.fire("turn_end");
	assert.match(lastStatus(h) ?? "", /ctx 260k .*\/fresh$/);
	assert.equal(warnings(h).length, 1);
	assert.match(warnings(h)[0]!.message, /Run \/fresh/);
	h.setTokens(300_000);
	await h.fire("turn_end");
	h.setTokens(240_000);
	await h.fire("turn_end");
	h.setTokens(270_000);
	await h.fire("turn_end");
	assert.equal(warnings(h).length, 1, "no repeated nagging while above the warn line");
	h.setTokens(40_000);
	await h.fire("turn_end");
	assert.equal(lastStatus(h), undefined);
	h.setTokens(255_000);
	await h.fire("turn_end");
	assert.equal(warnings(h).length, 2, "a new crossing after dropping below warn notifies again");
});

await test("unknown token count leaves state alone", async () => {
	const h = harness({ tokens: 260_000 });
	await h.fire("session_start");
	await h.fire("turn_end");
	const before = h.statuses.length;
	h.setTokens(null);
	await h.fire("turn_end");
	assert.equal(h.statuses.length, before);
});

await test("thresholds come from settings.json contextWatcher", async () => {
	const h = harness({ settings: { contextWatcher: { warnTokens: 50_000, suggestTokens: 60_000 } } });
	await h.fire("session_start");
	h.setTokens(55_000);
	await h.fire("turn_end");
	assert.match(lastStatus(h) ?? "", /^ctx 55k/);
	h.setTokens(61_000);
	await h.fire("turn_end");
	assert.equal(warnings(h).length, 1);
});

await test("skips print/json/rpc modes and orchestrator workers", async () => {
	for (const mode of ["print", "json", "rpc"]) {
		const h = harness({ mode, tokens: 400_000 });
		await h.fire("session_start");
		await h.fire("turn_end");
		assert.equal(h.statuses.filter(Boolean).length, 0, mode);
		assert.equal(warnings(h).length, 0, mode);
	}
	process.env.PI_ORCH_AGENT_NAME = "worker";
	try {
		const h = harness({ tokens: 400_000 });
		await h.fire("session_start");
		await h.fire("turn_end");
		assert.equal(h.statuses.filter(Boolean).length, 0);
		await h.run("fresh");
		assert.equal(h.execCalls.length, 0);
		assert.match(h.notices.at(-1)?.message ?? "", /orchestrator worker/);
	} finally {
		delete process.env.PI_ORCH_AGENT_NAME;
	}
	process.env.PI_ORCH_NO_ADOPT = "1";
	try {
		const h = harness({ tokens: 260_000 });
		await h.fire("session_start");
		await h.fire("turn_end");
		assert.equal(warnings(h).length, 1, "a fork successor (PI_ORCH_NO_ADOPT only) is a lead");
	} finally {
		delete process.env.PI_ORCH_NO_ADOPT;
	}
});

await test("never pauses or sends anything on its own", async () => {
	const h = harness({ tokens: 900_000 });
	await h.fire("session_start");
	for (let i = 0; i < 5; i++) await h.fire("turn_end");
	assert.equal(h.userMessages.length, 0);
	assert.equal(h.newSessions.length, 0);
	assert.equal(h.execCalls.length, 0);
});

const dir = mkdtempSync(join(tmpdir(), "ctxw-"));
const factsScript = join(dir, "pi-pause-facts");
writeFileSync(factsScript, "#!/bin/sh\n");
const mission = join(dir, "ABC-1234");
mkdirSync(mission);
const resume = join(mission, "RESUME.md");
const facts = (path: string) =>
	["# Pause facts", "", "- Topic: ABC-1234", "", "## Mission folder", "", `- RESUME.md: ${path}`, ""].join("\n");
const settings = { contextWatcher: { factsScript, startTimeoutMs: 500 } };

await test("/fresh: facts, one pause message, then a new session seeded with resume <topic>", async () => {
	const h = harness({
		settings,
		tokens: 270_000,
		factsStdout: facts(resume),
		onUserMessage: (_text, hh) => {
			writeFileSync(resume, "# Resume: ABC-1234 widget sync\n- Goal: x\n");
			hh.assistantSays(`Paused.\nRESUME: ${resume}`);
		},
	});
	await h.fire("session_start");
	await h.run("fresh");
	assert.equal(h.execCalls.length, 1);
	assert.equal(h.execCalls[0]!.command, factsScript);
	assert.deepEqual(h.execCalls[0]!.args.slice(0, 4), ["--cwd", "/tmp/repo", "--session-id", "old-session-id"]);
	assert.ok(h.execCalls[0]!.args.includes("--context-tokens"));
	assert.equal(h.userMessages.length, 1);
	assert.match(h.userMessages[0]!, /Pause section of the recall skill/);
	assert.match(h.userMessages[0]!, new RegExp(`Write RESUME.md at ${resume.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
	assert.match(h.userMessages[0]!, /- Topic: ABC-1234/);
	assert.equal(h.newSessions.length, 1);
	assert.equal(h.newSessions[0]!.parentSession, "/tmp/sessions/old.jsonl");
	assert.equal(h.freshMessages.length, 1);
	assert.match(h.freshMessages[0]!.text, /^\/skill:recall resume ABC-1234 widget sync\n\nRESUME\.md: /);
	assert.deepEqual(h.freshMessages[0]!.options, { expandPromptTemplates: true });
	assert.equal(h.notices.filter((n) => n.level === "error").length, 0);
});

await test("/fresh: the RESUME path printed by the agent wins over the facts path", async () => {
	const other = join(dir, "topic-x", "RESUME.md");
	mkdirSync(join(dir, "topic-x"));
	const h = harness({
		settings,
		factsStdout: "# Pause facts\n- Topic: topic-x\n",
		onUserMessage: (_text, hh) => {
			writeFileSync(other, "no header\n");
			hh.assistantSays(`Done.\n\`RESUME: ${other}\``);
		},
	});
	await h.fire("session_start");
	await h.run("fresh");
	assert.match(h.userMessages[0]!, /No mission folder was found/);
	assert.equal(h.newSessions.length, 1);
	assert.match(h.freshMessages[0]!.text, /^\/skill:recall resume topic-x\n/);
});

await test("/fresh leaves the session alone when RESUME.md is missing or stale", async () => {
	const missing = join(dir, "nowhere", "RESUME.md");
	const h1 = harness({ settings, factsStdout: facts(missing), onUserMessage: (_t, hh) => hh.assistantSays(`RESUME: ${missing}`) });
	await h1.fire("session_start");
	await h1.run("fresh");
	assert.equal(h1.newSessions.length, 0);
	assert.match(h1.notices.at(-1)?.message ?? "", /this session is unchanged: RESUME.md not found/);

	writeFileSync(resume, "# Resume: old\n");
	const past = new Date(Date.now() - 3_600_000);
	utimesSync(resume, past, past);
	const h2 = harness({ settings, factsStdout: facts(resume), onUserMessage: (_t, hh) => hh.assistantSays(`RESUME: ${resume}`) });
	await h2.fire("session_start");
	await h2.run("fresh");
	assert.equal(h2.newSessions.length, 0);
	assert.match(h2.notices.at(-1)?.message ?? "", /was not written after \/fresh started/);
});

await test("/fresh stops when the facts script fails or is missing", async () => {
	const h1 = harness({ settings, factsCode: 2 });
	await h1.fire("session_start");
	await h1.run("fresh");
	assert.equal(h1.userMessages.length, 0);
	assert.match(h1.notices.at(-1)?.message ?? "", /pi-pause-facts exited 2: boom/);

	const h2 = harness({ settings: { contextWatcher: { factsScript: join(dir, "absent") } } });
	await h2.fire("session_start");
	await h2.run("fresh");
	assert.equal(h2.execCalls.length, 0);
	assert.match(h2.notices.at(-1)?.message ?? "", /facts script not found/);
});

await test("/fresh stops when the pause turn never starts, is aborted, or the switch is cancelled", async () => {
	const h1 = harness({ settings, factsStdout: facts(resume) });
	await h1.fire("session_start");
	const original = h1.fire;
	h1.fire = async (event, payload) => {
		if (event === "agent_start" || event === "agent_settled") return;
		await original(event, payload);
	};
	await h1.run("fresh");
	assert.equal(h1.newSessions.length, 0);
	assert.match(h1.notices.at(-1)?.message ?? "", /did not start/);

	const h2 = harness({ settings, factsStdout: facts(resume) });
	await h2.fire("session_start");
	const original2 = h2.fire;
	h2.fire = async (event, payload) => {
		if (event === "agent_settled") return original2(event, { type: "agent_settled", aborted: true });
		await original2(event, payload);
	};
	await h2.run("fresh");
	assert.equal(h2.newSessions.length, 0);
	assert.match(h2.notices.at(-1)?.message ?? "", /aborted/);

	const h3 = harness({
		settings,
		factsStdout: facts(resume),
		cancelNewSession: true,
		onUserMessage: (_t, hh) => {
			writeFileSync(resume, "# Resume: ABC-1234\n");
			hh.assistantSays(`RESUME: ${resume}`);
		},
	});
	await h3.fire("session_start");
	await h3.run("fresh");
	assert.equal(h3.newSessions.length, 1);
	assert.equal(h3.freshMessages.length, 0);
	assert.match(h3.notices.at(-1)?.message ?? "", /cancelled/);
});

const writesNote = (hh: Harness) => writeFileSync(resume, "# Resume: ABC-1234\n");

await test("/fresh stays put when the pause turn ended with an error, even with a fresh note", async () => {
	const h = harness({
		settings,
		factsStdout: facts(resume),
		onUserMessage: (_t, hh) => {
			writesNote(hh);
			hh.assistantSays(`RESUME: ${resume}`, "error", "overloaded");
		},
	});
	await h.fire("session_start");
	await h.run("fresh");
	assert.equal(h.newSessions.length, 0);
	assert.match(h.notices.at(-1)?.message ?? "", /unchanged: the pause turn ended with stopReason error: overloaded/);
});

await test("/fresh treats `RESUME: none` as a refusal even when the facts path is fresh", async () => {
	const h = harness({
		settings,
		factsStdout: facts(resume),
		onUserMessage: (_t, hh) => {
			writesNote(hh);
			hh.assistantSays("Could not finish.\nRESUME: none, the wip commit failed");
		},
	});
	await h.fire("session_start");
	await h.run("fresh");
	assert.equal(h.newSessions.length, 0);
	assert.match(h.notices.at(-1)?.message ?? "", /unchanged: the agent answered `RESUME: none`/);
});

await test("/fresh rejects a note written shortly before the pause message", async () => {
	writeFileSync(resume, "# Resume: ABC-1234\n");
	await new Promise((resolve) => setTimeout(resolve, 50));
	const h = harness({ settings, factsStdout: facts(resume), onUserMessage: (_t, hh) => hh.assistantSays(`RESUME: ${resume}`) });
	await h.fire("session_start");
	await h.run("fresh");
	assert.equal(h.newSessions.length, 0);
	assert.match(h.notices.at(-1)?.message ?? "", /was not written after \/fresh started/);
});

await test("/fresh needs the RESUME line from this pause run, not the facts path or an older reply", async () => {
	const h = harness({
		settings,
		factsStdout: facts(resume),
		onUserMessage: (_t, hh) => {
			writesNote(hh);
			hh.runMessages.push({ role: "assistant", content: [{ type: "text", text: "Paused." }], stopReason: "stop" });
		},
	});
	h.assistantSays(`RESUME: ${resume}`);
	await h.fire("session_start");
	await h.run("fresh");
	assert.equal(h.newSessions.length, 0);
	assert.match(h.notices.at(-1)?.message ?? "", /unchanged: the agent named no RESUME.md path/);
});

const pausedOk = (_t: string, hh: Harness) => {
	writesNote(hh);
	hh.assistantSays(`RESUME: ${resume}`);
};

async function captureStderr(body: () => Promise<void>): Promise<string> {
	const original = process.stderr.write.bind(process.stderr);
	let out = "";
	process.stderr.write = ((chunk: string | Uint8Array) => {
		out += String(chunk);
		return true;
	}) as typeof process.stderr.write;
	try {
		await body();
	} finally {
		process.stderr.write = original;
	}
	return out;
}

await test("/fresh switch failures are reported truthfully with the recovery paths", async () => {
	const before = harness({ settings, factsStdout: facts(resume), onUserMessage: pausedOk, newSessionFailure: "beforeShutdown" });
	await before.fire("session_start");
	await before.run("fresh");
	const beforeMsg = before.notices.at(-1)?.message ?? "";
	assert.match(beforeMsg, /switch failed before the old session closed: cannot create session file/);
	assert.match(beforeMsg, /Old session: \/tmp\/sessions\/old\.jsonl/);
	assert.doesNotMatch(beforeMsg, /unchanged/);

	const after = harness({ settings, factsStdout: facts(resume), onUserMessage: pausedOk, newSessionFailure: "afterShutdown" });
	await after.fire("session_start");
	const errAfter = await captureStderr(() => after.run("fresh"));
	assert.match(errAfter, /old session was closed but the new one failed to start: runtime startup failed/);
	assert.match(errAfter, /pi --session \/tmp\/sessions\/old\.jsonl/);
	assert.ok(errAfter.includes(`Pause note: ${resume}`));
	assert.equal(after.notices.filter((n) => /unchanged/.test(n.message)).length, 0);
	assert.match(after.notices.at(-1)?.message ?? "", /switching to a new session\. Old session: \/tmp\/sessions\/old\.jsonl/);

	const fatal = harness({ settings, factsStdout: facts(resume), onUserMessage: pausedOk, newSessionFailure: "fatal" });
	await fatal.fire("session_start");
	const errFatal = await captureStderr(() => fatal.run("fresh"));
	assert.match(errFatal, /new session failed to start\. Old session/);
});

await test("/fresh seed failure surfaces an error in the new session with the RESUME.md path", async () => {
	const h = harness({ settings, factsStdout: facts(resume), onUserMessage: pausedOk, newSessionFailure: "seed" });
	await h.fire("session_start");
	await h.run("fresh");
	assert.equal(h.freshMessages.length, 0);
	const last = h.freshNotices.at(-1) ?? "";
	assert.match(last, /resume message failed: no model selected/);
	assert.ok(last.includes(`RESUME.md ${resume}`));
	assert.match(last, /\/skill:recall resume ABC-1234/);
});

await test("/fresh refuses outside interactive mode", async () => {
	const h = harness({ mode: "print", settings, factsStdout: facts(resume) });
	await h.fire("session_start");
	await h.run("fresh");
	assert.equal(h.execCalls.length, 0);
	assert.match(h.notices.at(-1)?.message ?? "", /interactive mode/);
});

await test("reply parsing", () => {
	assert.equal(mod.resumeFromReply("a\nRESUME: /x/RESUME.md\nRESUME: /y/RESUME.md"), "/y/RESUME.md");
	assert.equal(mod.resumeFromReply("RESUME: none"), "none");
	assert.equal(mod.resumeFromReply("RESUME: none, the plans folder is read-only"), "none");
	assert.equal(mod.resumeFromReply(undefined), undefined);
	assert.deepEqual(mod.parseFacts(facts("/p/RESUME.md")), { resumePath: "/p/RESUME.md", topic: "ABC-1234" });
	assert.deepEqual(mod.parseFacts("- RESUME.md: not determined; use `<plans>/x/RESUME.md`"), {
		resumePath: undefined,
		topic: undefined,
	});
});

if (failures > 0) {
	console.log(`${failures} failed`);
	process.exit(1);
}
console.log("all passed");
