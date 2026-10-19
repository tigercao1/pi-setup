/**
 * The verifier node: adversarial, majority-vote verification of a single finding.
 *
 *   INPUT    one finding — never the worker's chat, reasoning, or confidence
 *   CONTEXT  fresh and empty; each skeptic is a new process with no skills, no
 *            extensions, no context files, and no team identity
 *   CHECKS   three skeptics in parallel, each asking a different question
 *   PASS     kept only if a majority (2 of 3) let it live
 *
 * Why three separate processes rather than one agent asking itself three
 * questions: a single context lets the first judgement anchor the other two.
 * Independent processes cannot see each other's verdicts, so agreement is
 * evidence rather than momentum.
 *
 * Why the finding only: a worker's own narrative is the most persuasive and
 * least reliable input to a review. Today a worker asserted "all 20 symbols
 * fetched, no nulls" while its own data showed seven nulls — a reviewer given
 * that sentence starts from the wrong prior.
 */

import { spawn } from "node:child_process";
import { EXT_DIR } from "./config.ts";

export type SkepticKind = "correct" | "current" | "source";

export interface Verdict {
	kind: SkepticKind;
	verdict: "pass" | "fail";
	reason: string;
	/** True when the skeptic failed to run or produced unparseable output. */
	inconclusive: boolean;
	raw?: string;
}

export interface VerificationResult {
	passed: boolean;
	verdicts: Verdict[];
	passCount: number;
	failCount: number;
	/** Skeptics that produced no usable verdict (crash, timeout, rambling). */
	inconclusiveCount: number;
	/**
	 * True when the finding failed only because skeptics could not reach a
	 * verdict. "Not verified" is NOT "disproved", and reporting the two the
	 * same way silently buries true findings — observed: a real bug was
	 * relayed upward as "rejected" when all three skeptics simply timed out.
	 */
	unverified: boolean;
}

const QUESTIONS: Record<SkepticKind, string> = {
	correct:
		"IS IT CORRECT? Does the claim actually hold up? Re-derive it from primary evidence. " +
		"Check arithmetic, units, direction of change, logic, and whether the stated conclusion " +
		"follows from the stated evidence. A claim that is merely plausible is not verified.",
	current:
		"IS IT CURRENT? Is the evidence recent and still true, or stale? Check dates, versions, " +
		"and whether the claim describes a state that has since changed. Anything undated is " +
		"suspect: say so. If the claim depends on 'today', establish today's actual date first " +
		"(run `date`) rather than assuming.",
	source:
		"IS THE SOURCE REAL? Does each cited source exist and actually say what it is cited for? " +
		"Resolve every citation: read the file at that path and line, or fetch the URL with " +
		"`curl -sL`. A source that exists but does not support the claim is a FAIL, as is a " +
		"citation you cannot resolve at all. Quote the text you found.",
};

/** Deliberately hostile framing: the default answer is FAIL. */
export function buildSkepticPrompt(options: {
	kind: SkepticKind;
	finding: string;
	sources?: string[];
	context?: string;
}): string {
	return [
		"You are a hostile verifier. You did NOT do the work you are judging and you cannot see the",
		"reasoning behind it. You have one job: try to DISPROVE the finding below.",
		"",
		"Your default answer is FAIL. A finding passes only if you actively establish that it holds.",
		"Absence of evidence against it is NOT evidence for it. Do not be charitable, do not fill in",
		"gaps on the author's behalf, and do not be swayed by confident phrasing.",
		"",
		`## Your question\n${QUESTIONS[options.kind]}`,
		"",
		`## The finding\n${options.finding}`,
		options.sources?.length ? `\n## Cited sources\n${options.sources.map((s) => `- ${s}`).join("\n")}` : "",
		options.context ? `\n## Neutral context (facts only, not the author's argument)\n${options.context}` : "",
		"",
		"## Method",
		"Use bash to verify: read files, grep, run `date`, `curl -sL` a URL, recompute numbers.",
		"Investigate before judging; do not answer from memory or plausibility.",
		"",
		"## Output",
		"Your FINAL message must be exactly one line of JSON and nothing else:",
		'{"verdict":"pass"|"fail","reason":"<= 240 chars, cite what you actually checked"}',
		"Use \"fail\" if you could not verify it, if a source does not resolve, or if the claim is",
		"only partly true. Say which part failed.",
	]
		.filter(Boolean)
		.join("\n");
}

