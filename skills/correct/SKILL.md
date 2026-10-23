---
name: correct
description: "Find the mistakes agents keep repeating in a repo and make each one impossible: architecture first, then types, then a lint whose error names the fix, then a test, and docs last. Prove each check fails on a real past mistake. Reads reflect's backlog. Use for /skill:correct."
disable-model-invocation: true
---

# Correct

Adapted from pstack (MIT, Lauren Tan).

Tiger keeps correcting agents in this repo for the same mistakes. Change the repo so the next agent
cannot make them.

Assume every contributor is an agent that sees only the files it opened, copies the nearest example,
and takes the shortest path that compiles. Design the repo so a change that looks right from one
file is right for the whole repo.

Run only when Tiger types `/skill:correct` or asks for it. The project overlay (`## correct` in the
project's skill-overlays file) names the repo's evidence sources and first candidates.

## 1. Find the mistake classes

Read, in this order:

1. `$HOME/Documents/knowledge-base-remote/<Project>/docs/plans/reflect-backlog.md`: the
   `Status: open` entries the `reflect` skill wrote. Each is a candidate with one occurrence.
2. Recent commits and reverts (`git log --oneline -200`, `git log --grep='^Revert' -50`).
3. Review comments on recent PRs (`gh pr list --state merged --limit 50`, then
   `gh api repos/<owner>/<repo>/pulls/<n>/comments` and `.../reviews`), read-only.
4. The agent instruction files (`AGENTS.md` at the root and in subdirectories) and the house rules
   in `~/.pi/agent/AGENTS.md` and the project rules: every "Measured" paragraph is a lesson kept as
   text.
5. Code comments that explain a workaround.

Group the mistakes into classes. A class counts once it has happened twice: two commits, reviews,
reverts or backlog entries showing the same mistake. Cite each occurrence (PR number, commit, file
and line, backlog entry). One occurrence stays in the backlog.

## 2. Fix each class at the highest level that works

1. **Eliminate it with architecture.** Give each piece of state one owner and each task one
   supported way. Hide internals so the wrong import fails. Replace hand-synced lists with one
   source of truth. Delete old ways and dead code an agent would copy.
2. **Enforce it with types so the bad state cannot be written.** If bad code still compiles, add a
   lint or CI check whose error names the file, type or function to use instead. If the pattern is
   already common, fail only when a change adds more (a ratchet), and keep the list of existing
   offenders in a config file the check reads.
3. **Test the behavior.** Fix or delete any test that still passes when the behavior it checks
   breaks, or that fails when only the internals change (see the test skill the project overlay
   names).
4. **Write docs or agent rules last, only for judgment calls.** Nothing fails when an agent skips
   them.

## 3. Fix and prove

Fix the most frequent classes first.

- **One PR per class**, within the ~400-added-line budget of the `pr-review-gate` skill
  (`~/.pi/homebase/skills/pr-review-gate/SKILL.md`). A class whose fix is bigger becomes a stack
  (`~/.pi/agent/skills/github-stacked-prs/SKILL.md`), with the check last so every PR stays green.
- **Prove each new check fails on a real past mistake.** Check out or reapply the commit that
  made the mistake, run the check, and keep the failing output. A check never seen failing on a
  real case is not done.
- Run the same command locally and in CI.
- **Exceptions go in the check's config file or in the ticket**, each with the reason, an expiry
  date and the human who approved it. Never as an explanatory inline comment. The toolchain's own
  disable directive (`rubocop:disable`, `eslint-disable`) is allowed only when the check has no
  config-level exception, and carries no prose.
- **Shared or framework code escalates.** If the fix lands in code the project rules list as
  shared (and any widely-used module), stop and bring Tiger the class, the evidence and a proposed
  scope for its own ticket.
- **No outward side effects without Tiger's explicit ask** for that specific action: no opening PRs,
  pushing, review comments, Linear changes or Slack posts. Work on a local branch and report.
  When he asks for PRs, each one passes `pr-review-gate` and takes its body from the project's PR
  conventions skill.

## 4. Keep the rule table

Keep a table in the agent instruction file that pairs each rule with what enforces it:

| Rule | Enforced by | Proven on |
|---|---|---|
| `<the rule, one line>` | `<check name and command>`, or `docs only` | `<the past PR or commit it fails on>` |

When Tiger corrects you, fix the mistake and add the rule. If the rule was already there and
nothing enforces it, that is a repeat: fix it at the highest level in the same change. Drop a rule's
prose once its check exists; the row stays. Mark each backlog entry the fix covers
`Status: fixed in <branch or PR>`.

## Reply

Each class with its evidence (every occurrence cited), the level you picked and why a higher level
did not work, the proof that the check fails on the past mistake, and what is waiting on Tiger
(PRs to open, escalated shared-code fixes).
