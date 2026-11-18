---
name: recall
description: "Pause and resume work across pi sessions: write the RESUME.md pause note (what /fresh asks for), pick work back up from it, and check every claim in it against live git/gh/tracker state before trusting it. Use for 'pause', 'stop here, I'll pick it up later', '/fresh', 'resume X', 'where did I leave off', or 'catch me up on X'."
---

# Recall

Recall owns three things: the pause note format (`RESUME.md`), the resume steps, and the live
check that turns a remembered claim into a current one. It writes nothing except pause notes and
ledger rows.

## Where notes live

Keep pause notes outside any git working tree, so they never show up in `git status` or a PR: one
folder per topic under a notes root you choose, e.g. `<notes>/<topic>/RESUME.md`, with an optional
`ledger.md` beside it. Set `PI_PAUSE_PLANS_ROOT=<notes>` and `pi-pause-facts` names
`<notes>/<TICKET>/RESUME.md` itself whenever the cwd or branch names a ticket ID (`ABC-123`).

## Pause

Only when asked ("pause", "stop here", or `/fresh`). "Keep going" is not a pause.

`/fresh` (the context-watcher extension) is the normal way to pause a long interactive session.
It runs `pi-pause-facts`, sends you one message with its output, and after your turn opens a new
session in the same cwd seeded with `/skill:recall resume <topic>` and the RESUME.md path. End that
turn with the line `RESUME: <absolute path>` (or `RESUME: none` and why); without a freshly
written RESUME.md the old session stays as it is.

0. Get the facts. `/fresh` has already run `pi-pause-facts` and pasted the output; otherwise run it
   yourself (it ships in this package's `bin/`). It prints the deterministic facts: cwd, repo,
   branch, HEAD SHA, dirty files, ahead/behind, open PRs, this session's live orchestrator agents,
   the notes folder when it can name one, the last ledger rows, context size and session cost. Copy
   its output verbatim into RESUME.md; never retype or edit it. If step 2 makes a commit, run it
   again after the commit and use the newer output.
1. Finish the current atomic step or back out of it. Start nothing new. Tell running workers to
   checkpoint (`team_write_handoff`) and stop.
2. Commit uncommitted edits as one `wip: <topic> paused` commit on the current branch. If the tree
   is broken, say so in one line of the commit body. No push and no PR unless one already exists.
3. Write `RESUME.md` (the path the facts name, else `<notes>/<topic>/RESUME.md` with the branch
   name or a short slug as the topic). Overwrite it; it is a pointer to now. You write only goal,
   done and verified, not yet verified, next step, key files and gotchas; the rest is the facts
   block.

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

4. Append one row to `ledger.md` beside it (create it with that row if absent):
   `- <ts> · pause · <one line> · result: paused · evidence: <wip SHA>, RESUME.md`.

Reply with what is on disk, the commit, whether the tree is clean, and the first action on resume.

## Resume

1. Read `RESUME.md` (the path in the seed message, or `<notes>/<topic>/RESUME.md`) and the newest
   rows of `ledger.md`. The newest `pause` row names the wip SHA.
2. Live-check it (below). Check the wip SHA against the branch tip and the PR head. If either moved,
   the note is stale for that part; say what changed and read the commits since.
3. Append two rows to the ledger, a `start` row for this session and then the `resume` row:
   `- <ts> · start · <agent or session> picks up from RESUME.md · result: active · evidence: -`
   `- <ts> · resume · picking up at <next step> · result: active · evidence: <wip SHA>, RESUME.md`
4. Reply "picking up at <next step>", naming what you inherited and what you are re-checking, then
   continue. Do not redo work the note marks verified unless the live check contradicts it.

For "catch me up on X" without a RESUME.md, gather the same claims from the repo (`git log`,
branches, open PRs) and any notes folder for the topic, then live-check them the same way.

## Live check

A note is a claim about the past. Before stating any claim that can go stale (branch tip, dirty
tree, PR state, review decision, CI, ticket status), check it now:

- `git -C <worktree> status --short` and `git -C <worktree> log -1 --format='%H %s'`
- `gh pr view <n> --json state,isDraft,reviewDecision,headRefOid,statusCheckRollup`
- `gh pr list --head <branch> --json number,state,isDraft`
- the tracker's issue lookup, when a tracker tool is available

Mark each claim `current`, `stale (was X, now Y)`, or `unchecked`. A claim you could not check is
`unchecked`, never `current`. Agent-written notes and session handoffs record what was said, not
what is true: never state them as fact without this check.

## Output when catching up

- **Capsule**: at most 5 bullets: what the work is and where it stands.
- **Threads**: one line each with one status tag (`[merged #N]`, `[open PR #N]`, `[draft PR #N]`,
  `[in flight <branch>]`, `[paused <sha>]`, `[planned, not started]`) and `current`, `stale` or
  `unchecked`.
- **Next move**: the single most useful next action.
- **Sources**: the file each claim came from and the command that checked it.
