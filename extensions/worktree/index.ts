import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { choose } from "../_shared/prompt.ts";

const execFileAsync = promisify(execFile);

// WT_BIN wins, then the copy shipped alongside this extension, then PATH.
// The bundled copy is what makes the extension work on a fresh checkout: a bare
// PATH lookup only resolves for someone who installed the script by hand.
function resolveWt(): string | undefined {
  const pathDirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const candidates = [
    process.env.WT_BIN,
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "wt"),
    ...pathDirs.map((dir) => join(dir, "wt")),
  ].filter((c): c is string => !!c);
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // next candidate
    }
  }
  return undefined;
}

const WT = resolveWt();
const STATUS_KEY = "worktree";
const SPEC_PREFIX = "worktree:";

type Worktree = {
  path: string;
  name: string;
  branch: string;
  dirty: number;
  ahead: number;
  prunable: boolean;
  current: boolean;
  main: boolean;
  pr: number | null;
  prState: string | null;
};

type RunResult = { ok: true; stdout: string } | { ok: false; error: string };

async function run(args: string[], cwd: string, timeoutMs = 300_000): Promise<RunResult> {
  if (!WT) return { ok: false, error: "wt not found" };
  try {
    const { stdout } = await execFileAsync(WT, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: "1" },
    });
    return { ok: true, stdout };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string; code?: string };
    if (e.code === "ENOENT") {
      return { ok: false, error: `${WT} not found on PATH` };
    }
    const detail = (e.stderr || e.stdout || e.message || "").trim();
    return { ok: false, error: detail || "wt failed" };
  }
}

async function list(cwd: string, withPr: boolean): Promise<Worktree[]> {
  const args = withPr ? ["ls", "--json", "--pr"] : ["ls", "--json"];
  const res = await run(args, cwd, 30_000);
  if (!res.ok) throw new Error(res.error);
  return JSON.parse(res.stdout) as Worktree[];
}

function describe(wt: Worktree): string {
  const bits: string[] = [wt.branch];
  if (wt.prunable) bits.push("prunable");
  else {
    bits.push(wt.dirty === 0 ? "clean" : `${wt.dirty} dirty`);
    if (wt.ahead > 0) bits.push(`${wt.ahead} unpushed`);
  }
  if (wt.pr) bits.push(`#${wt.pr} ${wt.prState}`);
  if (wt.main) bits.push("main");
  return `${wt.current ? "* " : "  "}${wt.name.padEnd(24)} ${bits.join("  ")}`;
}

