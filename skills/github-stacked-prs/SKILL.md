---
name: github-stacked-prs
description: >-
  Manage GitHub's native stacked pull requests with the official `gh stack` CLI extension. Load BEFORE any work touching a chain of dependent PRs: cascading a rebase after changing a lower PR, restacking, keeping bases consistent, inserting/reordering/dropping a PR mid-stack, retargeting a base that the plain API refuses to change, or syncing a stack onto a moved trunk. Also load when `gh pr edit --base` fails with "part of a stack", or when you are about to hand-rebase several branches in sequence — there is a single command for that.
---

# GitHub stacked PRs (`gh stack`)

GitHub has a **native** stacked-PR feature (distinct from Graphite/ghstack). Once PRs are
grouped into a Stack, the ordinary API refuses base changes:

```
GraphQL: Cannot change the base branch because the pull request is part of a stack. (updatePullRequest)
HTTP 422: Validation Failed / PullRequest.base is invalid
```

There are **no stack mutations in the GraphQL schema** — `PullRequestStack` and
`PullRequestStackEntry` are read-only. Do not hunt for one; use the official extension.

## Install

```bash
gh ext install github/gh-stack
```

## The commands that matter

| Command | Use |
|---|---|
| `gh stack link <bottom> ... <top>` | Create/extend a stack from PR numbers, URLs, or branch names. **Chains bases automatically.** No local tracking needed. |
| `gh stack unstack <stack-number>` | Remove the stack on GitHub (PRs survive; only the grouping goes). `--local` = local tracking only. |
| `gh stack view` / `checkout` / `modify` | Inspect, switch, interactively restructure (TUI — unusable headless). |
| `gh stack rebase` / `submit` / `sync` / `merge` | Remote operations on the whole stack. |

## Do not hand-rebase a stack — one command does it

If you changed a PR low in the stack and everything above needs updating, **do not** loop
`git rebase` + `git push --force-with-lease` branch by branch. That is slow, conflict-prone, and
leaves the chain broken if it dies halfway.

```bash
gh stack sync
```

`sync` performs the whole cascade: fetches, reconciles local tracking with the stack on GitHub,
fast-forwards trunk, **cascade-rebases every branch onto its updated parent**, pushes all branches
**atomically** with `--force-with-lease --atomic`, syncs PR state, and re-links the stack object.
Atomic matters: a partial hand-cascade is exactly how the chain ends up broken.

Narrower tools when you want less:

| Command | Does |
|---|---|
| `gh stack rebase` | Cascade-rebase only, no push. `--no-trunk` skips trunk. `--upstack` / `--downstack` limit the range. `--continue` / `--abort` after conflicts. |
| `gh stack push` | Push stack branches (per-branch `--force-with-lease`, NOT atomic). |
| `gh stack view` | Status per branch, including `⚠ Needs rebase` — use this to check a chain instead of hand-rolling `git merge-base --is-ancestor`. |
| `gh stack checkout <n>` | Set up local tracking from a stack number, PR number, PR URL, or branch. Needed before the others if the stack was created in the web UI. |

Conflicts during a cascade stop the rebase; resolve, `git add`, then `gh stack rebase --continue`.

**Headless agents:** `sync` and `submit` can prompt in an interactive terminal (divergence
resolution; `submit` opens an editor). `rebase`, `push` and `view --json` are safe non-interactively.
Prefer `gh stack rebase` then `gh stack push` when you cannot answer a prompt, and always
`export GIT_EDITOR=true` first.

## Do NOT rebase the whole stack for an upstack change — it dismisses approvals

Plain `gh stack rebase` does two things: fast-forwards **trunk**, then rebases **every** branch from
the bottom up onto it. So a change to a PR near the top rewrites the SHA of every PR below it,
`gh stack push` force-pushes them, and **GitHub dismisses the approvals on those lower PRs**. Lower
PRs are usually the ones already reviewed, so this is expensive.

Scope the rebase to only what actually needs moving:

```bash
gh stack checkout <the PR you are changing>
# ...edit, git commit...
gh stack rebase --upstack --no-trunk   # only branches ABOVE the current one; trunk untouched
gh stack push                          # unchanged branches are no-ops, so no force-push, no dismissal
```

