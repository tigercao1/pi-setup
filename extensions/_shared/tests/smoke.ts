/**
 * Smoke test for the shared extension layer.
 *
 * These modules are used by both agent-orchestrator and session-fork, so a
 * regression here breaks two extensions at once. Everything is model-free and
 * process-free except the AppleScript checks, which compile (not run) the
 * generated scripts — AppleScript only fails at runtime, which in production
 * means "the pane silently never opens".
 *
 * Run with:
 *
 *   npm test
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { drainEnvelopes, countEnvelopes, postEnvelope, watchEnvelopes } from "../mailbox.ts";
import { itermForEach, itermScript, quoteArgv, shq, type Where } from "../pane.ts";
import {
	buildSessionArgv,
	findSessionByName,
	readSessionIdFromLog,
	sessionIdFromFile,
	stripOrchIdentity,
} from "../sessions.ts";
import { askMessage, choose } from "../prompt.ts";
import { spawnEnv } from "../spawn-env.ts";

const root = join(tmpdir(), `shared-smoke-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

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

console.log("pane");

await test("shell quoting survives quotes, spaces and newlines", () => {
	const nasty = `a b'c"d$e\nf`;
	const echoed = execFileSync("/bin/sh", ["-c", `printf %s ${shq(nasty)}`], { encoding: "utf8" });
	assert.equal(echoed, nasty);
});

await test("argv rendering is copy-pasteable", () => {
	const rendered = quoteArgv(["pi", "--name", "main ⑂ try B", "--fork", "abc"]);
	assert.match(rendered, /"main ⑂ try B"/);
	const parsed = execFileSync("/bin/sh", ["-c", `for a in ${rendered}; do printf '%s\\n' "$a"; done`], {
		encoding: "utf8",
	})
		.trim()
		.split("\n");
	assert.deepEqual(parsed, ["pi", "--name", "main ⑂ try B", "--fork", "abc"]);
});

const hasOsacompile = (() => {
	try {
		execFileSync("command", ["-v", "osacompile"], { shell: "/bin/sh", stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

await test("every iTerm2 script we generate compiles", () => {
	if (!hasOsacompile) {
		console.log("      (skipped: no osacompile on this platform)");
		return;
	}
	const command = `cd '/tmp/a b' && echo $$ > '/tmp/x.pid' && exec 'pi' '--name' 'main ⑂ "B"'`;
	const scripts: string[] = [];
	for (const where of ["split-v", "split-h", "tab", "window"] as Where[]) {
		scripts.push(itermScript(command, where));
		scripts.push(itermScript(command, where, 'title with "quotes"'));
	}
	scripts.push(itermForEach("w0t0p0:ABC-123", ["          close s"]));
	scripts.push(
		itermForEach("w0t0p0:ABC-123", ["          select w", "          select t", "          select s"]),
	);
	scripts.push(itermForEach("w0t0p0:ABC-123", ["          return text of s"]));
	scripts.forEach((script, index) => {
		const out = join(root, `script-${index}.scpt`);
		try {
			execFileSync("osacompile", ["-o", out, "-e", script], { stdio: "pipe" });
		} catch (error) {
			const err = error as { stderr?: Buffer };
			throw new Error(`script ${index} failed to compile: ${err.stderr?.toString() ?? ""}\n${script}`);
		}
	});
});

console.log("sessions");

await test("resume argv keeps flags, drops the old assignment and prompt", () => {
	const original = [
		"/usr/local/bin/pi",
		"--name",
		"team:worker",
		"--thinking",
		"low",
		"--no-extensions",
		"-e",
		"/ext/index.ts",
		"--append-system-prompt",
		"you are worker-a",
		"--mode",
		"json",
		"--",
		"begin the assignment",
	];
	const argv = buildSessionArgv({ originalArgv: original, sessionId: "sess-1", mode: "inspect" });
	assert.ok(!argv.includes("--append-system-prompt"), "the stale assignment is dropped");
	assert.ok(!argv.includes("--mode"), "print/json mode is dropped");
	assert.ok(!argv.includes("begin the assignment"), "the kickoff prompt is dropped");
	assert.ok(argv.includes("--no-extensions"), "context flags are replayed");
	assert.deepEqual(argv.slice(-2), ["--session", "sess-1"]);

	const forked = buildSessionArgv({
		originalArgv: original,
		sessionId: "sess-1",
		mode: "fork",
		extraArgs: ["--name", "fresh name"],
	});
	assert.deepEqual(forked.slice(-2), ["--fork", "sess-1"]);
	assert.equal(forked.filter((a) => a === "--name").length, 1, "the old name is replaced, not doubled");
	assert.ok(forked.includes("fresh name"));

	const asked = buildSessionArgv({
		originalArgv: original,
		sessionId: "sess-1",
		mode: "inspect",
		question: "what failed?",
	});
	assert.deepEqual(asked.slice(-3), ["-p", "--", "what failed?"]);
});

await test("a JSON session header yields the session id, human logs do not", () => {
	const jsonLog = join(root, "json.log");
	writeFileSync(jsonLog, `{"type":"session","version":3,"id":"11111111-2222-3333-4444-555555555555"}\n`);
	assert.equal(readSessionIdFromLog(jsonLog), "11111111-2222-3333-4444-555555555555");

	const humanLog = join(root, "human.log");
	writeFileSync(humanLog, "pi 0.84.4\n> hello\n");
	assert.equal(readSessionIdFromLog(humanLog), null);
	assert.equal(readSessionIdFromLog(join(root, "missing.log")), null);
});

await test("a session is findable by its display name", () => {
	const sessionDir = join(root, "sessions", "--Users-x--");
	mkdirSync(sessionDir, { recursive: true });
	const id = "99999999-8888-7777-6666-555555555555";
	const file = join(sessionDir, `2026-09-04T10-00-00_${id}.jsonl`);
	writeFileSync(
		file,
		[
			`{"type":"session","version":3,"id":"${id}"}`,
			`{"type":"session_info","id":"a1","name":"team-1:orch-b"}`,
			"",
		].join("\n"),
	);
	writeFileSync(
		join(sessionDir, "2026-09-04T09-00-00_00000000-0000-0000-0000-000000000000.jsonl"),
		`{"type":"session_info","id":"a1","name":"someone else"}\n`,
	);
	process.env.PI_ORCH_SESSION_DIR = join(root, "sessions");
	try {
		const hit = findSessionByName("team-1:orch-b");
		assert.ok(hit, "a named session is findable even without a JSON log header");
		assert.equal(hit!.sessionId, id);
		assert.equal(hit!.sessionFile, file);
		assert.equal(findSessionByName("no such session"), null);
	} finally {
		delete process.env.PI_ORCH_SESSION_DIR;
	}
	assert.equal(sessionIdFromFile(file), id);
	assert.equal(sessionIdFromFile("/tmp/not-a-session.jsonl"), null);
});

console.log("identity");

await test("orchestrator identity is strippable, and NO_ADOPT is forced on", () => {
	const env = stripOrchIdentity({
		PATH: "/bin",
		PI_ORCH_TEAM_NAME: "team-1",
		PI_ORCH_AGENT_NAME: "worker-a",
		PI_ORCH_PI_BIN: "/usr/bin/pi",
	});
	assert.equal(env.PI_ORCH_TEAM_NAME, undefined);
	assert.equal(env.PI_ORCH_AGENT_NAME, undefined);
	assert.equal(env.PI_ORCH_PI_BIN, "/usr/bin/pi", "the binary path is config, not identity");
	assert.equal(env.PI_ORCH_NO_ADOPT, "1");
	assert.equal(env.PATH, "/bin");
});

await test("spawnEnv passes credentials but never identity or model lies", () => {
	const saved = { ...process.env };
	Object.assign(process.env, {
		ANTHROPIC_API_KEY: "sk-test",
		SOME_TOKEN: "t",
		PI_ORCH_AGENT_NAME: "worker-a",
		PI_FORK_SPAWN_ID: "fork-1",
		PI_FORK_ROOT: "/tmp/registry",
		PI_MODEL: "opus",
		RANDOM_UNRELATED: "x",
	});
	try {
		const env = spawnEnv({ PI_FORK_SPAWN_ID: "fork-2" });
		assert.equal(env.ANTHROPIC_API_KEY, "sk-test");
		assert.equal(env.SOME_TOKEN, "t");
		assert.equal(env.PI_ORCH_AGENT_NAME, undefined, "identity is never inherited");
		assert.equal(env.PI_FORK_SPAWN_ID, "fork-2", "the caller's explicit identity wins");
		assert.equal(env.PI_FORK_ROOT, "/tmp/registry", "registry location is config, so it travels");
		assert.equal(env.PI_MODEL, undefined, "the child's own pi sets its model");
		assert.equal(env.RANDOM_UNRELATED, undefined);
		assert.ok(env.PATH, "PATH always survives");
	} finally {
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
	}
});

console.log("mailbox");

await test("mail round-trips and is delivered exactly once", () => {
	const mail = join(root, "mail");
	postEnvelope(mail, { to: "alice", from: "bob", kind: "message", content: "hi" });
	postEnvelope(mail, { to: "alice", from: "carol", kind: "handback", content: "done" });
	assert.equal(countEnvelopes(mail, "alice"), 2);
	const first = drainEnvelopes(mail, "alice");
	assert.equal(first.length, 2);
	assert.deepEqual(
		first.map((m) => m.from),
		["bob", "carol"],
		"delivery is in send order",
	);
	assert.equal(drainEnvelopes(mail, "alice").length, 0, "drained mail is gone");
	assert.equal(drainEnvelopes(mail, "nobody").length, 0, "an unknown address is empty, not an error");
});

await test("a watcher picks up mail posted after it started", async () => {
	const mail = join(root, "mail-watch");
	const seen: string[] = [];
	const stop = watchEnvelopes(mail, "alice", (batch) => {
		for (const item of batch) seen.push(item.content);
	});
	postEnvelope(mail, { to: "alice", from: "bob", kind: "message", content: "later" });
	await new Promise((resolve) => setTimeout(resolve, 2500));
	stop();
	assert.deepEqual(seen, ["later"]);
	postEnvelope(mail, { to: "alice", from: "bob", kind: "message", content: "after stop" });
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.deepEqual(seen, ["later"], "a stopped watcher stays stopped");
	assert.equal(countEnvelopes(mail, "alice"), 1, "and leaves the mail for the next reader");
});


function promptCtx(hasUI: boolean, answers: { select?: string; input?: string; editor?: string } = {}) {
	const asked: string[] = [];
	return {
		asked,
		hasUI,
		ui: {
			select: async (title: string) => (asked.push(`select:${title}`), answers.select),
			input: async (title: string) => (asked.push(`input:${title}`), answers.input),
			editor: async (title: string) => (asked.push(`editor:${title}`), answers.editor),
		},
	};
}

const layouts = [
	{ label: "Vertical split", value: "split-v" },
	{ label: "New tab", value: "tab" },
];

await test("choose returns the picked choice's value", async () => {
	assert.deepEqual(await choose(promptCtx(true, { select: "New tab" }), "Where?", layouts), { value: "tab" });
});

await test("choose returns null when the selection is cancelled", async () => {
	assert.equal(await choose(promptCtx(true), "Where?", layouts), null);
});

await test("choose without a UI returns the first choice and never prompts", async () => {
	const ctx = promptCtx(false, { select: "New tab" });
	assert.deepEqual(await choose(ctx, "Where?", layouts), { value: "split-v" });
	assert.deepEqual(ctx.asked, []);
});

await test("askMessage: Enter with nothing typed is an empty message, Esc is null", async () => {
	assert.equal(await askMessage(promptCtx(true, { input: "  " }), "Message?"), "");
	assert.equal(await askMessage(promptCtx(true, { input: " hi " }), "Message?"), "hi");
	assert.equal(await askMessage(promptCtx(true), "Message?"), null);
});

await test("askMessage uses the editor when multiline, and never prompts without a UI", async () => {
	const ctx = promptCtx(true, { editor: "line 1\nline 2" });
	assert.equal(await askMessage(ctx, "Message?", { multiline: true }), "line 1\nline 2");
	assert.deepEqual(ctx.asked, ["editor:Message?"]);
	const headless = promptCtx(false, { input: "ignored" });
	assert.equal(await askMessage(headless, "Message?"), "");
	assert.deepEqual(headless.asked, []);
});

rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "\nall shared smoke tests passed" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
