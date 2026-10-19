/**
 * Settings, profiles, and the argv/env used to launch a spawned agent.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnEnv } from "../_shared/spawn-env.ts";
import type { Role, TaskContract } from "./state.ts";

export const EXT_DIR = dirname(fileURLToPath(import.meta.url));
export const EXT_ENTRY = join(EXT_DIR, "index.ts");
const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

export type OrchLevel = "auto" | "1-tier" | "2-tier";

interface ModelDefault {
	model?: string;
	provider?: string;
	thinkingLevel?: string;
}

interface Settings {
	defaultModel?: string;
	defaultProvider?: string;
	orchestrator?: { level?: OrchLevel };
	team?: {
		/** Skills attached to every spawn (names or paths). */
		defaultSkills?: string[];
		/** User-defined worker profiles, merged over the built-ins. */
		profiles?: Record<string, Partial<Profile>>;
		/**
		 * How teammate mail reaches the lead.
		 *   immediate - wake the lead on every message (noisy; interrupts you)
		 *   batched   - accumulate, deliver once the workers go quiet (default)
		 *   manual    - never wake the lead; mail rides along with your next prompt
		 */
		mailDelivery?: "immediate" | "batched" | "manual";
		/** Quiet period before batched mail is delivered. Default 20s. */
		mailQuietSeconds?: number;
		/** Longest mail is ever held in batched mode. Default 300s. */
		mailMaxHoldSeconds?: number;
		/** Rows the widget shows before collapsing to "+N more". Default 6. */
		widgetRows?: number;
		/** Minutes a finished agent stays in the tree before reaping. Default 10. */
		reapAfterMinutes?: number;
		/** Hard cap on agents tracked in one team. Default 40. */
		maxAgents?: number;
		/** Days before an abandoned team directory is swept. Default 7. */
		teamRetentionDays?: number;
		/** Default for team_spawn's contextFiles when not specified. */
		contextFiles?: boolean;
		modelDefaults?: Partial<Record<Role, ModelDefault>>;
		/** Max direct children before 2-tier mode promotes a spawn. */
		promoteThreshold?: number;
		/** Live direct children one parent may have. Default 5. */
		maxChildrenPerParent?: number;
		/** Live agents in one team, lead excluded. Default 8. */
		maxLiveAgents?: number;
		/** Levels below the lead an agent may sit at. Default 3. */
		maxDepth?: number;
		/** Queue a spawn that hits a count cap instead of refusing it. Default true. */
		queueSpawns?: boolean;
	};
}

function readSettings(): Settings {
	try {
		return JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Settings;
	} catch {
		return {};
	}
}

export const orchLevel = (): OrchLevel => readSettings().orchestrator?.level ?? "auto";

export function setOrchLevel(level: OrchLevel): void {
	const raw = existsSync(SETTINGS_PATH) ? readFileSync(SETTINGS_PATH, "utf8") : "{}";
	const settings = JSON.parse(raw) as Settings & Record<string, unknown>;
	settings.orchestrator = { ...(settings.orchestrator ?? {}), level };
	writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
}

/**
 * Built-ins plus `team.profiles` from settings. Settings win, so a profile can
 * be redefined (or a new one added) without touching this file. Read at tool
 * registration, so edits need a /reload.
 */
export function allProfiles(): Record<string, Profile> {
	const custom = readSettings().team?.profiles ?? {};
	const merged: Record<string, Profile> = { ...NAMED_PROFILES };
	for (const [name, profile] of Object.entries(custom)) {
		merged[name] = { ...(merged[name] ?? { role: "worker", description: name }), ...profile };
	}
	return merged;
}

export type MailDelivery = "immediate" | "batched" | "manual";

export const mailDelivery = (): MailDelivery =>
	(process.env.PI_ORCH_MAIL_DELIVERY as MailDelivery | undefined) ??
	readSettings().team?.mailDelivery ??
	"batched";

const envMs = (name: string): number | undefined => {
	const raw = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(raw) ? raw : undefined;
};

export const mailQuietMs = (): number =>
	envMs("PI_ORCH_MAIL_QUIET_MS") ?? (readSettings().team?.mailQuietSeconds ?? 20) * 1000;