/** Last JSON object in the output wins: pi prints the final message last. */
export function parseVerdict(kind: SkepticKind, raw: string): Verdict {
	const cleaned = raw.replace(/\x1b\][^\x07]*\x07|\x1b\[[0-9;?]*[A-Za-z]/g, "");
	const matches = cleaned.match(/\{[^{}]*"verdict"\s*:\s*"(?:pass|fail)"[^{}]*\}/gi);
	const candidate = matches?.[matches.length - 1];
	if (candidate) {
		try {
			const parsed = JSON.parse(candidate) as { verdict?: string; reason?: string };
			if (parsed.verdict === "pass" || parsed.verdict === "fail") {
				return {
					kind,
					verdict: parsed.verdict,
					reason: (parsed.reason ?? "").slice(0, 400),
					inconclusive: false,
				};
			}
		} catch {
			// Fall through to the conservative default.
		}
	}
	// Unparseable is not neutral: an unverified finding must not survive.
	return {
		kind,
		verdict: "fail",
		reason: "skeptic produced no parseable verdict (treated as fail)",
		inconclusive: true,
		raw: cleaned.slice(-400),
	};
}

/** 2-of-3. Inconclusive counts as fail, so silence never rescues a claim. */
export function tally(verdicts: Verdict[]): VerificationResult {
	const passCount = verdicts.filter((v) => v.verdict === "pass").length;
	const inconclusiveCount = verdicts.filter((v) => v.inconclusive).length;
	const disproved = verdicts.filter((v) => v.verdict === "fail" && !v.inconclusive).length;
	return {
		passed: passCount > verdicts.length / 2,
		verdicts,
		passCount,
		failCount: verdicts.length - passCount,
		inconclusiveCount,
		// Nobody actually argued against it; the checks just did not land.
		unverified: passCount <= verdicts.length / 2 && disproved === 0,
	};
}

function runOne(options: {
	bin: string;
	prompt: string;
	cwd: string;
	env: Record<string, string>;
	model?: string;
	provider?: string;
	thinkingLevel?: string;
	timeoutMs: number;
}): Promise<string> {
	const argv: string[] = [];
	if (options.provider) argv.push("--provider", options.provider);
	if (options.model) argv.push("--model", options.model);
	if (options.thinkingLevel) argv.push("--thinking", options.thinkingLevel);
	// Fresh and empty: no skills, no extensions, no AGENTS.md, no team identity.
	argv.push("--no-extensions", "--no-skills", "--no-context-files", "--no-session");
	argv.push("-p", "--", options.prompt);

	return new Promise((resolve) => {
		// stdin MUST be closed. pi's print mode merges piped stdin into the
		// prompt, so an open pipe (execFile's default) makes it wait for EOF
		// forever — the process burns its whole timeout and prints nothing.
		const child = spawn(options.bin, argv, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		let settled = false;
		const finish = (text: string): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(text);
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(out || `TIMEOUT after ${Math.round(options.timeoutMs / 1000)}s`);
		}, options.timeoutMs);
		timer.unref?.();
		child.stdout.on("data", (chunk) => {
			out += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			err += String(chunk);
		});
		child.on("error", (error) => finish(`ERROR: ${error.message}`));
		child.on("close", () => finish(out || err));
	});
}


/** Run all three skeptics concurrently and tally. */
export async function runSkeptics(options: {
	finding: string;
	sources?: string[];
	context?: string;
	cwd: string;
	env: Record<string, string>;
	bin?: string;
	model?: string;
	provider?: string;
	thinkingLevel?: string;
	timeoutMs?: number;
	kinds?: SkepticKind[];
}): Promise<VerificationResult> {
	const kinds = options.kinds ?? (["correct", "current", "source"] as SkepticKind[]);
	const bin = options.bin ?? process.env.PI_ORCH_PI_BIN ?? "pi";
	// Code-reading skeptics routinely need more than three minutes; too short a
	// timeout turns every verification into a silent "inconclusive".
	const timeoutMs = options.timeoutMs ?? 420_000;

	const results = await Promise.all(
		kinds.map(async (kind) => {
			const raw = await runOne({
				bin,
				prompt: buildSkepticPrompt({
					kind,
					finding: options.finding,
					sources: options.sources,
					context: options.context,
				}),
				cwd: options.cwd,
				env: options.env,
				model: options.model,
				provider: options.provider,
				thinkingLevel: options.thinkingLevel,
				timeoutMs,
			});
			return parseVerdict(kind, raw);
		}),
	);
	return tally(results);
}

export const SKEPTIC_LABEL: Record<SkepticKind, string> = {
	correct: "correct?",
	current: "current?",
	source: "source real?",
};

export const verifierExtDir = EXT_DIR;
