/**
 * Built-in classifier bridge tests (offline).
 *
 *   node --experimental-strip-types tests/builtin.test.ts
 */

import { formatClassifierAnswers, formatUsage, gatewayModelId, toClassifierQuestions } from "../builtin.ts";
import { JevError } from "../client.ts";
import { normaliseQuestions } from "../normalise.ts";

let failures = 0;

function check(name: string, condition: unknown, detail = ""): void {
	if (condition) console.log(`  ok   ${name}`);
	else {
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

console.log("question mapping");
{
	const mapped = toClassifierQuestions(
		normaliseQuestions([
			{ id: "blocks", type: "boolean", instructions: "Does this block merging?" },
			{
				id: "kind",
				type: "choice",
				choices: [
					{ name: "defect", criteria: "a real bug" },
					{ name: "flake", criteria: "nondeterministic" },
				],
			},
			{ id: "sev", type: "score", scale: ["harmless", "minor", "serious"] },
		]),
	);

	const blocks = mapped.blocks;
	check("boolean becomes bool", blocks.type === "bool");
	check(
		"bool carries true/false criteria",
		blocks.type === "bool" && blocks.criteria.true.length > 0 && blocks.criteria.false.length > 0,
	);
	check("bool keeps our instructions", blocks.instructions === "Does this block merging?");

	const kind = mapped.kind;
	check(
		"choice criteria pass through",
		kind.type === "choice" && kind.criteria.defect === "a real bug" && kind.criteria.flake === "nondeterministic",
	);
	check("choice gets default instructions", kind.instructions.length > 0);

	const sev = mapped.sev;
	check("score criteria are the scale", sev.type === "score" && sev.criteria.join(",") === "harmless,minor,serious");
	check("score gets default instructions", sev.instructions.length > 0);

	const explicit = toClassifierQuestions(
		normaliseQuestions([{ id: "sev", type: "score", instructions: "How bad?", scale: ["a", "b"] }]),
	);
	check("explicit instructions win over the default", explicit.sev.instructions === "How bad?");
}
expectThrow("boolean without instructions rejected", () =>
	toClassifierQuestions({ a: { type: "boolean", instructions: " " } }),
);

console.log("\nanswer formatting");
{
	const questions = toClassifierQuestions(
		normaliseQuestions([
			{ id: "blocks", type: "boolean", instructions: "?" },
			{ id: "kind", type: "choice", choices: [{ name: "defect", criteria: "x" }, { name: "flake", criteria: "y" }] },
			{ id: "sev", type: "score", scale: ["a", "b", "c", "d", "e"] },
		]),
	);
	const text = formatClassifierAnswers(
		{
			blocks: { type: "bool", probability: 0.8421 },
			kind: { type: "choice", choice: "defect", probabilities: { defect: 0.9, flake: 0.1 }, confidence: 1 },
			sev: { type: "score", score: 3.021, confidence: 0.46 },
		},
		questions,
	);
	const lines = text.split("\n");
	check("bool line", lines[0] === "blocks  bool    p=0.84", lines[0]);
	check("choice line", lines[1] === "kind    choice  defect  conf=1.00  [defect 0.90, flake 0.10]", lines[1]);
	check("score range comes from the scale length", lines[2] === "sev     score   3.02 of 0..4  conf=0.46", lines[2]);
	check("no answers is not a crash", formatClassifierAnswers({}, questions) === "(no answers)");
}

console.log("\nmodel reference");
{
	check("a slashed gateway id stays whole", gatewayModelId("typesafe-ai/jev") === "typesafe-ai/jev");
	check("the gateway prefix is stripped", gatewayModelId("vercel-ai-gateway/typesafe-ai/jev") === "typesafe-ai/jev");
	check(
		"another provider's ref is never split off the gateway",
		gatewayModelId("typesafe/jev-latest") === "typesafe/jev-latest",
	);
	expectThrow("an empty model is rejected", () => gatewayModelId("  "));
}

console.log("\nusage");
check("missing usage is reported, not hidden", formatUsage(undefined) === "usage unreported");
check(
	"tokens and cost",
	formatUsage({
		input: 796,
		output: 62,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 858,
		cost: { input: 0.0000334, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0000334 },
	}) === "796 in / 62 out tokens · $0.000033",
	formatUsage({
		input: 796,
		output: 62,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 858,
		cost: { input: 0.0000334, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0000334 },
	}),
);
check(
	"zero cost is omitted",
	formatUsage({
		input: 10,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 12,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	}) === "10 in / 2 out tokens",
);

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
