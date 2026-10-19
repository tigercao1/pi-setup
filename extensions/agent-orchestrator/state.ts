/**
 * File-backed team state.
 *
 * Everything a team needs to coordinate lives under
 * `~/.pi/orchestrator-teams/<team>/`. Agents are separate OS processes, so the
 * filesystem is the only shared medium: no sockets, no parent/child pipes.
 * That also means state survives a lead restart.
 *
 *   config.json        full agent tree (TeamConfig)
 *   status/<a>.json    latest StatusReport per agent
 *   contracts/<a>.json TaskContract per agent
 *   mailbox/<a>/*.json queued messages, deleted once delivered
 *   attention/<p>/*    attention requests, scoped to a parent
 *   handoffs/<a>.json  handoff reports written before a recycle
 *   evaluations/       evaluator verdicts
 *   logs/<a>.log       spawned process output (post-mortem)
 *   queue/<a>.json     spawns waiting for a free slot under the concurrency caps
 */

import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureDir, readJson, sleepSync, writeAtomic } from "../_shared/fsjson.ts";
import {
	drainEnvelopes,
	postEnvelope,
	watchEnvelopes,
} from "../_shared/mailbox.ts";

export type Role = "lead" | "orchestrator" | "worker" | "evaluator";
export type AgentState = "queued" | "spawning" | "active" | "done" | "stuck" | "error" | "killed";
export type Backend = "tmux" | "iterm2" | "headless";

export interface TaskContract {
	outputPath?: string;
	outputFormat?: string;
	evaluationCriteria?: string[];
	passDefinition?: string;
	failDefinition?: string;
}

export interface AgentRecord {
	name: string;
	role: Role;
	parent: string | null;
	task: string;
	cwd: string;
	model?: string;
	/** Provider the model was resolved against; replayed on recycle. */
	provider?: string;
	thinkingLevel?: string;
	profile?: string;
	canSpawn: boolean;
	backend: Backend;
	/** tmux pane id, iTerm session id, or `pid:<n>` for headless. */
	paneId: string | null;
	visible: boolean;
	createdAt: string;
	killedAt?: string;
	/** pi session UUID, read from the agent's first log line. */
	sessionId?: string;
	/** Resolved path of the saved session, when found on disk. */
	sessionFile?: string;
	/** Exact launch argv, replayed when resuming so the agent is unchanged. */
	argv?: string[];
}

export interface TeamConfig {
	team: string;
	createdAt: string;
	leadName: string;
	cwd: string;
	backend: Backend;
	/** tmux session the lead was in, used to reattach after a restart. */
	tmuxSession?: string;
	leadPid: number;
	agents: AgentRecord[];
}

export interface StatusReport {
	agent: string;
	state: AgentState;
	output?: string;
	note?: string;
	updatedAt: string;
}

export interface Mail {
	id: string;
	from: string;
	to: string;
	kind: "message" | "broadcast" | "shutdown" | "kickoff";
	content: string;
	sentAt: string;
}

export interface AttentionRequest {
	from: string;
	level: "low" | "medium" | "high";
	question: string;
	at: string;
}

export interface HandoffReport {
	agent: string;
	completedWork: string;
	pendingTasks?: string;
	corrections?: string;
	stateRefs?: string[];
	writtenAt: string;
}

export const TEAMS_ROOT = join(homedir(), ".pi", "orchestrator-teams");

export function teamDir(team: string): string {
	// An empty team name silently resolves to TEAMS_ROOT, which scatters
	// status/, mailbox/ and logs/ across the root and makes every team's state
	// look corrupt. Fail loudly instead.
	if (!team || team.includes("/") || team === "." || team === "..") {
		throw new Error(`Invalid team name: ${JSON.stringify(team)}`);
	}
	return join(TEAMS_ROOT, team);
}
const sub = (team: string, ...parts: string[]): string => join(teamDir(team), ...parts);

export const statusDir = (team: string) => sub(team, "status");
export const contractsDir = (team: string) => sub(team, "contracts");
export const mailboxRoot = (team: string) => sub(team, "mailbox");
export const mailboxDir = (team: string, agent: string) => sub(team, "mailbox", agent);
export const attentionDir = (team: string, parent: string) => sub(team, "attention", parent);
export const handoffsDir = (team: string) => sub(team, "handoffs");
export const evaluationsDir = (team: string) => sub(team, "evaluations");
export const logsDir = (team: string) => sub(team, "logs");
export const configPath = (team: string) => sub(team, "config.json");
export const queueDir = (team: string) => sub(team, "queue");

let nameCounter = 0;