| Flag | Effect |
|---|---|
| `--upstack` | only rebase from the current branch to the top — leaves everything below untouched |
| `--downstack` | only rebase from trunk up to the current branch |
| `--no-trunk` | skip fetching/rebasing trunk — stops an unrelated trunk move from rewriting the whole stack |

**Verified:** running `gh stack rebase --upstack --no-trunk` from the top branch reported
`starting from <top> to <top>` and left every branch SHA unchanged.

Only use a bare `gh stack rebase` (trunk included, whole stack) when you deliberately want the stack
on the latest trunk — e.g. before merging, or to pick up a migration. Expect approvals to drop then,
and say so before doing it.

## Never script conflict resolution across a cascade

A cascade replays your change onto each branch in turn, so the *same file* conflicts repeatedly and
it is tempting to write a loop that resolves and continues. **Don't.**

Two things go wrong:

1. **Marker style varies.** Depending on the operation git emits either `<<<<<<< HEAD` or
   `<<<<<<< ours` / `>>>>>>> theirs`. A script matching one silently no-ops on the other — and if it
   then runs `git add`, it **commits the conflict markers**. The committed files no longer parse,
   and only a parse check or CI catches it.
2. **Each conflict is genuinely different.** Same file, different hunks: one branch may re-add a
   helper, another may add a legitimate new test beside the conflicting ones, a third may have an
   empty "ours" side.
   Blanket "take ours" or "take theirs" throws away real work in at least one of them.

Resolve them one at a time. After each: check markers are gone, check the file parses, then continue.

```bash
git diff --name-only --diff-filter=U            # what conflicted
# ...resolve by hand...
grep -c '<<<<<<<\|>>>>>>>' <file>              # must be 0
ruby -c <file>                                  # must say "Syntax OK"
git add <file> && gh stack rebase --continue
```

## Always verify before `gh stack push`

A cascade touches every branch, so a mistake is multiplied. Before pushing, on every branch:

```bash
for b in <branches>; do
  # 1. no conflict markers committed anywhere
  git show $b:<file> | grep -c '<<<<<<<\|>>>>>>>'
  # 2. specs actually run (a broken file reports "error occurred outside of examples",
  #    NOT a failure count — easy to skim past)
  git checkout -q $b && bin/rspec <specs>
done
```

Watch for `0 examples, 0 failures, 1 error occurred outside of examples`. That is a **load error**,
not a pass. Skimming for "0 failures" will read it as green.

## The two hard limits

1. **`gh pr edit --base` never works on a stack member.** Bottom, middle, or leaf — all refuse.
2. **`gh stack link` only APPENDS.** Inserting mid-stack fails with:
   `✗ Cannot update stack: new PRs must be added to the top of the existing stack`

## Recipe: insert a PR into the middle of an existing stack

This is the case that blocks people. You must tear the stack down and rebuild it:

```bash
# 1. find the stack number (shown in the GitHub stack UI, or read it off a PR)
gh api graphql -f query='
  query { repository(owner:"OWNER", name:"REPO") {
    pullRequest(number: 1204) { stack { number size entries(first:20){nodes{position pullRequest{number}}} } } } }'

# 2. remove the stack on GitHub (PRs are NOT closed or altered)
gh stack unstack <stack-number>

# 3. relink in the desired order, bottom to top — this fixes every base
gh stack link 1201 1202 1203 1204 1205 1206
```

Branches must already be rebased in that order locally and pushed; `link` sets PR bases,
it does not rewrite commits.

## ⚠️ `gh stack` and per-branch worktrees do not coexist

`gh stack rebase` checks out each branch in turn in ONE working directory. If a branch is held by
another worktree, git refuses ("already used by worktree") and the cascade cannot run.

**Verified in practice:** with stack branches each checked out in their own worktree,
`gh stack rebase` is blocked until the branches are freed.

Free them **non-destructively** — detach, do not remove:

