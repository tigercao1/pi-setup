---
name: recall
description: "Rebuild working context on one topic from the local qmd indexes (exported pi sessions, handoffs, plans, daily notes), RESUME.md and the mission ledger, then check every claim against live git/gh/tracker state and hand back a short brief. Also owns pause and resume, the validity labels on notes, and reconcile (checking a folder of notes against its sources and reporting drift). Use for 'recall X', 'catch me up on X', 'where did I leave off', 'resume X', 'pause', 'recall reconcile X', 'reconcile this work stream', or before picking up work started in another session."
---

# Recall

Adapted from pstack's recall, session-pickup and pause-safely (MIT, Lauren Tan).

Recall is the read path over things other tools already write. It searches local qmd indexes, reads
the resume note and ledger, checks what it found against live state, and returns a brief. It also
owns the pause note format and the resume steps. Other skills (intake) point here instead of keeping
their own copy.

## What is indexed

There are two qmd indexes, split by where a source lives and, for sessions, by routing rules. The
active layer's `## recall` overlay names the work index and its live-state commands. Without an
overlay, the only index is `personal`. The split is by collection, not a content guarantee: a
session the rules misroute, a personal plan that discusses company work, or a mixed daily note can
put company text in `personal`. Treat both indexes as private to this machine.

- `personal` (from `~/.pi/agent/qmd/personal.yml.tmpl`): pi setup plans, sessions and handoffs, pi
  config, and one collection per personal project (`-c <project>`, plus `<project>-notes` for its
  knowledge-base notes and `<project>-repo` for docs in its `~/files` checkout). `ssms-reports`
  holds the worker reports and reviews at the top of `~/files/wt`; `pstack` is the upstream pstack
  source in `~/files/pstack-src`.
  `pages` in either index holds the knowledge-base HTML pages converted to text (labels and
  rules in `references/validity.md`, "Converted HTML pages").
- The work index (overlay): the layer's plans, daily notes, the layer's rules and skills, and the
  work sessions and handoffs (a machine-local addition: `qmd/local/<index>.local.yml.tmpl` in the
  layer, gitignored, or `~/.pi/agent/qmd/<index>.local.yml.tmpl`; see `~/.pi/agent/qmd/README.md`).

Who writes what (recall writes nothing except pause notes, drift reports and validity labels):

| Writer | Lands in | Reader before recall |
|---|---|---|
| pi sessions | `~/.pi/agent/sessions/**/*.jsonl`, exported by `~/.pi/agent/bin/pi-memory-export` to `~/.pi/memory/<segment>/sessions/` | none |
| `team_write_handoff` | `~/.pi/orchestrator-teams/<team>/handoffs/<agent>.json`, exported to `~/.pi/memory/<segment>/handoffs/` | `team_recycle` |
| session-fork handoffs | `~/.pi/session-forks/handoffs/*.md`, copied to the same handoffs folder | the forked session |
| work-report (`pi-today`) | the daily notes folder (`daily` collection) | standups, weekly summaries |
| intake | `mission.md`, `ledger.md` in the plans topic folder | intake |
| pause (below) | `RESUME.md` in the plans topic folder | recall |

`team_write_handoff` and work-report keep their jobs. They are writers; recall is their only
cross-cutting reader. A handoff still exists for `team_recycle`; a daily note still exists for the
standup.

