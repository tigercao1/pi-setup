/**
 * Mechanical spawn budget for the PR review gate.
 *
 * A gate-lane reviewer spawn must carry a reservation from
 * `pr-gate-spawn.sh check` (verified, then bound to the agent) or an explicit
 * exemption reason. The gate engine owns the state file; this module only
 * shells out to it.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { allProfiles, defaultSkills, EXT_DIR } from "./config.ts";

export interface GateReservation {
	state: string;
	spawnId: string;
}

const GATE_PROFILES = new Set(["code-review", "reviewer"]);
const GATE_SKILL = "pr-approval-review";
const GATE_TASK_RE = /pr-review-gate|gate lane/i;

function skillName(skill: string): string {
	const base = basename(skill);
	return base === "SKILL.md" ? basename(dirname(skill)) : base.replace(/\.md$/, "");
}

export function effectiveSkills(profile: string | undefined, skills: string[] | undefined): string[] {
	const profileSkills = profile ? (allProfiles()[profile]?.skills ?? []) : [];
	return [...new Set([...(skills ?? []), ...defaultSkills(), ...profileSkills])];
}

/** Why this spawn is a gate-lane review, or null when it is not one. */
export function gateTrigger(profile: string | undefined, skills: string[] | undefined, task: string): string | null {
	if (!profile) return null;
	if (effectiveSkills(profile, skills).some((s) => skillName(s) === GATE_SKILL)) {
		return `its effective skills include ${GATE_SKILL}`;
	}
	if (!GATE_PROFILES.has(profile)) return null;
	const hit = task.match(GATE_TASK_RE);
	return hit ? `the task mentions '${hit[0]}'` : null;
}

export function gateScript(): string {
	const local = join(EXT_DIR, "..", "..", "bin", "pr-gate-spawn.sh");
	return existsSync(local) ? local : join(homedir(), ".pi", "agent", "bin", "pr-gate-spawn.sh");
}

export function gateShapeError(gate: unknown): string | null {
	const g = gate as Partial<GateReservation> | null;
	if (!g || typeof g !== "object") return "gate must be {state, spawnId}";
	if (typeof g.state !== "string" || !isAbsolute(g.state)) return "gate.state must be an absolute path to the gate state JSON";
	if (!existsSync(g.state)) return `gate.state does not exist: ${g.state}`;
	if (typeof g.spawnId !== "string" || !g.spawnId.trim()) return "gate.spawnId must be the spawn_id printed by pr-gate-spawn.sh check";
	return null;
}

export type GateResult = { ok: true; detail: Record<string, unknown> } | { ok: false; error: string };

export function runGate(action: "verify" | "bind", gate: GateReservation, agent: string, team: string): GateResult {
	const proc = spawnSync(
		gateScript(),
		[action, "--state", gate.state, "--spawn-id", gate.spawnId.trim(), "--agent", agent, "--team", team],
		{ encoding: "utf8", timeout: 20_000 },
	);
	let detail: Record<string, unknown> = {};
	try {
		detail = JSON.parse(proc.stdout || "{}") as Record<string, unknown>;
	} catch {
		detail = {};
	}
	if (proc.status === 0) return { ok: true, detail };
	const reason =
		(typeof detail.refused === "string" && detail.refused) ||
		proc.stderr?.trim() ||
		proc.error?.message ||
		`pr-gate-spawn.sh ${action} exited ${proc.status}`;
	return { ok: false, error: reason };
}
