import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const IDLE_POLL_MS = 15_000;
// Backstop for a marker that outlives every event and idle check, e.g. an
// agent run wedged on a network call that never settles.
const MAX_HOLD_MS = Number(process.env.NO_SLEEP_MAX_HOLD_MS ?? 90 * 60 * 1000);

const ACTIVE_DIR =
  process.env.PI_CAFFEINATE_ACTIVE_DIR ?? join(homedir(), ".pi/agent/run/active");
const TMP_DIR = dirname(ACTIVE_DIR);

export default function (pi: ExtensionAPI) {
  if (process.platform !== "darwin") return;

  // Subagents get piped stdio; the launchd watcher already covers spawned
  // teammates. NO_SLEEP_FORCE exists so the logic can be exercised in print mode.
  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!isInteractive && !process.env.NO_SLEEP_FORCE) return;

  const marker = join(ACTIVE_DIR, String(process.pid));
  let heldSince = 0;
  let poll: NodeJS.Timeout | undefined;

  const stop = (_why: string) => {
    heldSince = 0;
    try {
      rmSync(marker, { force: true });
    } catch {
      // already gone
    }
  };

  const start = () => {
    if (heldSince) return;
    const tmp = join(TMP_DIR, `${process.pid}.${Date.now()}.tmp`);
    try {
      mkdirSync(ACTIVE_DIR, { recursive: true });
      const body = JSON.stringify({
        pid: process.pid,
        cwd: process.cwd(),
        startedAt: new Date().toISOString(),
      });
      writeFileSync(tmp, `${body}\n`, { mode: 0o644 });
      renameSync(tmp, marker);
      heldSince = Date.now();
    } catch {
      heldSince = 0;
      try {
        rmSync(tmp, { force: true });
      } catch {
        // best effort
      }
    }
  };

  // The events are the fast path; this is what makes a missed event survivable.
  // Correctness now depends on polled state rather than on any event arriving.
  const startPolling = (ctx: ExtensionContext) => {
    if (poll) clearInterval(poll);
    poll = setInterval(() => {
      if (!heldSince) return;
      if (ctx.isIdle()) {
        stop("idle");
        return;
      }
      if (Date.now() - heldSince > MAX_HOLD_MS) {
        stop("max-hold");
      }
    }, IDLE_POLL_MS);
    poll.unref?.();
  };

  pi.on("session_start", (_event, ctx) => {
    stop("session_start");
    startPolling(ctx);
  });

  pi.on("agent_start", () => {
    start();
  });

  pi.on("agent_end", () => {
    stop("agent_end");
  });

  // agent_end fires per low-level run; agent_settled means pi will not continue
  // on its own. Both stop, so an aborted or errored run still releases.
  pi.on("agent_settled", () => {
    stop("agent_settled");
  });

  // A blocking prompt means pi is waiting on a human, not working. Holding the
  // machine awake through an unattended dialog is how a hold lasts for days.
  pi.on("ui_prompt_start", () => {
    stop("ui_prompt");
  });

  pi.on("ui_prompt_end", (_event, ctx) => {
    if (!ctx.isIdle()) start();
  });

  pi.on("session_shutdown", () => {
    if (poll) clearInterval(poll);
    poll = undefined;
    stop("session_shutdown");
  });

  process.on("exit", () => stop("process_exit"));
}