export const mailMaxHoldMs = (): number =>
	envMs("PI_ORCH_MAIL_MAX_HOLD_MS") ?? (readSettings().team?.mailMaxHoldSeconds ?? 300) * 1000;

export const widgetRows = (): number => readSettings().team?.widgetRows ?? 6;
export const reapRetentionMs = (): number =>
	(readSettings().team?.reapAfterMinutes ?? 10) * 60_000;
export const maxTrackedAgents = (): number => readSettings().team?.maxAgents ?? 40;
export const teamRetentionMs = (): number =>
	(readSettings().team?.teamRetentionDays ?? 7) * 24 * 60 * 60_000;

export const defaultSkills = (): string[] => readSettings().team?.defaultSkills ?? [];
export const defaultContextFiles = (): boolean => readSettings().team?.contextFiles ?? false;

export const promoteThreshold = (): number => readSettings().team?.promoteThreshold ?? 5;

const positiveInt = (value: unknown, fallback: number): number =>
	typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;

export interface SpawnLimits {
	maxChildrenPerParent: number;
	maxLiveAgents: number;
	maxDepth: number;
	queueSpawns: boolean;
}

export function spawnLimits(): SpawnLimits {
	const team = readSettings().team ?? {};
	return {
		maxChildrenPerParent: positiveInt(team.maxChildrenPerParent, 5),
		maxLiveAgents: positiveInt(team.maxLiveAgents, 8),
		maxDepth: positiveInt(team.maxDepth, 3),
		queueSpawns: team.queueSpawns ?? true,
	};
}

/** Fall back to the caller's own model so a team is coherent by default. */
const HARD_DEFAULTS: Record<Role, ModelDefault> = {
	lead: {},
	orchestrator: { thinkingLevel: "medium" },
	worker: { thinkingLevel: "low" },
	evaluator: { thinkingLevel: "medium" },
};

export interface Profile {
	role: Role;
	/** Model id, e.g. "openai/gpt-6.1-sol". Overrides inheritance from the lead. */
	model?: string;
	/** Provider for `model`. Always set this when setting `model`: a bare id can
	 *  resolve to a different provider in the child and fail on auth. */
	provider?: string;
	thinkingLevel?: string;
	extensions?: string[];
	/**
	 * Skill names or paths handed to the child. Names are resolved per-repo
	 * (`agentOrchestrator.projectSkillRoots`, then global), and a
	 * name that does not resolve in the current repo is skipped rather than
	 * failing the spawn — so a profile can name repo-specific skills safely.
	 */
	skills?: string[];
	/** Keep AGENTS.md/CLAUDE.md conventions. Default true for code/PR work. */
	contextFiles?: boolean;
	description: string;
}

/**
 * Named bundles of extension + thinking level.
 *
 * Deliberately generic: extension names here are resolved against
 * `~/.pi/agent/extensions/` at spawn time and silently skipped when absent, so
 * an unknown name never breaks a spawn.
 */
export const NAMED_PROFILES: Record<string, Profile> = {
	researcher: {
		role: "worker",
		thinkingLevel: "low",
		description: "Read-only investigation: search, read, summarise into one file",
	},
	coder: {
		role: "worker",
		thinkingLevel: "medium",
		description: "Implements a scoped change in 1-3 files",
	},
	reviewer: {
		role: "worker",
		model: "openai/gpt-6.1-sol",
		provider: "vercel-ai-gateway",
		thinkingLevel: "medium",
		skills: ["pr-approval-review"],
		contextFiles: true,
		description:
			"Reviews a diff or set of files with the pr-approval-review rubric, including the no-unnecessary-changes audit",
	},
	"code-review": {
		role: "worker",
		model: "openai/gpt-6.1-sol",
		provider: "vercel-ai-gateway",
		thinkingLevel: "medium",
		skills: ["pr-approval-review"],
		contextFiles: true,
		description:
			"Second-opinion PR/code review on gpt-6.1-sol with the pr-approval-review rubric",
	},
	verifier: {
		role: "worker",
		model: "openai/gpt-6.1-sol",
		provider: "vercel-ai-gateway",
		thinkingLevel: "high",
		// Deliberately bare: a verifier must not inherit the conventions,
		// skills or repo framing that shaped the work it is judging.
		skills: [],
		contextFiles: false,
		description:
			"Hostile verifier: tries to DISPROVE a finding. Fresh empty context, never sees the worker's chat",
	},
	manager: {
		role: "orchestrator",
		thinkingLevel: "medium",
		contextFiles: false,
		description:
			"Manager: spawns a batch of workers, awaits them with team_await, verifies their findings, " +
			"and reports ONE synthesised answer upward. Keeps raw worker output out of the lead's context",
	},
	"pr-author": {
		role: "worker",
		thinkingLevel: "medium",
		contextFiles: true,
		description: "Takes a ticket to an open PR using the repo's ticket-to-PR skill",
	},
	tester: {
		role: "worker",
		thinkingLevel: "low",
		description: "Writes or runs tests for a single target",
	},
	"docs-writer": {
		role: "worker",
		thinkingLevel: "low",
		description: "Synthesises markdown from existing data, no new research",
	},
	"batch-orchestrator": {
		role: "orchestrator",
		thinkingLevel: "medium",
		description: "Coordinates a batch of 4-7 workers",
	},
};

