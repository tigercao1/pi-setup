/**
 * Client for TypeSafe AI's Jev evaluation model, via the Vercel AI Gateway.
 *
 * Jev is not a chat model: POST /v1/chat/completions rejects it with
 * ModelTypeMismatchError. It takes a blob of state plus typed questions and
 * returns choices, scores and boolean probabilities, evaluating every question
 * in one round trip.
 *
 * It has no tools and a 32k context. It cannot read a file, resolve a citation
 * or fetch a URL. Everything it judges must be inside `state`.
 *
 * Exported for direct import by other extensions (planned: agent-orchestrator
 * classification and anchor-drift polling), not only by the `jev` tool.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const JEV_MODEL = "typesafe-ai/jev";
export const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/evaluate";

/** 32k context; refuse well before the gateway does, with a message that says why. */
export const MAX_STATE_CHARS = 100_000;

export type Question =
	| { type: "boolean"; instructions: string }
	| { type: "choice"; criteria: Record<string, string>; instructions?: string }
	| { type: "score"; criteria: string[]; instructions?: string };

export type Answer =
	| { type: "boolean"; probability: number }
	| { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
	| { type: "score"; score: number; probabilities: Record<string, number>; confidence: number };

export interface Usage {
	inputTokens: number;
	outputTokens: number;
}

export interface EvaluateResult {
	answers: Record<string, Answer>;
	usage?: Usage;
	model: string;
	attempts: number;
}

export interface EvaluateOptions {
	model?: string;
	apiKey?: string;
	timeoutMs?: number;
	retries?: number;
	signal?: AbortSignal;
}

export class JevError extends Error {
	readonly status?: number;
	readonly retryable: boolean;
	constructor(message: string, options: { status?: number; retryable?: boolean } = {}) {
		super(message);
		this.name = "JevError";
		this.status = options.status;
		this.retryable = options.retryable ?? false;
	}
}

let cachedKey: string | undefined;

/**
 * Env first, then the vercel-ai-gateway apiKey in models.json, which supports a
 * literal, `$VAR`/`${VAR}`, or a leading `!command`.
 */
export function resolveApiKey(refresh = false): string {
	if (!refresh && cachedKey) return cachedKey;

	const fromEnv = process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_AI_GATEWAY_API_KEY;
	if (fromEnv) {
		cachedKey = fromEnv;
		return cachedKey;
	}

	const modelsPath = join(process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "models.json");
	if (!existsSync(modelsPath)) {
		throw new JevError(
			`No API key: set AI_GATEWAY_API_KEY, or add a vercel-ai-gateway apiKey to ${modelsPath}`,
		);
	}

	let spec: unknown;
	try {
		const parsed = JSON.parse(readFileSync(modelsPath, "utf8")) as {
			providers?: Record<string, { apiKey?: unknown }>;
		};
		spec = parsed.providers?.["vercel-ai-gateway"]?.apiKey;
	} catch (error) {
		throw new JevError(`Could not parse ${modelsPath}: ${(error as Error).message}`);
	}

	if (typeof spec !== "string" || spec.length === 0) {
		throw new JevError(`No vercel-ai-gateway apiKey in ${modelsPath}, and AI_GATEWAY_API_KEY is unset`);
	}

	cachedKey = materialise(spec);
	return cachedKey;
}

function materialise(spec: string): string {
	if (spec.startsWith("!")) {
		const command = spec.slice(1).trim();
		try {
			return execFileSync("/bin/sh", ["-c", command], { encoding: "utf8", timeout: 15_000 }).trim();
		} catch (error) {
			throw new JevError(`apiKey command failed (${command}): ${(error as Error).message}`);
		}
	}
	const interpolated = spec.replace(/\$\{([A-Z0-9_]+)\}|\$([A-Z0-9_]+)/gi, (_m, a, b) => process.env[a ?? b] ?? "");
	if (!interpolated) throw new JevError(`apiKey "${spec}" interpolated to an empty string`);
	return interpolated;
}

/** Throws on a malformed question rather than letting the gateway return a terse Zod error. */
export function validateQuestions(questions: Record<string, Question>): void {
	const ids = Object.keys(questions);
	if (ids.length === 0) throw new JevError("questions is empty");

	for (const id of ids) {
		const q = questions[id];
		if (q.type === "boolean") {
			if (!q.instructions?.trim()) throw new JevError(`question "${id}": boolean needs instructions`);
		} else if (q.type === "choice") {
			const options = Object.keys(q.criteria ?? {});
			if (options.length < 2) throw new JevError(`question "${id}": choice needs at least 2 criteria options`);
			for (const option of options) {
				if (!q.criteria[option]?.trim())
					throw new JevError(`question "${id}": choice option "${option}" has an empty description`);
			}
		} else if (q.type === "score") {
			if (!Array.isArray(q.criteria) || q.criteria.length < 2)
				throw new JevError(`question "${id}": score needs a criteria array of at least 2 rungs, lowest first`);
		} else {
			throw new JevError(`question "${id}": type must be boolean, choice or score`);
		}
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function evaluate(
	state: string,
	questions: Record<string, Question>,
	options: EvaluateOptions = {},
): Promise<EvaluateResult> {
	if (!state?.trim()) throw new JevError("state is empty; Jev can only judge what you put in state");
	if (state.length > MAX_STATE_CHARS)
		throw new JevError(
			`state is ${state.length} chars, over the ${MAX_STATE_CHARS} limit (Jev's context is 32k tokens). ` +
				"Summarise or split the questions across calls.",
		);
	validateQuestions(questions);

	const model = options.model ?? JEV_MODEL;
	const apiKey = options.apiKey ?? resolveApiKey();
	const retries = options.retries ?? 2;
	const timeoutMs = options.timeoutMs ?? 30_000;
	const body = JSON.stringify({ model, state, questions });

	let lastError: JevError | undefined;

	for (let attempt = 1; attempt <= retries + 1; attempt++) {
		const timer = AbortSignal.timeout(timeoutMs);
		const signal = options.signal ? AbortSignal.any([options.signal, timer]) : timer;

		try {
			const response = await fetch(GATEWAY_URL, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
				body,
				signal,
			});

			const payload = (await response.json().catch(() => ({}))) as {
				answers?: Record<string, Answer>;
				usage?: Usage;
				error?: { message?: string };
			};

			if (!response.ok || payload.error) {
				const message = payload.error?.message ?? `HTTP ${response.status}`;
				lastError = new JevError(`Jev: ${message}`, {
					status: response.status,
					retryable: response.status >= 500 || response.status === 429,
				});
				if (!lastError.retryable) throw lastError;
			} else if (!payload.answers) {
				lastError = new JevError("Jev returned no answers", { retryable: true });
			} else {
				return { answers: payload.answers, usage: payload.usage, model, attempts: attempt };
			}
		} catch (error) {
			if (error instanceof JevError) {
				if (!error.retryable) throw error;
				lastError = error;
			} else {
				const aborted = options.signal?.aborted;
				if (aborted) throw new JevError("Jev call cancelled");
				lastError = new JevError(`Jev request failed: ${(error as Error).message}`, { retryable: true });
			}
		}

		if (attempt <= retries) await sleep(300 * attempt ** 2);
	}

	throw lastError ?? new JevError("Jev call failed");
}

/** One-liner per answer, stable enough to read in a transcript. */
export function formatAnswers(result: EvaluateResult): string {
	const width = Math.max(...Object.keys(result.answers).map((id) => id.length));
	const lines: string[] = [];

	for (const [id, answer] of Object.entries(result.answers)) {
		const label = id.padEnd(width);
		if (answer.type === "boolean") {
			lines.push(`${label}  bool    p=${answer.probability.toFixed(2)}`);
		} else if (answer.type === "choice") {
			const spread = Object.entries(answer.probabilities)
				.sort((a, b) => b[1] - a[1])
				.map(([option, p]) => `${option} ${p.toFixed(2)}`)
				.join(", ");
			lines.push(`${label}  choice  ${answer.choice}  conf=${answer.confidence.toFixed(2)}  [${spread}]`);
		} else {
			const rungs = Object.keys(answer.probabilities).length;
			lines.push(
				`${label}  score   ${answer.score.toFixed(2)} of 0..${rungs - 1}  conf=${answer.confidence.toFixed(2)}`,
			);
		}
	}

	return lines.join("\n");
}
