/**
 * Session UI: the lead-only `/agents` overlay, and the live status widget that
 * every orchestrator session (lead or sub-orchestrator) draws for its own
 * subtree.
 */

import type {
	ExtensionCommandContext,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { capturePane, focusPane, isAlive, killAgent, quoteArgv } from "./backend.ts";
import { maxTrackedAgents, reapRetentionMs, widgetRows } from "./config.ts";
import { activityLabel, readActivity } from "./digest.ts";
import { reapTeam } from "./reap.ts";
import { buildViews, countsLine, countStates, displayState, STATE_ICON, widgetLines } from "./view.ts";
import { buildResumeArgv, checkResumable } from "./resume.ts";
import { askLine, visibleAsks } from "./ask.ts";
import type { Runtime } from "./session.ts";
import {
	type AgentRecord,
	childrenOf,
	patchAgent,
	readAllStatuses,
	type StatusReport,
	writeStatus,
} from "./state.ts";
import { openAgentSession } from "./tools.ts";

/**
 * Actions the overlay hands back to its caller.
 *
 * Resolved rather than executed inside the component, because opening a
 * session or writing to the editor must happen with the command context, after
 * the overlay has closed.
 */
type OverlayAction =
	| { type: "open" | "attach" | "fork"; agent: AgentRecord }
	| { type: "copy"; agent: AgentRecord };

interface Row {
	agent: AgentRecord;
	depth: number;
	status?: StatusReport;
	alive: boolean;
}

/**
 * Rows for the overlay, ordered exactly like the widget (needs-attention
 * first). Two orderings of the same tree is how the widget and the tree came
 * to disagree in the first place.
 */
function flatten(rt: Runtime): Row[] {
	const config = rt.config();
	if (!config) return [];
	const statuses = readAllStatuses(config.team);
	const rows: Row[] = [];
	const walk = (parent: string, depth: number): void => {
		for (const agent of childrenOf(config, parent)) {
			rows.push({
				agent,
				depth,
				status: statuses[agent.name],
				alive: !agent.killedAt && isAlive(config.team, agent.name),
			});
			walk(agent.name, depth + 1);
		}
	};
	walk(config.leadName, 0);
	return rows;
}

/**
 * Interactive tree. Kept intentionally small: navigate, focus a pane, peek at
 * output, kill. Anything more complex belongs in a tool call the model can see.
 */
class AgentTreeOverlay implements Component {
	private rows: Row[];
	private selected = 0;
	private peek: string[] = [];
	private rt: Runtime;
	private theme: Theme;
	private requestRender: () => void;
	private done: (value: OverlayAction | null) => void;

	constructor(
		rt: Runtime,
		theme: Theme,
		requestRender: () => void,
		done: (value: OverlayAction | null) => void,
	) {
		this.rt = rt;
		this.theme = theme;
		this.requestRender = requestRender;
		this.done = done;
		this.rows = flatten(rt);
	}

	invalidate(): void {}

	private refresh(): void {
		this.rows = flatten(this.rt);
		if (this.selected >= this.rows.length) this.selected = Math.max(0, this.rows.length - 1);
	}

	/** Called on a timer so the tree stays live while the overlay is open. */
	tick(): void {
		this.refresh();
	}

	handleInput(data: string): void {
		const row = this.rows[this.selected];
		if (matchesKey(data, Key.up) || data === "k") {
			this.selected = Math.max(0, this.selected - 1);
			this.peek = [];
		} else if (matchesKey(data, Key.down) || data === "j") {
			this.selected = Math.min(this.rows.length - 1, this.selected + 1);
			this.peek = [];
		} else if (matchesKey(data, Key.enter)) {
			if (row) {
				const ok = focusPane(row.agent.paneId);
				this.peek = ok
					? [`focused ${row.agent.name}`]
					: [
							`${row.agent.name} has no visible pane (headless).`,
							"d = peek at its output, o = open its session in a pane.",
						];
			}
		} else if (data === "o" || data === "c" || data === "f" || data === "y") {
			// The resume machinery used to be reachable only as a model tool call,
			// which made a headless agent's transcript invisible from here.
			if (row) {
				const type =
					data === "o" ? "open" : data === "c" ? "attach" : data === "f" ? "fork" : "copy";
				this.done({ type, agent: row.agent } as OverlayAction);
				return;
			}
		} else if (data === "d") {
			if (row && this.rt.team) {
				const activity = row.agent.visible ? null : readActivity(this.rt.team, row.agent.name, 12);
				this.peek =
					activity && !activity.raw && activity.lines.length > 0
						? activity.lines
						: capturePane(this.rt.team, row.agent.name, row.agent.paneId, 12).trimEnd().split("\n");
			}
		} else if (data === "x") {
			if (row && this.rt.team) {
				killAgent(this.rt.team, row.agent.name, row.agent.paneId);
				patchAgent(this.rt.team, row.agent.name, { killedAt: new Date().toISOString() });
				writeStatus(this.rt.team, {
					agent: row.agent.name,
					state: "killed",
					note: "killed from /agents",
				});
				this.refresh();
				this.peek = [`killed ${row.agent.name}`];
			}
		} else if (data === "R") {
			// Recycle finished agents out of the tree from the overlay.
			if (this.rt.team) {
				const result = reapTeam(this.rt.team, { all: true });
				this.refresh();
				this.peek =
					result.reaped.length > 0
						? [`reaped ${result.reaped.length}: ${result.reaped.join(", ")}`, `archive: ${result.archive}`]
						: ["nothing to reap — all agents are live or unfinished"];
			}
		} else if (data === "r") {
			this.refresh();
			this.peek = [];
		} else if (matchesKey(data, Key.escape) || data === "q") {
			this.done(null);
			return;
		}
		this.requestRender();
	}

	render(width: number): string[] {
		const t = this.theme;
		const lines: string[] = [t.fg("accent", "Agents")];
		if (this.rows.length === 0) {
			lines.push(t.fg("dim", "no agents — use team_spawn"));
		}
		this.rows.forEach((row, index) => {
			const state = displayState(row.agent, row.status);
			const marker = index === this.selected ? "›" : " ";
			const doing =
				row.alive && !row.agent.visible && this.rt.team
					? activityLabel(readActivity(this.rt.team, row.agent.name, 1))
					: "";
			const body =
				`${marker} ${"  ".repeat(row.depth)}${STATE_ICON[state] ?? "?"} ${row.agent.name} ` +
				t.fg(
					"dim",
					`${row.agent.role}${row.agent.visible ? "" : " headless"}${row.alive ? "" : " exited"}` +
						(doing ? `  ${doing}` : ""),
				);
			lines.push(truncateToWidth(index === this.selected ? t.fg("accent", body) : body, width));
		});
		if (this.peek.length > 0) {
			lines.push(t.fg("dim", "─".repeat(Math.min(width, 40))));
			for (const line of this.peek.slice(-12)) lines.push(truncateToWidth(t.fg("dim", line), width));
		}
		lines.push(
			t.fg(
				"dim",
				truncateToWidth(
					"↑↓ move  ⏎ focus  o open  c continue-as  f fork  y copy cmd  d peek  x kill  q close",
					width,
				),
			),
		);
		return lines;
	}
}

export async function openAgentsOverlay(rt: Runtime, ctx: ExtensionCommandContext): Promise<void> {
	if (!rt.config()) {
		ctx.ui.notify("No team is running.", "info");
		return;
	}
	let ticker: ReturnType<typeof setInterval> | null = null;
	const action = await ctx.ui.custom<OverlayAction | null>((tui, theme, _keybindings, done) => {
		const overlay = new AgentTreeOverlay(rt, theme, () => tui.requestRender(), done);
		// Live view: agents change state while the overlay is open.
		ticker = setInterval(() => {
			overlay.tick();
			tui.requestRender();
		}, 2000);
		ticker.unref?.();
		return overlay;
	}, { overlay: true, overlayOptions: { anchor: "top-right", width: "45%", margin: 1 } });
	if (ticker) clearInterval(ticker);
	if (action) await runOverlayAction(rt, action, ctx);
}

async function runOverlayAction(
	rt: Runtime,
	action: OverlayAction,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const team = rt.team;
	if (!team) return;
	if (action.type === "copy") {
		const check = checkResumable(team, action.agent, "inspect");
		if (!check.ok) {
			ctx.ui.notify(check.reason as string, "warning");
			return;
		}
		const argv = buildResumeArgv({
			originalArgv: action.agent.argv ?? [process.env.PI_ORCH_PI_BIN ?? "pi"],
			sessionId: check.sessionId as string,
			mode: "inspect",
		});
		ctx.ui.setEditorText(`cd ${action.agent.cwd} && ${quoteArgv(argv)}`);
		ctx.ui.notify(`Resume command for ${action.agent.name} placed in the editor.`, "info");
		return;
	}
	const mode = action.type === "open" ? "inspect" : action.type === "attach" ? "attach" : "fork";
	const result = openAgentSession(rt, action.agent.name, mode);
	ctx.ui.notify(result.message, result.ok ? "info" : "warning");
}

/**
 * Poll-driven widget above the editor, rooted at this session's own agent:
 * its direct children, each with a rolled-up tally of its subtree. Hidden
 * while the subtree is empty.
 */
export function startStatusWidget(
	rt: Runtime,
	ui: Pick<ExtensionContext["ui"], "setWidget" | "setStatus">,
	pendingMail?: () => number,
): () => void {
	const tick = (): void => {
		const config = rt.config();
		if (!config || config.agents.length === 0) {
			ui.setWidget("agent-orchestrator", undefined);
			ui.setStatus("agent-orchestrator", undefined);
			return;
		}

		// Recycle finished agents out of the tree before rendering, so the
		// widget shows the current run rather than a graveyard. The lead owns
		// housekeeping; sub-orchestrators only read.
		if (rt.isLead) {
			try {
				reapTeam(config.team, { olderThanMs: reapRetentionMs(), maxAgents: maxTrackedAgents() });
			} catch {
				// Reaping is housekeeping: never let it break the display.
			}
		}

		const current = rt.config();
		const root = rt.isLead ? current?.leadName : rt.me;
		const statuses = current ? readAllStatuses(current.team) : {};
		const views =
			current && root ? buildViews(current, statuses, (name) => isAlive(current.team, name), root) : [];
		const asks = current && root ? visibleAsks(current.team, rt.me).map((ask) => askLine(ask)) : [];
		if (!current || (views.length === 0 && asks.length === 0)) {
			ui.setWidget("agent-orchestrator", undefined);
			ui.setStatus("agent-orchestrator", undefined);
			return;
		}
		const counts = countStates(views);

		// Function form: pi hands us the real width, so rows are clipped
		// instead of wrapping and silently doubling the widget's height.
		ui.setWidget("agent-orchestrator", (_tui, theme) => ({
			invalidate() {},
			render(width: number): string[] {
				const waiting = pendingMail?.() ?? 0;
				const title = rt.isLead ? current.team : `${rt.me} (${current.team})`;
				const lines = widgetLines({
					teamName: waiting > 0 ? `${title}  ✉ ${waiting} held` : title,
					overlayHint: rt.isLead,
					views,
					width,
					maxRows: widgetRows(),
					asks,
					activity: (view) =>
						view.alive && !view.agent.visible
							? activityLabel(readActivity(current.team, view.agent.name, 1))
							: "",
				});
				return lines.map((line, index) =>
					index === 0 ? theme.fg("accent", line) : theme.fg("dim", line),
				);
			},
		}));
		ui.setStatus("agent-orchestrator", `agents ${countsLine(counts)}`);
	};
	const timer = setInterval(tick, 3000);
	timer.unref?.();
	tick();
	return () => {
		clearInterval(timer);
		ui.setWidget("agent-orchestrator", undefined);
		ui.setStatus("agent-orchestrator", undefined);
	};
}

