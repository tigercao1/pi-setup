import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { leadTrialModels, loadModels, type ModelRef } from "./personas.ts";

export const TRIAL_MODELS = ["anthropic/claude-sonnet-5.5", "anthropic/claude-opus-5.5"];
export const TRIAL_PROVIDER = "vercel-ai-gateway";
const TSV_HEADER = "ts\tteam\tagent\tarm\tmodel\ttask\n";

export interface LeadTrialSettings {
	enabled: boolean;
	until?: string;
	models: string[];
	provider: string;
}

export interface TrialArm {
	arm: string;
	model: string;
	provider: string;
	until?: string;
	baseModel?: string;
	baseProvider?: string;
}

export interface TrialCandidate {
	role: string;
	model?: string;
	profileModel?: string;
	roleOverride?: string;
	baseModel?: string;
	baseProvider?: string;
}

const agentDir = (): string => join(homedir(), ".pi", "agent");
export const trialLogPath = (): string => join(agentDir(), "run", "lead-trial.tsv");

export function parseLeadTrial(raw: unknown, defaultProvider?: string, personaArms: ModelRef[] = []): LeadTrialSettings {
	const s = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const models = Array.isArray(s.models) ? s.models.filter((m): m is string => typeof m === "string" && m.length > 0) : [];
	const fromPersonas = models.length === 0 && personaArms.length > 0;
	return {
		enabled: s.enabled === true,
		until: typeof s.until === "string" && /^\d{4}-\d{2}-\d{2}/.test(s.until) ? s.until.slice(0, 10) : undefined,
		models: models.length > 0 ? models : fromPersonas ? personaArms.map((arm) => arm.model) : TRIAL_MODELS,
		provider:
			typeof s.provider === "string" && s.provider
				? s.provider
				: fromPersonas
					? personaArms[0]!.provider
					: (defaultProvider ?? TRIAL_PROVIDER),
	};
}

export function readLeadTrial(): LeadTrialSettings {
	const personaArms = leadTrialModels(loadModels());
	try {
		const settings = JSON.parse(readFileSync(join(agentDir(), "settings.json"), "utf8")) as Record<string, unknown>;
		return parseLeadTrial(
			settings.leadTrial,
			typeof settings.defaultProvider === "string" ? settings.defaultProvider : undefined,
			personaArms,
		);
	} catch {
		return parseLeadTrial(undefined, undefined, personaArms);
	}
}

const localDate = (now: Date): string => {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

export function trialActive(settings: LeadTrialSettings, now = new Date()): boolean {
	return settings.enabled && Boolean(settings.until) && localDate(now) <= settings.until!;
}

export function isTrialSpawn(spawn: TrialCandidate): boolean {
	if (spawn.model || spawn.roleOverride || spawn.profileModel) return false;
	return spawn.role === "orchestrator" && Boolean(spawn.baseModel);
}

export const armLabel = (model: string): string => model.split("/").pop() ?? model;

export function pickArm(team: string, agent: string, settings: LeadTrialSettings): TrialArm {
	const digest = createHash("sha256").update(`${team}\u0000${agent}`).digest();
	const model = settings.models[digest[0]! % settings.models.length]!;
	return { arm: armLabel(model), model, provider: settings.provider, until: settings.until };
}

export function leadTrialArm(
	team: string,
	agent: string,
	spawn: TrialCandidate,
	settings = readLeadTrial(),
	now = new Date(),
	logPath = trialLogPath(),
): TrialArm | undefined {
	if (!trialActive(settings, now) || !isTrialSpawn(spawn) || !trialLogWritable(logPath)) return undefined;
	return { ...pickArm(team, agent, settings), baseModel: spawn.baseModel, baseProvider: spawn.baseProvider };
}

export function inheritedModel(
	trial: TrialArm | undefined,
	own: { model: string; provider: string } | undefined,
): { model: string; provider: string } | undefined {
	if (!trial?.baseModel) return own;
	return { model: trial.baseModel, provider: trial.baseProvider ?? own?.provider ?? "" };
}

export function trialLogWritable(path = trialLogPath()): boolean {
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, existsSync(path) ? "" : TSV_HEADER);
		return true;
	} catch {
		return false;
	}
}

const cell = (value: string): string => value.replace(/[\t\r\n]+/g, " ").trim();

export function appendTrialLog(
	row: { team: string; agent: string; arm: string; model: string; task: string },
	path = trialLogPath(),
): string | undefined {
	try {
		mkdirSync(dirname(path), { recursive: true });
		const firstLine = row.task.split("\n").find((line) => line.trim()) ?? "";
		const line = [new Date().toISOString(), row.team, row.agent, row.arm, row.model, firstLine.slice(0, 200)].map(cell).join("\t");
		appendFileSync(path, `${existsSync(path) ? "" : TSV_HEADER}${line}\n`);
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}
