---
name: worktree-cleanup
description: Audit git worktrees and reclaim disk space safely. Runs the read-only `wt clean --audit` report (size, days since last commit and last pi session, live processes, uncommitted and untracked files, unpushed commits, merge/PR state, suggested bucket), cross-checks each candidate, lists them to the user and removes only the worktrees the user explicitly approves by name. Use when asked to clean up, prune or list stale worktrees, free disk space taken by worktrees, or "which worktrees can I delete".
---

# Worktree cleanup

Adapted from pstack's worktree-cleanup playbook (MIT, Lauren Tan).

This is the one task that deletes the user's state with no code review to catch a slip, so the
gates below are the review. **Nothing is removed without the user's explicit yes for that worktree
by name, in this conversation.** A yes for "clean up" in general is not a yes for a specific path.

## 1. Snapshot and audit (read-only)

Run from inside the repo (any of its worktrees):

```bash
df -h /
wt clean --audit --size            # or the worktree tool: action "audit", withSize: true
```

`wt` is `~/.pi/agent/bin/wt`. Add `--stale-days N` to change the stale threshold (default 30).
`--size` runs `du` on every worktree and can take minutes; leave it off when the question is not
about disk. Paths come from `git worktree list`, never hand-typed.

Do not run plain `wt clean` as part of the audit: it runs `git worktree prune`. That only drops
metadata for worktrees whose directory is already gone, but it is still a write; say you are doing
it.

## 2. Read the buckets as advice

| Bucket | Meaning | Default |
|---|---|---|
| `keep: current` / `keep: in use` | this session's checkout, or a live process has its cwd inside it (pi session, dev server) | keep |
| `keep: open PR` | PR is open or draft | keep |
| `keep: active` | recent commits, no merge signal | keep |
| `hold: uncommitted` | `wip:N` tracked files changed | show the diff, ask |
| `hold: unpushed` | commits on no remote that are not the head of a merged PR | show `git log --oneline`, ask |
| `verify: recent session` | a pi session ran in it in the last 2 days | check the session, ask |
| `verify: in base, no PR` | branch tip is already in the base branch and no PR was found; often a branch created and never used | ask |
| `verify: stale` | no commit for the stale threshold, no open PR | ask |
| `candidate: done` | PR merged or closed (`0(pr)` = local commits are the merged PR head), clean, not in use | list for approval |

`scratch:N` is untracked files. They are lost on removal; name them (`git -C <path> status
--porcelain | grep '^??'`) before asking.

## 3. Cross-check before listing

- **In use beats the bucket.** Ask the user which worktrees belong to work still in progress
  (pinned sessions, running agents, a stack they are working on). Check `team_status` for live
  workers whose cwd is a worktree, and the newest file in
  `~/.pi/agent/sessions/--<path with / replaced by ->--/` for anything you doubt. A worktree used by a
  background worker is in use even if its name means nothing to the user.
- **Stacks.** A worktree holding a branch of a native GitHub stack may be needed by `gh stack`;
  check `gh stack view` before listing it.
- **Merged is not the same as safe.** A merged PR whose worktree has new local commits shows as
  `hold: unpushed`; those commits are not on any remote.

## 4. List candidates and wait

Show one table: worktree · branch · bucket · size · reason it looks removable · what would be lost
(nothing / N untracked files named / N uncommitted files / N unpushed commits). Then the held-back
ones with a one-line reason each. Ask for an explicit yes per name, and whether to delete each
branch too (default: keep the branch). Stop and wait.

## 5. Remove only the approved set

Per approved name, one at a time:

```bash
wt rm --keep-branch <name>          # or the worktree tool: action "remove", name: <name>
```

`wt rm` refuses a dirty worktree for a non-interactive caller; do not add `-y` unless the user
approved losing that specific uncommitted work after seeing it. Add `--delete-branch` only for
branches the user said to delete. If a directory survives on ignored build artifacts, show its size
and ask before `rm -rf`. Then `git worktree prune`.

Never remove the main checkout. Never remove a worktree you were not given by name.

## 6. Report

`df -h /` before and after with the space reclaimed, the worktrees removed (and branches deleted, if
any), and each held-back worktree with its one-line reason. Note that `du` counts copy-on-write
clones at full size, so reclaimed space can be less than the sum of the sizes.

Other disk reclaimers (package caches, simulators, build caches) are out of scope unless the user
asks; list them with sizes and let the user choose.