export interface ResolvedRuntime {
	model?: string;
	provider?: string;
	thinkingLevel?: string;
	extensions: string[];
	skills: string[];
	/** From the profile; merged with explicit + default skills by the caller. */
	profileSkills: string[];
	/** undefined = fall back to the settings default. */
	contextFiles?: boolean;
}

/**
 * Resolution order: explicit args, then profile, then settings defaults, then
 * hard-coded defaults. `undefined` means "inherit whatever pi would pick".
 */
export function resolveRuntime(options: {
	role: Role;
	model?: string;
	provider?: string;
	thinkingLevel?: string;
	profile?: string;
	contextFiles?: boolean;
	extensions?: string[];
	/**
	 * Skills handed to the child explicitly. Unlike extensions these survive
	 * `slim`, because `--skill` is additive even under `--no-skills`.
	 */
	skills?: string[];
	slim: boolean;
	/** The spawning agent's own model, used when nothing else specifies one. */
	inherit?: { model: string; provider: string };
}): ResolvedRuntime {
	const profile = options.profile ? allProfiles()[options.profile] : undefined;
	const settingsDefault = readSettings().team?.modelDefaults?.[options.role] ?? {};
	const hard = HARD_DEFAULTS[options.role];

	const extensions = new Set<string>();
	if (options.slim) {
		for (const name of options.extensions ?? profile?.extensions ?? []) extensions.add(name);
	}

	// Model and provider travel together: a bare model id can match a different
	// provider in the child process and fail on auth.
	// Precedence: explicit spawn args > profile > settings role defaults >
	// inherit the spawning agent's own model.
	const model =
		options.model ?? profile?.model ?? settingsDefault.model ?? hard.model ?? options.inherit?.model;
	const pinned = (id: string | undefined): string | undefined => {
		if (!id) return undefined;
		if (id === options.inherit?.model) return options.inherit?.provider;
		const settings = readSettings();
		return id === settings.defaultModel ? settings.defaultProvider : undefined;
	};
	const provider = options.model
		? (options.provider ?? pinned(options.model))
		: model === profile?.model
			? profile?.provider
			: (settingsDefault.model ? settingsDefault.provider : undefined) ?? pinned(model);

	return {
		model,
		provider,
		contextFiles: options.contextFiles ?? profile?.contextFiles,
		profileSkills: profile?.skills ?? [],
		thinkingLevel:
			options.thinkingLevel ??
			profile?.thinkingLevel ??
			settingsDefault.thinkingLevel ??
			hard.thinkingLevel,
		extensions: [...extensions],
		skills: [...new Set(options.skills ?? [])],
	};
}

const BUILTIN_EXTENSION_GROUPS: Record<string, string[]> = {
	mcp: ["builtin:mcp", "builtin:codemode", "builtin:tool-search"],
};

/** `name` -> the `-e` values it expands to. */
export function resolveExtensionArgs(name: string): string[] {
	const group = BUILTIN_EXTENSION_GROUPS[name];
	if (group) return [...group];
	if (name.startsWith("builtin:")) return [name];
	const path = resolveExtensionPath(name);
	return path ? [path] : [];
}

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

interface AgentDirSettings {
	agentOrchestrator?: {
		contextExtensions?: string[];
		projectSkillRoots?: string[];
	};
}

