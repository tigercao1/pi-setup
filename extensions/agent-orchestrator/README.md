# agent-orchestrator

Hierarchical multi-agent teams for pi. Your session becomes a **lead** that spawns teammate agents
as real, separate pi processes — in tmux panes, iTerm2 panes, or headless background processes —
and coordinates them through files.

The lead stays responsive the whole time. Unlike a blocking subagent call, `team_spawn` returns as
soon as the teammate starts.

```
lead (your session)
 └─ sub-orchestrator   canSpawn=true, coordinates a sub-team
     └─ worker         canSpawn=false, leaf task executor
```

## Why

- **Parallelism** — N teammates working at once, each with its own context window.
- **Context hygiene** — a worker's raw tool output never enters your window; you read its
  deliverable file instead.
- **Durable assignments** — the task lives in the teammate's *system prompt*, so it survives
  context compaction.
- **Visibility** — teammates run in panes you can watch and type into.

## Install

Nothing to install: the directory lives at `~/.pi/agent/extensions/agent-orchestrator/` and pi
auto-discovers it. Verify with `/help` (look for `/agents`, `/team`, `/orch`) or by asking the model
to call `team_status`.

Optional dev deps for typechecking and tests:

```bash
cd ~/.pi/agent/extensions/agent-orchestrator
npm install
npm run typecheck
npm test        # model-free smoke test
```

## Backends

Detected automatically, no configuration:

| Backend | When | Behaviour |
|---|---|---|
| `tmux` | `$TMUX` is set and `tmux` is on PATH | visible agents get a split pane; headless agents get a hidden window |
| `iterm2` | macOS + iTerm2 | visible agents get a real pane via AppleScript |
| `headless` | everything else | detached background process, output to `logs/<agent>.log` |

Override with `PI_ORCH_BACKEND=tmux|iterm2|headless`.

### Visible vs. headless — the one thing worth understanding

- **Visible** agents run interactive pi. After finishing a turn they idle in their pane, so they can
  wait for messages and for their own children.
- **Headless** agents run `pi --mode json`: one agent loop, then the process exits. Perfect for a
  worker (do the task, write the file, report, die), but a *sub-orchestrator* cannot wait for
  children this way. `team_spawn` warns when you ask for that combination.

JSON mode is deliberate: it makes the log a live event stream, so you can watch a headless agent's
tool calls as they happen. Print mode (`-p`) would emit only the final answer, making a busy worker
indistinguishable from a hung one.

Defaults: workers headless, sub-orchestrators visible. Override per spawn with `visible`.

## Tools

Availability is gated by role, so a worker literally cannot spawn or kill anything.

| Tool | Roles | Purpose |
|---|---|---|
| `team_spawn` | lead, sub-orch | Spawn a teammate. `name`, `task`, `canSpawn`, `model`, `provider`, `thinkingLevel`, `profile`, `extensions`, `slim`, `visible`, `cwd`, `taskContract` |
| `team_status` | lead, sub-orch | Agent tree with live process state, staleness (>10 min), attention requests, and ready deliverables |
| `team_diagnose` | lead, sub-orch | Last N lines of an agent's pane/log output |
| `team_message` | all | Message one agent by name |
| `team_broadcast` | all | Message every other agent |
| `team_request_shutdown` | lead, sub-orch | Ask an agent to finish and exit gracefully |
| `team_force_shutdown` | lead, sub-orch | Kill an agent and cascade to its descendants |
| `team_recycle` | lead, sub-orch | Kill + respawn under the same name, seeded with its handoff |
| `team_evaluate` | lead, sub-orch | Spawn an evaluator that grades deliverables against their contracts |
| `team_cleanup` | lead, sub-orch | Kill everything, remove the team directory (`keepFiles` to retain logs) |
| `team_write_status` | all | Report `active` / `done` / `stuck` / `error` + output path |
| `team_write_handoff` | all | Write a handoff report before context recycling |
| `team_attention` | non-lead | Ask the *direct* parent for input at low / medium / high urgency |
| `team_ask` | lead, sub-orch | One-shot question into a finished agent's saved session (`name`, `question`, `timeoutSeconds` per attempt; `dismiss: true` clears its unanswered entries) |

### team_ask always says whether it got an answer

