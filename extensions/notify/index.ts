/**
 * Notify — desktop notification when the agent finishes and is waiting for input.
 *
 * Protocols:
 *   OSC 9   → iTerm2
 *   OSC 99  → Kitty
 *   OSC 777 → Ghostty, WezTerm, and other terminals that support it
 *   osascript fallback → terminals without OSC notification support (e.g. VS Code)
 *
 * Also listens for the `notify:send` inter-extension event so other extensions
 * (e.g. `guard`) can raise a notification mid-turn while blocked on user input.
 */

import { execFile } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { askMessage } from "../_shared/prompt.ts";

const MAX_BODY_CHARS = 140;

type Protocol = "osc9" | "osc99" | "osc777" | "osascript" | "windows";

/** Strip control characters that would corrupt an OSC sequence. */
const sanitize = (value: string) =>
	value
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();

const truncate = (value: string, max = MAX_BODY_CHARS) =>
	value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;

function detectProtocol(): Protocol {
	if (process.env.WT_SESSION) return "windows";
	if (process.env.KITTY_WINDOW_ID || process.env.TERM === "xterm-kitty") return "osc99";

	switch (process.env.TERM_PROGRAM) {
		case "iTerm.app":
			return "osc9";
		case "ghostty":
		case "WezTerm":
		case "Hyper":
		case "rio":
			return "osc777";
		// Terminals with no OSC notification support.
		case "vscode":
		case "Apple_Terminal":
		case "Cursor":
		case "windsurf":
			return process.platform === "darwin" ? "osascript" : "osc777";
		default:
			return process.platform === "darwin" && !process.env.TERM_PROGRAM
				? "osascript"
				: "osc777";
	}
}

const writeSequence = (sequence: string) => {
	try {
		process.stdout.write(sequence);
	} catch {
		// Ignore write failures (closed stdout, non-tty, etc.)
	}
};

const notifyOSC9 = (title: string, body: string) =>
	writeSequence(`\x1b]9;${title}: ${body}\x07`);

const notifyOSC777 = (title: string, body: string) =>
	writeSequence(`\x1b]777;notify;${title};${body}\x07`);

const notifyOSC99 = (title: string, body: string) => {
	writeSequence(`\x1b]99;i=pi:d=0;${title}\x1b\\`);
	writeSequence(`\x1b]99;i=pi:p=body;${body}\x1b\\`);
};

const escapeAppleScript = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

const notifyOsascript = (title: string, body: string) => {
	const script = `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(title)}"`;
	execFile("osascript", ["-e", script], () => {
		// Best effort: swallow errors (notifications may be disabled).
	});
};

function windowsToastScript(title: string, body: string): string {
	const type = "Windows.UI.Notifications";
	const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
	const template = `[${type}.ToastTemplateType]::ToastText01`;
	const toast = `[${type}.ToastNotification]::new($xml)`;
	return [
		`${mgr} > $null`,
		`$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
		`$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${body.replace(/'/g, "''")}')) > $null`,
		`[${type}.ToastNotificationManager]::CreateToastNotifier('${title.replace(/'/g, "''")}').Show(${toast})`,
	].join("; ");
}

const notifyWindows = (title: string, body: string) => {
	execFile("powershell.exe", ["-NoProfile", "-Command", windowsToastScript(title, body)], () => {});
};

function notify(rawTitle: string, rawBody: string): Protocol {
	const title = sanitize(rawTitle) || "pi";
	const body = truncate(sanitize(rawBody) || "Ready for input");
	const protocol = detectProtocol();

	switch (protocol) {
		case "osc9":
			notifyOSC9(title, body);
			break;
		case "osc99":
			notifyOSC99(title, body);
			break;
		case "osascript":
			notifyOsascript(title, body);
			break;
		case "windows":
			notifyWindows(title, body);
			break;
		default:
			notifyOSC777(title, body);
	}
	return protocol;
}

/** Text of the last assistant message, used as the notification body. */
function lastAssistantText(ctx: ExtensionContext): string | undefined {
	const entries = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: string; message?: { role?: string; content?: unknown } };
		const message = entry?.message;
		if (entry?.type !== "message" || message?.role !== "assistant") continue;

		const content = message.content;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) continue;

		const text = content
			.filter(
				(block): block is { type: "text"; text: string } =>
					!!block &&
					typeof block === "object" &&
					(block as { type?: string }).type === "text" &&
					typeof (block as { text?: string }).text === "string",
			)
			.map((block) => block.text)
			.join(" ")
			.trim();
		if (text) return text;
	}
	return undefined;
}

/** Short project label so multiple pi windows are distinguishable. */
const projectLabel = (cwd: string) => cwd.split("/").filter(Boolean).pop() ?? "pi";

export default function (pi: ExtensionAPI) {
	let ctxRef: ExtensionContext | undefined;

	pi.on("session_start", async (_event, ctx) => {
		ctxRef = ctx;
	});

	// Fires after retries / compaction / queued follow-ups are done, i.e. when
	// pi is genuinely idle and waiting on the user.
	pi.on("agent_settled", async (_event, ctx) => {
		ctxRef = ctx;
		notify(`pi · ${projectLabel(ctx.cwd)}`, lastAssistantText(ctx) ?? "Ready for input");
	});

	// Other extensions: pi.events.emit("notify:send", { title?, body? })
	pi.events.on("notify:send", (data) => {
		const payload = (data ?? {}) as { title?: string; body?: string; message?: string };
		const cwd = ctxRef?.cwd ?? process.cwd();
		notify(payload.title ?? `pi · ${projectLabel(cwd)}`, payload.body ?? payload.message ?? "");
	});

	pi.registerCommand("notify", {
		description: "Send a test desktop notification (asks for the text; Enter sends the default)",
		handler: async (args, ctx) => {
			const text = args.trim() || (await askMessage(ctx, "Notification text (Enter for the default test message)"));
			if (text === null) return;
			const protocol = notify(
				`pi · ${projectLabel(ctx.cwd)}`,
				text || "Test notification — notifications are working.",
			);
			ctx.ui.notify(
				`Sent test notification via ${protocol} (TERM_PROGRAM=${process.env.TERM_PROGRAM ?? "unset"})`,
				"info",
			);
		},
	});
}