function agentDirSettings(): AgentDirSettings {
	try {
		return JSON.parse(readFileSync(join(agentDir(), "settings.json"), "utf8")) as AgentDirSettings;
	} catch {
		return {};
	}
}

const expandHome = (path: string): string => path.replace(/^~(?=\/|$)/, homedir());

const stringList = (value: unknown): string[] | undefined =>
	Array.isArray(value) ? value.filter((e): e is string => typeof e === "string") : undefined;

export const DEFAULT_PROJECT_SKILL_ROOTS = [".claude/skills", ".agents/skills", ".pi/skills"];

export function projectSkillRoots(cwd: string): string[] {
	const configured = stringList(agentDirSettings().agentOrchestrator?.projectSkillRoots);
	return (configured ?? DEFAULT_PROJECT_SKILL_ROOTS).map((root) => resolve(cwd, expandHome(root)));
}

export function contextExtensionPaths(): string[] {
	const configured = stringList(agentDirSettings().agentOrchestrator?.contextExtensions) ?? [];
	const paths: string[] = [];
	for (const entry of configured) {
		const base = resolve(agentDir(), expandHome(entry));
		const found = [join(base, "index.ts"), `${base}.ts`, base].find((candidate) => existsSync(candidate));
		if (found && !paths.includes(found)) paths.push(found);
	}
	return paths;
}

export function settingsDirs(key: "skills" | "extensions"): string[] {
	const dir = agentDir();
	try {
		const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
		const entries: unknown[] = Array.isArray(settings[key]) ? settings[key] : [];
		return entries
			.filter((e): e is string => typeof e === "string" && !/^[!+-]/.test(e) && !e.startsWith("builtin:"))
			.map((e) => resolve(dir, e.replace(/^~(?=\/)/, homedir())))
			.filter((p) => existsSync(p));
	} catch {
		return [];
	}
}

/** `name` -> path under the agent dir's extensions or a settings `extensions` directory, or an absolute path as-is. */
export function resolveExtensionPath(name: string): string | null {
	if (isAbsolute(name) || name.startsWith(".")) {
		const path = resolve(name);
		return existsSync(path) ? path : null;
	}
	for (const root of [join(agentDir(), "extensions"), ...settingsDirs("extensions")]) {
		const base = join(root, name);
		for (const candidate of [join(base, "index.ts"), `${base}.ts`, base]) {
			if (existsSync(candidate)) return candidate;
		}
	}
	return null;
}

/**
 * `name` -> a skill directory or file. Bare names are looked up in the project's
 * skill locations first, then the global ones, so a worker started in a repo
 * gets that repo's copy of a skill.
 */
export function resolveSkillPath(name: string, cwd: string): string | null {
	if (isAbsolute(name) || name.startsWith(".")) {
		const path = resolve(cwd, name);
		return existsSync(path) ? path : null;
	}
	const roots = [
		...projectSkillRoots(cwd),
		join(agentDir(), "skills"),
		...settingsDirs("skills"),
		join(homedir(), ".agents", "skills"),
		join(homedir(), ".claude", "skills"),
	];
	for (const root of roots) {
		const base = join(root, name);
		for (const candidate of [join(base, "SKILL.md"), `${base}.md`, base]) {
			if (existsSync(candidate)) return candidate;
		}
	}
	return null;
}

/** Env vars a spawned agent needs: auth, PATH, and its own identity. */
const ROLE_GUIDE_FILE: Record<Role, string> = {
	lead: "lead",
	orchestrator: "orchestrator",
	worker: "worker",
	evaluator: "worker",
};

/** The env a spawned agent gets. Shared with the fork-session extension. */
export { spawnEnv };

