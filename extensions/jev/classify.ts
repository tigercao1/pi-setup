/**
 * Phase 1 classification for the `intake` skill.
 *
 * intake scores recon evidence on clarity, blast radius, unknowns and
 * parallelism, then routes:
 *
 *   unknowns present                  -> SPIKE
 *   clarity low                       -> SCOPE
 *   clarity high & blast radius small -> EXECUTE
 *   clarity high & blast radius large -> SPLIT
 *
 * Jev produces the four scores. `route()` is a pure function and the routing
 * tree stays here in code, so a decision is reproducible and a wrong route is
 * diagnosable from the numbers in ledger.md rather than being an unexplained
 * orchestrator judgement.
 *
 * The rubric lives here rather than in a caller's prompt for the same reason
 * intake forbids paraphrasing an anchor: scores are only comparable across runs
 * if every run asked byte-identical questions.
 */

import { createHash } from "node:crypto";
import { evaluate, type EvaluateOptions, type Question, type Usage } from "./client.ts";

export type Dimension = "clarity" | "blast_radius" | "unknowns" | "parallelism";
export type Route = "SPIKE" | "SCOPE" | "EXECUTE" | "SPLIT" | "UNCERTAIN";

export interface Thresholds {
	/** unknowns at or above this routes to SPIKE. */
	unknownsSpike: number;
	/** clarity below this routes to SCOPE. */
	clarityLow: number;
	/** blast radius at or above this routes to SPLIT rather than EXECUTE. */
	blastLarge: number;
	/**
	 * Minimum probability mass on the deciding side of a threshold. Below it the
	 * route is UNCERTAIN.
	 *
	 * Deliberately NOT Jev's own `confidence`, which measures how sharply the
	 * distribution picks a single rung. Measured on a one-file change: the mass
	 * was {0: 0.68, 1: 0.09, 2: 0.23} - 0.77 of it below the blast-radius
	 * threshold, so "small" was not in doubt - yet `confidence` read 0.54 because
	 * the model was split between rungs 0 and 1. That is a distinction the
	 * threshold does not care about, and gating on it sent a trivial ticket to
	 * UNCERTAIN.
	 */
	decisionMassFloor: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
	unknownsSpike: 2.5,
	clarityLow: 2.0,
	blastLarge: 2.0,
	decisionMassFloor: 0.6,
};

/** Probability mass on the rungs that satisfy the same predicate the score did. */
export function decisionMass(probabilities: Record<string, number>, predicate: (rung: number) => boolean): number {
	let total = 0;
	let side = 0;
	for (const [rung, probability] of Object.entries(probabilities)) {
		total += probability;
		if (predicate(Number(rung))) side += probability;
	}
	return total > 0 ? side / total : 0;
}

/**
 * Bump whenever any rung text or instruction changes. Scores are comparable
 * across missions only if the questions were byte-identical, so a ledger entry
 * that does not say which rubric produced it is not evidence of anything.
 */
export const RUBRIC_VERSION = 1;

export const RUBRIC: Record<Dimension, { instructions: string; scale: string[] }> = {
	clarity: {
		instructions: "How well defined is the work, judged only on what the recon establishes?",
		scale: [
			"a vague wish with no stated outcome",
			"the goal is stated but acceptance criteria are missing or contradictory",
			"goal and rough shape are clear, but specific behaviour is open to interpretation",
			"goal, expected behaviour and affected area are all stated",
			"specified closely enough that two engineers would build the same thing",
		],
	},
	blast_radius: {
		instructions: "How much of the codebase does this work touch or put at risk?",
		scale: [
			"one file or one isolated function with no other caller",
			"a handful of files inside a single pack or module",
			"several files across one layer, or one pack plus its specs",
			"multiple packs or layers, or a shared interface other teams call",
			"framework, migrations, auth, billing, or code most of the repo depends on",
		],
	},
	unknowns: {
		instructions:
			"How much is genuinely unknown - not merely unstated? Planning around real unknowns produces fiction.",
		scale: [
			"everything needed to plan is established by the recon",
			"small gaps a grep or a query would close",
			"one material question whose answer would change the approach",
			"several material questions, or one that decides whether the work is possible at all",
			"feasibility itself is unknown; any plan written now would be invented",
		],
	},
	parallelism: {
		instructions: "If this were split, how independently could the parts be built?",
		scale: [
			"strictly sequential; every part depends on the one before it",
			"mostly sequential with one part that could start early",
			"two or three parts that overlap but share files",
			"several parts sharing little, schedulable in two waves",
			"the parts are independent and could be built simultaneously",
		],
	},
};

