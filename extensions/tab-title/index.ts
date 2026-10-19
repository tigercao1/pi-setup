import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import path from "node:path";
import { askMessage, choose } from "../_shared/prompt.ts";

const MAX_TRANSCRIPT_CHARS = 6000;
const MAX_USER_MESSAGES = 6;
const MAX_TITLE_CHARS = 48;
const DEBOUNCE_MS = 400;
const STATE_ENTRY_TYPE = "tab-title";

type Mode = "auto" | "pinned" | "off";
type Placement = "aboveEditor" | "belowEditor" | "status" | "off";
type Style = "pill" | "box" | "plain";
type Label = { emoji?: string; summary: string; verbatim?: boolean };

type ThemeColor = Parameters<Theme["fg"]>[0];
type ThemeBg = Parameters<Theme["bg"]>[0];

const EMOJI_PATTERN = /^(\p{Extended_Pictographic}\uFE0F?(?:\u200D\p{Extended_Pictographic}\uFE0F?)*)/u;

// Fallback when the model returns a bare label.
const EMOJI_KEYWORDS: Array<[RegExp, string]> = [
	[/\b(bug|fix|broken|error|crash|regression)/i, "🐛"],
	[/\b(test|spec|rspec|jest|coverage)/i, "🧪"],
	[/\b(doc|docs|readme|comment|write.?up)/i, "📝"],
	[/\b(refactor|cleanup|rename|migrate|restructure)/i, "♻️"],
	[/\b(perf|performance|slow|optimi[sz]e|latency)/i, "⚡"],
	[/\b(deploy|release|ship|rollout|version)/i, "🚀"],
	[/\b(security|auth|token|permission|secret)/i, "🔐"],
	[/\b(style|css|scss|ui|design|layout)/i, "🎨"],
	[/\b(data|query|sql|db|database|migration)/i, "🗄️"],
	[/\b(payroll|invoice|billing|payment|tax)/i, "💸"],
	[/\b(extension|tool|script|automation|build)/i, "🛠️"],
	[/\b(investigate|debug|research|explore|why)/i, "🔍"],
];

const PLACEMENTS: Placement[] = ["aboveEditor", "belowEditor", "status", "off"];
const STYLES: Style[] = ["pill", "box", "plain"];
const REFRESH_MODES: Array<"once" | "always"> = ["once", "always"];

const matchOption = <T extends string>(options: T[], value: string | undefined, fallback: T): T =>
	options.find((option) => option.toLowerCase() === value?.toLowerCase()) ?? fallback;

const normalizeName = (value: string | undefined) => {
	const name = (value ?? "").replace(/[\r\n]+/g, " ").trim();
	return name ? name : undefined;
};

const guessEmoji = (summary: string) =>
	EMOJI_KEYWORDS.find(([pattern]) => pattern.test(summary))?.[1] ?? "💠";

const env = (name: string) => {
	const value = process.env[name]?.trim();
	return value ? value : undefined;
};

const truthy = (value: string | undefined, fallback: boolean) => {
	if (value === undefined) return fallback;
	return !/^(0|false|no|off)$/i.test(value);
};

const extractText = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const part = block as { type?: string; text?: string };
		if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
	}
	return parts.join("\n");
};

type TranscriptState = { text: string; userMessageCount: number };
type PersistedState = { name: string };

const readPersistedName = (ctx: ExtensionContext) => {
	const entries = ctx.sessionManager.getBranch() as Array<{
		type: string;
		customType?: string;
		data?: { name?: unknown };
	}>;

	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
		return typeof entry.data?.name === "string" ? normalizeName(entry.data.name) : undefined;
	}
	return undefined;
};

const buildTranscript = (ctx: ExtensionContext): TranscriptState => {
	const entries = ctx.sessionManager.getBranch() as Array<{
		type: string;
		message?: { role?: string; content?: unknown };
	}>;

	const userMessages: string[] = [];
	let lastAssistant = "";

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const role = entry.message?.role;
		const text = extractText(entry.message?.content).trim();
		if (!text) continue;
		// Compaction summaries and tool results add noise without adding intent.
		if (role === "user") userMessages.push(text);
		else if (role === "assistant") lastAssistant = text;
	}

	const recent = userMessages.slice(-MAX_USER_MESSAGES);
	const sections = recent.map((text, index) => `User ${index + 1}: ${text}`);
	if (lastAssistant) sections.push(`Assistant (latest): ${lastAssistant}`);

	let text = sections.join("\n\n");
	if (text.length > MAX_TRANSCRIPT_CHARS) text = `…${text.slice(-MAX_TRANSCRIPT_CHARS)}`;

	return { text, userMessageCount: userMessages.length };
};

const PROMPT = [
	"You name terminal tabs for a coding session.",
	"Read the conversation and reply with one emoji followed by a label describing what the session is working on.",
	"Rules:",
	"- Format: <emoji> <label>, e.g. '🐛 fix cart rounding bug'",
	"- Exactly one emoji, chosen to fit the task",
	"- Label is 2 to 5 words, at most 40 characters",
	"- Plain text: no quotes, no trailing period, no markdown",
	"- Describe the task, not the tooling",
	"- Prefer the most recent user intent when the topic changed",
	"Reply with that single line only.",
].join("\n");