A resumed `pi -p` turn cannot report back later, so `team_ask` frames every question as a one-shot
reply ("no later turn… put the complete answer in this reply"). The reply is then checked: a
timeout, a signal, a non-zero exit, an empty reply (which is also what a turn ending on a tool
call prints), or a reply that only promises work ("I've started…", "I'll return a verdict") is
a non-answer. A non-answer is re-asked once, in the same session, with a stricter prompt that
quotes it. If that fails too, the result starts with `NO ANSWER: <reason>` and has
`details.answered: false`. Every ask is recorded in `<team>/asks.json`; `team_status` and the
widget show `⚠ ask → <agent>: no answer (<reason>)` until a later ask to that agent is answered or
it is dismissed. The deferral check is a regex heuristic (`ask.ts` `findDeferral`), not a model
call.

## The manager pattern

For a wide fan-out, put a **manager** between the lead and the workers:

```
lead ──> manager ──> worker x N
         (awaits, verifies, synthesises)
```

`team_spawn({ name: "manager", profile: "manager", task: "..." })`

What it buys you that batching does not: **the workers' raw output never enters the lead's
context**. Batching fixes *when* you are interrupted; a manager fixes *how much* reaches the lead.
The manager absorbs N verbose reports and hands up one synthesised answer with deliverable paths.

**The lifecycle trap.** A headless agent runs one agent loop and exits, so a manager that spawns
children and ends its turn dies before they report — measured: manager dead at t+10s, its helper's
reply orphaned. `team_await` is the fix: one blocking call that parks the manager alive until its
children settle, then returns their states and deliverable paths. Polling `team_status` in a loop
does not work — the process can exit between calls, and it burns the manager's context.

```
team_spawn x N  →  team_await({})  →  read deliverables  →  team_verify  →  one report upward
```

`team_await` takes a timeout (default 900s) so one stuck worker cannot hang the manager forever;
it returns with the stragglers named.

**When it is worth it:** 4+ workers, verbose output, or work needing verification and re-spawning
below the lead. **When it is not:** two or three workers (the manager costs a strong-model agent and
adds latency), or when you want to watch progress live.

## Recycling agents

A team's agent list only ever grew. After a few batches the widget was mostly headstones — finished
agents crowding out the handful still running — and the only way to clear them was to tear down the
whole team.

**Reaping** is the middle ground. An agent is recycled out of the tree when it is (1) not alive,
(2) in a terminal state, and (3) older than a retention window. Before removal its final status,
deliverable path, task and session id are appended to `<team>/archive/agents.jsonl`, so reaping
never destroys the answer to "what did that worker produce?".

| Trigger | When |
|---|---|
| automatic | every widget tick (3s) and before every spawn |
| cap | oldest terminal agents reaped once a team exceeds `team.maxAgents` (default 40) |
| manual | `team_reap({ olderThanMinutes })`, or `R` in `/agents` |

An agent with live descendants is never reaped — pruning a parent would orphan the subtree and lose
the path back to running processes.

**Liveness is identity-checked.** Pids get recycled: a team from two weeks ago can name a pid that
now belongs to an unrelated process. `isAlive` compares the process's start time against when the
pid was recorded, so a recycled pid reads as dead — otherwise abandoned teams look alive forever and
`killAgent` becomes a loaded gun aimed at whatever inherited the number.

**Log reading is incremental.** Agent logs are JSONL event streams that reach tens of megabytes.
The digest parses only the bytes appended since the last read (~0ms per tick instead of ~30ms per
agent on a 9MB log), and resets when a log is truncated by a respawn.

**Sweeping** handles disk: on lead startup, team directories older than `team.teamRetentionDays`
(default 7) whose lead process is gone and which have no live agent are deleted. A team whose lead
is alive, or that still has a live agent, is never touched, so concurrent sessions are safe.

## Concurrency caps

Every agent is a full pi process. One unbounded fan-out (a sub-orchestrator spawning eight managers,
each spawning its own workers) once ran ~27 at once on a laptop. Spawns are now capped in code:

