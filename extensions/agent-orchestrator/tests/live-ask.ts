/**
 * Live end-to-end: spawn a worker, let it finish, then question it inside its
 * own saved session. Costs real tokens.
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import agentOrchestrator from "../index.ts";
import { listTeams, readAllStatuses, readTeam } from "../state.ts";

const MODEL = "anthropic/claude-haiku-4.5";
const PROVIDER = "vercel-ai-gateway";
const tools = new Map<string, { execute: (id: string, p: unknown) => Promise<{ content: Array<{ text: string }> }> }>();
const handlers = new Map<string, Array<(e: unknown, c: unknown) => unknown>>();
const pi = {
  on: (e: string, h: never) => handlers.set(e, [...(handlers.get(e) ?? []), h]),
  registerTool: (d: { name: string }) => tools.set(d.name, d as never),
  registerCommand: () => {},
  registerMessageRenderer: () => {},
  sendMessage: () => {},
} as unknown as Parameters<typeof agentOrchestrator>[0];

const cwd = join(tmpdir(), `orch-ask-${Date.now()}`);
mkdirSync(cwd, { recursive: true });
const ctx = { cwd, hasUI: false, model: { id: MODEL, provider: PROVIDER }, ui: { notify(){}, setWidget(){}, setStatus(){} } };
agentOrchestrator(pi);
for (const h of handlers.get("session_start") ?? []) await h({ reason: "startup" }, ctx);

const before = new Set(listTeams().map((t) => t.team));
const secret = `ORCHID-${Math.floor(Math.random() * 100000)}`;
const out = join(cwd, "note.txt");
const call = async (n: string, p: unknown) => (await tools.get(n)!.execute("t", p)).content.map((c) => c.text).join("\n");

console.log(await call("team_spawn", {
  name: "rememberer",
  task: `Run exactly: bash -c 'echo ${secret} > ${out}'. Then call team_write_status(state='done', output='${out}') and team_message 'team_lead' with the word DONE. Nothing else.`,
  thinkingLevel: "off",
}));
const team = listTeams().find((t) => !before.has(t.team))!.team;

const deadline = Date.now() + 180_000;
while (Date.now() < deadline && readAllStatuses(team).rememberer?.state !== "done") {
  await new Promise((r) => setTimeout(r, 3000));
}
// Wait for the process itself to exit, not just for the status flip.
const { isAlive } = await import("../backend.ts");
const exitBy = Date.now() + 60_000;
while (Date.now() < exitBy && isAlive(team, "rememberer")) {
  await new Promise((r) => setTimeout(r, 1000));
}
const agent = readTeam(team)!.agents.find((a) => a.name === "rememberer")!;
console.log(`status=${readAllStatuses(team).rememberer?.state} sessionId=${agent.sessionId ?? "MISSING"}`);
console.log(`sessionFile=${agent.sessionFile ?? "MISSING"}`);

// The question can only be answered from that worker's own context.
const answer = await call("team_ask", { name: "rememberer", question: "What exact code word did you write to the file? Reply with just the word." });
console.log("\n--- team_ask ---\n" + answer);

const checks: Array<[string, boolean]> = [
  ["worker finished", readAllStatuses(team).rememberer?.state === "done"],
  ["session id recorded", Boolean(agent.sessionId)],
  ["session file located", Boolean(readTeam(team)!.agents.find((a) => a.name === "rememberer")!.sessionFile)],
  ["resumed session recalled the secret", answer.includes(secret)],
];
console.log("");
for (const [n, ok] of checks) console.log(`${ok ? "  ok" : "FAIL"}  ${n}`);
await call("team_cleanup", {});
rmSync(cwd, { recursive: true, force: true });
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
