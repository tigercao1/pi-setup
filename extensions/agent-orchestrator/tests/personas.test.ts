/**
 * Persona model routing: models.json loading, resolveRuntime precedence, the jev route for
 * unprofiled workers (stubbed, never live) and the lead trial arms. Runs under a throwaway HOME
 * and agent dir, so it never reads or writes the real settings.
 *
 *   node --experimental-strip-types tests/personas.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "personas-test-"));
process.env.HOME = sandbox;
const agentDir = join(sandbox, ".pi", "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
assert.ok(homedir().startsWith(sandbox), "HOME must be the sandbox before config.ts loads");

const { allProfiles, resolveRuntime } = await import("../config.ts");
const personas = await import("../personas.ts");
const { resetRouteKey, routeUnprofiled, setJevEvaluate } = await import("../route.ts");
const { isTrialSpawn, readLeadTrial, TRIAL_MODELS } = await import("../trial.ts");
const { modelLine } = await import("../tools.ts");

const GW = "vercel-ai-gateway";
const OPUS = "anthropic/claude-opus-5.5";
const SONNET = "anthropic/claude-sonnet-5.5";
const GPT = "openai/gpt-6.1-sol";
const HAIKU = "anthropic/claude-haiku-5.5";
const sonnetParent = { model: SONNET, provider: GW };

const DESIGN = {
	providers: { [GW]: { apiKey: "$UNUSED" } },
	aliases: {
		opus: { model: OPUS, provider: GW },
		sonnet: { model: SONNET, provider: GW },
		gpt: { model: GPT, provider: GW },
		haiku: { model: HAIKU, provider: GW },
	},
	personas: {
		lead: "sonnet",
		coder: "opus", "pr-author": "opus", tester: "opus",
		reviewer: "gpt", "code-review": "gpt", verifier: "gpt", "verifier-mcp": "gpt",
		researcher: "sonnet", "docs-writer": "sonnet",
		manager: "inherit", "batch-orchestrator": "inherit",
		"gate-approval-second": "opus",
		"skim-test": "haiku",
	},
	unprofiled: { router: "jev", implementation: "opus", other: "sonnet", fallback: "opus", minConfidence: 0.8, timeoutMs: 3000 },
	leadTrial: ["sonnet", "opus"],
};

const modelsPath = join(agentDir, "models.json");
const settingsPath = join(sandbox, ".pi", "agent", "settings.json");
const writeModels = (value: unknown) => writeFileSync(modelsPath, typeof value === "string" ? value : JSON.stringify(value));
const writeSettings = (value: unknown) => writeFileSync(settingsPath, JSON.stringify(value));
const resetSettings = () => rmSync(settingsPath, { force: true });

let failures = 0;
let passes = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
	writeModels(DESIGN);
	resetSettings();
	setJevEvaluate();
	try {
		await fn();
		passes++;
		console.log(`  ok  ${name}`);
	} catch (error) {
		failures++;
		console.log(`FAIL  ${name}\n      ${(error as Error).message}`);
	}
}

const resolveFor = (profile: string, extra: Record<string, unknown> = {}) =>
	resolveRuntime({ role: allProfiles()[profile]?.role ?? "worker", profile, slim: true, inherit: sonnetParent, ...extra });

console.log("models.json loader");

await test("the design file parses, and pi's providers key sits beside it", () => {
	const config = personas.loadModels();
	assert.equal(config.source, "file");
	assert.equal(config.warning, undefined);
	assert.deepEqual(personas.personaModel("code-review", config), { model: GPT, provider: GW });
	assert.equal(personas.personaModel("manager", config), undefined, "inherit has no model");
	assert.deepEqual(personas.leadTrialModels(config).map((r) => r.model), [SONNET, OPUS]);
});

await test("a missing file falls back to the built-in table with one warning", () => {
	rmSync(modelsPath);
	const config = personas.loadModels();
	assert.equal(config.source, "fallback");
	assert.match(config.warning ?? "", /models\.json is missing/);
	assert.match(personas.takeModelsWarning(config) ?? "", /^WARNING: .*models\.json is missing; using the built-in persona models/);
	assert.equal(personas.takeModelsWarning(config), undefined, "the same warning is printed once");
	assert.equal(personas.personaModel("verifier", config)?.model, GPT);
	assert.equal(personas.personaModel("coder", config)?.model, OPUS);
	assert.deepEqual(config.unprofiled, { router: "none", fallback: "opus", reason: "no routing config" });
});

await test("an invalid file falls back too, naming the problem", () => {
	writeModels("{ not json");
	assert.match(personas.loadModels().warning ?? "", /is invalid/);
	writeModels({ ...DESIGN, personas: { ...DESIGN.personas, coder: "opsu" } });
	const config = personas.loadModels();
	assert.equal(config.source, "fallback");
	assert.match(config.warning ?? "", /persona "coder" names unknown alias "opsu"/);
	writeModels({ providers: DESIGN.providers });
	assert.match(personas.loadModels().warning ?? "", /no `aliases` object/, "pi's own providers-only file is not a persona file");
	writeModels({ ...DESIGN, unprofiled: { ...DESIGN.unprofiled, minConfidence: 2 } });
	assert.match(personas.loadModels().warning ?? "", /minConfidence/);
});

console.log("resolveRuntime precedence");

await test("coder, pr-author and tester resolve to opus under a Sonnet parent, with no settings profiles", () => {
	for (const profile of ["coder", "pr-author", "tester"]) {
		const r = resolveFor(profile);
		assert.equal(r.model, OPUS, profile);
		assert.equal(r.provider, GW, profile);
	}
});

await test("reviewer, code-review, verifier and verifier-mcp resolve to gpt under a Sonnet parent", () => {
	for (const profile of ["reviewer", "code-review", "verifier", "verifier-mcp"]) {
		const r = resolveFor(profile);
		assert.equal(r.model, GPT, profile);
		assert.equal(r.provider, GW, profile);
	}
	assert.equal(resolveFor("researcher").model, SONNET);
	assert.equal(resolveFor("docs-writer").model, SONNET);
});

await test("explicit model > settings profile model > persona > modelDefaults > inherit", () => {
	writeSettings({
		team: {
			profiles: { coder: { model: "x/settings", provider: "p-settings" } },
			modelDefaults: { worker: { model: "x/defaults", provider: "p-defaults" } },
		},
	});
	const explicit = resolveFor("coder", { model: "x/explicit", provider: "p-explicit" });
	assert.deepEqual([explicit.model, explicit.provider], ["x/explicit", "p-explicit"], "explicit wins");
	const settings = resolveFor("coder");
	assert.deepEqual([settings.model, settings.provider], ["x/settings", "p-settings"], "a settings profile model beats the persona");
	const persona = resolveFor("tester");
	assert.deepEqual([persona.model, persona.provider], [OPUS, GW], "the persona beats modelDefaults");
	const defaults = resolveFor("manager", { role: "worker" });
	assert.deepEqual([defaults.model, defaults.provider], ["x/defaults", "p-defaults"], "an inherit persona falls through to modelDefaults");
	resetSettings();
	assert.equal(resolveFor("manager").model, SONNET, "with nothing else, inherit means the parent's model");
});

await test("a persona set to inherit falls through, and the profile keeps everything else", () => {
	writeModels({ ...DESIGN, personas: { ...DESIGN.personas, coder: "inherit", reviewer: "inherit" } });
	assert.equal(resolveFor("coder").model, SONNET);
	const reviewer = resolveFor("reviewer");
	assert.equal(reviewer.model, SONNET);
	assert.ok(reviewer.profileSkills.includes("pr-approval-review"), "skills survive");
	assert.equal(allProfiles().coder!.model, undefined);
});

await test("NAMED_PROFILES carries no model ids: changing an alias moves every persona on it", async () => {
	const { NAMED_PROFILES } = await import("../config.ts");
	for (const [name, profile] of Object.entries(NAMED_PROFILES)) {
		assert.equal(profile.model, undefined, `${name} hard-codes a model`);
		assert.equal(profile.provider, undefined, `${name} hard-codes a provider`);
	}
	writeModels({ ...DESIGN, aliases: { ...DESIGN.aliases, gpt: { model: "openai/next", provider: "other-gw" } } });
	for (const profile of ["reviewer", "code-review", "verifier", "verifier-mcp"]) {
		assert.deepEqual([resolveFor(profile).model, resolveFor(profile).provider], ["openai/next", "other-gw"], profile);
	}
});

await test("a routed model sits below profiles and above modelDefaults", () => {
	writeSettings({ team: { modelDefaults: { worker: { model: "x/defaults", provider: "p" } } } });
	const routed = { model: SONNET, provider: GW };
	assert.equal(resolveRuntime({ role: "worker", slim: true, routed, inherit: sonnetParent }).model, SONNET);
	assert.equal(resolveRuntime({ role: "worker", slim: true, routed: { model: "x/r", provider: "pr" } }).provider, "pr");
	assert.equal(resolveRuntime({ role: "worker", profile: "coder", slim: true, routed }).model, OPUS, "a profile ignores routing");
	assert.equal(resolveRuntime({ role: "worker", model: "x/e", slim: true, routed }).model, "x/e");
});

console.log("unprofiled worker routing (jev stubbed)");

const stubJev = (answer: () => Promise<number>) => {
	const calls: Array<{ state: string; questions: Record<string, unknown>; options?: Record<string, unknown> }> = [];
	setJevEvaluate(async (state, questions, options) => {
		calls.push({ state, questions, options: options as Record<string, unknown> });
		return { answers: { implementation: { type: "boolean", probability: await answer() } }, model: "stub", attempts: 1 };
	});
	return calls;
};

await test("confident other gives sonnet, with one boolean question over the task text", async () => {
	const calls = stubJev(async () => 0.07);
	const r = await routeUnprofiled("Read the three docs and write a summary table");
	assert.equal(r?.model, SONNET);
	assert.equal(r?.outcome, "other");
	assert.equal(r?.label, "jev: other, 0.93");
	assert.equal(calls.length, 1);
	assert.deepEqual(Object.keys(calls[0]!.questions), ["implementation"]);
	assert.equal((calls[0]!.questions.implementation as { type: string }).type, "boolean");
	assert.match(calls[0]!.state, /Read the three docs/);
	const { signal, ...options } = calls[0]!.options!;
	assert.deepEqual(options, { timeoutMs: 3000, retries: 0 }, "timeout comes from models.json, no retries");
	assert.ok(signal instanceof AbortSignal, "the route passes its timeout signal down");
});

await test("implementation gives opus", async () => {
	stubJev(async () => 0.93);
	const r = await routeUnprofiled("Fix the bug and open a PR");
	assert.equal(r?.model, OPUS);
	assert.equal(r?.label, "jev: implementation, 0.93");
	assert.equal(modelLine(r?.model, undefined, r), "Model: anthropic/claude-opus-5.5 (jev: implementation, 0.93)");
	assert.equal(modelLine(r?.model, "low", r), "Model: anthropic/claude-opus-5.5 (jev: implementation, 0.93), thinking low");
	assert.equal(modelLine(OPUS, "low"), "Model: anthropic/claude-opus-5.5 (low)", "an unrouted line is unchanged");
});

await test("low confidence gives opus", async () => {
	stubJev(async () => 0.3);
	const r = await routeUnprofiled("Look at the logs");
	assert.equal(r?.model, OPUS);
	assert.equal(r?.outcome, "fallback");
	assert.equal(r?.label, "jev fallback: low confidence (other, 0.70)");
	stubJev(async () => 0.2);
	assert.equal((await routeUnprofiled("x"))?.model, SONNET, "exactly minConfidence counts as confident");
});

await test("an error, a missing key or a malformed answer gives opus", async () => {
	setJevEvaluate(async () => {
		throw new Error("Jev: HTTP 503");
	});
	assert.deepEqual([(await routeUnprofiled("x"))?.model, (await routeUnprofiled("x"))?.label], [OPUS, "jev fallback: error"]);
	setJevEvaluate(async () => {
		throw new Error("No API key: set AI_GATEWAY_API_KEY");
	});
	assert.equal((await routeUnprofiled("x"))?.label, "jev fallback: no key");
	setJevEvaluate(async () => ({ answers: {}, model: "stub", attempts: 1 }));
	assert.equal((await routeUnprofiled("x"))?.label, "jev fallback: error");
});

await test("a timeout gives opus within timeoutMs, even when jev never answers", async () => {
	writeModels({ ...DESIGN, unprofiled: { ...DESIGN.unprofiled, timeoutMs: 150 } });
	setJevEvaluate(() => new Promise(() => {}));
	const started = Date.now();
	const r = await routeUnprofiled("x");
	assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
	assert.equal(r?.model, OPUS);
	assert.equal(r?.label, "jev fallback: timeout");
	setJevEvaluate(async () => {
		throw new Error("Jev request failed: The operation was aborted due to timeout");
	});
	assert.equal((await routeUnprofiled("x"))?.label, "jev fallback: timeout", "the client's own abort reads as a timeout");
});

await test("no unprofiled section means no jev call and no routing", async () => {
	const calls = stubJev(async () => 0.1);
	const { unprofiled: _drop, ...rest } = DESIGN;
	writeModels(rest);
	assert.equal(await routeUnprofiled("x"), undefined);
	assert.equal(calls.length, 0);
});

await test("a missing or invalid file sends an unprofiled worker to opus without jev, labelled as a fallback", async () => {
	const calls = stubJev(async () => 0.01);
	for (const broken of [() => rmSync(modelsPath), () => writeModels("{ invalid"), () => writeModels({ providers: DESIGN.providers })]) {
		broken();
		const r = await routeUnprofiled("Implement parser");
		assert.deepEqual(
			r && { router: r.router, outcome: r.outcome, model: r.model, provider: r.provider, reason: r.reason, label: r.label },
			{ router: "none", outcome: "fallback", model: OPUS, provider: GW, reason: "no routing config", label: "fallback: no routing config" },
		);
		const runtime = resolveRuntime({ role: "worker", slim: true, routed: { model: r!.model, provider: r!.provider }, inherit: sonnetParent });
		assert.deepEqual([runtime.model, runtime.provider], [OPUS, GW], "the routed fallback beats the Sonnet parent");
		assert.equal(modelLine(r!.model, undefined, r), "Model: anthropic/claude-opus-5.5 (fallback: no routing config)");
		assert.equal((await routeUnprofiled("Summarise the docs"))?.model, OPUS, "every unprofiled worker, not only implementation");
	}
	assert.equal(calls.length, 0, "jev is never called without a routing config");
});

console.log("api key lookup inside the routing timeout (fetch stubbed, never live)");

const keyEnv = ["AI_GATEWAY_API_KEY", "VERCEL_AI_GATEWAY_API_KEY", "PI_AGENT_DIR"] as const;
async function withKeyCommand(
	apiKey: string | undefined,
	fetchStub: typeof fetch,
	fn: () => Promise<void>,
	timeoutMs = DESIGN.unprofiled.timeoutMs,
): Promise<void> {
	const savedEnv = keyEnv.map((name) => [name, process.env[name]] as const);
	const savedFetch = globalThis.fetch;
	for (const name of keyEnv) delete process.env[name];
	process.env.PI_AGENT_DIR = agentDir;
	resetRouteKey();
	writeModels({ ...DESIGN, providers: apiKey === undefined ? {} : { [GW]: { apiKey } }, unprofiled: { ...DESIGN.unprofiled, timeoutMs } });
	globalThis.fetch = fetchStub;
	try {
		await fn();
	} finally {
		globalThis.fetch = savedFetch;
		for (const [name, value] of savedEnv) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		resetRouteKey();
	}
}

await test("a slow api key command cannot stretch the route past timeoutMs, and it is killed", async () => {
	const marker = join(sandbox, "key-command-finished");
	let fetches = 0;
	await withKeyCommand(`!sleep 4; touch ${marker}; printf dummy-key`, async () => {
		fetches++;
		return new Promise<Response>(() => {});
	}, async () => {
		const started = Date.now();
		const r = await routeUnprofiled("Fix parser");
		const elapsed = Date.now() - started;
		assert.ok(elapsed < 1500, `took ${elapsed} ms for timeoutMs 1000`);
		assert.equal(r?.model, OPUS);
		assert.equal(r?.label, "jev fallback: timeout");
		assert.equal(fetches, 0, "no request without a key");
		await new Promise((resolve) => setTimeout(resolve, 4000));
		assert.equal(existsSync(marker), false, "the key command was killed with the route");
	}, 1000);
});

await test("the key comes from the models.json command and reaches jev as the bearer token", async () => {
	const seen: string[] = [];
	await withKeyCommand("!printf dummy-key", async (_url, init) => {
		seen.push(String((init?.headers as Record<string, string>).authorization));
		return new Response(JSON.stringify({ answers: { implementation: { type: "boolean", probability: 0.9 } } }));
	}, async () => {
		const r = await routeUnprofiled("Fix parser");
		assert.equal(r?.label, "jev: implementation, 0.90");
		assert.equal((await routeUnprofiled("Fix parser"))?.model, OPUS);
		assert.deepEqual(seen, ["Bearer dummy-key", "Bearer dummy-key"]);
	});
});

await test("a key command that fails, or no key at all, still reads as no key", async () => {
	let fetches = 0;
	const never = async () => {
		fetches++;
		return new Response("{}");
	};
	await withKeyCommand("!exit 3", never, async () => {
		assert.equal((await routeUnprofiled("x"))?.label, "jev fallback: no key");
	});
	await withKeyCommand(undefined, never, async () => {
		assert.equal((await routeUnprofiled("x"))?.label, "jev fallback: no key");
	});
	assert.equal(fetches, 0);
});

console.log("lead trial");

await test("trial arms come from models.json leadTrial when settings name no models", () => {
	writeSettings({ defaultProvider: GW, leadTrial: { enabled: true, until: "2099-01-01" } });
	const trial = readLeadTrial();
	assert.deepEqual(trial.models, [SONNET, OPUS]);
	assert.equal(trial.provider, GW);
	writeModels({ ...DESIGN, leadTrial: ["haiku", "gpt"] });
	assert.deepEqual(readLeadTrial().models, [HAIKU, GPT]);
});

await test("settings leadTrial.models still wins", () => {
	writeModels({ ...DESIGN, leadTrial: ["haiku"] });
	writeSettings({ leadTrial: { enabled: true, until: "2099-01-01", models: ["x/a", "x/b"] } });
	assert.deepEqual(readLeadTrial().models, ["x/a", "x/b"]);
	rmSync(modelsPath);
	resetSettings();
	assert.deepEqual(readLeadTrial().models, TRIAL_MODELS, "neither: the built-in arms");
});

await test("manager and batch-orchestrator on inherit stay in the trial; a persona model takes them out", () => {
	const base = { baseModel: SONNET, baseProvider: GW };
	for (const profile of ["manager", "batch-orchestrator"]) {
		assert.equal(isTrialSpawn({ role: "orchestrator", profileModel: allProfiles()[profile]?.model, ...base }), true, profile);
	}
	writeModels({ ...DESIGN, personas: { ...DESIGN.personas, manager: "opus" } });
	assert.equal(isTrialSpawn({ role: "orchestrator", profileModel: allProfiles().manager?.model, ...base }), false);
});

setJevEvaluate();
rmSync(sandbox, { recursive: true, force: true });
console.log(failures === 0 ? `\nall ${passes} persona tests passed` : `\n${failures} persona test(s) failed, ${passes} passed`);
process.exit(failures === 0 ? 0 : 1);
