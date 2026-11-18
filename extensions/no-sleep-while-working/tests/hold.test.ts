import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
	console.log("skipped: macOS only");
	process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(tmpdir(), "no-sleep-test-"));
const teams = join(root, "teams");
const active = join(root, "run", "active");
const log = join(root, "caffeinate.log");
const fake = join(root, "fake-caffeinate");
writeFileSync(fake, `#!/bin/sh\necho "$$ $*" >> "${log}"\nexec sleep 600\n`);
chmodSync(fake, 0o755);
mkdirSync(teams, { recursive: true });

process.env.NO_SLEEP_FORCE = "1";
process.env.NO_SLEEP_POLL_MS = "200";
process.env.PI_CAFFEINATE_ACTIVE_DIR = active;
process.env.PI_CAFFEINATE_TEAMS_DIR = teams;
process.env.NO_SLEEP_CAFFEINATE_BIN = fake;
delete process.env.NO_SLEEP_SELF_HOLD;

const mod = await import("../index.ts");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const holders = (): { pid: number; args: string }[] => {
	let text = "";
	try {
		text = readFileSync(log, "utf8");
	} catch {
		return [];
	}
	return text
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [pid, ...rest] = line.split(" ");
			return { pid: Number(pid), args: rest.join(" ") };
		});
};
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const liveHolders = () => holders().filter((h) => alive(h.pid));
const waitFor = async (what: string, check: () => boolean, ms = 3_000) => {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		if (check()) return;
		await sleep(50);
	}
	assert.fail(`timed out waiting for: ${what}`);
};

let passed = 0;
const ok = (name: string) => {
	passed++;
	console.log(`  ok   ${name}`);
};

assert.equal(mod.holdMode(true, []), "dis");
assert.equal(mod.holdMode(false, ["a(1)"]), "is");
assert.equal(mod.holdMode(false, []), "");
ok("hold mode: -dis mid-turn, -is for agents only, none otherwise");

const handlers = new Map<string, ((event: unknown, ctx: unknown) => void)[]>();
const pi = {
	on(event: string, fn: (event: unknown, ctx: unknown) => void) {
		handlers.set(event, [...(handlers.get(event) ?? []), fn]);
	},
};
let idle = true;
const ctx = { isIdle: () => idle };
const fire = (event: string) => {
	for (const fn of handlers.get(event) ?? []) fn({}, ctx);
};
mod.default(pi as never);

fire("session_start");
await sleep(300);
assert.equal(liveHolders().length, 0);
ok("idle session with no agents holds nothing");

idle = false;
fire("agent_start");
await waitFor("a -dis holder", () => liveHolders().length === 1);
assert.equal(liveHolders()[0]!.args, `-dis -w ${process.pid}`);
assert.ok(readFileSync(join(active, String(process.pid)), "utf8").includes(`"pid":${process.pid}`));
ok("a turn holds caffeinate -dis -w <pi pid> and writes the marker");

idle = true;
fire("agent_end");
await waitFor("release", () => liveHolders().length === 0);
assert.throws(() => readFileSync(join(active, String(process.pid))));
ok("turn end releases the holder and removes the marker");

const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
const writeTeam = (name: string, leadPid: number, agents: unknown[]) => {
	mkdirSync(join(teams, name), { recursive: true });
	writeFileSync(join(teams, name, "config.json"), JSON.stringify({ team: name, leadPid, agents }));
};
writeTeam("someone-else", process.pid + 100000, [{ name: "theirs", paneId: `pid:${other.pid}` }]);
await sleep(400);
assert.equal(liveHolders().length, 0);
ok("agents of a team led by another pi do not count");

writeTeam("mine", process.pid, [
	{ name: "w1", paneId: `pid:${worker.pid}` },
	{ name: "gone", paneId: "pid:999999" },
	{ name: "pane", paneId: "%3" },
]);
assert.deepEqual(mod.liveSpawnedAgents(teams, process.pid), [`w1(${worker.pid})`]);
await waitFor("an -is holder from the poll", () => liveHolders().some((h) => h.args === `-is -w ${process.pid}`));
assert.equal(liveHolders().length, 1);
ok("a live headless agent of this session holds caffeinate -is between turns (dead pids and pane agents ignored)");

idle = false;
fire("agent_start");
await waitFor("mode change to -dis", () => liveHolders().length === 1 && liveHolders()[0]!.args.startsWith("-dis"));
idle = true;
fire("agent_settled");
await waitFor("back to -is", () => liveHolders().length === 1 && liveHolders()[0]!.args.startsWith("-is"));
ok("mode switches -is -> -dis -> -is with exactly one holder");

worker.kill();
await waitFor("release after the agent dies", () => liveHolders().length === 0);
ok("holder released once the last agent exits");

idle = false;
fire("agent_start");
await waitFor("holder", () => liveHolders().length === 1);
fire("session_shutdown");
await waitFor("shutdown release", () => liveHolders().length === 0);
ok("session_shutdown releases the holder");
other.kill();

const child = spawn(process.execPath, ["--experimental-strip-types", join(here, "hold-child.ts")], {
	env: { ...process.env, NO_SLEEP_CAFFEINATE_BIN: "caffeinate", PI_CAFFEINATE_ACTIVE_DIR: join(root, "child-active") },
	stdio: ["ignore", "pipe", "inherit"],
});
const childPid = child.pid!;
await new Promise<void>((resolve) => child.stdout!.on("data", (d) => String(d).includes("holding") && resolve()));
const realHolders = () => {
	try {
		return execFileSync("pgrep", ["-f", `caffeinate -dis -w ${childPid}`], { encoding: "utf8" }).trim();
	} catch {
		return "";
	}
};
await waitFor("real caffeinate for the child", () => realHolders() !== "");
child.kill("SIGKILL");
await waitFor("caffeinate exits with its pi (-w)", () => realHolders() === "", 5_000);
ok("real caffeinate -w <pid> does not outlive a SIGKILLed pi");

rmSync(root, { recursive: true, force: true });
console.log(`\nall ${passed} no-sleep tests passed`);
process.exit(0);
