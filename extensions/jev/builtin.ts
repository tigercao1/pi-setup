/** Bridge from this extension's question shapes to pi's built-in classifier API. */

import type { ClassifierAnswer, ClassifierQuestion, Usage } from "@earendil-works/pi-ai";
import { JevError, type Question } from "./client.ts";

const DEFAULT_BOOL_CRITERIA = {
	true: "The condition described in the instructions holds for the state.",
	false: "It does not hold.",
} as const;

const DEFAULT_CHOICE_INSTRUCTIONS = "Pick the option whose criteria best describe the state.";
const DEFAULT_SCORE_INSTRUCTIONS = "Score the state on the scale below, lowest rung first.";

export function toClassifierQuestions(questions: Record<string, Question>): Record<string, ClassifierQuestion> {
	const mapped: Record<string, ClassifierQuestion> = {};

	for (const [id, question] of Object.entries(questions)) {
		if (question.type === "boolean") {
			if (!question.instructions?.trim()) throw new JevError(`question "${id}": boolean needs instructions`);
			mapped[id] = { type: "bool", instructions: question.instructions, criteria: { ...DEFAULT_BOOL_CRITERIA } };
		} else if (question.type === "choice") {
			mapped[id] = {
				type: "choice",
				instructions: question.instructions?.trim() || DEFAULT_CHOICE_INSTRUCTIONS,
				criteria: question.criteria,
			};
		} else {
			mapped[id] = {
				type: "score",
				instructions: question.instructions?.trim() || DEFAULT_SCORE_INSTRUCTIONS,
				criteria: question.criteria,
			};
		}
	}

	return mapped;
}

/** One-liner per answer, stable enough to read in a transcript. */
export function formatClassifierAnswers(
	answers: Record<string, ClassifierAnswer>,
	questions: Record<string, ClassifierQuestion>,
): string {
	const ids = Object.keys(answers);
	if (ids.length === 0) return "(no answers)";
	const width = Math.max(...ids.map((id) => id.length));
	const lines: string[] = [];

	for (const [id, answer] of Object.entries(answers)) {
		const label = id.padEnd(width);
		if (answer.type === "bool") {
			lines.push(`${label}  bool    p=${answer.probability.toFixed(2)}`);
		} else if (answer.type === "choice") {
			const spread = Object.entries(answer.probabilities)
				.sort((a, b) => b[1] - a[1])
				.map(([option, p]) => `${option} ${p.toFixed(2)}`)
				.join(", ");
			lines.push(`${label}  choice  ${answer.choice}  conf=${answer.confidence.toFixed(2)}  [${spread}]`);
		} else {
			const question = questions[id];
			const rungs = question?.type === "score" ? question.criteria.length : 0;
			const range = rungs > 0 ? ` of 0..${rungs - 1}` : "";
			lines.push(`${label}  score   ${answer.score.toFixed(2)}${range}  conf=${answer.confidence.toFixed(2)}`);
		}
	}

	return lines.join("\n");
}

export const JEV_PROVIDER = "vercel-ai-gateway";

/** A gateway model id, bare or prefixed with `vercel-ai-gateway/`. Every call stays on the gateway. */
export function gatewayModelId(ref: string): string {
	const trimmed = ref.trim();
	const prefix = `${JEV_PROVIDER}/`;
	const id = trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
	if (!id) throw new JevError("model is empty");
	return id;
}

export function formatUsage(usage: Usage | undefined): string {
	if (!usage) return "usage unreported";
	const cost = usage.cost?.total ? ` · $${usage.cost.total.toFixed(6)}` : "";
	return `${usage.input} in / ${usage.output} out tokens${cost}`;
}
