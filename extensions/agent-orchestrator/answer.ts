import { closeSync, openSync, readSync, statSync } from "node:fs";
import { normalisePath } from "./contract.ts";

export const ANSWER_MAX_LINES = 25;
export const FALLBACK_LINES = 20;
export const ANSWER_BLOCK_MAX_CHARS = 3000;
export const DELIVERABLE_READ_BYTES = 512 * 1024;

const ANSWER_HEADING = /^##\s+Answer\b/i;
const SECTION_END = /^#{1,2}\s/;

export interface AnswerExcerpt {
	path: string;
	found: boolean;
	text: string;
}

export function extractAnswer(body: string): { found: boolean; lines: string[]; more: number } {
	const lines = body.split("\n");
	const start = lines.findIndex((line) => ANSWER_HEADING.test(line));
	if (start === -1) {
		const head = lines.slice(0, FALLBACK_LINES);
		return { found: false, lines: head, more: Math.max(0, lines.length - head.length) };
	}
	let end = lines.findIndex((line, i) => i > start && SECTION_END.test(line));
	if (end === -1) end = lines.length;
	const section = lines.slice(start + 1, end);
	while (section.length > 0 && section[0]!.trim() === "") section.shift();
	while (section.length > 0 && section[section.length - 1]!.trim() === "") section.pop();
	const kept = section.slice(0, ANSWER_MAX_LINES);
	return { found: true, lines: kept, more: section.length - kept.length };
}

function readHead(path: string, maxBytes: number): string {
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.alloc(maxBytes);
		const read = readSync(fd, buffer, 0, maxBytes, 0);
		return buffer.subarray(0, read).toString("utf8");
	} finally {
		closeSync(fd);
	}
}

export function fitLines(lines: string[], maxChars: number): { text: string; clipped: boolean } {
	const kept: string[] = [];
	let used = 0;
	for (const line of lines) {
		const cost = line.length + (kept.length > 0 ? 1 : 0);
		if (used + cost <= maxChars) {
			kept.push(line);
			used += cost;
			continue;
		}
		const room = maxChars - used - (kept.length > 0 ? 1 : 0);
		if (room > 0) kept.push(line.slice(0, room));
		return { text: kept.join("\n"), clipped: true };
	}
	return { text: kept.join("\n"), clipped: false };
}

export function answerExcerpt(path: string, cwd: string, maxChars = ANSWER_BLOCK_MAX_CHARS): AnswerExcerpt {
	const full = normalisePath(path, cwd);
	let body: string;
	let partial = false;
	try {
		const stat = statSync(full);
		if (stat.isDirectory()) return { path: full, found: false, text: "(deliverable is a directory; no answer extracted)" };
		partial = stat.size > DELIVERABLE_READ_BYTES;
		body = readHead(full, DELIVERABLE_READ_BYTES);
	} catch {
		return { path: full, found: false, text: "(deliverable unreadable; no answer extracted)" };
	}
	const { found, lines, more } = extractAnswer(body);
	const notice = (clipped: boolean): string[] => {
		if (!found) {
			const rest = more > 0 ? `, ${more} more in the file` : partial ? ", more in the file" : "";
			return [`(no '## Answer' section; first ${FALLBACK_LINES} lines shown${clipped ? `, cut at ${maxChars} chars` : ""}${rest})`];
		}
		if (clipped) return [`… (Answer cut at ${maxChars} chars; read ${full} for the rest)`];
		return more > 0 ? [`… (${more} more line(s) in the Answer section; read ${full} for the rest)`] : [];
	};
	const room = Math.max(0, maxChars - Math.max(...[notice(true), notice(false)].map((n) => n.join("\n").length)) - 1);
	const fitted = fitLines(lines, room);
	const tail = notice(fitted.clipped);
	return { path: full, found, text: [fitted.text, ...tail].filter((part, i) => i > 0 || part !== "").join("\n") };
}

export function answerBlock(name: string, path: string, cwd: string, maxChars = ANSWER_BLOCK_MAX_CHARS): string {
	const header = `### ${name}: ${normalisePath(path, cwd)}`;
	const excerpt = answerExcerpt(path, cwd, Math.max(200, maxChars - header.length - 2));
	return [header, "", excerpt.text].join("\n");
}