/**
 * Content hash of the rubric. `RUBRIC_VERSION` is hand-maintained and can be
 * forgotten; this cannot. Two entries with different digests were scored by
 * different questions, whatever their version numbers claim.
 */
export const RUBRIC_DIGEST: string = createHash("sha256")
	.update(
		JSON.stringify(
			(Object.keys(RUBRIC) as Dimension[])
				.sort()
				.map((d) => [d, RUBRIC[d].instructions, RUBRIC[d].scale]),
		),
	)
	.digest("hex")
	.slice(0, 8);

export interface DimensionScore {
	score: number;
	confidence: number;
	probabilities: Record<string, number>;
}

/** Dense per-rung array, indexed 0..rungs-1, so a future threshold can be replayed. */
export function distribution(dimension: Dimension, scores: Record<Dimension, DimensionScore>): number[] {
	const rungs = RUBRIC[dimension].scale.length;
	const probabilities = scores[dimension].probabilities;
	return Array.from({ length: rungs }, (_, rung) => Number((probabilities[String(rung)] ?? 0).toFixed(4)));
}

export interface Classification {
	scores: Record<Dimension, DimensionScore>;
	route: Route;
	/** Probability mass on the deciding side of the branch that produced the route. */
	mass?: number;
	/** Which rule fired, with the numbers that fired it. */
	reason: string;
	/** Set when route is UNCERTAIN: the deciding dimension that fell below the floor. */
	blockedOn?: Dimension;
	thresholds: Thresholds;
	rubricVersion: number;
	rubricDigest: string;
	usage?: Usage;
	model: string;
}

/**
 * Pure. Evaluated in intake's stated order, and a branch whose deciding
 * dimension is under the confidence floor stops rather than guessing.
 *
 * UNCERTAIN never falls through to EXECUTE: the lanes differ in how much
 * investigation they buy, and the cheap error is investigating work that did
 * not need it.
 */
export function route(
	scores: Record<Dimension, DimensionScore>,
	thresholds: Thresholds = DEFAULT_THRESHOLDS,
): { route: Route; reason: string; blockedOn?: Dimension; mass?: number } {
	const n = (d: Dimension) => scores[d].score.toFixed(2);

	/** Decide one branch, or stop if too little mass sits on the side the score chose. */
	const decide = (d: Dimension, limit: number, above: boolean) => {
		const holds = above ? scores[d].score >= limit : scores[d].score < limit;
		const chosenSideIsHigh = above === holds;
		const mass = decisionMass(scores[d].probabilities, (rung) => (rung >= limit) === chosenSideIsHigh);
		return { holds, mass };
	};

	const blocked = (d: Dimension, mass: number) => ({
		route: "UNCERTAIN" as const,
		reason:
			`${d} ${n(d)} sits across its threshold — only ${mass.toFixed(2)} of the probability mass is on ` +
			`the deciding side, under the floor ${thresholds.decisionMassFloor}. Decide this one by hand.`,
		blockedOn: d,
		mass,
	});

	const spike = decide("unknowns", thresholds.unknownsSpike, true);
	if (spike.mass < thresholds.decisionMassFloor) return blocked("unknowns", spike.mass);
	if (spike.holds)
		return {
			route: "SPIKE",
			reason: `unknowns ${n("unknowns")} >= ${thresholds.unknownsSpike} (mass ${spike.mass.toFixed(2)})`,
			mass: spike.mass,
		};

	const scope = decide("clarity", thresholds.clarityLow, false);
	if (scope.mass < thresholds.decisionMassFloor) return blocked("clarity", scope.mass);
	if (scope.holds)
		return {
			route: "SCOPE",
			reason: `clarity ${n("clarity")} < ${thresholds.clarityLow} (mass ${scope.mass.toFixed(2)})`,
			mass: scope.mass,
		};

	const split = decide("blast_radius", thresholds.blastLarge, true);
	if (split.mass < thresholds.decisionMassFloor) return blocked("blast_radius", split.mass);
	return split.holds
		? {
				route: "SPLIT",
				reason: `clarity ${n("clarity")} ok, blast radius ${n("blast_radius")} >= ${thresholds.blastLarge} (mass ${split.mass.toFixed(2)})`,
				mass: split.mass,
			}
		: {
				route: "EXECUTE",
				reason: `clarity ${n("clarity")} ok, blast radius ${n("blast_radius")} < ${thresholds.blastLarge} (mass ${split.mass.toFixed(2)})`,
				mass: split.mass,
			};
}

