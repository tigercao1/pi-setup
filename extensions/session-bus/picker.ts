/**
 * A fixed-height, scrolling, type-to-filter picker.
 *
 * `ctx.ui.select` prints every option, so a machine with forty sessions
 * pushes the prompt off screen. This shows a window of rows that scrolls with
 * the cursor, and narrows as you type.
 */

import { decodeKittyPrintable, Key, matchesKey } from "@earendil-works/pi-tui";
import { formatRow, type RowInput } from "./labels.ts";

export interface PickerRow extends RowInput {
	/** Extra text matched by the filter but not shown (full path, full id). */
	search?: string;
}

export interface PickerTheme {
	accent: (text: string) => string;
	muted: (text: string) => string;
	dim: (text: string) => string;
}

const plain: PickerTheme = { accent: (t) => t, muted: (t) => t, dim: (t) => t };

export function visibleRows(total: number, terminalRows: number | undefined): number {
	const room = (terminalRows ?? 24) - 12;
	return Math.max(3, Math.min(total, 12, room));
}

export function matches(row: PickerRow, query: string): boolean {
	const needle = query.trim().toLowerCase();
	if (needle === "") return true;
	const hay = [row.alias, row.id, row.detail, row.search].filter(Boolean).join(" ").toLowerCase();
	return needle.split(/\s+/).every((word) => hay.includes(word));
}

/** Window start that keeps `selected` in view, scrolling one row at a time. */
export function windowStart(selected: number, previousStart: number, height: number, total: number): number {
	let start = previousStart;
	if (selected < start) start = selected;
	if (selected >= start + height) start = selected - height + 1;
	return Math.max(0, Math.min(start, Math.max(0, total - height)));
}

export class Picker {
	private query = "";
	private selected = 0;
	private start = 0;
	private filtered: number[];
	private readonly title: string;
	private readonly rows: PickerRow[];
	private readonly onDone: (index: number | undefined) => void;
	private readonly theme: PickerTheme;
	private readonly terminalRows: () => number | undefined;

	constructor(
		title: string,
		rows: PickerRow[],
		onDone: (index: number | undefined) => void,
		theme: PickerTheme = plain,
		terminalRows: () => number | undefined = () => process.stdout.rows,
	) {
		this.title = title;
		this.rows = rows;
		this.onDone = onDone;
		this.theme = theme;
		this.terminalRows = terminalRows;
		this.filtered = rows.map((_, i) => i);
	}

	private refilter(): void {
		this.filtered = this.rows.flatMap((row, i) => (matches(row, this.query) ? [i] : []));
		this.selected = 0;
		this.start = 0;
	}

	private move(delta: number): void {
		if (this.filtered.length === 0) return;
		this.selected = Math.max(0, Math.min(this.filtered.length - 1, this.selected + delta));
	}

	handleInput(data: string): void {
		const height = visibleRows(this.filtered.length, this.terminalRows());
		if (matchesKey(data, Key.up)) this.move(-1);
		else if (matchesKey(data, Key.down)) this.move(1);
		else if (matchesKey(data, Key.pageUp)) this.move(-height);
		else if (matchesKey(data, Key.pageDown)) this.move(height);
		else if (matchesKey(data, Key.home)) this.move(-this.filtered.length);
		else if (matchesKey(data, Key.end)) this.move(this.filtered.length);
		else if (matchesKey(data, Key.enter)) this.onDone(this.filtered[this.selected]);
		else if (matchesKey(data, Key.escape) || data === "\u0003") {
			if (this.query !== "") {
				this.query = "";
				this.refilter();
			} else this.onDone(undefined);
		} else if (matchesKey(data, Key.backspace)) {
			this.query = [...this.query].slice(0, -1).join("");
			this.refilter();
		} else {
			const printable = decodeKittyPrintable(data) ?? (data.length === 1 && data >= " " ? data : undefined);
			if (printable) {
				this.query += printable;
				this.refilter();
			}
		}
	}

	render(width: number): string[] {
		const height = visibleRows(this.filtered.length, this.terminalRows());
		this.start = windowStart(this.selected, this.start, height, this.filtered.length);
		const lines = [this.theme.accent(this.title), ""];
		lines.push(
			this.query === ""
				? this.theme.dim("  type to filter")
				: `  ${this.theme.accent("filter:")} ${this.query}`,
		);
		if (this.filtered.length === 0) {
			lines.push(this.theme.muted("  no matches — backspace to widen"));
		}
		for (let i = this.start; i < Math.min(this.filtered.length, this.start + height); i++) {
			const row = this.rows[this.filtered[i]!]!;
			const text = formatRow(row, Math.max(20, width - 4));
			lines.push(i === this.selected ? this.theme.accent(`→ ${text}`) : `  ${text}`);
		}
		const above = this.start;
		const below = Math.max(0, this.filtered.length - this.start - height);
		lines.push(
			this.theme.dim(
				`  ${this.filtered.length === 0 ? 0 : this.selected + 1}/${this.filtered.length}` +
					(above > 0 ? `  ↑${above} more` : "") +
					(below > 0 ? `  ↓${below} more` : ""),
			),
		);
		lines.push("", this.theme.dim("↑↓ move  pgup/pgdn page  type filter  enter select  esc clear/cancel"));
		return lines;
	}

	invalidate(): void {}
}