export default function (pi: ExtensionAPI) {
  // Without the CLI there is nothing to wrap. Registering anyway would put a tool
  // in every prompt that can only ever fail, and would block `worktree:` spawns
  // outright rather than letting them run in the parent's checkout.
  if (!WT) {
    pi.on("tool_call", async (event, ctx) => {
      if (event.toolName !== "team_spawn") return;
      const input = event.input as { cwd?: string; name?: string };
      if (!input.cwd?.startsWith(SPEC_PREFIX)) return;
      delete input.cwd;
      ctx.ui.notify(
        `worktree: wt not found, ${input.name ?? "worker"} will run in the current checkout`,
        "warning",
      );
    });
    return;
  }

  const refreshStatus = async (ctx: ExtensionContext) => {
    try {
      const worktrees = await list(ctx.cwd, false);
      const here = worktrees.find((w) => w.current);
      if (!here || here.main) {
        ctx.ui.setStatus(STATUS_KEY, undefined);
        return;
      }
      const dirty = here.dirty === 0 ? "" : ` ~${here.dirty}`;
      ctx.ui.setStatus(STATUS_KEY, `wt:${here.name}${dirty}`);
    } catch {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    await refreshStatus(ctx);
  });

  // Workers spawned without an explicit cwd inherit the orchestrator's checkout and
  // would edit the same working tree concurrently. A cwd of "worktree:<ticket>" is
  // resolved here into a real provisioned worktree before the spawn runs.
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "team_spawn") return;
    const input = event.input as { cwd?: string; name?: string };
    if (!input.cwd?.startsWith(SPEC_PREFIX)) return;

    const spec = input.cwd.slice(SPEC_PREFIX.length).trim();
    const fast = spec.endsWith("+fast");
    const target = (fast ? spec.slice(0, -"+fast".length) : spec).trim();
    if (!target) return { block: true, reason: "worktree: spec is empty" };

    const prMatch = target.match(/^pr\/?#?(\d+)$/i);
    const slug = prMatch ? `pr-${prMatch[1]}` : target.toLowerCase();

    const existing = await run(["path", slug], ctx.cwd, 30_000);
    if (existing.ok && existing.stdout.trim()) {
      input.cwd = existing.stdout.trim();
      ctx.ui.notify(`worktree: reusing ${input.cwd} for ${input.name ?? "worker"}`, "info");
      return;
    }

    const args = prMatch ? ["pr", prMatch[1]] : ["new", target];
    if (fast) args.push("--skip-heavy");
    args.push("--porcelain");
    ctx.ui.notify(
      `worktree: provisioning ${slug} for ${input.name ?? "worker"}${fast ? "" : " (~1 min)"}...`,
      "info",
    );
    const res = await run(args, ctx.cwd);
    if (!res.ok) return { block: true, reason: `worktree: ${res.error}` };

    const path = res.stdout.trim();
    if (!path) return { block: true, reason: "worktree: could not resolve created path" };
    input.cwd = path;
    ctx.ui.notify(`worktree: ${input.name ?? "worker"} -> ${path}`, "info");
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await refreshStatus(ctx);
  });

  pi.registerCommand("wt", {
    description: "Manage git worktrees: pick list, list with PR status, new or clean (or type them)",
    getArgumentCompletions: (prefix: string) => {
      const items = [
        { value: "--pr", label: "--pr  include PR status (slower)" },
        { value: "new", label: "new   create a worktree" },
        { value: "clean", label: "clean prune stale, report merged" },
      ].filter((i) => i.value.startsWith(prefix));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const argv = args.trim().split(/\s+/).filter(Boolean);
      if (argv.length === 0 && ctx.hasUI) {
        const picked = await choose(ctx, "Worktrees", [
          { label: "List worktrees", value: [] as string[] },
          { label: "List with GitHub PR status (slower)", value: ["--pr"] },
          { label: "New worktree…", value: ["new"] },
          { label: "Clean: prune stale, report merged", value: ["clean"] },
        ]);
        if (!picked) return;
        argv.push(...picked.value);
      }

      if (argv[0] === "clean") {
        const res = await run(["clean"], ctx.cwd, 60_000);
        ctx.ui.notify(res.ok ? res.stdout.trim() : res.error, res.ok ? "info" : "error");
        return;
      }

      if (argv[0] === "new") {
        await createFlow(ctx, argv.slice(1).join(" "));
        await refreshStatus(ctx);
        return;
      }

      const withPr = argv.includes("--pr");
      let worktrees: Worktree[];
      try {
        worktrees = await list(ctx.cwd, withPr);
      } catch (err) {
        ctx.ui.notify(`worktree: ${(err as Error).message}`, "error");
        return;
      }

      const NEW = "+ new worktree...";
      const PR = "+ check out a PR...";
      const labels = worktrees.map(describe);
      const choice = await ctx.ui.select("Worktrees", [...labels, NEW, PR]);
      if (!choice) return;

      if (choice === NEW) {
        await createFlow(ctx, "");
        await refreshStatus(ctx);
        return;
      }
      if (choice === PR) {
        const num = await ctx.ui.input("PR number:", "e.g. 1234");
        if (!num) return;
        ctx.ui.notify(`Checking out PR #${num} (this can take ~1 min)...`, "info");
        const res = await run(["pr", num.replace(/^#/, "")], ctx.cwd);
        ctx.ui.notify(res.ok ? res.stdout.trim() : res.error, res.ok ? "info" : "error");
        return;
      }

      const wt = worktrees[labels.indexOf(choice)];
      if (!wt) return;
      await actionFlow(ctx, wt);
      await refreshStatus(ctx);
    },
  });

  async function createFlow(ctx: ExtensionContext, preset: string) {
    let spec = preset;
    if (!spec) {
      const input = await ctx.ui.input("Ticket + description:", "PROJ-123 short description");
      if (!input) return;
      spec = input;
    }
    const parts = spec.trim().split(/\s+/);
    ctx.ui.notify(`Creating worktree for ${parts[0]} (provisioning, can take a minute)...`, "info");
    const res = await run(["new", ...parts, "--porcelain"], ctx.cwd);
    if (!res.ok) {
      ctx.ui.notify(res.error, "error");
      return;
    }
    const path = res.stdout.trim();
    ctx.ui.notify(res.stdout.trim(), "info");
    if (path) ctx.ui.setEditorText?.(`cd ${path}`);
  }

  async function actionFlow(ctx: ExtensionContext, wt: Worktree) {
    const COPY = "copy cd command to editor";
    const REMOVE = "remove worktree";
    const SHOW = "show path";
    const action = await ctx.ui.select(wt.name, [COPY, SHOW, REMOVE]);
    if (!action) return;

    if (action === SHOW) {
      ctx.ui.notify(wt.path, "info");
      return;
    }
    if (action === COPY) {
      ctx.ui.setEditorText?.(`cd ${wt.path}`);
      return;
    }

    if (wt.main) {
      ctx.ui.notify("refusing to remove the main checkout", "error");
      return;
    }
    const warning =
      wt.dirty > 0
        ? `${wt.name} has ${wt.dirty} uncommitted change(s). Remove anyway?`
        : `Remove ${wt.name} (${wt.branch})?`;
    if (!(await ctx.ui.confirm("Remove worktree", warning))) return;

    const deleteBranch = await ctx.ui.confirm("Delete branch", `Also delete '${wt.branch}'?`);
    const res = await run(
      ["rm", "-y", deleteBranch ? "--delete-branch" : "--keep-branch", wt.path],
      ctx.cwd,
      60_000,
    );
    ctx.ui.notify(res.ok ? res.stdout.trim() : res.error, res.ok ? "info" : "error");
  }

  pi.registerTool({
    name: "worktree",
    label: "Worktree",
    description:
      "Manage provisioned git worktrees of this repo. Use 'list' to see existing worktrees, " +
      "'create' to make an isolated checkout for a ticket, 'path' to resolve one by name, " +
      "and 'remove' to delete one. Created worktrees are provisioned from the repo's worktree " +
      "profile (shared config linked, per-branch state cloned) and can be used immediately via " +
      "'cd <path> && ...' in bash.",
    promptSnippet: "Create and manage isolated git worktrees for parallel work",
    promptGuidelines: [
      "Use worktree with action 'create' when work on a different ticket must not disturb the " +
        "current checkout; then run commands inside it with 'cd <path> && ...'.",
      "Do not use worktree remove without the user explicitly asking.",
    ],
    parameters: Type.Object({
      action: StringEnum(["list", "create", "path", "remove"] as const),
      ticket: Type.Optional(
        Type.String({
          description: "Ticket ID or existing branch name (with a slash) for create, e.g. PROJ-123",
        }),
      ),
      description: Type.Optional(
        Type.String({ description: "Short description appended to the branch name" }),
      ),
      name: Type.Optional(
        Type.String({ description: "Worktree name or path for path/remove" }),
      ),
      skipHeavy: Type.Optional(
        Type.Boolean({
          description:
            "Skip cloning the profile's heavy paths (e.g. dependency folders) on create; much faster",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const fail = (text: string) => ({
        content: [{ type: "text" as const, text }],
        isError: true,
        details: {},
      });

      switch (params.action) {
        case "list": {
          const res = await run(["ls"], ctx.cwd, 30_000);
          return res.ok
            ? { content: [{ type: "text", text: res.stdout.trim() }], details: {} }
            : fail(res.error);
        }
        case "create": {
          if (!params.ticket) return fail("ticket is required for create");
          const args = ["new", params.ticket];
          if (params.description) args.push(...params.description.split(/\s+/));
          if (params.skipHeavy) args.push("--skip-heavy");
          args.push("--porcelain");
          const res = await run(args, ctx.cwd);
          if (!res.ok) return fail(res.error);
          const path = res.stdout.trim();
          return {
            content: [{ type: "text", text: res.stdout.trim() }],
            details: { path },
          };
        }
        case "path": {
          if (!params.name) return fail("name is required for path");
          const res = await run(["path", params.name], ctx.cwd, 30_000);
          return res.ok
            ? { content: [{ type: "text", text: res.stdout.trim() }], details: {} }
            : fail(res.error);
        }
        case "remove": {
          if (!params.name) return fail("name is required for remove");
          // No -y: wt refuses to discard a dirty worktree for a non-TTY caller.
          const res = await run(["rm", "--keep-branch", params.name], ctx.cwd, 60_000);
          return res.ok
            ? { content: [{ type: "text", text: res.stdout.trim() }], details: {} }
            : fail(res.error);
        }
      }
    },
  });
}
