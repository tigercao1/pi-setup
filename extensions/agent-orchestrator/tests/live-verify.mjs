import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXT = dirname(dirname(fileURLToPath(import.meta.url)));
const PI_DOCS = join(EXT, "node_modules", "@earendil-works", "pi-coding-agent", "docs");
const { runSkeptics } = await import(`${EXT}/verify.ts`);
const { spawnEnv } = await import(`${EXT}/config.ts`);
const env = spawnEnv({});

// TRUE finding (verified by hand earlier today).
const truthy = {
  finding: "pi's extension API exposes `pi.registerMessageRenderer(customType, renderer)` for rendering custom messages created with pi.sendMessage().",
  sources: [`${PI_DOCS}/extensions.md line 1593`],
};

// FALSE finding — the real shape of today's bad market report: right-looking
// numbers, an invented baseline date that is a Sunday.
const falsy = {
  finding: "On Monday 2026-08-31 the S&P 500 (^GSPC) closed at 7686.14, up +2.62% from its previous close of 7489.72 on 2026-08-30.",
  sources: ["/tmp/mkt-raw/%5EGSPC.json (Yahoo chart API, range=1mo, daily bars)"],
};

for (const [label, c] of [["TRUE claim", truthy], ["FALSE claim", falsy]]) {
  const t0 = Date.now();
  const r = await runSkeptics({ ...c, cwd: homedir(), env, thinkingLevel: "low",
    model: "openai/gpt-6.1-sol", provider: "vercel-ai-gateway", timeoutMs: 240000 });
  console.log(`\n=== ${label}: ${r.passed ? "VERIFIED" : "REJECTED"} (${r.passCount}/3, ${Math.round((Date.now()-t0)/1000)}s)`);
  for (const v of r.verdicts) console.log(`  ${v.kind.padEnd(8)} ${v.verdict.toUpperCase().padEnd(5)} ${v.reason.slice(0,140)}`);
}
