/**
 * Picker labels that survive a narrow terminal.
 *
 * Session names are long ("🔧 resolve skill collisions and YAML error ⑂ yji0")
 * and the part that tells two of them apart — the fork marker and the id — sits
 * at the end, exactly where a plain `slice()` cuts. So the distinguishing parts
 * are pulled out and placed first, and only the free-text middle is shortened.
 */

const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;
const ZERO = /[\u200B-\u200F\u20D0-\u20FF\uFE00-\uFE0F]/u;

/** Terminal columns a string occupies (CJK and emoji count as two). */
export function displayWidth(text: string): number {
	let width = 0;
	for (const ch of text) width += ZERO.test(ch) ? 0 : WIDE.test(ch) ? 2 : 1;
	return width;
}

/** Shorten to `max` columns, ending in `…` when anything was cut. */
export function truncate(text: string, max: number): string {
	if (max <= 0) return "";
	if (displayWidth(text) <= max) return text;
	let out = "";
	let width = 0;
	for (const ch of text) {
		const w = ZERO.test(ch) ? 0 : WIDE.test(ch) ? 2 : 1;
		if (width + w > max - 1) break;
		out += ch;
		width += w;
	}
	return `${out.trimEnd()}…`;
}

export interface NameParts {
	name: string;
	/** Fork id from a trailing `⑂ abcd`, or undefined when not a fork. */
	fork?: string;
}

export function splitName(alias: string): NameParts {
	const match = alias.match(/^(.*?)\s*⑂\s*(\S+)\s*$/u);
	if (!match) return { name: alias.trim() };
	return { name: match[1]!.trim(), fork: match[2] };
}

export interface RowInput {
	state: string;
	alias: string;
	/** Short id shown for individual sessions, so same-named ones can be told apart. */
	id?: string;
	/** Count of sessions behind a folder row. */
	count?: number;
	/** Trailing context (path, queued count), dropped first when space runs out. */
	detail?: string;
}

/**
 * One picker row fitted to `columns`: state, fork marker, id and count are
 * never cut; the name gets what is left; the detail only if room remains.
 */
export function formatRow(row: RowInput, columns: number): string {
	const { name, fork } = splitName(row.alias);
	const fixed = [
		row.state,
		fork ? `⑂${fork}` : "",
		row.id ?? "",
		row.count && row.count > 1 ? `×${row.count}` : "",
	].filter(Boolean);
	const fixedText = fixed.join(" ");
	const budget = Math.max(12, columns);
	const nameRoom = budget - displayWidth(fixedText) - 2;
	const nameText = truncate(name, Math.max(8, nameRoom));
	let line = `${fixed[0]} ${nameText}${fixed.length > 1 ? `  ${fixed.slice(1).join(" ")}` : ""}`;
	if (row.detail) {
		const room = budget - displayWidth(line) - 2;
		if (room >= 10) line += `  ${truncate(row.detail, room)}`;
	}
	return line;
}
