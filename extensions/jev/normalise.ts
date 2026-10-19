/**
 * Tool-input compatibility layer.
 *
 * Models produce both the documented array form and the gateway's native record
 * form, and both `choices: [{name, criteria}]` and `criteria: {name: desc}`.
 * Accept all of them rather than failing a call that expressed the right intent.
 *
 * No pi imports here, so the smoke test can exercise it standalone.
 */

import { JevError, type Question } from "./client.ts";

export interface QuestionInput {
	id?: string;
	type: "boolean" | "choice" | "score";
	instructions?: string;
	choices?: Array<{ name: string; criteria?: string }> | Record<string, string> | string[];
	scale?: string[];
	criteria?: Record<string, string> | string[];
}

export function normaliseQuestions(
	input: QuestionInput[] | Record<string, QuestionInput> | undefined,
): Record<string, Question> {
	const listed = listQuestions(input);
	const questions: Record<string, Question> = {};

	for (const q of listed) {
		if (questions[q.id]) throw new JevError(`duplicate question id "${q.id}"`);

		if (q.type === "boolean") {
			if (!q.instructions?.trim()) throw new JevError(`question "${q.id}": boolean needs instructions`);
			questions[q.id] = { type: "boolean", instructions: q.instructions };
		} else if (q.type === "choice") {
			questions[q.id] = {
				type: "choice",
				criteria: choiceCriteria(q),
				...(q.instructions && { instructions: q.instructions }),
			};
		} else if (q.type === "score") {
			const scale = q.scale ?? (Array.isArray(q.criteria) ? q.criteria : undefined);
			if (!scale?.length) throw new JevError(`question "${q.id}": score needs scale[], lowest rung first`);
			questions[q.id] = { type: "score", criteria: scale, ...(q.instructions && { instructions: q.instructions }) };
		} else {
			throw new JevError(`question "${q.id}": type must be boolean, choice or score`);
		}
	}

	return questions;
}

function listQuestions(
	input: QuestionInput[] | Record<string, QuestionInput> | undefined,
): Array<QuestionInput & { id: string }> {
	if (Array.isArray(input)) return input.map((q, i) => ({ ...q, id: q.id ?? `q${i + 1}` }));
	if (input && typeof input === "object") return Object.entries(input).map(([id, q]) => ({ ...q, id: q.id ?? id }));
	throw new JevError("questions must be an array of {id, type, ...} or an object keyed by question id");
}

function choiceCriteria(q: QuestionInput & { id: string }): Record<string, string> {
	const source = q.choices ?? q.criteria;

	if (Array.isArray(source)) {
		const criteria: Record<string, string> = {};
		for (const entry of source) {
			if (typeof entry === "string") criteria[entry] = entry;
			else if (entry?.name) criteria[entry.name] = entry.criteria ?? entry.name;
		}
		if (Object.keys(criteria).length === 0) throw new JevError(`question "${q.id}": choice has no usable options`);
		return criteria;
	}

	if (source && typeof source === "object") return source as Record<string, string>;
	throw new JevError(`question "${q.id}": choice needs choices[] with name and criteria`);
}