export async function classify(
	state: string,
	options: EvaluateOptions & { thresholds?: Partial<Thresholds> } = {},
): Promise<Classification> {
	const thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };

	const questions: Record<string, Question> = {};
	for (const [dimension, rubric] of Object.entries(RUBRIC)) {
		questions[dimension] = { type: "score", criteria: rubric.scale, instructions: rubric.instructions };
	}

	const result = await evaluate(state, questions, options);

	const scores = {} as Record<Dimension, DimensionScore>;
	for (const dimension of Object.keys(RUBRIC) as Dimension[]) {
		const answer = result.answers[dimension];
		if (!answer || answer.type !== "score") throw new Error(`Jev returned no score for ${dimension}`);
		scores[dimension] = {
			score: answer.score,
			confidence: answer.confidence,
			probabilities: answer.probabilities,
		};
	}

	return {
		scores,
		...route(scores, thresholds),
		thresholds,
		rubricVersion: RUBRIC_VERSION,
		rubricDigest: RUBRIC_DIGEST,
		usage: result.usage,
		model: result.model,
	};
}

/** Machine-readable twin of the entry, for replaying a threshold change over history. */
export function ledgerRecord(classification: Classification, unit?: string, at = new Date()): Record<string, unknown> {
	const scores: Record<string, { score: number; confidence: number; p: number[] }> = {};
	for (const dimension of Object.keys(RUBRIC) as Dimension[]) {
		scores[dimension] = {
			score: Number(classification.scores[dimension].score.toFixed(4)),
			confidence: Number(classification.scores[dimension].confidence.toFixed(4)),
			p: distribution(dimension, classification.scores),
		};
	}

	return {
		at: at.toISOString().replace(/\.\d+Z$/, "Z"),
		...(unit && { unit }),
		route: classification.route,
		...(classification.blockedOn && { blockedOn: classification.blockedOn }),
		...(classification.mass !== undefined && { mass: Number(classification.mass.toFixed(4)) }),
		rubric: { version: classification.rubricVersion, digest: classification.rubricDigest },
		thresholds: classification.thresholds,
		model: classification.model,
		scores,
	};
}

/**
 * Appended to ledger.md verbatim: a table a human reads, then one HTML-comment
 * line a script reads. The comment carries the full per-rung distribution, so a
 * later threshold change - fixed or relative - can be replayed against every
 * past classification without a single new API call.
 */
export function ledgerEntry(classification: Classification, unit?: string, at = new Date()): string {
	const record = ledgerRecord(classification, unit, at);
	const rungLabels = RUBRIC.clarity.scale.map((_, rung) => rung).join(" ");

	const lines = [
		`## ${record.at} · classify${unit ? ` · ${unit}` : ""}`,
		"",
		`route: **${classification.route}** — ${classification.reason}`,
		"",
		`| dimension | score | confidence | p(${rungLabels}) |`,
		"|---|---|---|---|",
	];

	for (const dimension of Object.keys(RUBRIC) as Dimension[]) {
		const { score, confidence } = classification.scores[dimension];
		const spread = distribution(dimension, classification.scores)
			.map((p) => p.toFixed(2))
			.join(" ");
		lines.push(`| ${dimension} | ${score.toFixed(2)} of 0..4 | ${confidence.toFixed(2)} | ${spread} |`);
	}

	const usage = classification.usage
		? `${classification.usage.inputTokens} in / ${classification.usage.outputTokens} out tokens`
		: "usage unreported";
	lines.push(
		"",
		`rubric v${classification.rubricVersion} (${classification.rubricDigest}) · scored by ` +
			`${classification.model} (${usage}) · thresholds ` +
			`unknowns>=${classification.thresholds.unknownsSpike} clarity<${classification.thresholds.clarityLow} ` +
			`blast>=${classification.thresholds.blastLarge} mass-floor=${classification.thresholds.decisionMassFloor}`,
		"",
		`<!-- jev-classify ${JSON.stringify(record)} -->`,
		"",
	);

	return lines.join("\n");
}

/** Every machine record in a ledger.md, oldest first. */
export function parseLedger(markdown: string): Array<Record<string, unknown>> {
	const records: Array<Record<string, unknown>> = [];
	for (const match of markdown.matchAll(/<!-- jev-classify (\{.*?\}) -->/g)) {
		try {
			records.push(JSON.parse(match[1]) as Record<string, unknown>);
		} catch {
			// A hand-edited entry should not make the rest unreadable.
		}
	}
	return records;
}
