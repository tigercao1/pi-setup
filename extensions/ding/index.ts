/**
 * Ding — plays a short pitched tick at the end of every agent turn.
 *
 * Each pi process picks its own pitch from a 10-note scale derived from
 * `process.pid`, so several concurrent pi instances are distinguishable by ear.
 *
 * macOS only (uses the built-in `afplay`); a no-op elsewhere.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SOUND = "/System/Library/Sounds/Tink.aiff";

// 10 rates log-spaced from 0.5x to 4.0x — each step is 400 cents (a major third).
const RATES = Array.from({ length: 10 }, (_, i) =>
	Number((0.5 * (8 ** (i / 9))).toFixed(3)),
);

const RATE = RATES[process.pid % RATES.length];

const enabled = process.platform === "darwin" && existsSync(SOUND);

function ding(): void {
	if (!enabled) return;
	execFile("afplay", ["-r", String(RATE), SOUND], () => {
		// Best effort: ignore playback failures.
	});
}

export default function (pi: ExtensionAPI) {
	pi.on("agent_settled", async () => {
		ding();
	});

	pi.registerCommand("ding", {
		description: "Play this process's ding sound (pitch slot check)",
		handler: async (_args, ctx) => {
			ding();
			const slot = process.pid % RATES.length;
			ctx.ui.notify(
				enabled
					? `ding: slot ${slot} · rate ${RATE}x (pid ${process.pid})`
					: "ding: disabled (macOS + afplay required)",
				"info",
			);
		},
	});
}
