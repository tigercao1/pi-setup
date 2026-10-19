/**
 * Registers the `jev` tool: fast typed judgements over text the caller already has.
 *
 * The classifier API wants `questions` as a record of id to question object. The
 * tool takes an array of {id, type, ...} instead, so the parameter schema stays a
 * plain array of objects rather than a record of a discriminated union.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { JEV_MODEL, JevError, MAX_STATE_CHARS } from "./client.ts";
import { classify, ledgerEntry, RUBRIC } from "./classify.ts";
import { normaliseQuestions, type QuestionInput } from "./normalise.ts";
import { formatClassifierAnswers, formatUsage, gatewayModelId, JEV_PROVIDER, toClassifierQuestions } from "./builtin.ts";

const QuestionParam = Type.Object({
	id: Type.String({ description: "Short key for this question; it labels the answer." }),
	type: StringEnum(["boolean", "choice", "score"] as const),
	instructions: Type.Optional(
		Type.String({
			description:
				"What to judge. Required for boolean. Optional extra framing for choice and score.",
		}),
	),
	choices: Type.Optional(
		Type.Array(
			Type.Object({
				name: Type.String({ description: "Option name, returned as the chosen value." }),
				criteria: Type.String({ description: "When this option is the right answer." }),
			}),
			{ description: "Required for type=choice. At least 2 options." },
		),
	),
	scale: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Required for type=score. Ordered rung descriptions, LOWEST first, e.g. " +
				'["not severe","minor","moderate","serious","critical"].',
		}),
	),
});

const JevParams = Type.Object({
	state: Type.String({
		description:
			"Everything to be judged, inline. Jev cannot read files, run commands or fetch URLs - " +
			"paste the text, diff summary, findings or report here. Max ~100k chars.",
	}),
	questions: Type.Array(QuestionParam, {
		description: "All questions are evaluated in parallel in one request. Prefer one call with many.",
	}),
	model: Type.Optional(
		Type.String({
			description: "Override the evaluation model, as a vercel-ai-gateway model id. Default typesafe-ai/jev.",
		}),
	),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "jev",
		label: "Jev evaluate",
		description:
			"Fast typed judgement over text you provide: classification, routing, rubric scoring, " +
			"boolean checks. Returns a choice, a score, or a probability per question, each with a " +
			"calibrated confidence, and answers many questions in one request. " +
			"It does NOT investigate - no file reads, no commands, no URLs - so everything it judges " +
			"must be inline in `state`. Use it to decide what deserves scrutiny, never to establish " +
			"that something is true.",
		promptSnippet: "Score or classify text with the Jev evaluation model",
		promptGuidelines: [
			"Use jev for cheap repeated judgements over text you already have: triage, routing, " +
				"rubric scores, contradiction checks. Batch every question into one call.",
			"Never use jev in place of a deterministic check (a grep, a script, an exit code), and " +
				"never treat its output as verification that a claim is true - it cannot open a source.",
		],
		parameters: JevParams,
		async execute(_id, rawInput, signal, _onUpdate, ctx) {
			const input = rawInput as { state: string; questions: QuestionInput[]; model?: string };
			if (!input.state?.trim()) throw new JevError("state is empty; Jev can only judge what you put in state");
			if (input.state.length > MAX_STATE_CHARS)
				throw new JevError(
					`state is ${input.state.length} chars, over the ${MAX_STATE_CHARS} limit (Jev's context is 32k tokens). ` +
						"Summarise or split the questions across calls.",
				);

			const questions = toClassifierQuestions(normaliseQuestions(input.questions));
			if (Object.keys(questions).length === 0) throw new JevError("questions is empty");

			const registry = ctx?.modelRegistry;
			if (!registry) throw new JevError("jev needs a pi session: no model registry in the tool context");
			const modelId = gatewayModelId(input.model ?? JEV_MODEL);
			const model = registry.getModelOfType("classifier", JEV_PROVIDER, modelId);
			if (!model || model.provider !== JEV_PROVIDER)
				throw new JevError(
					`No ${JEV_PROVIDER} classifier model ${modelId}. jev only calls classifiers through the ` +
						`Vercel AI Gateway; pass a gateway model id such as ${JEV_MODEL}.`,
				);

			const result = await registry.classify(
				model,
				{ state: { state: input.state }, questions },
				{ signal },
			);

			if (result.stopReason === "aborted") throw new JevError("Jev call cancelled");
			if (result.stopReason !== "stop")
				throw new JevError(`Jev: ${result.errorMessage ?? `classification ${result.stopReason}`}`);

			return {
				content: [
					{
						type: "text" as const,
						text: `${result.model} · ${formatUsage(result.usage)}\n\n${formatClassifierAnswers(result.answers, questions)}\n\n${JSON.stringify(result.answers)}`,
					},
				],
				details: { answers: result.answers, usage: result.usage, model: result.model, provider: result.provider },
			};
		},
	});

	pi.registerTool({
		name: "jev_classify",
		label: "Jev classify",
		description:
			"intake Phase 1 classification. Scores recon evidence on clarity, blast radius, unknowns and " +
			"parallelism, then applies intake's routing tree to return SPIKE, SCOPE, EXECUTE, SPLIT, or " +
			"UNCERTAIN when the deciding dimension is below the confidence floor. " +
			"The rubric is fixed in code so scores are comparable across missions - do not restate it. " +
			"Pass the recon findings or mission.md contents as `state`; the model cannot read the file.",
		promptSnippet: "Score recon evidence and route an intake unit",
		promptGuidelines: [
			"Use jev_classify at intake Phase 1 instead of judging the recon in your own context - you " +
				"wrote the recon summary, so scoring it yourself anchors on your own framing.",
			"The returned route is a proposal from a fixed rule, not a verdict. UNCERTAIN means decide " +
				"by hand. Never let it skip a gate or widen a bound.",
		],
		parameters: Type.Object({
			state: Type.String({
				description: "Recon findings or mission.md contents, inline. Everything the scores depend on.",
			}),
			unit: Type.Optional(Type.String({ description: "Unit or ticket id, recorded in the ledger entry." })),
			ledgerPath: Type.Optional(
				Type.String({ description: "Absolute path to ledger.md. When given, the entry is appended." }),
			),
		}),
		async execute(_id, rawInput, signal) {
			const input = rawInput as { state: string; unit?: string; ledgerPath?: string };
			const result = await classify(input.state, { signal });
			const entry = ledgerEntry(result, input.unit);

			let ledgerNote = "ledgerPath not given — entry not written";
			if (input.ledgerPath) {
				try {
					const dir = dirname(input.ledgerPath);
					if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
					appendFileSync(input.ledgerPath, `${existsSync(input.ledgerPath) ? "\n" : ""}${entry}`);
					ledgerNote = `appended to ${input.ledgerPath}`;
				} catch (error) {
					ledgerNote = `could not write ${input.ledgerPath}: ${(error as Error).message}`;
				}
			}

			return {
				content: [{ type: "text" as const, text: `${entry}\n${ledgerNote}` }],
				details: { ...result, ledgerEntry: entry, ledgerPath: input.ledgerPath },
			};
		},
	});

	pi.registerCommand("jev-rubric", {
		description: "Print the fixed jev_classify rubric",
		handler: async (_args, ctx) => {
			const lines: string[] = [];
			for (const [dimension, rubric] of Object.entries(RUBRIC)) {
				lines.push(`${dimension}: ${rubric.instructions}`);
				rubric.scale.forEach((rung, index) => lines.push(`  ${index}  ${rung}`));
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
