/**
 * Live end-to-end test: spawns a real pi worker and waits for it to complete
 * the full protocol (deliverable -> team_write_status -> team_message).
 *
 * Costs real tokens. Run explicitly:
 *
 *   node --experimental-strip-types tests/live.ts [model]
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import agentOrchestrator from "../index.ts";
import { listTeams, readAllStatuses, teamDir } from "../state.ts";

const MODEL = process.argv[2] ?? "anthropic/claude-haiku-4.5";
const PROVIDER = process.argv[3] ?? "vercel-ai-gateway";
const TIMEOUT_MS = 300_000;

const tools = new Map<string, { execute: (id: string, params: unknown) => Promise<{ content: Array<{ text: string }> }> }>();
const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
const received: string[] = [];

const pi = {
	on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
		handlers.set(event, [...(handlers.get(event) ?? []), handler]);
	},
	registerTool: (definition: { name: string; execute: never }) =>
		tools.set(definition.name, definition as never),
	registerCommand: () => {},
	sendMessage: (message: { content: string }) => {
		received.push(message.content);
		console.log(`\n--- delivered to lead ---\n${message.content}\n`);
	},
} as unknown as Parameters<typeof agentOrchestrator>[0];

const cwd = join(tmpdir(), `orch-live-${Date.now()}`);
mkdirSync(cwd, { recursive: true });
const outputPath = join(cwd, "greeting.md");

// Pretend the lead is running MODEL on PROVIDER; children should inherit both.
const ctx = {
	cwd,
	hasUI: false,
	model: { id: MODEL, provider: PROVIDER },
	ui: { notify: () => {}, setWidget: () => {}, setStatus: () => {} },
};

agentOrchestrator(pi);
for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);

const before = new Set(listTeams().map((t) => t.team));
const spawn = await tools.get("team_spawn")!.execute("live", {
	name: "greeter",
	task: `Write a two-line greeting to ${outputPath}. Do not do anything else.`,
	thinkingLevel: "off",
	taskContract: { outputPath, outputFormat: "markdown" },
});
console.log(spawn.content.map((c) => c.text).join("\n"));

const team = listTeams().find((t) => !before.has(t.team))!.team;
console.log(`team dir: ${teamDir(team)}`);

const deadline = Date.now() + TIMEOUT_MS;
let status = readAllStatuses(team).greeter;
while (Date.now() < deadline && status?.state !== "done" && status?.state !== "error") {
	await new Promise((resolve) => setTimeout(resolve, 3000));
	status = readAllStatuses(team).greeter;
	process.stdout.write(`\r[${Math.round((Date.now() - (deadline - TIMEOUT_MS)) / 1000)}s] ${status?.state ?? "?"}   `);
}
console.log("");

const checks: Array<[string, boolean]> = [
	["worker reported done", status?.state === "done"],
	["deliverable exists at the contract path", existsSync(outputPath)],
	["worker messaged the lead", received.some((m) => m.includes("greeter"))],
];
for (const [name, ok] of checks) console.log(`${ok ? "  ok" : "FAIL"}  ${name}`);
if (existsSync(outputPath)) console.log(`\n${readFileSync(outputPath, "utf8")}`);
else console.log(`\nlog tail:\n${readFileSync(join(teamDir(team), "logs", "greeter.log"), "utf8").slice(-2000)}`);

await tools.get("team_cleanup")!.execute("live", {});
rmSync(cwd, { recursive: true, force: true });
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