export function newTeamName(): string {
	const now = new Date();
	// yyyymmddhhmmss — slice(0, 14) stops before the fractional-seconds dot.
	const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
	// Second granularity alone collides: two leads (or a rapid respawn) started
	// in the same second would share one directory and clobber each other's
	// agent list. Suffix with the pid plus a counter to make it unique.
	const suffix = `${process.pid.toString(36)}${(nameCounter++).toString(36)}`;
	let candidate = `team-${stamp}-${suffix}`;
	for (let attempt = 2; existsSync(join(TEAMS_ROOT, candidate)); attempt++) {
		candidate = `team-${stamp}-${suffix}-${attempt}`;
	}
	return candidate;
}

export function createTeam(config: Omit<TeamConfig, "createdAt" | "agents">): TeamConfig {
	const full: TeamConfig = { ...config, createdAt: new Date().toISOString(), agents: [] };
	for (const dir of [
		statusDir(config.team),
		contractsDir(config.team),
		handoffsDir(config.team),
		evaluationsDir(config.team),
		logsDir(config.team),
		mailboxDir(config.team, config.leadName),
		attentionDir(config.team, config.leadName),
	]) {
		ensureDir(dir);
	}
	writeAtomic(configPath(config.team), full);
	return full;
}

export const readTeam = (team: string): TeamConfig | null =>
	readJson<TeamConfig>(configPath(team));

export function writeTeam(config: TeamConfig): void {
	writeAtomic(configPath(config.team), config);
}

const LOCK_STALE_MS = 5000;

/**
 * Cross-process mutex via exclusive file creation (`wx` is atomic on POSIX).
 *
 * Re-reading before writing is not enough: two processes can both read, both
 * mutate, and the second write silently drops the first's agent record —
 * leaving an orphaned process nothing can kill.
 */
function withLock<T>(team: string, fn: (held: boolean) => T, options: { required?: boolean } = {}): T | undefined {
	const lock = join(teamDir(team), ".config.lock");
	let held = false;
	for (let attempt = 0; attempt < 100 && !held; attempt++) {
		try {
			const fd = openSync(lock, "wx");
			writeFileSync(fd, `${process.pid}`);
			closeSync(fd);
			held = true;
		} catch {
			// A crashed holder must not deadlock the team forever.
			try {
				if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock);
			} catch {
				// Someone else cleared it first.
			}
			sleepSync(10);
		}
	}
	// A caller that mutates a list (rather than overwriting one field) must not
	// run unlocked: a lost update there orphans a live agent process.
	if (!held && options.required) return undefined;
	try {
		return fn(held);
	} finally {
		if (held) {
			try {
				unlinkSync(lock);
			} catch {
				// Already removed as stale.
			}
		}
	}
}

/** Run `fn` under the team's config lock (best effort if it cannot be taken). */
export function withTeamLock<T>(team: string, fn: () => T): T | undefined {
	return withLock(team, () => fn());
}

/**
 * Read-modify-write the team config under a cross-process lock.
 *
 * Sub-orchestrators mutate the same file as the lead, and spawns happen in
 * bursts, so this is genuinely contended.
 */
export function updateTeam(
	team: string,
	fn: (config: TeamConfig) => void,
	options: { required?: boolean } = {},
): TeamConfig | null {
	const result = withLock(
		team,
		() => {
			const config = readTeam(team);
			if (!config) return null;
			fn(config);
			writeTeam(config);
			return config;
		},
		options,
	);
	return result ?? null;
}

/** True when the team's directory still exists on disk. */
export function teamExists(team: string): boolean {
	try {
		return existsSync(teamDir(team));
	} catch {
		return false;
	}
}

export function addAgent(team: string, agent: AgentRecord): void {
	updateTeam(team, (config) => {
		config.agents = config.agents.filter((a) => a.name !== agent.name);
		config.agents.push(agent);
	});
	ensureDir(mailboxDir(team, agent.name));
	if (agent.canSpawn) ensureDir(attentionDir(team, agent.name));
}

export function patchAgent(team: string, name: string, patch: Partial<AgentRecord>): void {
	updateTeam(team, (config) => {
		const agent = config.agents.find((a) => a.name === name);
		if (agent) Object.assign(agent, patch);
	});
}

export const findAgent = (config: TeamConfig, name: string): AgentRecord | undefined =>
	config.agents.find((a) => a.name === name);

/** Every descendant of `name`, deepest last. Used for cascade kills. */
export function descendantsOf(config: TeamConfig, name: string): AgentRecord[] {
	const out: AgentRecord[] = [];
	const queue = [name];
	while (queue.length > 0) {
		const current = queue.shift() as string;
		for (const agent of config.agents) {
			if (agent.parent === current) {
				out.push(agent);
				queue.push(agent.name);
			}
		}
	}
	return out;
}

export const childrenOf = (config: TeamConfig, name: string): AgentRecord[] =>
	config.agents.filter((a) => a.parent === name);

