/**
 * Turning a headless agent's log into "what is it doing right now".
 *
 * Headless agents run `pi --mode json`, so their log is a JSONL event stream.
 * Print mode would only ever emit the final answer, which makes a running
 * worker look identical to a hung one. Parsing the stream gives live tool
 * activity, token spend, and a completion signal for free.
 *
 * Anything that is not valid JSONL (an interactive pane's log, a crash dump,
 * a stack trace) falls back to a raw tail, so this never hides an error.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { logPath } from "./state.ts";

export interface Activity {
	/** Human-readable recent events, oldest first. */
	lines: string[];
	/** Tool currently executing, if any. */
	currentTool: string | null;
	toolCalls: number;
	totalTokens: number;
	costUsd: number;
	finished: boolean;
	/** True when the log was not a JSON event stream. */
	raw: boolean;
}

const EMPTY: Activity = {
	lines: [],
	currentTool: null,
	toolCalls: 0,
	totalTokens: 0,
	costUsd: 0,
	finished: false,
	raw: false,
};

function oneLine(value: unknown, max = 90): string {
	const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function summariseArgs(toolName: string, args: Record<string, unknown> | undefined): string {
	if (!args) return "";
	// Show the argument that actually says what the call does.
	for (const key of ["command", "path", "file_path", "pattern", "query", "name", "to", "url"]) {
		if (key in args) return oneLine(args[key]);
	}
	return oneLine(args);
}

/**
 * Incremental parse state per log file.
 *
 * Agent logs are JSONL event streams that reach tens of megabytes. Re-reading
 * and re-parsing the whole file on every 3-second widget tick cost ~30ms per
 * agent on a 9MB log and scales linearly — with a dozen agents that is a
 * visible stutter in the lead's UI. Each tick now parses only the bytes
 * appended since the last read.
 */
interface LogCursor {
	offset: number;
	partial: string;
	lines: string[];
	currentTool: string | null;
	toolCalls: number;
	totalTokens: number;
	costUsd: number;
	finished: boolean;
	parsedAny: boolean;
	rawLines: string[];
}

const cursors = new Map<string, LogCursor>();
const MAX_KEPT_LINES = 60;

function freshCursor(): LogCursor {
	return {
		offset: 0,
		partial: "",
		lines: [],
		currentTool: null,
		toolCalls: 0,
		totalTokens: 0,
		costUsd: 0,
		finished: false,
		parsedAny: false,
		rawLines: [],
	};
}

/** Read bytes [from, to) without pulling the whole file into memory. */
function readRange(path: string, from: number, to: number): string {
	const length = to - from;
	if (length <= 0) return "";
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.allocUnsafe(length);
		const read = readSync(fd, buffer, 0, length, from);
		return buffer.subarray(0, read).toString("utf8");
	} finally {
		closeSync(fd);
	}
}

function ingest(cursor: LogCursor, chunk: string): void {
	const text = cursor.partial + chunk;
	const rows = text.split("\n");
	// The final element is an incomplete line unless the chunk ended with \n.
	cursor.partial = rows.pop() ?? "";
	for (const row of rows) {
		if (row.trim() === "") continue;
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(row) as Record<string, unknown>;
		} catch {
			if (cursor.rawLines.length < MAX_KEPT_LINES) cursor.rawLines.push(oneLine(row, 200));
			else {
				cursor.rawLines.shift();
				cursor.rawLines.push(oneLine(row, 200));
			}
			continue;
		}
		cursor.parsedAny = true;
		const type = event.type as string;
		const push = (line: string): void => {
			cursor.lines.push(line);
			if (cursor.lines.length > MAX_KEPT_LINES) cursor.lines.shift();
		};

		if (type === "tool_execution_start") {
			const name = String(event.toolName ?? "tool");
			cursor.currentTool = name;
			cursor.toolCalls++;
			push(`▸ ${name} ${summariseArgs(name, event.args as Record<string, unknown>)}`.trimEnd());
		} else if (type === "tool_execution_end") {
			cursor.currentTool = null;
			if (event.isError) push(`  ✖ ${String(event.toolName)} failed`);
		} else if (type === "message_end") {
			const message = event.message as
				| {
						role?: string;
						content?: Array<{ type?: string; text?: string }>;
						usage?: { totalTokens?: number; cost?: { total?: number } };
				  }
				| undefined;
			if (!message || message.role !== "assistant") continue;
			if (message.usage?.totalTokens) cursor.totalTokens = message.usage.totalTokens;
			if (message.usage?.cost?.total) cursor.costUsd += message.usage.cost.total;
			const said = (message.content ?? [])
				.filter((part) => part.type === "text" && part.text?.trim())
				.map((part) => oneLine(part.text))
				.join(" ");
			if (said) push(`· ${said}`);
		} else if (type === "agent_end") {
			cursor.finished = true;
			push("■ turn finished");
		}
	}
}

export function readActivity(team: string, agent: string, maxLines = 20): Activity {
	const path = logPath(team, agent);
	if (!existsSync(path)) {
		cursors.delete(path);
		return { ...EMPTY };
	}
	let size: number;
	try {
		size = statSync(path).size;
	} catch {
		return { ...EMPTY };
	}

	let cursor = cursors.get(path);
	// A shrunken file means the log was truncated (an agent name was reused):
	// start over rather than reporting the dead predecessor's run.
	if (!cursor || size < cursor.offset) {
		cursor = freshCursor();
		cursors.set(path, cursor);
	}
	if (size > cursor.offset) {
		ingest(cursor, readRange(path, cursor.offset, size));
		cursor.offset = size;
	}
	if (size === 0) return { ...EMPTY };

	if (!cursor.parsedAny) {
		return { ...EMPTY, raw: true, lines: cursor.rawLines.slice(-maxLines) };
	}
	return {
		lines: cursor.lines.slice(-maxLines),
		currentTool: cursor.currentTool,
		toolCalls: cursor.toolCalls,
		totalTokens: cursor.totalTokens,
		costUsd: cursor.costUsd,
		finished: cursor.finished,
		raw: false,
	};
}

/** Drop cached parse state (used by tests and after a team is destroyed). */
export function resetActivityCache(): void {
	cursors.clear();
}

/** One-line "doing X" summary for the widget and the tree. */
export function activityLabel(activity: Activity): string {
	if (activity.raw) return activity.lines[activity.lines.length - 1] ?? "";
	const parts: string[] = [];
	if (activity.currentTool) parts.push(`${activity.currentTool}…`);
	else if (activity.finished) parts.push("finished");
	if (activity.toolCalls > 0) parts.push(`${activity.toolCalls} calls`);
	if (activity.costUsd > 0) parts.push(`$${activity.costUsd.toFixed(3)}`);
	return parts.join("  ");
}
