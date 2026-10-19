/**
 * Optional bridge to the session-fork registry.
 *
 * A teammate is, structurally, a fork of the lead's session tree: it has a
 * parent session, its own transcript, and a pane. Publishing agents into
 * `~/.pi/session-forks` therefore makes `/forks` a single view of "every pi
 * process related to this one", instead of two half-views (`/agents` for
 * teammates, `/forks` for your own branches).
 *
 * Deliberately best effort and dynamically imported: agent-orchestrator must
 * keep working with session-fork uninstalled, and a spawned worker runs with
 * `--no-extensions` so it can never publish for itself.
 */

import { logPath } from "./state.ts";
import { pidFilePath } from "./backend.ts";
import type { AgentRecord } from "./state.ts";

export interface PublishInput {
	team: string;
	agent: AgentRecord;
	sessionId: string;
	sessionFile?: string;
	argv: string[];
	/** The lead's own session id, so the agent hangs off it in the tree. */
	leadSessionId?: string;
	piBin?: string;
}

export async function publishAgent(input: PublishInput): Promise<void> {
	try {
		const registry = await import("../session-fork/registry.ts");
		registry.ensureRegistryDirs();
		const now = new Date().toISOString();
		const key = `agent-${input.team}-${input.agent.name}`;
		const previous = registry.readRecord(key);
		registry.writeRecord({
			...previous,
			key,
			sessionId: input.sessionId,
			sessionFile: input.sessionFile,
			name: `${input.team}:${input.agent.name}`,
			label: input.agent.role,
			cwd: input.agent.cwd,
			pidFile: pidFilePath(input.team, input.agent.name),
			logFile: logPath(input.team, input.agent.name),
			backend: input.agent.backend,
			paneId: input.agent.paneId ?? undefined,
			parentKey: input.leadSessionId ? `s-${input.leadSessionId}` : undefined,
			parentSessionId: input.leadSessionId,
			piBin: input.piBin ?? process.env.PI_ORCH_PI_BIN ?? "pi",
			argv: input.argv,
			createdAt: previous?.createdAt ?? input.agent.createdAt ?? now,
			lastSeenAt: now,
		});
	} catch {
		// session-fork is not installed, or its registry moved. Not an error:
		// teams work perfectly well without the shared view.
	}
}
