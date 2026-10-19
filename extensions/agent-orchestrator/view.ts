/**
 * How a team is summarised for humans.
 *
 * Shared by the widget, `/team`, and the `/agents` overlay so they can never
 * disagree with each other — the widget once reported `0▶ 0✔ 0⚠ 0✖` while
 * listing five agents, because counts and rows used different rules.
 *
 * Two rules drive everything here:
 *   1. An agent's outcome outranks how it was stopped. A worker that reported
 *      `done` and was later cleaned up is ✔, not ✖.
 *   2. Screen space is finite. With 20 agents the interesting ones are the
 *      live, stuck and failed; finished work is a line of counts.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentRecord, AgentState, StatusReport, TeamConfig } from "./state.ts";

export interface AgentView {
	agent: AgentRecord;
	depth: number;
	status?: StatusReport;
	alive: boolean;
	state: AgentState;
	/** Lower sorts first. */
	rank: number;
	updatedAt: number;
}

const TERMINAL: ReadonlySet<string> = new Set(["done", "error", "stuck"]);

export const STATE_ICON: Record<string, string> = {
	queued: "⧗",
	spawning: "◌",
	active: "●",
	done: "✔",
	stuck: "⚠",
	error: "✖",
	killed: "✖",
};

/**
 * What the agent actually ended up as.
 *
 * `killedAt` records how a process was stopped, not what it achieved.
 * Cleanup marks every agent killed, so preferring it would erase the outcome
 * of an entire finished team.
 */
export function displayState(agent: AgentRecord, status: StatusReport | undefined): AgentState {
	if (status && TERMINAL.has(status.state)) return status.state;
	if (agent.killedAt) return "killed";
	return status?.state ?? "spawning";
}

/** Needs-attention first, finished last; recent before old inside a group. */
function rankOf(state: AgentState, alive: boolean): number {
	if (state === "stuck") return 0;
	if (state === "error") return 1;
	if (alive) return 2; // active / spawning and running
	if (state === "queued") return 3;
	if (state === "done") return 4;
	if (state === "killed") return 5;
	return 3; // claims to be active but the process is gone
}

/** `root` defaults to the lead; a sub-orchestrator passes its own name to see only its subtree. */
export function buildViews(
	config: TeamConfig,
	statuses: Record<string, StatusReport>,
	isAlive: (agent: string) => boolean,
	root: string = config.leadName,
): AgentView[] {
	const views: AgentView[] = [];
	const walk = (parent: string, depth: number): void => {
		for (const agent of config.agents.filter((a) => a.parent === parent)) {
			const status = statuses[agent.name];
			const alive = !agent.killedAt && isAlive(agent.name);
			const state = displayState(agent, status);
			views.push({
				agent,
				depth,
				status,
				alive,
				state,
				rank: rankOf(state, alive),
				updatedAt: status ? Date.parse(status.updatedAt) : Date.parse(agent.createdAt),
			});
			walk(agent.name, depth + 1);
		}
	};
	walk(root, 0);
	return views;
}

/**
 * Each depth-0 view's descendants, in tree order. Relies on buildViews
 * emitting a depth-first walk, so a subtree is the run of deeper views
 * that follows its root.
 */
export function subtreeOf(views: AgentView[], index: number): AgentView[] {
	const head = views[index];
	if (!head) return [];
	const out: AgentView[] = [];
	for (let i = index + 1; i < views.length && (views[i] as AgentView).depth > head.depth; i++) {
		out.push(views[i] as AgentView);
	}
	return out;
}

export interface Counts {
	live: number;
	done: number;
	stuck: number;
	error: number;
	killed: number;
	queued: number;
	total: number;
}

/** Every agent lands in exactly one bucket, so the numbers add up to `total`. */
export function countStates(views: AgentView[]): Counts {
	const counts: Counts = { live: 0, done: 0, stuck: 0, error: 0, killed: 0, queued: 0, total: views.length };
	for (const view of views) {
		if (view.state === "done") counts.done++;
		else if (view.state === "queued") counts.queued++;
		else if (view.state === "stuck") counts.stuck++;
		else if (view.state === "error") counts.error++;
		else if (view.alive) counts.live++;
		else counts.killed++;
	}
	return counts;
}

export const countsLine = (c: Counts): string =>
	`${c.live}▶ ${c.done}✔ ${c.stuck}⚠ ${c.error}✖${c.queued > 0 ? ` ${c.queued}⧗` : ""}${c.killed > 0 ? ` ${c.killed}⊘` : ""}`;

/**
 * Truncate to `width` terminal COLUMNS.
 *
 * Uses pi-tui's own width helpers rather than counting characters: a CJK name
 * or an emoji occupies two columns, so a code-point count silently overflows
 * and the widget wraps — which is the whole failure this bounding exists to
 * prevent.
 */
export function clip(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	if (width === 1) return "…";
	return truncateToWidth(text, width, "…");
}

export interface WidgetLinesOptions {
	teamName: string;
	views: AgentView[];
	/** Terminal width; rows are clipped to it so nothing ever wraps. */
	width: number;
	maxRows: number;
	/** Live activity label, e.g. "bash…  7 calls  $0.03". */
	activity?: (view: AgentView) => string;
	/** Advertise `/agents`; false where the overlay is unavailable (sub-orchestrators). */
	overlayHint?: boolean;
	/** Ask lines (owed or in flight), shown below the agent rows. */
	asks?: string[];
}

/**
 * The widget: a header plus at most `maxRows` direct children, chosen by
 * priority rather than by spawn order. A child that manages its own team
 * carries a rolled-up tally of that subtree instead of listing it, so each
 * level sees its direct reports and not its reports' reports. Anything not
 * shown is accounted for in the header counts and the "+N more" line, so
 * nothing disappears silently.
 */
export function widgetLines(options: WidgetLinesOptions): string[] {
	const counts = countStates(options.views);
	const header = clip(
		`${options.teamName}  ${countsLine(counts)}${options.overlayHint === false ? "" : "  (/agents)"}`,
		options.width,
	);
	const askRows = (options.asks ?? []).map((line) => clip(`  ${line}`, options.width));
	if (options.views.length === 0) return [header, ...askRows];

	const top = options.views
		.map((view, index) => ({ view, below: subtreeOf(options.views, index) }))
		.filter(({ view }) => view.depth === 0);
	const sorted = top.sort((a, b) => a.view.rank - b.view.rank || b.view.updatedAt - a.view.updatedAt);
	const shown = sorted.slice(0, Math.max(1, options.maxRows));
	const rows = shown.map(({ view, below }) => {
		const doing = options.activity?.(view) ?? "";
		const note = view.status?.note ? ` — ${view.status.note}` : "";
		const rollup = below.length > 0 ? `  [${countsLine(countStates(below))}]` : "";
		return clip(
			`  ${STATE_ICON[view.state] ?? "?"} ${view.agent.name}${rollup}${doing ? `  ${doing}` : ""}${note}`,
			options.width,
		);
	});
	const hidden = sorted.length - shown.length;
	if (hidden > 0) {
		const hint = options.overlayHint === false ? "team_status for the rest" : "/agents for the full tree";
		rows.push(clip(`  +${hidden} more — ${hint}`, options.width));
	}
	return [header, ...rows, ...askRows];
}