```bash
# confirm no TRACKED changes would be stranded (untracked files are safe either way)
git -C <worktree> status --porcelain | grep -v '^??'

git -C <worktree> checkout --detach     # frees the branch, keeps the worktree and its files
# ... run gh stack checkout / rebase / push from one checkout ...
git -C <worktree> checkout <branch>     # re-attach afterwards
```

Removing and re-adding worktrees also works but is destructive to untracked files in them and
should not be done without the human's explicit say-so.

**Better still: don't use one worktree per branch for stacked work.** Use a single checkout and let
`gh stack checkout` move you between branches. The per-branch-worktree layout fights the tooling.

## `gh stack rebase` fast-forwards trunk as a side effect

A cascade also brings the stack onto the latest trunk. Two consequences to plan for:

- New migrations arrive with it — run `bin/rails db:migrate RAILS_ENV=test` in each worktree you
  then run specs in, or the suite aborts at load with "pending migrations".
- Conflicts on a cascade are often against *trunk*, not between your own branches. Typical case:
  a shared list file (e.g. `package_todo.yml`) where trunk added one entry and your branch added
  another — resolve as a union, not a pick.

Use `--no-trunk` if you want only the inter-branch rebases and no trunk movement.

**Observed:** the first cascade of a freshly restructured stack produced a few mechanical conflicts;
the next, once the stack had settled, produced none. Expect the first run after a restructure to need
`gh stack rebase --continue` a few times.

## ⚠️ `gh stack link` silently flips drafts to READY

**Observed** (gh 2.97.0, `github/gh-stack`): after `unstack` + `link`, PRs that were drafts came
back **ready for review**, even without `--open`.

**Do not "fix" this by converting back to draft.** A PR that is open for review must never be
returned to draft — reviewers lose it from their queue and review state gets muddied. If the flip
is unwanted, raise it with the human; do not toggle. If the PRs were meant to be ready anyway,
the flip is harmless.

Check state without changing it:

```bash
for pr in 1201 1202 1203 1204 1205 1206; do
  gh pr view $pr --json number,isDraft --jq '"#\(.number) draft=\(.isDraft)"'
done
```

## Stack numbers are NOT PR numbers

A stack has its own identifier namespace. `gh stack link` prints e.g. `Created stack with 6 PRs
(stack #1207)` — that number will **not** resolve as a PR or issue:

```bash
gh pr view 1207      # => no such PR
```

Use it only where a stack number is expected (`gh stack unstack <n>`, `gh stack link <n> ...`,
the web stack UI). To inspect membership, query a member PR:

```bash
gh api graphql -f query='
  query { repository(owner:"OWNER", name:"REPO") {
    pullRequest(number: 1204) {
      stack { number size entries(first:20){nodes{position pullRequest{number baseRefName}}} }
    } } }'
```

## Verifying a restructure worked

Check bases **and** line counts. A stale base shows up as an inflated diff, because the PR
is measured against a base that does not contain the work below it:

```bash
for pr in 1201 1202 1203 1204 1205 1206; do
  gh pr view $pr --json number,baseRefName,additions,isDraft \
    --jq '"#\(.number) [\(if .isDraft then "draft" else "READY" end)] +\(.additions) base=\(.baseRefName)"'
done
```

Illustration of the symptom (synthetic numbers): after a `parser` PR is inserted below it, a
`formatter` PR reports `+900` while still based on the branch two steps down; once relinked onto its
true parent it drops to `+300`. **If a PR's diff looks bigger than the work it contains, suspect the base.**

`gh` also lags a few seconds after a push or restructure — re-query before trusting output.

## Designing stacks to avoid this

- **Appending is free; inserting is expensive.** Decide the slice boundaries before opening PRs.
- Merge **bottom-up and promptly** — a long-lived deep stack multiplies every restack.
- A PR carrying a cherry-picked commit from a lower PR will shed it on rebase once that
  lower PR merges. Say so in the body so reviewers do not review it twice.

## Passing this to worker agents

Headless workers cannot use `gh stack modify` (TUI). Give them `link` / `unstack` explicitly,
and require them to re-assert draft status afterwards. Also require:
`export GIT_EDITOR=true` before any rebase/amend, and `git commit -m`/`-F` only — an
interactive editor will hang a headless agent indefinitely.
