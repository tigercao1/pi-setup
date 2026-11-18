import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const POLL_MS = Number(process.env.NO_SLEEP_POLL_MS ?? 15_000);
// Backstop for a marker that outlives every event and idle check, e.g. an
// agent run wedged on a network call that never settles.
const MAX_HOLD_MS = Number(process.env.NO_SLEEP_MAX_HOLD_MS ?? 90 * 60 * 1000);

const ACTIVE_DIR =
  process.env.PI_CAFFEINATE_ACTIVE_DIR ?? join(homedir(), ".pi/agent/run/active");
const TMP_DIR = dirname(ACTIVE_DIR);
const TEAMS_DIR = process.env.PI_CAFFEINATE_TEAMS_DIR ?? join(homedir(), ".pi/orchestrator-teams");
const CAFFEINATE = process.env.NO_SLEEP_CAFFEINATE_BIN ?? "caffeinate";
const SELF_HOLD = process.env.NO_SLEEP_SELF_HOLD !== "0";
const PI_COMMS = new Set(["pi", "node"]);

export type HoldMode = "dis" | "is" | "";

/** Pids from `pids` that are alive and running pi (or node), so a recycled pid never holds the machine awake. */
export function livePiPids(pids: number[]): Set<number> {
  const alive = pids.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  if (alive.length === 0) return new Set();
  let out = "";
  try {
    out = execFileSync("ps", ["-o", "pid=,comm=", "-p", alive.join(",")], { encoding: "utf8", timeout: 5_000 });
  } catch (err) {
    out = String((err as { stdout?: string }).stdout ?? "");
  }
  const live = new Set<number>();
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(.+)$/);
    if (m && PI_COMMS.has(basename(m[2]!.trim()))) live.add(Number(m[1]));
  }
  return live;
}

/** `name(pid)` for each live headless agent in the orchestrator teams led by `leadPid`. */
export function liveSpawnedAgents(teamsDir: string, leadPid: number): string[] {
  let teams: string[] = [];
  try {
    teams = readdirSync(teamsDir);
  } catch {
    return [];
  }
  const agents: { name: string; pid: number }[] = [];
  for (const team of teams) {
    let config: { leadPid?: unknown; agents?: unknown };
    try {
      config = JSON.parse(readFileSync(join(teamsDir, team, "config.json"), "utf8"));
    } catch {
      continue;
    }
    if (config.leadPid !== leadPid || !Array.isArray(config.agents)) continue;
    for (const agent of config.agents as { name?: unknown; paneId?: unknown; killedAt?: unknown }[]) {
      const pane = typeof agent?.paneId === "string" ? agent.paneId : "";
      if (!pane.startsWith("pid:") || agent.killedAt) continue;
      const pid = Number.parseInt(pane.slice(4), 10);
      if (Number.isFinite(pid) && pid > 0) agents.push({ name: String(agent.name ?? "?"), pid });
    }
  }
  const live = livePiPids(agents.map((a) => a.pid));
  return [...new Set(agents.filter((a) => live.has(a.pid)).map((a) => `${a.name}(${a.pid})`))].sort();
}

export function holdMode(midTurn: boolean, agents: string[]): HoldMode {
  if (midTurn) return "dis";
  return agents.length > 0 ? "is" : "";
}

export default function (pi: ExtensionAPI) {
  if (process.platform !== "darwin") return;

  // Subagents get piped stdio; their lead holds the assertion for them.
  // NO_SLEEP_FORCE exists so the logic can be exercised in print mode.
  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!isInteractive && !process.env.NO_SLEEP_FORCE) return;

  const marker = join(ACTIVE_DIR, String(process.pid));
  let heldSince = 0;
  let poll: NodeJS.Timeout | undefined;
  let caff: ChildProcess | undefined;
  let caffMode: HoldMode = "";

  const release = () => {
    const child = caff;
    caff = undefined;
    caffMode = "";
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill();
      } catch {
        // already gone
      }
    }
  };

  const hold = (mode: Exclude<HoldMode, "">) => {
    try {
      const child = spawn(CAFFEINATE, [`-${mode}`, "-w", String(process.pid)], { stdio: "ignore" });
      child.on("error", () => {
        if (caff === child) {
          caff = undefined;
          caffMode = "";
        }
      });
      child.on("exit", () => {
        if (caff === child) {
          caff = undefined;
          caffMode = "";
        }
      });
      child.unref();
      caff = child;
      caffMode = mode;
    } catch {
      caff = undefined;
      caffMode = "";
    }
  };

  const reconcile = () => {
    if (!SELF_HOLD) return;
    const mode = holdMode(heldSince > 0, heldSince > 0 ? [] : liveSpawnedAgents(TEAMS_DIR, process.pid));
    if (caff && caffMode !== mode) release();
    if (mode && !caff) hold(mode);
  };

  const removeMarker = () => {
    heldSince = 0;
    try {
      rmSync(marker, { force: true });
    } catch {
      // already gone
    }
  };

  const stop = (_why: string) => {
    removeMarker();
    reconcile();
  };

  const start = () => {
    if (heldSince) return;
    const tmp = join(TMP_DIR, `${process.pid}.${Date.now()}.tmp`);
    heldSince = Date.now();
    try {
      mkdirSync(ACTIVE_DIR, { recursive: true });
      const body = JSON.stringify({
        pid: process.pid,
        cwd: process.cwd(),
        startedAt: new Date().toISOString(),
      });
      writeFileSync(tmp, `${body}\n`, { mode: 0o644 });
      renameSync(tmp, marker);
    } catch {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // best effort
      }
    }
    reconcile();
  };

  // The events are the fast path; this is what makes a missed event survivable.
  // Correctness now depends on polled state rather than on any event arriving.
  const startPolling = (ctx: ExtensionContext) => {
    if (poll) clearInterval(poll);
    poll = setInterval(() => {
      if (heldSince && ctx.isIdle()) {
        stop("idle");
        return;
      }
      if (heldSince && Date.now() - heldSince > MAX_HOLD_MS) {
        stop("max-hold");
        return;
      }
      reconcile();
    }, POLL_MS);
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
    removeMarker();
    release();
  });

  process.on("exit", () => {
    removeMarker();
    release();
  });
}