/** Levels below the lead: the lead is 0, its children 1. Unknown names count as the lead. */
export function depthOf(config: TeamConfig, name: string): number {
	let depth = 0;
	let current = findAgent(config, name);
	const seen = new Set<string>();
	while (current && !seen.has(current.name)) {
		seen.add(current.name);
		depth++;
		current = current.parent ? findAgent(config, current.parent) : undefined;
	}
	return depth;
}

/** `name` and every agent above it, nearest first, ending with the lead. */
export function ancestorsOf(config: TeamConfig, name: string): string[] {
	const out: string[] = [];
	let parent = findAgent(config, name)?.parent ?? null;
	while (parent && !out.includes(parent)) {
		out.push(parent);
		parent = findAgent(config, parent)?.parent ?? null;
	}
	return out;
}

// ---------------------------------------------------------------- status

export function writeStatus(team: string, report: Omit<StatusReport, "updatedAt">): StatusReport {
	const full: StatusReport = { ...report, updatedAt: new Date().toISOString() };
	// writeAtomic would mkdir the team back into existence after cleanup.
	if (!teamExists(team)) return full;
	writeAtomic(join(statusDir(team), `${report.agent}.json`), full);
	return full;
}

export const readStatus = (team: string, agent: string): StatusReport | null =>
	readJson<StatusReport>(join(statusDir(team), `${agent}.json`));

export function readAllStatuses(team: string): Record<string, StatusReport> {
	const out: Record<string, StatusReport> = {};
	const dir = statusDir(team);
	if (!existsSync(dir)) return out;
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".json")) continue;
		const report = readJson<StatusReport>(join(dir, file));
		if (report) out[report.agent] = report;
	}
	return out;
}

// -------------------------------------------------------------- contracts

export function writeContract(team: string, agent: string, contract: TaskContract): void {
	if (!teamExists(team)) return;
	writeAtomic(join(contractsDir(team), `${agent}.json`), contract);
}

export const readContract = (team: string, agent: string): TaskContract | null =>
	readJson<TaskContract>(join(contractsDir(team), `${agent}.json`));

// ---------------------------------------------------------------- mailbox

export const postMail = (team: string, mail: Omit<Mail, "id" | "sentAt">): Mail =>
	postEnvelope<Mail>(mailboxRoot(team), mail);

/** Read and delete everything addressed to `agent`. */
export const drainMailbox = (team: string, agent: string): Mail[] =>
	drainEnvelopes<Mail>(mailboxRoot(team), agent);

/** Deliver mail to `agent` as it arrives. */
export const watchMailbox = (
	team: string,
	agent: string,
	onMail: (mail: Mail[]) => void,
	pollMs = 2000,
): (() => void) => watchEnvelopes<Mail>(mailboxRoot(team), agent, onMail, pollMs);

// -------------------------------------------------------------- attention

export function postAttention(team: string, parent: string, request: AttentionRequest): void {
	if (!teamExists(team)) return;
	writeAtomic(
		join(attentionDir(team, parent), `${Date.now()}-${request.from}.json`),
		request,
	);
}

export function readAttention(team: string, parent: string, consume = false): AttentionRequest[] {
	const dir = attentionDir(team, parent);
	if (!existsSync(dir)) return [];
	const out: AttentionRequest[] = [];
	for (const file of readdirSync(dir).sort()) {
		if (!file.endsWith(".json")) continue;
		const path = join(dir, file);
		const request = readJson<AttentionRequest>(path);
		if (request) out.push(request);
		if (consume) {
			try {
				unlinkSync(path);
			} catch {
				// Already consumed.
			}
		}
	}
	return out;
}

// --------------------------------------------------------------- handoffs

export function writeHandoff(team: string, report: HandoffReport): string {
	const path = join(handoffsDir(team), `${report.agent}.json`);
	writeAtomic(path, report);
	return path;
}

export const readHandoff = (team: string, agent: string): HandoffReport | null =>
	readJson<HandoffReport>(join(handoffsDir(team), `${agent}.json`));

export function writeEvaluation(team: string, name: string, data: unknown): string {
	const path = join(evaluationsDir(team), `${name}.json`);
	writeAtomic(path, data);
	return path;
}

export const logPath = (team: string, agent: string): string =>
	join(logsDir(team), `${agent}.log`);

export function destroyTeam(team: string): void {
	rmSync(teamDir(team), { recursive: true, force: true });
}

/** Teams on disk, newest first. */
export function listTeams(): TeamConfig[] {
	if (!existsSync(TEAMS_ROOT)) return [];
	const teams: TeamConfig[] = [];
	for (const entry of readdirSync(TEAMS_ROOT)) {
		const config = readTeam(entry);
		if (config) teams.push(config);
	}
	return teams.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
