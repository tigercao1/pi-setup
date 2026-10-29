import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";

export interface CapSettings {
	enabled: boolean;
	thresholdBytes: number;
	errorThresholdBytes: number;
	headLines: number;
	tailLines: number;
	maxLineChars: number;
	readRangeMaxLines: number;
	exemptTools: string[];
	secretTools: string[];
	failureMarkers: string[];
	failureContextLines: number;
	failureMaxLines: number;
	retentionDays: number;
}

export const DEFAULT_FAILURE_MARKERS = [
	"\\berror",
	"\\bfail",
	"traceback",
	"exception",
	"\\bpanic",
	"\\bfatal\\b",
	"\\bnot ok\\b",
	"exit(?:ed)?(?: with)? (?:code|status)?\\s*[1-9]",
	"non-zero exit",
];

export const DEFAULTS: CapSettings = {
	enabled: true,
	thresholdBytes: 8 * 1024,
	errorThresholdBytes: 32 * 1024,
	headLines: 40,
	tailLines: 20,
	maxLineChars: 400,
	readRangeMaxLines: 400,
	exemptTools: [],
	secretTools: [],
	failureMarkers: DEFAULT_FAILURE_MARKERS,
	failureContextLines: 2,
	failureMaxLines: 60,
	retentionDays: 7,
};

const AGENT_DIR = join(homedir(), ".pi", "agent");
const ORCH_IDENTITY = ["PI_ORCH_TEAM_NAME", "PI_ORCH_AGENT_NAME", "PI_ORCH_AGENT_ROLE", "PI_ORCH_PARENT_NAME"];

const num = (value: unknown, fallback: number): number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;

const strings = (value: unknown): string[] | undefined =>
	Array.isArray(value) ? value.filter((t): t is string => typeof t === "string") : undefined;

export function parseSettings(raw: unknown): CapSettings {
	if (raw === false) return { ...DEFAULTS, enabled: false };
	const s = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	return {
		enabled: s.enabled !== false,
		thresholdBytes: num(s.thresholdBytes, DEFAULTS.thresholdBytes),
		errorThresholdBytes: num(s.errorThresholdBytes, DEFAULTS.errorThresholdBytes),
		headLines: num(s.headLines, DEFAULTS.headLines),
		tailLines: num(s.tailLines, DEFAULTS.tailLines),
		maxLineChars: num(s.maxLineChars, DEFAULTS.maxLineChars),
		readRangeMaxLines: num(s.readRangeMaxLines, DEFAULTS.readRangeMaxLines),
		exemptTools: strings(s.exemptTools) ?? [],
		secretTools: strings(s.secretTools) ?? [],
		failureMarkers: strings(s.failureMarkers) ?? DEFAULTS.failureMarkers,
		failureContextLines: num(s.failureContextLines, DEFAULTS.failureContextLines),
		failureMaxLines: num(s.failureMaxLines, DEFAULTS.failureMaxLines),
		retentionDays: num(s.retentionDays, DEFAULTS.retentionDays),
	};
}

export function readSettings(settingsPath: string): CapSettings {
	try {
		return parseSettings((JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>).leadOutputCap);
	} catch {
		return { ...DEFAULTS };
	}
}

export function isOrchestratorWorker(env: NodeJS.ProcessEnv = process.env): boolean {
	return ORCH_IDENTITY.some((key) => Boolean(env[key]));
}

export function appliesToMode(mode: string | undefined): boolean {
	return mode === "tui" || mode === "rpc";
}

export function matchesToolList(toolName: string, list: string[]): boolean {
	return list.some((entry) => (entry.endsWith("*") ? toolName.startsWith(entry.slice(0, -1)) : toolName === entry));
}

export function failurePattern(settings: CapSettings): RegExp | undefined {
	const valid = settings.failureMarkers.filter((source) => {
		try {
			new RegExp(source);
			return true;
		} catch {
			return false;
		}
	});
	return valid.length ? new RegExp(valid.map((source) => `(?:${source})`).join("|"), "i") : undefined;
}

export function exemptReason(event: ToolResultEvent, settings: CapSettings, bytes: number, text = ""): string | null {
	if (event.parentToolCallId) return "nested";
	if (matchesToolList(event.toolName, settings.secretTools)) return "secret";
	if (matchesToolList(event.toolName, settings.exemptTools)) return "listed";
	if (event.content.some((part) => part.type === "image")) return "image";
	if (event.toolName === "read") {
		const limit = (event.input as { limit?: unknown }).limit;
		if (typeof limit === "number" && limit > 0 && limit <= settings.readRangeMaxLines) return "read-range";
	}
	if (bytes < settings.errorThresholdBytes && (event.isError || failurePattern(settings)?.test(text))) return "small-failure";
	return null;
}

const humanSize = (bytes: number): string =>
	bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;

const clip = (line: string, max: number): string =>
	max > 0 && line.length > max ? `${line.slice(0, max)}…[+${line.length - max} chars]` : line;

const safeName = (value: string): string => value.replace(/[^A-Za-z0-9._-]/g, "_") || "unknown";

export function failureRanges(
	lines: string[],
	start: number,
	end: number,
	settings: CapSettings,
): Array<[number, number]> {
	const pattern = failurePattern(settings);
	if (!pattern || end <= start || settings.failureMaxLines <= 0) return [];
	const ranges: Array<[number, number]> = [];
	let budget = settings.failureMaxLines;
	for (let i = start; i < end && budget > 0; i++) {
		if (!pattern.test(lines[i] ?? "")) continue;
		const from = Math.max(start, i - settings.failureContextLines, ranges.at(-1)?.[1] ?? start);
		const to = Math.min(end, i + settings.failureContextLines + 1, from + budget);
		if (to <= from) continue;
		const last = ranges.at(-1);
		if (last && last[1] === from) last[1] = to;
		else ranges.push([from, to]);
		budget -= to - from;
		i = to - 1;
	}
	return ranges;
}

