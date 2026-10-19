/**
 * TUI rendering for mail delivered as a custom message.
 *
 * Mail arrives via `pi.sendMessage`, so it participates in LLM context and
 * needs a renderer to look like anything but a wall of text. Collapsed, it is a
 * one-line summary; expanded, the full body.
 *
 * Each sender gets a stable colour derived from its name, so you can tell who
 * is talking without reading the header.
 */

import { Text } from "@earendil-works/pi-tui";

/** Colour-blind-safe palette drawn from theme roles pi is known to define. */
const SENDER_COLORS = ["accent", "success", "warning", "info", "error"] as const;

function senderColor(name: string): string {
	let hash = 0;
	for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
	return SENDER_COLORS[hash % SENDER_COLORS.length] as string;
}

function firstLine(body: string, max = 100): string {
	const line = (body.split("\n").find((l) => l.trim() !== "") ?? "").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

interface MailDetails {
	count?: number;
	from?: string[];
	kinds?: string[];
}

type ThemeLike = { fg: (color: never, text: string) => string };

export type MailRenderer = (
	message: { content?: string; details?: unknown },
	options: { expanded?: boolean; outputPad?: number },
	theme: ThemeLike,
) => Text;

/**
 * Build a renderer for one custom mail type.
 *
 * Kept defensive: `details` is data written by another process, so every field
 * is treated as optional.
 */
export function createMailRenderer(fallbackLabel: string): MailRenderer {
	return (message, options, theme) => {
		const pad = options.outputPad ?? 0;
		const body = typeof message.content === "string" ? message.content : "";
		const details = (message.details ?? {}) as MailDetails;
		const senders = Array.isArray(details.from) ? details.from : [];
		const count = typeof details.count === "number" ? details.count : 1;
		const kinds = Array.isArray(details.kinds) ? details.kinds : [];

		const label = senders.length > 0 ? senders.join(", ") : fallbackLabel;
		const color = senderColor(senders[0] ?? label);
		const rail = theme.fg(color as never, "▌");
		const badge =
			count > 1
				? theme.fg("warning" as never, ` ${count} messages `)
				: kinds.includes("shutdown")
					? theme.fg("warning" as never, " shutdown ")
					: kinds.includes("handback")
						? theme.fg("success" as never, " handback ")
						: "";

		if (!options.expanded) {
			// Collapsed: one line. The body already begins with its own header line
			// (e.g. "▌ message from @worker"), so summarise from the text after it.
			const lines = body.split("\n").filter((l) => l.trim() !== "");
			const summary = firstLine(lines.slice(1).join("\n") || body);
			return new Text(
				`${rail} ${theme.fg(color as never, label)}${badge} ${theme.fg("dim" as never, summary)}`,
				pad,
				0,
			);
		}

		const rendered = body
			.split("\n")
			.map((line) => `${rail} ${line}`)
			.join("\n");
		return new Text(rendered, pad, 0);
	};
}
