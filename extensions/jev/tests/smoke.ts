/**
 * Live smoke test against the gateway. Requires a working vercel-ai-gateway key.
 *
 *   node --experimental-strip-types tests/smoke.ts
 */

import { evaluate, formatAnswers, JevError, resolveApiKey, validateQuestions } from "../client.ts";
import { normaliseQuestions } from "../normalise.ts";

let failures = 0;

function check(name: string, condition: unknown, detail = ""): void {
	if (condition) {
		console.log(`  ok   ${name}`);
	} else {
		failures++;
		console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

function expectThrow(name: string, fn: () => unknown): void {
	try {
		fn();
		failures++;
		console.log(`  FAIL ${name} — expected a throw`);
	} catch (error) {
		check(name, error instanceof JevError, `threw ${(error as Error).name}`);
	}
}

console.log("validation (offline)");
expectThrow("empty questions rejected", () => validateQuestions({}));
expectThrow("boolean without instructions rejected", () =>
	validateQuestions({ a: { type: "boolean", instructions: "" } }),
);
expectThrow("choice with one option rejected", () =>
	validateQuestions({ a: { type: "choice", criteria: { only: "x" } } }),
);
expectThrow("score with one rung rejected", () => validateQuestions({ a: { type: "score", criteria: ["x"] } }));

console.log("\ntool input normalisation (offline)");
{
	const fromArray = normaliseQuestions([
		{ id: "a", type: "boolean", instructions: "is it?" },
		{ id: "b", type: "choice", choices: [{ name: "x", criteria: "x means" }, { name: "y", criteria: "y means" }] },
		{ id: "c", type: "score", scale: ["low", "high"] },
	]);
	check("array form maps ids", Object.keys(fromArray).join(",") === "a,b,c");
	check("choices[] becomes a criteria record", JSON.stringify(fromArray.b) === JSON.stringify({ type: "choice", criteria: { x: "x means", y: "y means" } }));
	check("scale[] becomes score criteria", JSON.stringify(fromArray.c) === JSON.stringify({ type: "score", criteria: ["low", "high"] }));

	const fromRecord = normaliseQuestions({
		a: { type: "boolean", instructions: "is it?" },
		b: { type: "choice", criteria: { x: "x means", y: "y means" } },
	} as never);
	check("gateway record form accepted", Object.keys(fromRecord).join(",") === "a,b");
	check("native criteria record passes through", fromRecord.b.type === "choice" && fromRecord.b.criteria.x === "x means");

	const missingIds = normaliseQuestions([{ type: "boolean", instructions: "is it?" } as never]);
	check("missing id is generated", Object.keys(missingIds)[0] === "q1");
}
expectThrow("questions of the wrong type rejected", () => normaliseQuestions("nope" as never));
expectThrow("duplicate ids rejected", () =>
	normaliseQuestions([
		{ id: "a", type: "boolean", instructions: "x" },
		{ id: "a", type: "boolean", instructions: "y" },
	]),
);

console.log("\nkey resolution");
try {
	const key = resolveApiKey();
	check("resolved a non-empty key", key.length > 10, `length ${key.length}`);
} catch (error) {
	failures++;
	console.log(`  FAIL key resolution — ${(error as Error).message}`);
	process.exit(1);
}

console.log("\nlive call (all three question types in one request)");
const state = [
	"CI run 41822 on branch abc-5299-fix.",
	"Step `bin/rspec spec/catalog` failed with:",
	"  NoMethodError: undefined method `slug' for nil:NilClass",
	"  app/services/catalog/recommender.rb:88",
	"The same step passed on the previous commit.",
].join("\n");

const result = await evaluate(state, {
	kind: {
		type: "choice",
		criteria: {
			code_defect: "a real bug in the changed code",
			flake: "nondeterministic, unrelated to the change",
			infra: "CI infrastructure or dependency problem",
		},
	},
	severity: {
		type: "score",
		criteria: ["harmless", "minor", "moderate", "serious", "blocks the release"],
	},
	blocks_merge: { type: "boolean", instructions: "Does this failure block merging the PR?" },
});

console.log(`\n${formatAnswers(result)}\n`);

const { kind, severity, blocks_merge: blocksMerge } = result.answers;
check("choice answered", kind?.type === "choice" && typeof kind.choice === "string");
check("choice picked a declared option", kind?.type === "choice" && ["code_defect", "flake", "infra"].includes(kind.choice));
check("score answered", severity?.type === "score" && Number.isFinite(severity.score));
check("boolean answered", blocksMerge?.type === "boolean" && blocksMerge.probability >= 0 && blocksMerge.probability <= 1);
check("usage reported", (result.usage?.inputTokens ?? 0) > 0, JSON.stringify(result.usage));

console.log("\nerror paths (live)");
try {
	await evaluate("x".repeat(200_000), { a: { type: "boolean", instructions: "?" } });
	failures++;
	console.log("  FAIL oversized state rejected — expected a throw");
} catch (error) {
	check("oversized state rejected locally", error instanceof JevError && /over the/.test((error as Error).message));
}

try {
	await evaluate("hello", { a: { type: "boolean", instructions: "?" } }, { apiKey: "sk-invalid", retries: 0 });
	failures++;
	console.log("  FAIL bad key rejected — expected a throw");
} catch (error) {
	check("bad key produces a JevError", error instanceof JevError, (error as Error).message.slice(0, 80));
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
