/**
 * What an extension is, without running it.
 *
 * The list has to describe extensions that are currently DISABLED, so nothing
 * here may import or execute the target. Everything is read statically from
 * the entry file (its header comment and its register* calls) and, as a
 * fallback, from a sibling README.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ExtensionDoc {
	/** One line: what it is. */
	summary: string;
	/** A few lines of detail, already split into paragraphs. */
	detail: string[];
	commands: string[];
	tools: string[];
	shortcuts: string[];
}

const cache = new Map<string, { mtimeMs: number; doc: ExtensionDoc }>();
const EMPTY: ExtensionDoc = { summary: "", detail: [], commands: [], tools: [], shortcuts: [] };

/** Leading `/** … *\/` block, or a run of `//` lines, at the top of the file. */
function headerComment(source: string): string[] {
	const head = source.slice(0, 8000);
	const block = head.match(/^\s*\/\*\*?([\s\S]*?)\*\//);
	if (block) {
		return (block[1] ?? "")
			.split("\n")
			.map((line) => line.replace(/^\s*\*ical?\s?/, "").replace(/^\s*\*\s?/, "").trimEnd());
	}
	const lines: string[] = [];
	for (const line of head.split("\n")) {
		const match = line.match(/^\s*\/\/\s?(.*)$/);
		if (match) lines.push((match[1] ?? "").trimEnd());
		else if (lines.length > 0) break;
		else if (line.trim() !== "") break;
	}
	return lines;
}

/** `summary:` from README frontmatter, else its first real paragraph. */
function readmeSummary(entryPath: string): { summary: string; detail: string[] } {
	for (const candidate of [
		join(dirname(entryPath), "README.md"),
		join(dirname(entryPath), "..", "README.md"),
	]) {
		if (!existsSync(candidate)) continue;
		let text: string;
		try {
			text = readFileSync(candidate, "utf8").slice(0, 8000);
		} catch {
			continue;
		}
		const front = text.match(/^---\n([\s\S]*?)\n---/);
		const summaryLine = front?.[1]?.match(/^summary:\s*(.+)$/m)?.[1]?.trim();
		const body = front ? text.slice(front[0].length) : text;
		const paragraphs = body
			.split("\n\n")
			.map((p) => p.trim())
			.filter((p) => p !== "" && !p.startsWith("#") && !p.startsWith("```") && !p.startsWith("|"));
		return {
			summary: summaryLine ?? paragraphs[0]?.replace(/\n/g, " ") ?? "",
			detail: paragraphs.slice(summaryLine ? 0 : 1, summaryLine ? 2 : 3).map((p) => p.replace(/\n/g, " ")),
		};
	}
	return { summary: "", detail: [] };
}

function unique(values: string[]): string[] {
	return [...new Set(values)].sort();
}

function scanRegistrations(source: string): Pick<ExtensionDoc, "commands" | "tools" | "shortcuts"> {
	const commands = [...source.matchAll(/registerCommand\(\s*["'`]([\w:.-]+)/g)].map((m) => m[1] as string);
	const shortcuts = [...source.matchAll(/registerShortcut\(\s*["'`]([^"'`]+)/g)].map((m) => m[1] as string);
	// `name:` is the first field in practice, but allow a little slack for
	// comments or a label line before it.
	const tools = [...source.matchAll(/registerTool\(\s*\{[\s\S]{0,300}?name:\s*["'`]([\w:.-]+)/g)].map(
		(m) => m[1] as string,
	);
	return { commands: unique(commands), tools: unique(tools), shortcuts: unique(shortcuts) };
}

export function describeExtension(entryPath: string): ExtensionDoc {
	let mtimeMs = 0;
	try {
		mtimeMs = statSync(entryPath).mtimeMs;
	} catch {
		return { ...EMPTY };
	}
	const cached = cache.get(entryPath);
	if (cached && cached.mtimeMs === mtimeMs) return cached.doc;

	let source = "";
	try {
		source = readFileSync(entryPath, "utf8").slice(0, 200_000);
	} catch {
		return { ...EMPTY };
	}

	const header = headerComment(source);
	// First non-empty line is the "name — what it is" line.
	const first = header.find((line) => line.trim() !== "") ?? "";
	// Following lines up to the first blank line are the opening paragraph.
	const startIndex = header.indexOf(first);
	const paragraph: string[] = [];
	for (const line of header.slice(startIndex + 1)) {
		if (line.trim() === "") {
			if (paragraph.length > 0) break;
			continue;
		}
		paragraph.push(line.trim());
	}

	const fromReadme = readmeSummary(entryPath);
	// Summary is the first SENTENCE of the opening paragraph, not the first
	// line: header comments wrap mid-sentence, which produced summaries that
	// ended on "and hand".
	const opening = [first, ...paragraph].join(" ").replace(/^[\w@/-]+\s+[—-]\s+/, "").trim();
	const sentenceEnd = opening.search(/[.!?](\s|$)/);
	const firstSentence = sentenceEnd === -1 ? opening : opening.slice(0, sentenceEnd + 1);
	const summary = (firstSentence || fromReadme.summary).trim();
	const rest = opening.slice(summary.length).trim();
	const detail = rest !== "" ? [rest] : fromReadme.detail;

	const registrations = scanRegistrations(source);
	const inferred =
		registrations.tools.length > 0 || registrations.commands.length > 0
			? `No description. Provides ${[
					...registrations.commands.map((c) => `/${c}`),
					...registrations.tools,
				]
					.slice(0, 4)
					.join(", ")}.`
			: "No description available.";

	const doc: ExtensionDoc = {
		summary: summary || fromReadme.summary || inferred,
		detail: detail.filter(Boolean).slice(0, 2),
		...registrations,
	};
	cache.set(entryPath, { mtimeMs, doc });
	return doc;
}

/** Hard-wrap plain text (no ANSI) to `width` columns. */
export function wrap(text: string, width: number): string[] {
	if (width <= 0) return [];
	const words = text.split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		if (current === "") current = word;
		else if (current.length + 1 + word.length <= width) current += ` ${word}`;
		else {
			lines.push(current);
			current = word;
		}
	}
	if (current !== "") lines.push(current);
	return lines;
}
