import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA = path.join(os.homedir(), "Documents/knowledge-base-remote/Pi/voice");
const STATE = path.join(DATA, "state.json");
const INBOX = path.join(DATA, "inbox");
const ALIGN = path.join(os.homedir(), ".pi/agent/skills/tiger-voice/ALIGN.md");
const REMIND_AFTER_DAYS = 7;
const ALIGN_PROMPT = `Run a writing-voice alignment: read ${ALIGN} and follow it.`;

const today = () => new Date().toISOString().slice(0, 10);

function readState(): { last_aligned?: string | null } {
	try {
		return JSON.parse(fs.readFileSync(STATE, "utf8"));
	} catch {
		return {};
	}
}

function pendingCount(): number {
	try {
		return fs.readdirSync(INBOX).filter((f) => f.endsWith(".json")).length;
	} catch {
		return 0;
	}
}

function daysSinceAligned(): number | null {
	const last = readState().last_aligned;
	if (!last) return null;
	return Math.floor((Date.now() - new Date(last).getTime()) / 86_400_000);
}

function claimTodaysReminder(): boolean {
	fs.mkdirSync(DATA, { recursive: true });
	const stamp = path.join(DATA, `.reminded-${today()}`);
	try {
		fs.closeSync(fs.openSync(stamp, "wx"));
	} catch {
		return false;
	}
	for (const f of fs.readdirSync(DATA)) {
		if (f.startsWith(".reminded-") && f !== path.basename(stamp)) fs.rmSync(path.join(DATA, f), { force: true });
	}
	return true;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		const days = daysSinceAligned();
		if (days !== null && days < REMIND_AFTER_DAYS) return;
		if (!claimTodaysReminder()) return;
		const when = days === null ? "You haven't run a voice alignment yet" : `Last voice alignment was ${days} days ago`;
		ctx.ui.notify(`${when} (${pendingCount()} items already in the inbox). Run /voice-align when you have 10 minutes.`, "info");
	});

	pi.registerCommand("voice-align", {
		description: "Harvest what you posted, review proposed writing-voice changes, update the tiger-voice skill",
		handler: async (_args, ctx) => {
			if (ctx.isIdle()) {
				pi.sendUserMessage(ALIGN_PROMPT);
			} else {
				pi.sendUserMessage(ALIGN_PROMPT, { deliverAs: "followUp" });
				ctx.ui.notify("Voice alignment queued after the current turn", "info");
			}
		},
	});
}