export function roleGuide(role: Role): string {
	const path = join(EXT_DIR, "skills", ROLE_GUIDE_FILE[role], "SKILL.md");
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

/**
 * The spawned agent's system prompt addendum.
 *
 * The assignment lives in the system prompt on purpose: it survives context
 * compaction, so a long-running agent cannot forget what it was asked to do.
 */
export function buildSystemPrompt(options: {
	team: string;
	agent: string;
	role: Role;
	parent: string;
	canSpawn: boolean;
	task: string;
	contract?: TaskContract;
	handoff?: string;
	extraContext?: string;
}): string {
	const parts: string[] = [];
	const now = new Date();
	parts.push(
		[
			"# Multi-Agent Team Assignment",
			"",
			`**Current time at spawn: ${now.toString()}** (UTC: ${now.toISOString()}).`,
			"If your assignment names a date or day that contradicts this timestamp, TRUST THIS",
			"TIMESTAMP, adjust your work accordingly, and say so in your report and to your parent.",
			"For time-sensitive data, echo the date label the data source itself returned rather",
			"than the one you were told to expect — sources roll over on their own schedule.",
			"",
			`You are **${options.agent}**, a ${options.role} in team \`${options.team}\`.`,
			`Your parent is **${options.parent}**. You may${options.canSpawn ? "" : " NOT"} spawn child agents.`,
			"",
			"You are not talking to a human. Everything you produce must reach your parent",
			"through `team_message` and a deliverable file. When you finish, call",
			"`team_write_status` with state `done` and then `team_message` your parent.",
		].join("\n"),
	);

	parts.push(["## Your Assignment (from " + options.parent + ")", "", options.task].join("\n"));

	if (options.contract) {
		const c = options.contract;
		const lines = ["## Task Contract", ""];
		if (c.outputPath) lines.push(`- **Output path**: \`${c.outputPath}\` (write exactly here)`);
		if (c.outputFormat) lines.push(`- **Format**: ${c.outputFormat}`);
		if (c.evaluationCriteria?.length) {
			lines.push("- **Evaluation criteria**:");
			for (const criterion of c.evaluationCriteria) lines.push(`  - ${criterion}`);
		}
		if (c.passDefinition) lines.push(`- **Pass**: ${c.passDefinition}`);
		if (c.failDefinition) lines.push(`- **Fail**: ${c.failDefinition}`);
		parts.push(lines.join("\n"));
	}

	if (options.handoff) {
		parts.push(["## Handoff From Your Predecessor", "", options.handoff].join("\n"));
	}
	if (options.extraContext) {
		parts.push(["## Additional Context", "", options.extraContext].join("\n"));
	}

	const guide = roleGuide(options.role);
	if (guide) parts.push(guide);

	return parts.join("\n\n---\n\n");
}

/** argv for the spawned pi process. */
export function buildArgv(options: {
	team: string;
	agent: string;
	systemPrompt: string;
	kickoff: string;
	model?: string;
	provider?: string;
	thinkingLevel?: string;
	extensions: string[];
	skills: string[];
	cwd: string;
	/** Keep AGENTS.md / CLAUDE.md discovery even in slim mode. */
	contextFiles?: boolean;
	slim: boolean;
	headless: boolean;
}): string[] {
	const bin = process.env.PI_ORCH_PI_BIN ?? "pi";
	const argv = [bin, "--name", `${options.team}:${options.agent}`];

	if (options.provider) argv.push("--provider", options.provider);
	if (options.model) argv.push("--model", options.model);
	if (options.thinkingLevel) argv.push("--thinking", options.thinkingLevel);

	if (options.slim) {
		// Load nothing but this extension (plus explicit extras): a worker does
		// not need the lead's skills, context files, or unrelated extensions.
		argv.push("--no-extensions", "--no-skills");
		// Repo conventions live in AGENTS.md/CLAUDE.md. Stripping them from a
		// worker that writes code or opens a PR loses commit-message rules,
		// review conventions, and tooling invocations.
		if (!options.contextFiles) argv.push("--no-context-files");
		argv.push("-e", EXT_ENTRY);
		for (const name of options.extensions) {
			for (const value of resolveExtensionArgs(name)) argv.push("-e", value);
		}
	}
	if (options.contextFiles) {
		for (const path of contextExtensionPaths()) argv.push("-e", path);
	}

	// Outside the slim branch on purpose: --skill is additive even with
	// --no-skills, and naming a skill explicitly is meaningful either way.
	for (const name of options.skills) {
		const path = resolveSkillPath(name, options.cwd);
		if (path) argv.push("--skill", path);
	}

	argv.push("--append-system-prompt", options.systemPrompt);
	// JSON mode rather than -p: same one-shot lifecycle, but the log becomes an
	// event stream, so the parent can see tool activity while the agent works
	// instead of only its final answer.
	if (options.headless) argv.push("--mode", "json");
	argv.push("--", options.kickoff);
	return argv;
}
