import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const INHERIT = "inherit";

export interface ModelRef {
	model: string;
	provider: string;
}

export interface JevRules {
	router: "jev";
	implementation: string;
	other: string;
	fallback: string;
	minConfidence: number;
	timeoutMs: number;
}

export interface FixedRules {
	router: "none";
	fallback: string;
	reason: string;
}

export type UnprofiledRules = JevRules | FixedRules;

export interface ModelsConfig {
	aliases: Record<string, ModelRef>;
	personas: Record<string, string>;
	unprofiled?: UnprofiledRules;
	leadTrial?: string[];
	source: "file" | "fallback";
	warning?: string;
}

const GATEWAY = "vercel-ai-gateway";

export const FALLBACK_MODELS: ModelsConfig = {
	aliases: {
		opus: { model: "anthropic/claude-opus-5.5", provider: GATEWAY },
		gpt: { model: "openai/gpt-6.1-sol", provider: GATEWAY },
	},
	personas: {
		coder: "opus",
		"pr-author": "opus",
		tester: "opus",
		reviewer: "gpt",
		"code-review": "gpt",
		verifier: "gpt",
		"verifier-mcp": "gpt",
	},
	unprofiled: { router: "none", fallback: "opus", reason: "no routing config" },
	source: "fallback",
};

export const modelsJsonPath = (): string =>
	join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "models.json");

const isObject = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

export function parseModelsConfig(raw: unknown): ModelsConfig {
	if (!isObject(raw)) throw new Error("top level is not an object");
	if (!isObject(raw.aliases)) throw new Error("no `aliases` object");
	if (!isObject(raw.personas)) throw new Error("no `personas` object");

	const aliases: Record<string, ModelRef> = {};
	for (const [name, ref] of Object.entries(raw.aliases)) {
		if (name === INHERIT) throw new Error(`alias name "${INHERIT}" is reserved`);
		if (!isObject(ref) || !nonEmpty(ref.model) || !nonEmpty(ref.provider)) {
			throw new Error(`alias "${name}" needs a model and a provider`);
		}
		aliases[name] = { model: ref.model, provider: ref.provider };
	}
	const knownAlias = (where: string, alias: unknown): string => {
		if (!nonEmpty(alias) || !aliases[alias]) throw new Error(`${where} names unknown alias "${String(alias)}"`);
		return alias;
	};

	const personas: Record<string, string> = {};
	for (const [name, alias] of Object.entries(raw.personas)) {
		personas[name] = alias === INHERIT ? INHERIT : knownAlias(`persona "${name}"`, alias);
	}

	let unprofiled: JevRules | undefined;
	if (raw.unprofiled !== undefined) {
		const u = raw.unprofiled;
		if (!isObject(u)) throw new Error("`unprofiled` is not an object");
		if (u.router !== "jev") throw new Error(`unprofiled.router must be "jev"`);
		const minConfidence = u.minConfidence;
		const timeoutMs = u.timeoutMs;
		if (typeof minConfidence !== "number" || !(minConfidence >= 0 && minConfidence <= 1)) {
			throw new Error("unprofiled.minConfidence must be a number from 0 to 1");
		}
		if (typeof timeoutMs !== "number" || !(timeoutMs > 0)) throw new Error("unprofiled.timeoutMs must be a positive number");
		unprofiled = {
			router: "jev",
			implementation: knownAlias("unprofiled.implementation", u.implementation),
			other: knownAlias("unprofiled.other", u.other),
			fallback: knownAlias("unprofiled.fallback", u.fallback),
			minConfidence,
			timeoutMs,
		};
	}

	let leadTrial: string[] | undefined;
	if (raw.leadTrial !== undefined) {
		if (!Array.isArray(raw.leadTrial) || raw.leadTrial.length === 0) throw new Error("`leadTrial` must be a non-empty list of aliases");
		leadTrial = raw.leadTrial.map((alias, i) => knownAlias(`leadTrial[${i}]`, alias));
	}

	return { aliases, personas, unprofiled, leadTrial, source: "file" };
}

export function loadModels(path = modelsJsonPath()): ModelsConfig {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		const reason = (error as NodeJS.ErrnoException).code === "ENOENT" ? "is missing" : `cannot be read (${(error as Error).message})`;
		return { ...FALLBACK_MODELS, warning: `${path} ${reason}` };
	}
	try {
		return parseModelsConfig(JSON.parse(text));
	} catch (error) {
		return { ...FALLBACK_MODELS, warning: `${path} is invalid: ${(error as Error).message}` };
	}
}

const reported = new Set<string>();

export function takeModelsWarning(config: ModelsConfig = loadModels()): string | undefined {
	if (!config.warning || reported.has(config.warning)) return undefined;
	reported.add(config.warning);
	return `WARNING: ${config.warning}; using the built-in persona models instead (run pi-models show).`;
}

export function aliasModel(alias: string | undefined, config: ModelsConfig = loadModels()): ModelRef | undefined {
	return alias && alias !== INHERIT ? config.aliases[alias] : undefined;
}

export function personaAlias(persona: string, config: ModelsConfig = loadModels()): string | undefined {
	return config.personas[persona];
}

export function personaModel(persona: string, config: ModelsConfig = loadModels()): ModelRef | undefined {
	return aliasModel(personaAlias(persona, config), config);
}

export function leadTrialModels(config: ModelsConfig = loadModels()): ModelRef[] {
	return (config.leadTrial ?? []).map((alias) => config.aliases[alias]!).filter(Boolean);
}
