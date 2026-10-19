/**
 * The `/forks` overlay: a live tree of related sessions.
 *
 * The overlay never mutates a session itself. It resolves an action and lets
 * the command handler run it, because the interesting operations
 * (`switchSession`, `ui.input`) must not happen inside a rendering component.
 */

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { capturePaneText } from "../_shared/pane.ts";
import {
	childrenOf,
	describeRecord,
	type ForkRecord,
	isRecordAlive,
	listRecords,
	tailLog,
} from "./registry.ts";

export type ForkActionType =
	| "focus"
	| "open"
	| "fork"
	| "become"
	| "message"
	| "kill"
	| "copy";

export interface ForkAction {
	type: ForkActionType;
	record: ForkRecord;
}

interface Row {
	record: ForkRecord;
	depth: number;
	alive: boolean;
}

/**
 * Flatten the registry into a tree.
 *
 * Records whose parent is missing (pruned, or forked from a session that never
 * registered) become roots rather than disappearing.
 */
function flatten(): Row[] {
	const records = listRecords();
	const byKey = new Map(records.map((r) => [r.key, r]));
	const rows: Row[] = [];
	const seen = new Set<string>();
	const walk = (record: ForkRecord, depth: number): void => {
		if (seen.has(record.key)) return; // cycle guard: a corrupt parentKey loop
		seen.add(record.key);
		rows.push({ record, depth, alive: isRecordAlive(record) });
		for (const child of childrenOf(records, record.key)) walk(child, depth + 1);
	};
	for (const record of records) {
		if (!record.parentKey || !byKey.has(record.parentKey)) walk(record, 0);
	}
	// Anything left behind a cycle still deserves a line.
	for (const record of records) if (!seen.has(record.key)) walk(record, 0);
	return rows;
}

class ForksOverlay implements Component {
	private rows: Row[] = [];
	private selected = 0;
	private peek: string[] = [];
	private theme: Theme;
	private selfKey: string | null;
	private requestRender: () => void;
	private done: (value: ForkAction | null) => void;

	constructor(
		theme: Theme,
		selfKey: string | null,
		requestRender: () => void,
		done: (value: ForkAction | null) => void,
	) {
		this.theme = theme;
		this.selfKey = selfKey;
		this.requestRender = requestRender;
		this.done = done;
		this.refresh();
		const index = this.rows.findIndex((row) => row.record.key === selfKey);
		if (index >= 0) this.selected = index;
	}

	invalidate(): void {}

	private refresh(): void {
		this.rows = flatten();
		if (this.selected >= this.rows.length) this.selected = Math.max(0, this.rows.length - 1);
	}

	/** Called on a timer so the tree stays live while the overlay is open. */
	tick(): void {
		this.refresh();
	}

	handleInput(data: string): void {
		const row = this.rows[this.selected];
		const emit = (type: ForkActionType): void => {
			if (row) this.done({ type, record: row.record });
		};
		if (matchesKey(data, Key.up) || data === "k") {
			this.selected = Math.max(0, this.selected - 1);
			this.peek = [];
		} else if (matchesKey(data, Key.down) || data === "j") {
			this.selected = Math.min(this.rows.length - 1, this.selected + 1);
			this.peek = [];
		} else if (matchesKey(data, Key.enter)) {
			emit("focus");
			return;
		} else if (data === "o") {
			emit("open");
			return;
		} else if (data === "f") {
			emit("fork");
			return;
		} else if (data === "b") {
			emit("become");
			return;
		} else if (data === "m") {
			emit("message");
			return;
		} else if (data === "y") {
			emit("copy");
			return;
		} else if (data === "x") {
			emit("kill");
			return;
		} else if (data === "d") {
			if (row) {
				const live = capturePaneText(row.record.paneId ?? null, 12);
				const text = live ?? tailLog(row.record, 12);
				this.peek = (text ?? "(no output captured — this session has no pane and no log)")
					.trimEnd()
					.split("\n");
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
		const lines: string[] = [t.fg("accent", "Sessions & forks")];
		if (this.rows.length === 0) {
			lines.push(t.fg("dim", "no sessions registered yet — use /fork-pane"));
		}
		this.rows.forEach((row, index) => {
			const r = row.record;
			const icon = row.alive ? "●" : r.sessionId ? "○" : "✖";
			const marker = index === this.selected ? "›" : " ";
			const you = r.key === this.selfKey ? " (you)" : "";
			const meta = [
				r.parentKey ? "⑂" : "",
				r.label ?? "",
				r.sessionId ? r.sessionId.slice(0, 8) : "no session",
				row.alive ? "" : "exited",
			]
				.filter(Boolean)
				.join("  ");
			const body = `${marker} ${"  ".repeat(row.depth)}${icon} ${describeRecord(r)}${you} ${t.fg("dim", meta)}`;
			lines.push(truncateToWidth(index === this.selected ? t.fg("accent", body) : body, width));
		});
		if (this.peek.length > 0) {
			lines.push(t.fg("dim", "─".repeat(Math.min(width, 40))));
			for (const line of this.peek.slice(-12)) {
				lines.push(truncateToWidth(t.fg("dim", line), width));
			}
		}
		lines.push(
			t.fg(
				"dim",
				truncateToWidth(
					"↑↓ move  ⏎ focus  o open  f fork  b become  m message  y copy cmd  d peek  x kill  q close",
					width,
				),
			),
		);
		return lines;
	}
}

export async function openForksOverlay(
	ctx: ExtensionCommandContext,
	selfKey: string | null,
): Promise<ForkAction | null> {
	let ticker: ReturnType<typeof setInterval> | null = null;
	const action = await ctx.ui.custom<ForkAction | null>(
		(tui, theme, _keybindings, done) => {
			const overlay = new ForksOverlay(theme, selfKey, () => tui.requestRender(), done);
			ticker = setInterval(() => {
				overlay.tick();
				tui.requestRender();
			}, 2000);
			ticker.unref?.();
			return overlay;
		},
		{ overlay: true, overlayOptions: { anchor: "top-right", width: "55%", margin: 1 } },
	);
	if (ticker) clearInterval(ticker);
	return action ?? null;
}