| Setting | Default | Meaning |
|---|---|---|
| `team.maxChildrenPerParent` | 5 | live direct children of one parent (lead or sub-orchestrator) |
| `team.maxLiveAgents` | 8 | live agents in one team, lead excluded |
| `team.maxDepth` | 3 | levels below the lead (the lead's children are level 1) |
| `team.queueSpawns` | `true` | queue a spawn that hits a count cap; `false` refuses it instead |

"Live" means not killed, not `done`/`error`/`queued`, and either the process is alive or the spawn
reserved its slot under a minute ago. A visible manager idling after `done` does not hold a slot.
The count and the reservation happen under the team-config lock, so concurrent spawners cannot
both take the last slot.

A spawn that hits `maxChildrenPerParent` or `maxLiveAgents` returns `Queued …` naming the cap and
the counts. It appears in the tree as `⧗ queued`, `team_await` waits for it, and mail sent to it
waits in its mailbox. Every orchestrator process in the team runs a queue pump (every 3s,
`PI_ORCH_QUEUE_POLL_MS`), which starts entries oldest-first under their original parent once they
fit; entries are claimed by atomic rename, so two pumps never launch the same one. An entry whose
parent finished or died first is cancelled (`killed`, with a note). `maxDepth` refuses outright,
since waiting cannot help; a `canSpawn` child at the last allowed level is spawned as a worker.

`team_verify` skeptics and `team_ask` start short-lived pi processes outside `team_spawn` and are
not counted.

## Per-level status and reporting

Each orchestrator session sees its own level of the tree:

- **Widget.** Every orchestrator session with a UI (the lead, and sub-orchestrators in visible
  panes) shows a widget rooted at itself: its direct children, each with a rolled-up tally of its
  own subtree (`● u1-mgr  [2▶ 1✔]`). The lead no longer lists grandchildren. Reaping stays with
  the lead.
- **`team_status`** defaults to the caller's subtree, one level deep with rollups. `depth: N`
  expands further; `scope: "team"` shows the whole tree from the lead. `/team` shows the caller's
  full subtree.
- **Reports go to the spawning parent.** Attention requests, exit-without-done notices, startup
  crash reports and the watchdog were already addressed to the direct parent. In addition, a
  `team_message` from a non-lead agent to an ancestor above its parent is rerouted to the parent;
  `team_broadcast` reaches the sender's subtree and siblings, never up the chain; and
  `team_recycle` keeps the original parent instead of re-parenting under the caller.

## Widget bounding

The widget shows at most `team.widgetRows` direct children (default 6), chosen by priority — stuck, then
failed, then live, then most-recently finished — with `+N more` accounting for the rest. Rows are
clipped to the real terminal width, so a long status note cannot wrap and double the widget's
height. The header tally covers every tracked agent, including hidden ones.

Two rules keep the displays honest, both learned from a bug report:

- **Outcome outranks teardown.** `killedAt` records how a process was stopped, not what it achieved;
  a worker that reported `done` and was later cleaned up renders ✔, not ✖.
- **Counts and rows come from one function.** The widget once showed `0▶ 0✔ 0⚠ 0✖` above five
  rendered agents, because the tally skipped killed agents while the rows did not.

| Setting | Default | Meaning |
|---|---|---|
| `team.widgetRows` | 6 | agent rows before `+N more` |
| `team.reapAfterMinutes` | 10 | retention before a finished agent leaves the tree |
| `team.maxAgents` | 40 | hard cap on tracked agents |
| `team.teamRetentionDays` | 7 | age before an abandoned team directory is swept |

## Verification: the verifier node

`team_verify({ finding, sources, context })` runs an adversarial, majority-vote check on **one
claim** before it reaches your answer.

```
▸ VERIFIER NODE
INPUT    one finding — never the worker's chat, reasoning, or confidence
CONTEXT  fresh and empty; it has not seen the work it judges
CHECKS   three skeptics in parallel, one question each
           1. is it correct?      does the claim hold up when re-derived
           2. is it current?      is the evidence recent, or stale
           3. is the source real? does the citation resolve to what it is cited for
PASS     kept only if a majority (2 of 3) let it live
FAIL     dropped before it reaches the final answer
```

Each skeptic is a separate OS process launched with `--no-extensions --no-skills
--no-context-files --no-session` and no team identity. Three processes rather than one agent asking
itself three questions: in a single context the first judgement anchors the rest, so agreement
would be momentum rather than evidence.

Design choices that matter:

- **Hostile by default.** The prompt says the default answer is FAIL and that absence of evidence
  against a claim is not evidence for it.
- **Inconclusive counts as FAIL.** A skeptic that crashes, times out, or rambles cannot rescue a
  claim by staying silent.
- **The finding only.** A worker's narrative is the most persuasive and least reliable input to a
  review — one worker asserted "all 20 symbols fetched, no nulls" while its own data held seven.
- **Blocking on purpose.** Verification is a decision point, not background work.

The `verifier` profile (`openai/gpt-5.5`, thinking `high`, `skills: []`, `contextFiles: false`)
is deliberately bare so it cannot inherit the framing that shaped the work.

```bash
node --experimental-strip-types tests/live-verify.mjs   # true claim survives, false claim dies
```

## Commands

| Command | Description |
|---|---|
| `/agents` | Interactive tree overlay (lead only). Navigate: `↑↓/jk`. Act on the selected agent: `⏎` focus its pane, `o` open its session in a new pane (observer), `c` continue *as* it (re-attach its identity), `f` fork its transcript into a new agent, `y` copy the resume command into the editor, `d` peek at output, `x` kill, `r` refresh, `q` close |
| `/team` | Text tree of the team, any role |
| `/orch [auto\|1-tier\|2-tier]` | Pick the orchestration level from a list, or type it (persisted to `settings.json`). Esc, or no UI, just shows the current level |

A widget above the editor and a footer entry show live counts (`▶` active, `✔` done, `⚠` stuck,
`✖` error) while a team is running.

## Staying unblocked, and watching the team

**The lead is never blocked by design:**

- `team_spawn` returns in milliseconds — it launches a process, it does not wait for it.
- Teammates are separate OS processes with their own context windows.
- Their messages come back through the mailbox and are injected with `deliverAs: "followUp"` +
  `triggerTurn: true`: never interrupting a tool call, but waking an idle lead automatically.

So after spawning, the correct move is to **end the turn**. You get your prompt back and can keep
working; when a teammate finishes, the lead wakes up on its own and reports. The one way to break
this is for the lead to `sleep` or poll `team_status` in a loop — that pins the session for no
reason, so `team_spawn`'s tool guidelines and its return value both tell the model not to.

**Watching what each agent is doing:**

| Where | What you see |
|---|---|
| Widget above the editor | one line per agent, live: `● market-desk  bash…  7 calls  $0.032 — <status note>` |
| `/agents` | interactive tree, self-refreshing every 2s; `d` peeks at recent activity, `⏎` focuses a pane, `o`/`c`/`f` open, re-attach or fork its session, `x` kills |
| `/team` | text tree on demand, any role |
| `team_diagnose(name)` | activity digest for the model: recent tool calls, what the agent said, spend. `raw: true` for the unparsed log |
| `logs/<agent>.log` | the raw JSON event stream, `tail -f`-able |

Example digest from a live worker:

```
t+12s  [bash…  5 calls  $0.020]
        ▸ bash sleep 4 && df -h /
        ▸ bash ls /tmp | head -3
        · Now I'll write the deliverable with all three command outputs:
        ▸ write /private/tmp/probe_output.txt
```

## Usage

Just ask. Some prompts that work well:

> Spawn three workers to audit `src/`, `tests/`, and `docs/` for stale references to the old API,
> each writing findings to its own file, then summarise.

> Spawn a teammate to review the changes on this branch while I keep working.

> Execute this 4-step plan, one fresh worker per step, so no worker's context bleeds into the next.

Explicit call:

```
team_spawn({
  name: "api-audit",
  task: "Find every call site of `legacyFetch` under src/ and write a table of file:line -> replacement to /tmp/audit.md. Do not change code.",
  taskContract: { outputPath: "/tmp/audit.md", outputFormat: "markdown",
                  evaluationCriteria: ["every call site listed", "no code modified"] }
})
```

### Rules the roles follow

Each spawned agent gets a role guide injected into its system prompt (`skills/{lead,orchestrator,worker}/SKILL.md`):

- one agent = one deliverable file; never two agents writing the same file
- workers report `done` with an output path, then message their parent
- attention requests only ever reach the *direct* parent
- orchestrators synthesise, they never forward raw child output
- evaluate only after a whole batch is done

## Slim mode

`slim: true` (default) launches the teammate with `--no-extensions --no-skills --no-context-files`
and loads only this extension, plus anything in `extensions`. Without it, a 10-agent team would
copy your entire extension/skill/AGENTS.md context ten times. Set `slim: false` when a teammate
genuinely needs your full environment.

## Model selection

Resolution order, first match wins:

1. explicit `model` / `provider` / `thinkingLevel` on `team_spawn`
2. `profile`'s thinking level
3. `team.modelDefaults[role]` in `~/.pi/agent/settings.json`
4. **inherit the spawning agent's own model and provider** (default)

Inheriting is deliberate: a bare model id can resolve to a different provider in the child process
and fail on auth. Pass `provider` whenever you pass `model`.

## Profiles

`profile: "<name>"` applies a bundle of **model, provider, thinking level, skills, extensions and
context-file policy**. Precedence: explicit `team_spawn` args > profile > `team.modelDefaults` >
inherit the spawning agent's model.

| Profile | Model | Carries |
|---|---|---|
| `code-review` | `openai/gpt-6.1-sol` | `pr-approval-review` + `AGENTS.md` conventions |
| `reviewer` | `openai/gpt-6.1-sol` | `pr-approval-review` + `AGENTS.md` conventions |
| `pr-author` | inherit | `AGENTS.md` conventions (add the repo's ticket-to-PR skill via `team.profiles`) |
| `researcher` / `coder` / `tester` / `docs-writer` | inherit | thinking level only |
| `batch-orchestrator` | inherit | sub-orchestrator role |

Skill names in a profile are resolved per-repo (the `agentOrchestrator.projectSkillRoots`
directories, then global). A name that does not resolve in the current repo is **skipped**, not an error, so a
profile may safely name repo-specific skills.

Define your own in `~/.pi/agent/settings.json` — merged over the built-ins, so you can also
redefine one:

```json
{
  "team": {
    "profiles": {
      "security-review": {
        "role": "worker",
        "model": "openai/gpt-5.5-pro",
        "provider": "vercel-ai-gateway",
        "thinkingLevel": "high",
        "skills": ["pr-approval-review"],
        "contextFiles": true,
        "description": "Adversarial security review"
      }
    }
  }
}
```

Profiles are read at tool registration, so new ones need a `/reload`.

## Settings

```json
{
  "orchestrator": { "level": "auto" },
  "team": {
    "promoteThreshold": 5,
    "maxChildrenPerParent": 5,
    "maxLiveAgents": 8,
    "maxDepth": 3,
    "modelDefaults": {
      "worker":       { "model": "anthropic/claude-haiku-4.5", "provider": "vercel-ai-gateway", "thinkingLevel": "low" },
      "orchestrator": { "thinkingLevel": "medium" },
      "evaluator":    { "thinkingLevel": "medium" }
    }
  }
}
```

| `orchestrator.level` | Behaviour |
|---|---|
| `auto` | the caller's `canSpawn` decides (default) |
| `1-tier` | every spawn is forced to `worker` |
| `2-tier` | auto-promote to sub-orchestrator once a parent has ≥ `promoteThreshold` live children |

```json
{
  "agentOrchestrator": {
    "projectSkillRoots": [".claude/skills", ".agents/skills", ".pi/skills"],
    "contextExtensions": ["../my-rules/extensions/house-rules"]
  }
}
```

| `agentOrchestrator.*` | Behaviour |
|---|---|
| `projectSkillRoots` | directories, relative to the worker's `cwd`, searched for a bare skill name before the global skill dirs. Default `[".claude/skills", ".agents/skills", ".pi/skills"]`; setting it replaces the default |
| `contextExtensions` | extensions (paths relative to the agent dir, `~` allowed) passed with `-e` to every spawn that gets `contextFiles: true`, even under slim, because they inject house rules the way `AGENTS.md` does. `team_verify` skeptics never get them |

## Filesystem layout

```
~/.pi/orchestrator-teams/<team>/
  config.json          full agent tree
  status/<a>.json      latest status per agent
  contracts/<a>.json   task contract per agent
  asks.json            last 50 team_ask calls: who, question, answered, reason
  mailbox/<a>/         queued messages, deleted on delivery
  attention/<p>/       attention requests, scoped to parent p
  handoffs/<a>.json    handoff reports
  evaluations/         evaluator verdicts
  logs/<a>.log|.pid    output and pid of each spawned process
  queue/<a>.json       spawns waiting for a slot under the concurrency caps
```

The team directory is created lazily on the first `team_spawn`, so an ordinary session leaves no
trace. `team_cleanup` removes it; `Ctrl+C` on the lead cascade-kills agents but keeps the files.

## How it works

- **Shared pane/session layer.** The mechanics of putting a pi process on screen (tmux/iTerm2/
  headless, pid files, `0600` env files, capture, focus, kill), of locating and replaying saved
  sessions, and of file mailboxes live in `../_shared/`. The `session-fork` extension uses the same
  code, so a fix to either lands in both. What stays here is the team vocabulary.
- **Agents show up in `/forks`.** When `session-fork` is installed, each agent is published to
  `~/.pi/session-forks` as a child of the lead's session, so one overlay lists teammates *and* your
  own forked sessions. Best effort and dynamically imported: teams work fine without it.
- **Files, not pipes.** Agents are independent processes; the filesystem is the only shared medium.
  State therefore survives a lead restart, and the lead re-adopts a team whose tmux session or cwd
  matches and which still has live agents.
- **Mailbox delivery.** Messages are JSON files consumed by the recipient's `fs.watch` + 2s poll
  loop, then injected with `deliverAs: "followUp", triggerTurn: true`: never interrupt a tool call,
  but do wake an idle agent. The watcher follows the current team: `team_cleanup` + a fresh
  `team_spawn` in the same session used to leave the new team's mailbox Unwatched forever, so
  worker reports (including exit-without-done notices) piled up undelivered until a manual
  `team_status`. A standing 2s check now re-installs the watcher whenever the team changes.
- **Ownership gates destruction.** A process tears down a team only if it created it, or adopted one
  whose lead process is provably dead *and* which has a UI. Adoption used to match on cwd alone: a
  one-shot `pi -p` in the same directory adopted a running team and cascade-killed a working agent on
  exit. Passers-by now observe and leave.
- **Verified clock in every assignment.** The spawn prompt carries the real timestamp and tells the
  agent to trust it over any date in the task text, and to echo the date label its data source
  returned. A lead asserting "today is Monday" from memory once invalidated an entire report.
- **Identity by env.** `PI_ORCH_TEAM_NAME`, `_AGENT_NAME`, `_AGENT_ROLE`, `_PARENT_NAME`,
  `_CAN_SPAWN`. Same extension file, different role.
- **Secrets stay off the command line.** Env (including API keys) is passed via a `0600` file that
  the child sources and deletes, so nothing leaks into `ps` or the pane scrollback.
- **Pid-file liveness.** The spawned shell records `$$` then `exec`s pi, so one code path handles
  liveness and kills on every backend. A post-spawn check 8s later reports startup crashes to the
  parent's mailbox instead of leaving a phantom `spawning` node. Crucially, "process gone" is not
  treated as failure on its own: a fast worker can finish inside that window, so an exit only counts
  as a crash when the agent neither reported a terminal state nor reached `agent_end`, and the check
  never overwrites a verdict the agent wrote itself.
- **Parent-side watchdog.** The 8s check only covers startup, and the worker-side `session_shutdown`
  hook only fires on a graceful exit. A mid-task death (crash, OOM, SIGKILL, a turn-limit exit that
  never ran the hook) used to be invisible until a manual `team_status`. Every 30s
  (`PI_ORCH_WATCHDOG_POLL_MS` to override), each spawning parent polls its direct children: dead
  process + no terminal status = record `error` and wake the parent with the agent's last activity
  and a `team_recycle` suggestion. Detection only — the recycle decision stays with the parent.
- **Bounded messages.** Delivered mail is clamped to 4 000 chars and failure reports carry an
  activity digest rather than the raw event stream. A teammate cannot blow a hole in the lead's
  context by pasting a log into `team_message`.
- **Staggered spawns.** 3s × sibling index, so a batch of ten does not thundering-herd the provider.
- **Honest status.** An agent that exits without reporting `done` is recorded as `error`, not `done`.

## Tests

```bash
npm test                                          # model-free: state, tools, roles, real stub spawn
(cd ../_shared && npm test)                       # the shared pane/session/mailbox layer
node --experimental-strip-types tests/live.ts     # end-to-end with a real model (costs tokens)
```

`tests/live.ts` spawns a real worker, waits for the full protocol (deliverable → `team_write_status`
→ `team_message`), and cleans up.

## Limitations

- Sub-orchestrators need a pane backend (tmux/iTerm2); on the headless backend, prefer flat teams.
- iTerm2 splits the *current* session, so layout depends on where you launched pi.
- `/agents`'s `⏎` focuses a pane; headless agents have none — use `d` to peek, or `o` to open their
  session in a real pane.
- `c` (re-attach) and `o` (observe) refuse while the agent's process is alive, because two processes
  on one session file corrupt it. `f` (fork) is always safe.
- Agents inherit your credentials and run with your permissions. Everything they do is your doing.
