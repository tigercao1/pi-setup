import { spawn } from "node:child_process";
import { evaluate, type EvaluateOptions, type EvaluateResult, type Question } from "../jev/client.ts";
import { aliasModel, loadModels, type ModelsConfig, type UnprofiledRules } from "./personas.ts";

export type RouteOutcome = "implementation" | "other" | "fallback";

export interface SpawnRouting {
	router: UnprofiledRules["router"];
	outcome: RouteOutcome;
	alias: string;
	model: string;
	provider: string;
	confidence?: number;
	reason?: string;
	label: string;
}

export type JevEvaluate = (
	state: string,
	questions: Record<string, Question>,
	options?: EvaluateOptions,
) => Promise<EvaluateResult>;

class RouteTimeout extends Error {}

const KEY_SCRIPT =
	`const { resolveApiKey } = await import(${JSON.stringify(new URL("../jev/client.ts", import.meta.url).href)});` +
	"try { process.stdout.write(resolveApiKey()); } catch (error) { process.stderr.write(error.message); process.exit(1); }";

let routeKey: string | undefined;

export function resolveKeyAsync(signal?: AbortSignal): Promise<string> {
	if (routeKey) return Promise.resolve(routeKey);
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", KEY_SCRIPT],
			{ detached: true, stdio: ["ignore", "pipe", "pipe"] },
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		const kill = () => {
			try {
				process.kill(-child.pid!, "SIGKILL");
			} catch {}
			reject(new RouteTimeout("api key lookup aborted"));
		};
		if (signal?.aborted) return kill();
		signal?.addEventListener("abort", kill, { once: true });
		child.on("error", reject);
		child.on("close", (code) => {
			signal?.removeEventListener("abort", kill);
			if (code === 0 && stdout) resolve((routeKey = stdout));
			else reject(new Error(stderr.trim() || `api key lookup exited ${code}`));
		});
	});
}

const boundedEvaluate: JevEvaluate = async (state, questions, options = {}) =>
	evaluate(state, questions, { ...options, apiKey: options.apiKey ?? (await resolveKeyAsync(options.signal)) });

let jevEvaluate: JevEvaluate = boundedEvaluate;

export function setJevEvaluate(fn?: JevEvaluate): void {
	jevEvaluate = fn ?? boundedEvaluate;
}

export function resetRouteKey(): void {
	routeKey = undefined;
}

export const ROUTE_QUESTION_ID = "implementation";

export const ROUTE_QUESTION: Question = {
	type: "boolean",
	instructions:
		"The state is the full task given to a new worker agent. Is this implementation work: will the worker write or " +
		"change code or tests, make commits, or open or update a pull request? Answer false for research, reading, " +
		"reviewing, summarising, or writing prose or documents that are not code.",
};

const MAX_TASK_CHARS = 20_000;

function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expiry = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(new RouteTimeout(`no answer in ${ms} ms`));
			controller.abort();
		}, ms);
	});
	return Promise.race([work(controller.signal), expiry]).finally(() => clearTimeout(timer));
}

export function failureReason(error: unknown): string {
	if (error instanceof RouteTimeout) return "timeout";
	const message = error instanceof Error ? error.message : String(error);
	if (/timeout|timed out|aborted/i.test(message)) return "timeout";
	if (/no api key|apikey/i.test(message)) return "no key";
	return "error";
}

export async function routeUnprofiled(task: string, config: ModelsConfig = loadModels()): Promise<SpawnRouting | undefined> {
	const rules = config.unprofiled;
	if (!rules) return undefined;
	const router = rules.router;

	const pick = (alias: string, outcome: RouteOutcome, label: string, extra: Partial<SpawnRouting> = {}): SpawnRouting | undefined => {
		const ref = aliasModel(alias, config);
		return ref ? { router, outcome, alias, model: ref.model, provider: ref.provider, label, ...extra } : undefined;
	};
	if (rules.router === "none") {
		return pick(rules.fallback, "fallback", `fallback: ${rules.reason}`, { reason: rules.reason });
	}
	const fallback = (reason: string, confidence?: number) =>
		pick(rules.fallback, "fallback", `jev fallback: ${reason}`, { reason, ...(confidence === undefined ? {} : { confidence }) });

	let probability: number;
	try {
		const state = `Task for a new worker agent:\n\n${task.slice(0, MAX_TASK_CHARS)}`;
		const result = await withTimeout(
			(signal) => jevEvaluate(state, { [ROUTE_QUESTION_ID]: ROUTE_QUESTION }, { timeoutMs: rules.timeoutMs, retries: 0, signal }),
			rules.timeoutMs,
		);
		const answer = result.answers?.[ROUTE_QUESTION_ID];
		if (answer?.type !== "boolean" || !Number.isFinite(answer.probability)) return fallback("error");
		probability = Math.min(1, Math.max(0, answer.probability));
	} catch (error) {
		return fallback(failureReason(error));
	}

	if (probability >= 0.5) {
		return pick(rules.implementation, "implementation", `jev: implementation, ${probability.toFixed(2)}`, { confidence: probability });
	}
	const other = 1 - probability;
	if (other >= rules.minConfidence) {
		return pick(rules.other, "other", `jev: other, ${other.toFixed(2)}`, { confidence: other });
	}
	return fallback(`low confidence (other, ${other.toFixed(2)})`, other);
}
