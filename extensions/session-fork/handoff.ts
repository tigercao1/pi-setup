/**
 * Handoff: start a brand-new session from a summary of this one.
 *
 * A fork copies the whole transcript. A handoff does the opposite: it asks
 * the current model to distil what matters, lets the human add their own
 * instructions on top, and seeds a fresh session with only that document.
 * The successor starts with a small context and a clear brief, the way a
 * manager hands work to someone new.
 *
 * Kept free of pane and registry concerns so the smoke test can exercise the
 * pure parts without a model.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir } from "../_shared/fsjson.ts";

export const HANDOFF_SYSTEM_PROMPT = `You are writing a handoff brief. A brand-new agent session will start from this brief alone; it will not see the conversation.

Write it for a capable colleague who has zero context. Include, in this order:

## Goal
What the user is ultimately trying to achieve, in one or two sentences.

## State of play
What is done and verified, what is in progress, and what is blocked. Be concrete: PR numbers, commit SHAs, environments, counts, dates.

## Decisions and constraints
Decisions the user made and rules they set (things to do, things never to do). These matter most: a successor that repeats a rejected approach wastes the user's time.

## Gotchas
Traps found the hard way: wrong assumptions that were corrected, commands that misbehave, data that is not what it looks like.

## Files and references
Absolute paths, URLs, PRs and tickets the successor should open first, each with a few words on why.

## Open threads
Anything unfinished the successor may need to pick up.

Rules: state facts, not narrative. No "we discussed" or "the assistant then". Never invent a path or number. If something is uncertain, say so. Leave out greetings and preamble. Output only the brief.`;

interface EntryLike {
	type?: string;
	id?: string;
	message?: unknown;
	summary?: string;
	tokensBefore?: number;
	timestamp?: string | number;
	firstKeptEntryId?: string;
}

/**
 * Messages on the active branch, honouring the last compaction: the summary
 * stands in for everything before its first kept entry.
 */
export function collectHandoffMessages(branch: EntryLike[]): unknown[] {
	const toMessage = (entry: EntryLike): unknown => {
		if (entry.type === "message") return entry.message;
		if (entry.type === "compaction") {
			return {
				role: "compactionSummary",
				summary: entry.summary,
				tokensBefore: entry.tokensBefore,
				timestamp: new Date(entry.timestamp ?? Date.now()).getTime(),
			};
		}
		return undefined;
	};
	let compactionIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i]?.type === "compaction") {
			compactionIndex = i;
			break;
		}
	}
	if (compactionIndex < 0) return branch.map(toMessage).filter((m) => m !== undefined);
	const compaction = branch[compactionIndex] as EntryLike;
	const firstKept = branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
	const kept = [
		compaction,
		...(firstKept >= 0 ? branch.slice(firstKept, compactionIndex) : []),
		...branch.slice(compactionIndex + 1),
	];
	return kept.map(toMessage).filter((m) => m !== undefined);
}

/** The document the successor receives: generated summary plus the human's additions. */
export function composeHandoff(options: {
	summary: string;
	extra: string;
	parentName: string;
	parentSessionId?: string;
}): string {
	const extra = options.extra.trim();
	return [
		`# Handoff from ${options.parentName}${options.parentSessionId ? ` (session ${options.parentSessionId.slice(0, 8)})` : ""}`,
		"",
		"You are a new session taking over this work. The previous session is still open and does not see this one. " +
			"Treat the instructions under “From the user” as the task; the rest is background.",
		"",
		options.summary.trim(),
		"",
		"## From the user",
		"",
		extra.length > 0 ? extra : "(no extra instructions — continue the open threads above)",
		"",
		"---",
		"To report back to the previous session, run `/fork-back <summary>`. `/forks` lists related sessions.",
	].join("\n");
}

export function handoffDir(root: string): string {
	return join(root, "handoffs");
}

export function writeHandoffFile(root: string, key: string, document: string): string {
	const dir = handoffDir(root);
	ensureDir(dir);
	const file = join(dir, `${key}.md`);
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, document, { mode: 0o600 });
	renameSync(tmp, file);
	return file;
}

export function readHandoffFile(file: string | undefined): string | null {
	if (!file || !existsSync(file)) return null;
	const text = readFileSync(file, "utf8");
	return text.trim().length > 0 ? text : null;
}