export function summarise(
	text: string,
	settings: CapSettings,
	savedPath: string,
	extra?: { originalPath?: string },
): string {
	const bytes = Buffer.byteLength(text, "utf8");
	const lines = text.split("\n");
	const total = lines.length;
	const keepAll = total <= settings.headLines + settings.tailLines;
	const head = (keepAll ? lines : lines.slice(0, settings.headLines)).map((l) => clip(l, settings.maxLineChars));
	const tail = keepAll ? [] : lines.slice(total - settings.tailLines).map((l) => clip(l, settings.maxLineChars));
	const parts = [...head];
	const middleStart = head.length;
	const middleEnd = total - tail.length;
	let cursor = middleStart;
	for (const [from, to] of failureRanges(lines, middleStart, middleEnd, settings)) {
		if (from > cursor) parts.push(`… [${from - cursor} lines omitted] …`);
		if (cursor === middleStart) parts.push(`[lines matching failure markers, with context; line numbers are 1-based]`);
		for (let i = from; i < to; i++) parts.push(`${i + 1}: ${clip(lines[i] ?? "", settings.maxLineChars)}`);
		cursor = to;
	}
	if (middleEnd > cursor) parts.push(`… [${middleEnd - cursor} lines omitted] …`);
	parts.push(...tail);
	parts.push(
		"",
		`[lead-output-cap: output was ${humanSize(bytes)}, ${total} lines; full text saved to ${savedPath}` +
			(extra?.originalPath ? ` (untruncated tool output: ${extra.originalPath})` : "") +
			"]",
		"Read only the ranges you need (read with offset/limit, or grep the file), or delegate the digest to a worker.",
	);
	return parts.join("\n");
}

function writePrivate(path: string, text: string): void {
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, text, { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, path);
}

export function pruneOutputs(outputsDir: string, retentionDays: number, now = Date.now()): number {
	if (retentionDays <= 0) return 0;
	const cutoff = now - retentionDays * 86_400_000;
	let removed = 0;
	let sessions: string[];
	try {
		sessions = readdirSync(outputsDir);
	} catch {
		return 0;
	}
	for (const session of sessions) {
		const dir = join(outputsDir, session);
		let files: string[];
		try {
			if (!statSync(dir).isDirectory()) continue;
			files = readdirSync(dir);
		} catch {
			continue;
		}
		for (const file of files) {
			const path = join(dir, file);
			try {
				if (statSync(path).mtimeMs < cutoff) {
					unlinkSync(path);
					removed++;
				}
			} catch {}
		}
		try {
			if (readdirSync(dir).length === 0) rmdirSync(dir);
		} catch {}
	}
	return removed;
}

export function capToolResult(
	event: ToolResultEvent,
	options: { settings: CapSettings; outputsDir: string; sessionId: string },
): ToolResultEventResult | undefined {
	const { settings } = options;
	if (!settings.enabled) return undefined;
	const text = event.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	const bytes = Buffer.byteLength(text, "utf8");
	if (exemptReason(event, settings, bytes, text)) return undefined;
	const threshold = event.isError ? Math.max(settings.thresholdBytes, settings.errorThresholdBytes) : settings.thresholdBytes;
	if (bytes <= threshold) return undefined;

	const dir = join(options.outputsDir, safeName(options.sessionId));
	const savedPath = join(dir, `${safeName(event.toolCallId)}.txt`);
	const structuredPath = `${savedPath.replace(/\.txt$/, "")}.structured.json`;
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		chmodSync(options.outputsDir, 0o700);
		chmodSync(dir, 0o700);
		writePrivate(savedPath, text);
		if (event.structuredContent !== undefined) {
			writePrivate(structuredPath, `${JSON.stringify(event.structuredContent, null, 2)}\n`);
		}
	} catch {
		return undefined;
	}

	const details = event.details as { fullOutputPath?: unknown } | undefined;
	const originalPath = typeof details?.fullOutputPath === "string" ? details.fullOutputPath : undefined;
	const summary = summarise(text, settings, savedPath, { originalPath });
	const result: ToolResultEventResult = { content: [{ type: "text", text: summary }] };
	if (event.structuredContent !== undefined) {
		result.structuredContent = {
			leadOutputCap: {
				truncated: true,
				savedPath,
				structuredPath,
				bytes,
				lines: text.split("\n").length,
			},
		};
	}
	return result;
}

export function createLeadOutputCap(options: { agentDir?: string; env?: NodeJS.ProcessEnv } = {}) {
	const agentDir = options.agentDir ?? AGENT_DIR;
	const settingsPath = join(agentDir, "settings.json");
	const outputsDir = join(agentDir, "run", "outputs");
	const env = options.env ?? process.env;

	return function leadOutputCap(pi: ExtensionAPI): void {
		if (isOrchestratorWorker(env)) return;
		let settings = readSettings(settingsPath);

		pi.on("session_start", () => {
			settings = readSettings(settingsPath);
			if (settings.enabled) pruneOutputs(outputsDir, settings.retentionDays);
		});

		pi.on("tool_result", (event: ToolResultEvent, ctx: ExtensionContext) => {
			if (!appliesToMode(ctx.mode)) return undefined;
			let sessionId = "unknown";
			try {
				sessionId = ctx.sessionManager.getSessionId() || sessionId;
			} catch {
				sessionId = "unknown";
			}
			return capToolResult(event, { settings, outputsDir, sessionId });
		});
	};
}

export default createLeadOutputCap();