The exporter maps a session's cwd to a segment: `~/.pi/homebase/qmd/segments.tsv` (layer paths,
git remotes, work signals) first, then `~/.pi/agent/qmd/segments.tsv`. Sessions started in a mixed
folder such as `$HOME` are routed by their user turns, worker assignment, session name and tool
calls: one strong work signal (from the layer's `strong` rules) sends the session to work, otherwise
scored signals decide, and unclear ones go to `personal`. A single session is pinned with a line
`<session id><TAB><segment>` in the layer's `qmd/session-overrides.tsv` (wins) or
`~/.pi/agent/qmd/session-overrides.tsv`; the next export moves it. Test runs under `/private/tmp`
and `/private/var` are skipped.

## Inputs

- **Topic**: ticket ID, branch, PR number, file, or plain words.
- **Window**: default the last 7 days. State it back; never shrink "all" to "recent" quietly.
- **Index**: from cwd. The overlay says which folders mean the work index; everything else is
  `personal`. Never search the other index unless asked, and say so if you do.

## Steps

0. Refresh first (seconds, no model): `pi-memory-export --quiet && qmd --index <index> update`.
   New files are then found by `search` at once; `query` covers them only after `qmd --index <index>
   embed` (minutes).
1. **search** (BM25, about 0.1 s, no model): `~/.pi/agent/qmd/search --index <index> "<ids or exact
   words>"`, which wraps `qmd search --format json` and prints each hit's state and evidence link,
   confirmed first, superseded hidden (`--all` shows them). Raw `qmd --index <index> search ... -n 10
   --format json` (optionally `-c <collection>`) still works but shows no labels. Then
   `qmd --index <index> get <path>` on the top hits. Read the hit, not the whole session;
   `get <path>:<line>:<count>` reads a slice.
2. **query** only when step 1 gave fewer than 3 useful hits or the topic is plain prose:
   `~/.pi/agent/qmd/search --index <index> --query -n 8 "<question>"` (labels shown, as in step 1). A cold query takes 15-30 s and about
   4 GB of RAM, all local. Do not leave a qmd daemon running; start `qmd mcp --http --daemon` only for
   a burst of queries and stop it after.
3. **RESUME.md and ledger.md** in the matching plans topic folder, if present. The newest `pause`
   row in the ledger names the wip SHA.
4. **Live check.** For each claim from steps 1-3 that can go stale (branch tip, PR state, review
   decision, CI, ticket status), check it now with the overlay's commands, or generically:
   `git -C <worktree> status --short`, `git -C <worktree> log -1 --format=%H`,
   `gh pr view <n> --json state,isDraft,reviewDecision,headRefOid,statusCheckRollup`, and the
   tracker's issue lookup. Mark each claim `current` or `stale (was X, now Y)`. A claim you could not
   check is `unchecked`, never `current`. A `proposed` or `transcript` hit (see Labels) is never
   stated as fact without this check; a `confirmed` hit still gets its evidence link opened when
   the claim can have moved since its `as of` date.

For a topic that names a feature or bug with a long history in tickets, chat or error tracking, the
`why` skill's investigators cover that record. Ask before fanning out; recall alone stays local.

## Output contract

Write to chat, or to `<plans>/<topic>/RECALL.md` when asked.

- **Capsule**: at most 5 bullets. What the work is and where it stands.
- **Threads**: one line each, exactly one status tag: `[merged #N]`, `[open PR #N]`,
  `[draft PR #N]`, `[in flight <branch>]`, `[verified, uncommitted]`, `[paused <sha>]`,
  `[reverted #N]`, `[planned, not started]`. Each line also says `current`, `stale` or `unchecked`.
- **Problems**: at most 5 recurring ones, including fixes that shipped and were reverted.
- **Next move**: the single most useful next action.
- **Sources**: the paths or qmd docids each claim came from, the hit's state and evidence link, and
  the live command that checked it.

Stay on the topic. An adjacent ticket stays out unless it blocks this one.

## Labels

Every note claim has one state. The front matter, HTML meta tags and evidence format are in
`references/validity.md`.

| State | Meaning |
|---|---|
| `proposed` | an agent drafted or suggested it. Unlabelled notes are proposed. |
| `acted` | Tiger says he did it, and no source can show it. |
| `confirmed` | visible in a source of truth, and the evidence link resolves. |
| `superseded` | replaced by a later record, which the label points to. |
| `transcript` | always, for exported sessions and handoffs: what was said, not what is true. A label quoted inside one is not applied. |

The only automatic change is `proposed` to `confirmed`, with an evidence link that resolves. Anything
else (to `superseded`, dropping a claim, `acted` to `confirmed` without a link) waits for Tiger's yes.

## Reconcile

Invoked as `recall reconcile <folder|topic>` or "reconcile this work stream", when a work stream
closes, and as a weekly light pass (steps a-c only, no spawns). The procedure, briefs and report
format are in `references/reconcile.md`; follow it, this is the outline.

a. **Inventory every file** in scope, including `evidence/` and `build/` subfolders and generated
   pages. Skipping a file needs a reason.
b. **Extract claims, one per row**; split compound claims. Generated-page ticks are agent output:
   trace each "done" to a statement by Tiger or to a source before calling it acted or confirmed.
c. **Deterministic checks first.** Run `~/.pi/agent/qmd/reconcile-check` over the machine claim file
   (`id claim source kind pointer expect state`, schema in `references/reconcile.md` § b). It refuses an
   empty or malformed file; only a row with a satisfied `expect` can come back `confirmed`.
d. **One investigator per source** with MCP, using the `why` skill's investigator brief
   (`~/.pi/agent/skills/why/references/investigator-prompt.md`) and its source playbooks. Search
   sessions by content, not names, and fall back to raw JSONL.
e. **One `verifier-mcp` over the union** of every row before anything is merged (the swarm rule).
f. **Drift report**, "Needs you" table first. Every negative states which searches ran.
g. **Label updates** per the rule in Labels. No outward writes.

Ask before the fan-out, as `why` does: a reconcile over a big folder is several agents (one
investigator per source with claims plus one verifier, each a full worker session). Say which
investigators would run, which sources have no tool, and offer the narrow option (steps a-c plus the
one or two sources holding most claims). Then wait.

## Pause

Only when asked ("pause", "stop here, I'll pick it up tomorrow", or `/fresh`). "Keep going" is not a
pause.

`/fresh` (the `context-watcher` extension) is the normal way to pause a long interactive session.
The watcher shows the context size and per-call cost in the status line from 200k tokens and
suggests `/fresh` once at 250k (`contextWatcher` in `~/.pi/agent/settings.json`: `warnTokens`,
`suggestTokens`, `enabled`). `/fresh` runs `pi-pause-facts`, sends you one message with its output,
and after your turn opens a new session in the same cwd seeded with `resume <topic>` and the
RESUME.md path. End that turn with the line `RESUME: <absolute path>` (or `RESUME: none` and why);
without a freshly written RESUME.md the old session stays as it is.

0. Run `~/.pi/agent/bin/pi-pause-facts` first (`/fresh` has already run it and pasted the output).
   It prints the deterministic facts: cwd, repo, branch, HEAD SHA, dirty files, ahead/behind, open
   PRs, this session's live orchestrator agents, the mission folder and RESUME.md path when the cwd
   or branch names a ticket, the last 5 ledger rows, context size and session cost. Copy its output
   verbatim into RESUME.md; never retype or edit it. If step 2 makes a commit, run it again after
   the commit and use the newer output.
1. Finish the current atomic step or back out of it. Start nothing new. Tell running workers to
   checkpoint (`team_write_handoff`) and stop.
2. Commit uncommitted edits as one `wip: <topic> paused` commit on the current branch. If the tree
   is broken, say so in one line of the commit body. No push and no PR unless one already exists.
3. Write `RESUME.md` in the plans topic folder (the mission folder for an intake mission, otherwise
   `<plans>/<topic>/` with the branch name or a short slug; the facts name it when they can).
   Overwrite it; it is a pointer to now. You write only goal, done and verified, not yet verified,
   next step, key files and gotchas; the rest is the facts block.

   ```
   # Resume: <topic>
   - Goal: <one line>
   - Done and verified: <bullets, each with its evidence>
   - Not yet verified: <bullets>
   - Next step: <the first action on resume>
   - Key files: <paths>
   - Gotchas: <what will bite the next session>

   <pi-pause-facts output, verbatim>
   ```

4. Append one row to the topic's `ledger.md` (create it with that row if absent), in the intake
   ledger format: `- <ts> · pause · <one line> · result: paused · evidence: <wip SHA>, RESUME.md`.

Reply with what is on disk, the commit, whether the tree is clean, and the first action on resume.

## Resume

1. Run recall on the topic. The search finds `RESUME.md` and the ledger.
2. Check the wip SHA against the branch tip and the PR head (`git log -1`, `gh pr view`). If either
   moved, the note is stale for that part; say what changed and read the commits since.
3. Append two rows to the ledger, a `start` row for this session and then the `resume` row:
   `- <ts> · start · <agent or session> picks up from RESUME.md · result: active · evidence: -`
   `- <ts> · resume · picking up at <next step> · result: active · evidence: <wip SHA>, RESUME.md`
4. Reply "picking up at <next step>", naming what you inherited and what you are re-checking, then
   continue. Do not redo work the note marks verified unless the live check contradicts it.