const parseLabel = (raw: string): Label | undefined => {
	const firstLine = raw
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (!firstLine) return undefined;

	let rest = firstLine.replace(/^["'`*_#\s]+|["'`*_\s]+$/g, "").trim();
	const emoji = EMOJI_PATTERN.exec(rest)?.[1];
	if (emoji) rest = rest.slice(emoji.length).trim();

	const summary = rest.replace(/\s+/g, " ").replace(/\.$/, "").trim();
	if (!summary) return undefined;

	return {
		emoji,
		summary:
			summary.length > MAX_TITLE_CHARS
				? `${summary.slice(0, MAX_TITLE_CHARS - 1).trim()}…`
				: summary,
	};
};

export default function (pi: ExtensionAPI) {
	// Subagents and piped runs have no tab to rename.
	if (!process.stdout.isTTY) return;

	let mode: Mode = "auto";
	let label: Label | undefined;
	// The label describes the theme the session started with, so it is generated once.
	let settled = false;
	let generating = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let selfWrittenName: string | undefined;
	let persistedName: string | undefined;

	const format = env("PI_TAB_TITLE_FORMAT") ?? "{emoji} {summary}";
	const syncSessionName = truthy(env("PI_TAB_TITLE_SESSION_NAME"), true);
	const useEmoji = truthy(env("PI_TAB_TITLE_EMOJI"), true);
	const placement = matchOption(PLACEMENTS, env("PI_TAB_TITLE_WIDGET"), "aboveEditor");
	const style = matchOption(STYLES, env("PI_TAB_TITLE_STYLE"), "pill");
	const color = (env("PI_TAB_TITLE_COLOR") ?? "accent") as ThemeColor;
	const background = (env("PI_TAB_TITLE_BG") ?? "customMessageBg") as ThemeBg;
	const refreshEveryTurn = matchOption(REFRESH_MODES, env("PI_TAB_TITLE_REFRESH"), "once") === "always";

	const emojiFor = (current: Label) =>
		current.verbatim ? "" : useEmoji ? (current.emoji ?? guessEmoji(current.summary)) : "";

	const renderTitle = (current: Label) =>
		current.verbatim
			? current.summary
			: format
					.replaceAll("{emoji}", emojiFor(current))
					.replaceAll("{summary}", current.summary)
					.replaceAll("{cwd}", path.basename(process.cwd()))
					.replace(/\s+/g, " ")
					.trim();

	// Rendered as a component so the banner can wrap and pad to the live terminal width.
	const buildBanner = (theme: Theme, text: string) => ({
		invalidate: () => {},
		render: (width: number): string[] => {
			const paint = (value: string) => theme.bold(theme.fg(color, value));
			const inner = Math.max(8, width - 6);
			const lines = wrapTextWithAnsi(text, inner);
			const contentWidth = Math.max(...lines.map(visibleWidth));
			const pad = (line: string) => line + " ".repeat(contentWidth - visibleWidth(line));

			if (style === "plain") {
				return ["", ...lines.map((line) => ` ${paint(line)}`)];
			}

			if (style === "box") {
				const edge = "─".repeat(contentWidth + 2);
				return [
					"",
					` ${theme.fg(color, `╭${edge}╮`)}`,
					...lines.map(
						(line) =>
							` ${theme.fg(color, "│")} ${paint(pad(line))} ${theme.fg(color, "│")}`,
					),
					` ${theme.fg(color, `╰${edge}╯`)}`,
				];
			}

			return ["", ...lines.map((line) => ` ${theme.bg(background, paint(`  ${pad(line)}  `))}`)];
		},
	});

	const renderWidget = (ctx: ExtensionContext, current: Label | undefined) => {
		if (!ctx.hasUI || placement === "off") return;
		if (!current) {
			ctx.ui.setWidget("tab-title", undefined);
			ctx.ui.setStatus("tab-title", undefined);
			return;
		}

		const emoji = emojiFor(current);
		const text = [emoji, current.summary, mode === "pinned" ? "(pinned)" : ""]
			.filter(Boolean)
			.join(" ");

		if (placement === "status") {
			const theme = ctx.ui.theme;
			ctx.ui.setStatus("tab-title", theme.bold(theme.fg(color, text)));
			return;
		}

		ctx.ui.setWidget("tab-title", (_tui, theme) => buildBanner(theme, text), { placement });
	};

	const applyLabel = (ctx: ExtensionContext, next: Label) => {
		label = next;
		if (!ctx.hasUI) return;
		// setSessionName makes pi rewrite the title in its own format, so re-assert ours after.
		if (syncSessionName && mode !== "off") {
			selfWrittenName = normalizeName(renderTitle(next));
			pi.setSessionName(renderTitle(next));
			if (selfWrittenName && selfWrittenName !== persistedName) {
				persistedName = selfWrittenName;
				pi.appendEntry<PersistedState>(STATE_ENTRY_TYPE, { name: selfWrittenName });
			}
		}
		ctx.ui.setTitle(renderTitle(next));
		renderWidget(ctx, next);
	};

	const resolveModel = (ctx: ExtensionContext) => {
		const configured = env("PI_TAB_TITLE_MODEL");
		if (configured) {
			const [provider, ...rest] = configured.split("/");
			const modelId = rest.join("/");
			const found = provider && modelId ? ctx.modelRegistry.find(provider, modelId) : undefined;
			if (found && ctx.modelRegistry.hasConfiguredAuth(found)) return found;
		}
		const active = ctx.model;
		return active && ctx.modelRegistry.hasConfiguredAuth(active) ? active : undefined;
	};

	const generate = async (ctx: ExtensionContext) => {
		if (mode !== "auto" || generating) return;

		if (settled && !refreshEveryTurn) return;

		const { text, userMessageCount } = buildTranscript(ctx);
		if (!text || userMessageCount === 0) return;

		const model = resolveModel(ctx);
		if (!model) return;

		generating = true;
		try {
			const response = await ctx.modelRegistry.complete(
				model,
				{
					systemPrompt: PROMPT,
					messages: [
						{
							role: "user" as const,
							content: [{ type: "text" as const, text: `<conversation>\n${text}\n</conversation>` }],
							timestamp: Date.now(),
						},
					],
				},
				{ cacheRetention: "none", sessionId: uuidv7(), maxTokens: 200 },
			);

			const next = parseLabel(
				response.content
					.filter((block): block is { type: "text"; text: string } => block.type === "text")
					.map((block) => block.text)
					.join("\n"),
			);

			if (next && mode === "auto") {
				settled = true;
				applyLabel(ctx, next);
			}
		} catch {
			// A missing title is never worth surfacing an error for.
		} finally {
			generating = false;
		}
	};

	const schedule = (ctx: ExtensionContext) => {
		if (mode !== "auto") return;
		if (settled && !refreshEveryTurn) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			void generate(ctx);
		}, DEBOUNCE_MS);
		timer.unref?.();
	};

	pi.on("session_start", async (_event, ctx) => {
		const existing = normalizeName(pi.getSessionName());
		if (existing) {
			// A resumed session already has its theme; keep it instead of renaming.
			persistedName = readPersistedName(ctx);
			selfWrittenName = existing;
			settled = true;
			const own = persistedName === existing ? parseLabel(existing) : undefined;
			if (own) {
				label = own;
			} else {
				mode = "pinned";
				label = { summary: existing, verbatim: true };
			}
			if (ctx.hasUI) {
				ctx.ui.setTitle(renderTitle(label));
				renderWidget(ctx, label);
			}
		}
		schedule(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		schedule(ctx);
	});

	// pi rewrites the terminal title whenever session info changes; put ours back.
	pi.on("session_info_changed", async (event, ctx) => {
		if (mode === "off") return;
		const name = normalizeName(event.name);

		if (!name) {
			selfWrittenName = undefined;
			mode = "auto";
			settled = false;
			if (label?.verbatim) {
				label = undefined;
				if (ctx.hasUI) renderWidget(ctx, undefined);
			}
			schedule(ctx);
			return;
		}

		if (name !== selfWrittenName) {
			if (timer) clearTimeout(timer);
			timer = undefined;
			mode = "pinned";
			settled = true;
			selfWrittenName = name;
			label = { summary: name, verbatim: true };
			if (ctx.hasUI) {
				ctx.ui.setTitle(name);
				renderWidget(ctx, label);
			}
			return;
		}

		if (label && ctx.hasUI) ctx.ui.setTitle(renderTitle(label));
	});

	pi.on("session_shutdown", async () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
	});

	pi.registerCommand("tab-title", {
		description: "Tab title: pick auto, off or a pinned text (or type /tab-title text | auto | off | now)",
		handler: async (args, ctx) => {
			let arg = args.trim();
			const describe = () => (label ? renderTitle(label) : "none");

			if (!arg && ctx.hasUI) {
				const PIN = "pin";
				const picked = await choose(ctx, `Tab title (${mode}): ${describe()}`, [
					{ label: "Auto-name it now", value: "auto" },
					{ label: "Turn auto-naming off", value: "off" },
					{ label: "Pin my own text…", value: PIN },
				]);
				if (picked?.value === PIN) arg = (await askMessage(ctx, "Tab title text")) ?? "";
				else if (picked) arg = picked.value;
			}

			if (!arg) {
				ctx.ui.notify(`Tab title (${mode}): ${describe()}`, "info");
				return;
			}

			if (arg === "off") {
				mode = "off";
				renderWidget(ctx, undefined);
				ctx.ui.notify("Tab title auto-naming disabled", "info");
				return;
			}

			if (arg === "auto" || arg === "now") {
				mode = "auto";
				settled = false;
				if (label) renderWidget(ctx, label);
				await generate(ctx);
				ctx.ui.notify(`Tab title: ${describe()}`, "info");
				return;
			}

			mode = "pinned";
			settled = true;
			applyLabel(ctx, parseLabel(arg) ?? { summary: arg });
			ctx.ui.notify(`Tab title pinned: ${describe()}`, "info");
		},
	});
}
