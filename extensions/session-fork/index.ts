/**
 * session-fork — branch your pi session into another terminal pane, and hand
 * the result back.
 *
 * Two directions, one extension (they share a registry, a mailbox and a
 * renderer, and the child pane needs this same code loaded to answer):
 *
 *   /fork-pane [label]   fork THIS session into a new iTerm2/tmux pane
 *   /fork-back [message]  send a result to the session you were forked from
 *                         and put the cursor back in its pane
 *   /forks                tree of related sessions: focus, reopen, fork,
 *                         become, message, kill
 *   /handoff-pane [what]  start a FRESH session in a new pane from a summary
 *                         of this one plus your instructions
 *
 * Design notes:
 *
 * - Identity is env-based (`PI_FORK_*`), the same trick agent-orchestrator uses
 *   for teammates. A forked pane knows its parent because it was told at spawn.
 * - Every spawned process is scrubbed of `PI_ORCH_*`: a fork of a lead session
 *   that kept those vars would impersonate a teammate and could adopt — then
 *   destroy — a live team on exit.
 * - Forking never touches the source session file (`pi --fork` copies), so it
 *   is always safe, even while the source is running. Reopening the *same*
 *   session (`open`, `become`) is guarded by process liveness instead.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createMailRenderer } from "../_shared/mail-render.ts";
import {
	type Envelope,
	postEnvelope,
	countEnvelopes,
	watchEnvelopes,
} from "../_shared/mailbox.ts";
import {
	detectBackend,
	focusPane,
	killPane,
	ownPaneId,
	quoteArgv,
	spawnPane,
	type Where,
} from "../_shared/pane.ts";
import { askMessage, type Choice, choose } from "../_shared/prompt.ts";
import { buildSessionArgv, type ResumeMode } from "../_shared/sessions.ts";
import { spawnEnv } from "../_shared/spawn-env.ts";
import {
	describeRecord,
	ensureRegistryDirs,
	type ForkRecord,
	findBySessionId,
	isRecordAlive,
	logFileFor,
	mailRoot,
	patchRecord,
	pidFileFor,
	forksRoot,
	pruneRecords,
	readRecord,
	writeRecord,
} from "./registry.ts";
import { type ForkAction, openForksOverlay } from "./ui.ts";
import {
	HANDOFF_SYSTEM_PROMPT,
	collectHandoffMessages,
	composeHandoff,
	readHandoffFile,
	writeHandoffFile,
} from "./handoff.ts";

const MAIL_TYPE = "fork-message";

/**
 * Hard cap on one handback. A fork that pastes a log or a whole file into
 * `/fork-back` would otherwise blow a hole in the parent's context window —
 * the exact cost forking into a separate session exists to avoid.
 */
const MAX_MAIL_CHARS = 4000;

interface ForkMail extends Envelope {
	meta?: {
		turn?: boolean;
		label?: string;
		sessionId?: string;
		name?: string;
	};
}

function clamp(body: string): string {
	if (body.length <= MAX_MAIL_CHARS) return body;
	return (
		`${body.slice(0, MAX_MAIL_CHARS)}\n\n[…truncated ${body.length - MAX_MAIL_CHARS} chars. ` +
		`Point at a file instead of pasting content.]`
	);
}

const piBinary = (): string =>
	process.env.PI_FORK_PI_BIN ?? process.env.PI_ORCH_PI_BIN ?? "pi";

/** `fork-20260904-153001-a1b2`: sortable, unique, readable in `ps`. */
function newSpawnKey(): string {
	const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
	return `fork-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

interface Flags {
	where: Where;
	headless: boolean;
	/** /handoff-pane: leave the brief in the successor's editor instead of submitting it. */
	draft: boolean;
	/** /handoff-pane: replace this session in this pane instead of opening a new one. */
	here: boolean;
	/** null = unset: the default depends on the mail kind. See `deliver`. */
	turn: boolean | null;
	exit: boolean;
	to?: string;
	rest: string;
	/** Any option flag was typed, so the selection steps are skipped. `--to` does not count. */
	typed: boolean;
}

interface Placement {
	where: Where;
	headless: boolean;
	here: boolean;
}

const PANE_PLACEMENTS: Array<Choice<Placement>> = [
	{ label: "Vertical split", value: { where: "split-v", headless: false, here: false } },
	{ label: "Horizontal split", value: { where: "split-h", headless: false, here: false } },
	{ label: "New tab", value: { where: "tab", headless: false, here: false } },
	{ label: "New window", value: { where: "window", headless: false, here: false } },
	{ label: "Headless: print the command to run myself", value: { where: "split-v", headless: true, here: false } },
];

const HANDOFF_PLACEMENTS: Array<Choice<Placement>> = [
	...PANE_PLACEMENTS.slice(0, 4),
	{ label: "Replace this session in this pane", value: { where: "split-v", headless: false, here: true } },
	...PANE_PLACEMENTS.slice(4),
];

function applyPlacement(flags: Flags, placement: Placement): void {
	flags.where = placement.where;
	flags.headless = placement.headless;
	flags.here = placement.here;
}

const OPTION_FLAGS = new Set([
	"--tab",
	"--window",
	"--horizontal",
	"--vertical",
	"--headless",
	"--draft",
	"--here",
	"--turn",
	"--no-turn",
	"--exit",
]);

function parseFlags(args: string): Flags {
	const out: Flags = {
		where: "split-v",
		headless: false,
		draft: false,
		here: false,
		turn: null,
		exit: false,
		rest: "",
		typed: false,
	};
	const words = args.trim().length > 0 ? args.trim().split(/\s+/) : [];
	const rest: string[] = [];
	for (let i = 0; i < words.length; i++) {
		const word = words[i] as string;
		if (word === "--tab") out.where = "tab";
		else if (word === "--window") out.where = "window";
		else if (word === "--horizontal") out.where = "split-h";
		else if (word === "--vertical") out.where = "split-v";
		else if (word === "--headless") out.headless = true;
		else if (word === "--draft") out.draft = true;
		else if (word === "--here") out.here = true;
		else if (word === "--turn") out.turn = true;
		else if (word === "--no-turn") out.turn = false;
		else if (word === "--exit") out.exit = true;
		else if (word === "--to") out.to = words[++i];
		else rest.push(word);
		if (OPTION_FLAGS.has(word)) out.typed = true;
	}
	out.rest = rest.join(" ");
	return out;
}

export default function sessionFork(pi: ExtensionAPI): void {
	let selfKey: string | null = null;
	let disposers: Array<() => void> = [];
	/**
	 * Session-scoped notifier. Delivered mail lands in the transcript, but a
	 * handback that arrives while you are reading something else deserves a
	 * visible signal too — the whole point is that you were looking elsewhere.
	 */
	let notify: ((message: string) => void) | null = null;

	if (typeof pi.registerMessageRenderer === "function") {
		pi.registerMessageRenderer(MAIL_TYPE, createMailRenderer("fork") as never);
	}

	// ------------------------------------------------------- registration

	/**
	 * Write (or refresh) this session's own record.
	 *
	 * Called on every session_start, which also fires on /new, /resume, /fork
	 * and /clone. When the session UUID changes underneath a spawned identity,
	 * the old record is retired rather than overwritten — otherwise a `become`
	 * would silently relabel the fork's transcript as the parent's.
	 */
	function registerSelf(ctx: {
		cwd: string;
		sessionManager?: {
			getSessionId?: () => string | null | undefined;
			getSessionFile?: () => string | null | undefined;
		};
	}): ForkRecord | null {
		ensureRegistryDirs();
		const sessionId = ctx.sessionManager?.getSessionId?.() ?? null;
		if (!sessionId) return null; // --no-session: nothing to register or fork
		const sessionFile = ctx.sessionManager?.getSessionFile?.() ?? undefined;

		const spawnKey = process.env.PI_FORK_SPAWN_ID;
		let key = spawnKey ?? `s-${sessionId}`;
		if (spawnKey) {
			const stub = readRecord(spawnKey);
			if (stub?.sessionId && stub.sessionId !== sessionId) {
				// We were spawned as one session and have since switched to another.
				patchRecord(spawnKey, { pid: undefined, exitedAt: new Date().toISOString() });
				key = `s-${sessionId}`;
			}
		}
		if (selfKey && selfKey !== key) {
			patchRecord(selfKey, { pid: undefined, exitedAt: new Date().toISOString() });
		}

		const previous = readRecord(key);
		const now = new Date().toISOString();
		const record: ForkRecord = {
			...previous,
			key,
			sessionId,
			sessionFile: sessionFile ?? previous?.sessionFile,
			name: pi.getSessionName?.() ?? previous?.name,
			label: process.env.PI_FORK_LABEL ?? previous?.label,
			cwd: ctx.cwd,
			pid: process.pid,
			backend: detectBackend(),
			paneId: ownPaneId() ?? previous?.paneId,
			parentKey: process.env.PI_FORK_PARENT_KEY ?? previous?.parentKey,
			parentSessionId: process.env.PI_FORK_PARENT ?? previous?.parentSessionId,
			piBin: previous?.piBin ?? piBinary(),
			createdAt: previous?.createdAt ?? now,
			lastSeenAt: now,
			exitedAt: undefined,
		};
		selfKey = key;
		return writeRecord(record);
	}

	function self(): ForkRecord | null {
		return selfKey ? readRecord(selfKey) : null;
	}

	// ------------------------------------------------------------ mailbox

	function deliver(mail: ForkMail[]): void {
		if (mail.length === 0) return;
		const format = (item: ForkMail): string => {
			const who = item.meta?.name ?? item.meta?.label ?? item.from;
			const id = item.meta?.sessionId ? ` (session ${item.meta.sessionId.slice(0, 8)})` : "";
			const header =
				item.kind === "handback" ? `⑂ handback from ${who}${id}` : `▌ message from ${who}${id}`;
			return `${header}\n\n${item.content}`;
		};
		const body =
			mail.length === 1
				? format(mail[0] as ForkMail)
				: [`⑂ ${mail.length} messages from forked sessions`, "", mail.map(format).join("\n\n---\n\n")].join(
						"\n",
					);
		notify?.(
			mail.length === 1
				? `⑂ ${mail[0]!.kind === "handback" ? "handback" : "message"} from ` +
						`${mail[0]!.meta?.name ?? mail[0]!.meta?.label ?? mail[0]!.from}`
				: `⑂ ${mail.length} messages from forked sessions`,
		);
		// followUp never interrupts a running tool call.
		//
		// A *handback* triggers a turn by default: it means "I am done, control is
		// yours", and a transfer of control that leaves the recipient idle is
		// indistinguishable from one that was never sent — in an unattended run it
		// stalls the whole orchestration silently. A plain *message* stays opt-in,
		// so notes you want to read yourself do not spend a model turn.
		// Either default can be overridden with `--turn` / `--no-turn`.
		const wantsTurn = mail.some((m) =>
			typeof m.meta?.turn === "boolean" ? m.meta.turn : m.kind === "handback",
		);
		pi.sendMessage(
			{
				customType: MAIL_TYPE,
				content: body,
				display: true,
				details: {
					count: mail.length,
					from: [...new Set(mail.map((m) => m.meta?.name ?? m.meta?.label ?? m.from))],
					kinds: [...new Set(mail.map((m) => m.kind))],
				},
			},
			{ deliverAs: "followUp", triggerTurn: wantsTurn },
		);
	}

	// -------------------------------------------------------------- spawn

	interface SpawnOptions {
		source: ForkRecord;
		mode: ResumeMode;
		label?: string;
		where: Where;
		headless: boolean;
		/** Reuse the source's registry key (reopening the same session). */
		reuseKey?: boolean;
	}

	function spawnSession(options: SpawnOptions): { ok: boolean; message: string } {
		const { source, mode } = options;
		if (!source.sessionId) {
			return { ok: false, message: `${describeRecord(source)} has no saved session to open.` };
		}
		if (mode !== "fork" && isRecordAlive(source)) {
			return {
				ok: false,
				message:
					`${describeRecord(source)} is still running — two processes on one session file ` +
					`corrupts it. Press ⏎ to focus its pane, or f to fork it instead.`,
			};
		}

		const key = options.reuseKey ? source.key : newSpawnKey();
		const parentKey = options.reuseKey ? source.parentKey : source.key;
		const parentSessionId = options.reuseKey ? source.parentSessionId : source.sessionId;
		const label = options.label ?? (options.reuseKey ? source.label : undefined);
		const title =
			mode === "fork"
				? `${describeRecord(source)} ⑂ ${label ?? key.slice(-4)}`
				: describeRecord(source);

		const argv = buildSessionArgv({
			originalArgv: source.argv ?? [source.piBin ?? piBinary()],
			sessionId: source.sessionId,
			mode,
			extraArgs: ["--name", title],
		});
		// spawnEnv drops every PI_ORCH_*/PI_FORK_* it finds, so the child gets
		// exactly the identity we hand it and nothing inherited.
		const env = spawnEnv({
			PI_FORK_SPAWN_ID: key,
			PI_ORCH_NO_ADOPT: "1",
			...(parentSessionId ? { PI_FORK_PARENT: parentSessionId } : {}),
			...(parentKey ? { PI_FORK_PARENT_KEY: parentKey } : {}),
			...(label ? { PI_FORK_LABEL: label } : {}),
		});

		const pidFile = pidFileFor(key);
		const logFile = logFileFor(key);
		const now = new Date().toISOString();
		const stub: ForkRecord = {
			...(options.reuseKey ? source : {}),
			key,
			sessionId: mode === "fork" ? undefined : source.sessionId,
			sessionFile: mode === "fork" ? undefined : source.sessionFile,
			name: title,
			label,
			cwd: source.cwd,
			pid: undefined,
			pidFile,
			logFile,
			backend: detectBackend(),
			paneId: undefined,
			parentKey,
			parentSessionId,
			piBin: source.piBin ?? piBinary(),
			argv,
			createdAt: options.reuseKey ? (source.createdAt ?? now) : now,
			lastSeenAt: now,
			exitedAt: undefined,
			announced: false,
		};

		if (options.headless || detectBackend() === "headless") {
			// No pane to open into: hand back a runnable command rather than
			// starting something the user cannot see.
			const identity = Object.entries(env)
				.filter(([k]) => k.startsWith("PI_FORK_") || k === "PI_ORCH_NO_ADOPT")
				.map(([k, v]) => `${k}=${v}`)
				.join(" ");
			writeRecord(stub);
			return {
				ok: true,
				message: [
					`No pane backend available (backend: ${detectBackend()}), so run this yourself:`,
					"",
					"```bash",
					`cd ${source.cwd} && \\`,
					`  ${identity} \\`,
					`  ${quoteArgv(argv)}`,
					"```",
				].join("\n"),
			};
		}

		try {
			const result = spawnPane({
				pidFile,
				cwd: source.cwd,
				argv,
				env,
				visible: true,
				where: options.where,
				logFile,
				title,
			});
			writeRecord({ ...stub, paneId: result.paneId ?? undefined, backend: result.backend });
		} catch (error) {
			return { ok: false, message: `Failed to open a pane: ${(error as Error).message}` };
		}
		return {
			ok: true,
			message:
				mode === "fork"
					? `⑂ Forked into a new pane as “${title}”. The original transcript is untouched.`
					: `Reopened “${title}” in a new pane.`,
		};
	}

	// ----------------------------------------------------------- commands

	pi.registerCommand("fork-pane", {
		description: "Fork this session into a new pane (asks where; or type --tab|--window|--horizontal|--headless)",
		handler: async (args, ctx) => {
			const flags = parseFlags(args);
			await ctx.waitForIdle?.();
			const record = registerSelf(ctx) ?? self();
			if (!record?.sessionId) {
				ctx.ui.notify(
					"This session is not saved (--no-session), so there is nothing to fork.",
					"warning",
				);
				return;
			}
			if (!flags.typed) {
				const placement = await choose(ctx, "Open the fork where?", PANE_PLACEMENTS);
				if (!placement) return ctx.ui.notify("Fork cancelled.", "info");
				applyPlacement(flags, placement.value);
			}
			if (!flags.rest) {
				const label = await askMessage(ctx, "Label for the fork (Enter for none)");
				if (label === null) return ctx.ui.notify("Fork cancelled.", "info");
				flags.rest = label;
			}
			const result = spawnSession({
				source: record,
				mode: "fork",
				label: flags.rest || undefined,
				where: flags.where,
				headless: flags.headless,
			});
			ctx.ui.notify(result.message, result.ok ? "info" : "error");
		},
	});

	pi.registerCommand("fork-back", {
		description: "Send a result to the session this one was forked from (asks; or type --turn|--no-turn --exit)",
		handler: async (args, ctx) => {
			const flags = parseFlags(args);
			const me = registerSelf(ctx) ?? self();
			if (!me) {
				ctx.ui.notify("This session is not registered (ephemeral session?).", "warning");
				return;
			}
			const target = resolveTarget(me, flags.to);
			if (!target) {
				ctx.ui.notify(
					"No parent session recorded — this session was not created by /fork-pane. " +
						"Use /forks and press m to pick a target.",
					"warning",
				);
				return;
			}
			if (!flags.typed) {
				const turn = await choose<boolean | null>(ctx, `How should ${describeRecord(target)} receive it?`, [
					{ label: "Wake it to act on the result", value: null },
					{ label: "Deliver quietly, without starting a turn", value: false },
				]);
				if (!turn) return ctx.ui.notify("Handback cancelled.", "info");
				const exit = await choose(ctx, "After sending:", [
					{ label: "Stay in this session", value: false },
					{ label: "Exit this session", value: true },
				]);
				if (!exit) return ctx.ui.notify("Handback cancelled.", "info");
				flags.turn = turn.value;
				flags.exit = exit.value;
			}
			if (!flags.rest) {
				const typed = await askMessage(
					ctx,
					`Message for ${describeRecord(target)} (submit it empty to send your last reply)`,
					{ multiline: true },
				);
				if (typed === null) return ctx.ui.notify("Handback cancelled.", "info");
				flags.rest = typed;
			}
			const content = flags.rest || lastAssistantText(ctx) || "(no message)";
			postEnvelope<ForkMail>(mailRoot(), {
				to: target.key,
				from: me.key,
				kind: "handback",
				content: clamp(content),
				meta: {
					// null is omitted on the wire so the receiver applies the kind default.
					...(flags.turn === null ? {} : { turn: flags.turn }),
					label: me.label,
					sessionId: me.sessionId,
					name: me.name,
				},
			});
			const focused = focusPane(target.paneId ?? null);
			const alive = isRecordAlive(target);
			ctx.ui.notify(
				[
					`⑂ Handback sent to ${describeRecord(target)}.`,
					alive
						? focused
							? "Focused its pane."
							: "It is running; it will pick this up on its next turn."
						: "It is not running right now — the message is queued until it starts again.",
				].join(" "),
				"info",
			);
			if (flags.exit) {
				// Nothing was appended to this session, so exiting immediately loses
				// no state. Small delay so the notification is actually seen.
				setTimeout(() => process.exit(0), 400);
			}
		},
	});


	// ------------------------------------------------------------ handoff

	/**
	 * Ask the current model for a handoff brief of the active branch. Returns
	 * null when cancelled. The heavy pi imports are loaded lazily so the
	 * model-free smoke test never pulls in the whole runtime.
	 */
	async function generateBrief(ctx: ExtensionCommandContext, extra: string): Promise<string | null> {
		const messages = collectHandoffMessages(
			ctx.sessionManager.getBranch() as unknown as Parameters<typeof collectHandoffMessages>[0],
		);
		if (messages.length === 0) return null;
		const runtime = await import("@earendil-works/pi-coding-agent");
		const { uuidv7 } = await import("@earendil-works/pi-ai");
		const transcript = runtime.serializeConversation(runtime.convertToLlm(messages as never));
		const request =
			`## Conversation\n\n${transcript}\n\n` +
			`## What the user wants the new session to do\n\n${extra || "(not stated; brief the open threads)"}`;
		return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const loader = new runtime.BorderedLoader(tui, theme, "Writing the handoff brief…");
			loader.onAbort = () => done(null);
			ctx.modelRegistry
				.complete(
					ctx.model as never,
					{
						systemPrompt: HANDOFF_SYSTEM_PROMPT,
						messages: [{ role: "user", content: [{ type: "text", text: request }], timestamp: Date.now() }],
					},
					{ signal: loader.signal, cacheRetention: "none", sessionId: uuidv7() } as never,
				)
				.then((response) => {
					if (response.stopReason === "aborted") return done(null);
					done(
						response.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("\n"),
					);
				})
				.catch((error: unknown) => {
					ctx.ui.notify(`Handoff brief failed: ${(error as Error).message}`, "error");
					done(null);
				});
			return loader;
		});
	}

	function successorArgv(source: ForkRecord, ctx: ExtensionCommandContext, title: string): string[] {
		const argv = [source.piBin ?? piBinary()];
		const model = ctx.model as { provider?: string; id?: string } | undefined;
		if (model?.provider && model.id) argv.push("--model", `${model.provider}/${model.id}`);
		const thinking = pi.getThinkingLevel?.();
		if (thinking) argv.push("--thinking", String(thinking));
		argv.push("--name", title);
		return argv;
	}

	pi.registerCommand("handoff-pane", {
		description:
			"Start a fresh session in a new pane from a summary of this one plus your instructions " +
			"(asks; or type --draft --here --tab|--window|--horizontal|--headless)",
		handler: async (args, ctx) => {
			const flags = parseFlags(args);
			await ctx.waitForIdle?.();
			const record = registerSelf(ctx) ?? self();
			if (!record?.sessionId) {
				ctx.ui.notify("This session is not saved (--no-session), so there is nothing to hand off.", "warning");
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify("No model selected, so no brief can be written.", "error");
				return;
			}

			if (!flags.typed) {
				const placement = await choose(ctx, "Open the new session where?", HANDOFF_PLACEMENTS);
				if (!placement) return ctx.ui.notify("Handoff cancelled.", "info");
				applyPlacement(flags, placement.value);
				const start = await choose(ctx, "When it opens:", [
					{ label: "Start working on the brief", value: false },
					{ label: "Leave the brief in its editor for me to submit", value: true },
				]);
				if (!start) return ctx.ui.notify("Handoff cancelled.", "info");
				flags.draft = start.value;
			}

			let extra = flags.rest;
			if (!extra) {
				const typed = await askMessage(
					ctx,
					"What should the new session do? Anything to add on top of the summary? (Enter for nothing)",
					{ multiline: true },
				);
				if (typed === null) {
					ctx.ui.notify("Handoff cancelled.", "info");
					return;
				}
				extra = typed;
			}

			const summary = await generateBrief(ctx, extra);
			if (!summary) {
				ctx.ui.notify("Handoff cancelled (or nothing to summarise).", "info");
				return;
			}
			const draft = composeHandoff({
				summary,
				extra,
				parentName: describeRecord(record),
				parentSessionId: record.sessionId,
			});
			const brief = await ctx.ui.editor("Review the handoff brief (this is all the new session will see)", draft);
			if (brief === undefined || brief.trim().length === 0) {
				ctx.ui.notify("Handoff cancelled.", "info");
				return;
			}

			if (flags.here) {
				const result = await ctx.newSession({
					parentSession: record.sessionFile,
					withSession: async (fresh) => {
						if (flags.draft) {
							fresh.ui.setEditorText(brief);
							fresh.ui.notify("Handoff brief is in the editor. Submit when ready.", "info");
						} else {
							await fresh.sendUserMessage(brief);
						}
					},
				});
				if (result.cancelled) ctx.ui.notify("New session cancelled.", "info");
				return;
			}

			const key = newSpawnKey().replace(/^fork-/, "handoff-");
			const label = (extra.split("\n")[0] ?? "").slice(0, 60) || "handoff";
			const title = `${describeRecord(record)} → ${label}`;
			const briefFile = writeHandoffFile(forksRoot(), key, brief);
			const argv = successorArgv(record, ctx, title);
			const env = spawnEnv({
				PI_FORK_SPAWN_ID: key,
				PI_ORCH_NO_ADOPT: "1",
				PI_FORK_PARENT: record.sessionId,
				PI_FORK_PARENT_KEY: record.key,
				PI_FORK_LABEL: label,
			});
			const pidFile = pidFileFor(key);
			const logFile = logFileFor(key);
			const now = new Date().toISOString();
			const stub: ForkRecord = {
				key,
				name: title,
				label,
				cwd: record.cwd,
				pidFile,
				logFile,
				backend: detectBackend(),
				parentKey: record.key,
				parentSessionId: record.sessionId,
				piBin: record.piBin ?? piBinary(),
				argv,
				createdAt: now,
				lastSeenAt: now,
				announced: true,
				handoffFile: briefFile,
				handoffMode: flags.draft ? "draft" : "go",
				handoffConsumed: false,
			};

			if (flags.headless || detectBackend() === "headless") {
				writeRecord(stub);
				const identity = Object.entries(env)
					.filter(([k]) => k.startsWith("PI_FORK_") || k === "PI_ORCH_NO_ADOPT")
					.map(([k, v]) => `${k}=${v}`)
					.join(" ");
				ctx.ui.notify(
					[
						`No pane backend available (backend: ${detectBackend()}), so run this yourself:`,
						"",
						`cd ${record.cwd} && ${identity} ${quoteArgv(argv)}`,
						"",
						`The brief is saved at ${briefFile}.`,
					].join("\n"),
					"info",
				);
				return;
			}
			try {
				const result = spawnPane({ pidFile, cwd: record.cwd, argv, env, visible: true, where: flags.where, logFile, title });
				writeRecord({ ...stub, paneId: result.paneId ?? undefined, backend: result.backend });
			} catch (error) {
				ctx.ui.notify(`Failed to open a pane: ${(error as Error).message}`, "error");
				return;
			}
			ctx.ui.notify(
				`→ Handed off to a new session “${title}”` +
					(flags.draft ? " (brief left in its editor)." : ". It is starting on the brief now.") +
					" This session stays as it is; the successor can reply with /fork-back.",
				"info",
			);
		},
	});

	pi.registerCommand("forks", {
		description: "Tree of related sessions: focus, reopen, fork, become, message",
		handler: async (_args, ctx) => {
			registerSelf(ctx);
			const action = await openForksOverlay(ctx, selfKey);
			if (action) await runAction(action, ctx);
		},
	});

	function resolveTarget(me: ForkRecord, to?: string): ForkRecord | null {
		if (to) return readRecord(to) ?? findBySessionId(to);
		if (me.parentKey) {
			const byKey = readRecord(me.parentKey);
			if (byKey) return byKey;
		}
		if (me.parentSessionId) return findBySessionId(me.parentSessionId);
		return null;
	}

	/** Last assistant text on the active branch — the default handback body. */
	function lastAssistantText(ctx: ExtensionCommandContext): string | null {
		try {
			const entries = ctx.sessionManager.getBranch() as Array<{
				type?: string;
				message?: { role?: string; content?: unknown };
			}>;
			for (let i = entries.length - 1; i >= 0; i--) {
				const message = entries[i]?.message;
				if (!message || message.role !== "assistant") continue;
				const content = message.content;
				const text = Array.isArray(content)
					? content
							.filter((part): part is { type: string; text: string } => {
								const candidate = part as { type?: string; text?: unknown };
								return candidate.type === "text" && typeof candidate.text === "string";
							})
							.map((part) => part.text)
							.join("\n")
					: typeof content === "string"
						? content
						: "";
				if (text.trim()) return text.trim();
			}
		} catch {
			// Session shapes differ between pi versions; a missing default is fine.
		}
		return null;
	}

	async function runAction(action: ForkAction, ctx: ExtensionCommandContext): Promise<void> {
		const record = action.record;
		switch (action.type) {
			case "focus": {
				if (record.key === selfKey) {
					ctx.ui.notify("That is this session.", "info");
					return;
				}
				const ok = focusPane(record.paneId ?? null);
				ctx.ui.notify(
					ok
						? `Focused ${describeRecord(record)}.`
						: `${describeRecord(record)} has no pane to focus` +
								(isRecordAlive(record) ? " (headless)." : " — press o to reopen it."),
					ok ? "info" : "warning",
				);
				return;
			}
			case "open": {
				const result = spawnSession({
					source: record,
					mode: "inspect",
					where: "split-v",
					headless: false,
					reuseKey: true,
				});
				ctx.ui.notify(result.message, result.ok ? "info" : "warning");
				return;
			}
			case "fork": {
				const label = await ctx.ui.input("Label for the fork", "why are you branching?");
				const result = spawnSession({
					source: record,
					mode: "fork",
					label: label?.trim() || undefined,
					where: "split-v",
					headless: false,
				});
				ctx.ui.notify(result.message, result.ok ? "info" : "warning");
				return;
			}
			case "become": {
				if (record.key === selfKey) {
					ctx.ui.notify("You are already in that session.", "info");
					return;
				}
				if (!record.sessionFile) {
					ctx.ui.notify(
						`${describeRecord(record)} has no session file on disk yet.`,
						"warning",
					);
					return;
				}
				if (isRecordAlive(record)) {
					ctx.ui.notify(
						`${describeRecord(record)} is running in another process. Two processes on one ` +
							`session file corrupts it — focus its pane (⏎) or fork it (f) instead.`,
						"warning",
					);
					return;
				}
				const target = record.sessionFile;
				const result = await ctx.switchSession(target, {
					withSession: async (fresh) => {
						fresh.ui.notify(`Now in ${describeRecord(record)}.`, "info");
					},
				});
				if (result?.cancelled) ctx.ui.notify("Session switch was cancelled.", "warning");
				return;
			}
			case "message": {
				const text = await ctx.ui.input(`Message to ${describeRecord(record)}`, "");
				if (!text?.trim()) return;
				const me = self();
				postEnvelope<ForkMail>(mailRoot(), {
					to: record.key,
					from: me?.key ?? "unknown",
					kind: "message",
					content: clamp(text.trim()),
					meta: { turn: true, label: me?.label, sessionId: me?.sessionId, name: me?.name },
				});
				focusPane(record.paneId ?? null);
				ctx.ui.notify(`Sent to ${describeRecord(record)}.`, "info");
				return;
			}
			case "kill": {
				if (record.key === selfKey) {
					ctx.ui.notify("Refusing to kill this session. Use /exit.", "warning");
					return;
				}
				if (!isRecordAlive(record)) {
					ctx.ui.notify(`${describeRecord(record)} is not running.`, "info");
					return;
				}
				const confirmed = await ctx.ui.confirm(
					"Kill session",
					`Terminate ${describeRecord(record)}? Its transcript is kept.`,
				);
				if (!confirmed) return;
				killPane(record.pidFile ?? pidFileFor(record.key), record.paneId ?? null);
				patchRecord(record.key, { exitedAt: new Date().toISOString(), pid: undefined });
				ctx.ui.notify(`Killed ${describeRecord(record)}.`, "info");
				return;
			}
			case "copy": {
				const argv =
					record.argv ??
					(record.sessionId
						? buildSessionArgv({
								originalArgv: [record.piBin ?? piBinary()],
								sessionId: record.sessionId,
								mode: "inspect",
							})
						: null);
				if (!argv) {
					ctx.ui.notify("Nothing to copy: this record has no session yet.", "warning");
					return;
				}
				ctx.ui.setEditorText(`cd ${record.cwd} && ${quoteArgv(argv)}`);
				ctx.ui.notify("Command placed in the editor.", "info");
				return;
			}
		}
	}

	// ------------------------------------------------------------- events

	pi.on("session_start", async (_event, ctx) => {
		dispose();
		const record = registerSelf(ctx);
		if (!record) return;
		pruneRecords();

		const stop = watchEnvelopes<ForkMail>(mailRoot(), record.key, deliver);
		disposers.push(stop);

		// Heartbeat: `lastSeenAt` is what tells a stale record from a live one
		// after a crash, when no shutdown hook ran.
		const beat = setInterval(() => {
			if (selfKey) patchRecord(selfKey, { lastSeenAt: new Date().toISOString() });
		}, 20000);
		beat.unref?.();
		disposers.push(() => clearInterval(beat));

		if (ctx.hasUI) {
			notify = (message: string) => ctx.ui.notify(message, "info");
			disposers.push(() => {
				notify = null;
			});
			const status = (): void => {
				const current = self();
				if (!current) return;
				const pending = countEnvelopes(mailRoot(), current.key);
				const parent = current.parentKey ? readRecord(current.parentKey) : null;
				// Silent in an ordinary session: a status line saying "you have no
				// forks" is pure noise in every pi you ever open.
				if (!parent && pending === 0) {
					ctx.ui.setStatus("session-fork", undefined);
					return;
				}
				const bits = [
					parent ? `⑂ of ${describeRecord(parent)}` : "",
					current.label ? `“${current.label}”` : "",
					pending > 0 ? `${pending} queued` : "",
				].filter(Boolean);
				ctx.ui.setStatus("session-fork", bits.join("  "));
			};
			status();
			const timer = setInterval(status, 5000);
			timer.unref?.();
			disposers.push(() => {
				clearInterval(timer);
				ctx.ui.setStatus("session-fork", undefined);
			});
		}

		// A /handoff-pane successor starts from its brief, exactly once.
		if (record.handoffFile && record.handoffConsumed !== true && process.env.PI_FORK_SPAWN_ID) {
			const brief = readHandoffFile(record.handoffFile);
			patchRecord(record.key, { handoffConsumed: true, announced: true });
			if (brief) {
				if (record.handoffMode === "draft") {
					if (ctx.hasUI) {
						ctx.ui.setEditorText(brief);
						ctx.ui.notify("Handoff brief is in the editor. Submit when ready.", "info");
					}
				} else {
					pi.sendUserMessage(brief);
				}
			}
			return;
		}

		// Tell a freshly forked session what it is, exactly once. Not a turn: the
		// pane opens idle so the human can steer it.
		if (record.label && record.announced !== true && process.env.PI_FORK_SPAWN_ID) {
			const parent = record.parentKey ? readRecord(record.parentKey) : null;
			pi.sendMessage(
				{
					customType: MAIL_TYPE,
					content: [
						`⑂ This is a forked session, branched from ${parent ? describeRecord(parent) : "another session"}` +
							` at ${new Date().toLocaleTimeString()}.`,
						"",
						`Focus for this fork: ${record.label}`,
						"",
						"The parent session is still open in its own pane and does not see what happens here. " +
							"When there is a result worth sending, run `/fork-back <summary>` — it delivers the " +
							"message to the parent and focuses its pane. `/forks` lists related sessions.",
					].join("\n"),
					display: true,
					details: { count: 1, from: ["fork"], kinds: ["kickoff"] },
				},
				{ triggerTurn: false },
			);
			patchRecord(record.key, { announced: true });
		}
	});

	pi.on("session_shutdown", async () => {
		if (selfKey) {
			patchRecord(selfKey, { exitedAt: new Date().toISOString(), pid: undefined });
		}
		dispose();
	});

	function dispose(): void {
		for (const stop of disposers) {
			try {
				stop();
			} catch {
				// Ignore disposer failures.
			}
		}
		disposers = [];
	}
}
