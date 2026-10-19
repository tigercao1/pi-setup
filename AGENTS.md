# Global agent instructions

Project layers may inject their own rules on top of these; where both apply, follow both.

## File paths in replies

When telling the user where a file is, always give the full absolute path, with the home directory expanded to its real value (the full absolute path, starting at `/`), never a relative path, a `~/` path, or a path relative to a folder mentioned earlier. This applies to every file mentioned in chat, not only the main deliverable.

## Planning documents

Save all plan/design/breakdown documents to:

```
$HOME/Documents/knowledge-base-remote/<Project>/docs/plans/
```

Never write plan documents inside a git working tree — they should not be picked up by git or
show up in `git status`. This applies to project plans, work breakdowns, research/spike write-ups,
and similar scratch artifacts. Code, and docs that are genuinely part of a repo's deliverable,
still belong in the repo.

When a plan references a repo file, use the repo-relative path.

**Never reference a local-only path in anything other people will read.** Knowledge-base plan
documents live outside any repo and outside your teammates' reach, so a path like
`<Project>/docs/plans/foo.md` is unreadable to everyone but the user. In Linear issues, PR
descriptions, Slack, Confluence, and code comments, either inline the relevant findings, or link
something the reader can actually open (the PR, the ticket, a Confluence page, a Databricks query).
Repo-relative paths to committed files are fine; paths into the knowledge base are not.

This cuts both ways: if a finding is load-bearing enough for a ticket to cite it, it is
load-bearing enough to be written *into* the ticket. A pointer to a file only you can open is not
context — it reads as context while conveying nothing.

## Verify, then consolidate

Whenever work is split across parallel workers, or across several rounds of my own investigation,
the deliverable is **one document**, not a pile of per-worker reports. Never hand over "see these
four files". Per-worker outputs are raw material.

The order is fixed — **verification happens before consolidation, never after**:

1. **Workers produce findings** into their own scratch files. Inputs, not deliverables.
2. **ONE verifier** runs over the **union of all worker findings**, before I merge anything. One
   verifier, not one per worker: cross-worker contradictions are the highest-value thing to catch
   and only a verifier holding every finding at once can see them. Its job is adversarial — try to
   disprove **every** claim, from a named hostile angle (default: a reader with zero context who
   will repeat these claims out loud and be embarrassed if they are wrong). It re-derives from
   primary sources and must never see the workers' reasoning or narrative.
3. **I consolidate what survived** into one document — the approved paths. Disproved and
   unverifiable claims go in a short closing section, so the reader knows what was considered and
   dropped rather than wondering whether it was missed.

Why this order and not consolidate-then-verify: consolidating first means *I* reconcile the
contradictions, and my reconciliation is exactly the thing most likely to be wrong. A merged draft
launders two workers' disagreement into one confident sentence before any skeptic sees it, and the
verifier then grades my prose instead of their evidence. Verifying first keeps disagreements visible
as raw disagreements. It is also cheaper — nothing gets carefully merged and then deleted.

Rules of thumb:

- Agreement between workers is **not** evidence — they may share one wrong source. Overlapping
  claims count as one claim and get verified once, against the source, not against each other.
- Mark every surviving claim with its support: primary source, inference, or unverifiable.
  Inferences survive, but labelled.
- The consolidated doc is the single thing the user reads. Per-worker files may stay on disk, cited
  as appendices at most, never as the answer.
- This **supersedes `team_evaluate`'s per-agent grading** for research and analysis work.
  `team_evaluate` grades each agent against its own contract, which is the right check for "did
  this worker do its job" and the wrong one for "is this finding true". For code work, intake's
  per-unit gates stay as they are.

## External side effects

Never post outward-facing communication without the user's explicit request for that specific
action. This includes: comments, review replies, or review submissions on GitHub PRs; comments or
status changes on Linear issues; Slack messages; and emails. Review feedback the user pastes into
the session is LOCAL feedback unless they say otherwise — address it with commits only, and put any
proposed reply text in the completion report for the user to post themselves.

Allowed without asking: pushing commits to the agent's own working branch and opening draft PRs.

When asked to copy a Slack message to the clipboard, always use the `slack-copy` skill
(`~/.pi/agent/skills/slack-copy/SKILL.md`) so the formatting survives the paste. Never plain `pbcopy`.

## Reviewing a PR when I ask

When I ask for a review of a PR or diff ("review this PR", a PR URL, "review this as well"), do not
review it inline on the lead's model. Spawn one worker with `profile: "code-review"` (pinned to
`openai/gpt-6.1-sol`), `skills: ["pr-approval-review", "github-cli"]`, `extensions: ["mcp"]` so it can
reach Linear, Datadog and Sentry, and `contextFiles: true`. Give it the PR URL, the head SHA, and
the instruction to follow `pr-approval-review` and write its verdict to a file. Do not add your own
reading of the PR to the brief. Then end the turn. When its report arrives, relay the verdict and
copy-paste comments without rewriting their substance. If you disagree with a finding, say so
separately and name the evidence. The reviewer never posts to GitHub, and you do not either.

If the gateway rejects the model, say so and ask before falling back to another model. Do not
silently review it yourself instead.

## Convention review before every PR

Green CI is not evidence that a change follows the repo's conventions. Before opening a PR, run a
separate convention-review pass: a fresh agent (or a `reviewer`/`code-review` worker in parallel
with implementation) whose only job is to diff the changed files against the repo `AGENTS.md` and
any directory-local `AGENTS.md`, rule by rule. The author cannot do this pass — it will re-check what it
was already thinking about.

Linters, tests and boundary checkers enforce what they can see; a convention about parameter types
or layering usually passes all of them. An unenforced convention with live counterexamples is
exactly what an agent copying nearby code will reproduce.

Three specific traps, each worth its own habit:

- **Put the hard rules in the brief, not behind a pointer.** When a diff will touch a module's
  public interface, paste the boundary rules into the task text. `contextFiles: true` makes AGENTS.md
  available; it does not make the worker consult the relevant line at the relevant moment.
- **Never cite a module-internal service as the template for a public one.** Naming a file to copy
  transmits its signature too. Say which layer the template belongs to, or the worker will
  propagate an internal shape one layer further out than it belongs.
- **Treat every unplanned deviation as a review trigger.** A deviation means the worker solved a
  problem the brief did not anticipate — precisely where a second look pays. Reading the list is
  not reviewing it.

## Writing in my voice

Anything I will post under my own name (PR review comments, replies, Slack messages, Linear
comments) is drafted in my voice: load `~/.pi/agent/skills/tiger-voice/SKILL.md` and its
`examples.md` first, plus `examples-long.md` whenever the draft runs past about five sentences.
Read them every time, before drafting; working from memory of an earlier read does not count.
Pass `skills: ["tiger-voice"]` to any worker that drafts such text, and say in its brief that it
must read those files itself. Only
the rules marked [confirmed] and the curated examples count. Never treat the harvested inbox in
`~/Documents/knowledge-base-remote/Pi/voice/` as evidence of my voice; it changes the skill only
through `/voice-align`, with my approval.

Every such draft then goes through `~/.pi/agent/skills/clear-message/SKILL.md` before I see it:
question first, the one change named, plain words, a short-answer ending, and a passing skim test
(`clear-message/bin/skim-test.py`). Show me the draft with its skim-test line. My voice decides how
it sounds; clear-message decides whether a busy reader gets it, and wins on structure. Workers that
draft such text get `skills: ["tiger-voice", "clear-message"]` and must read both files themselves.

## Code comments in PRs

Do not add explanatory inline code comments. Editing an existing comment so it stays accurate
after your change is fine (it nets zero new lines, and a stale comment is worse than none); adding
new prose is not. Rationale, design decisions, tradeoffs and review
history belong in the PR description or the ticket — not in the source, where they go stale and
reviewers have repeatedly asked for them to be removed. Let names and structure carry the meaning;
if a line needs prose to be understood, prefer rewriting the code.

Allowed: functional directives the toolchain reads (`@ts-expect-error`, `eslint-disable`,
`rubocop:disable`/`standard:disable`, `frozen_string_literal`), and genuine documentation files
(FEATURE.md, READMEs, doc comments that are part of a published API contract).

## Scope discipline

Keep every PR within its ticket's intended scope.
- When reviewing (or relaying review feedback to workers), only raise what blocks the PR's stated
  purpose; everything else goes in a follow-ups list.
- When addressing review feedback, never implement changes beyond the ticket's scope — especially
  changes to shared/framework code (e.g. a shared experiments framework, widely-used models). If feedback
  seems to require it, stop and surface it to the user with a recommendation (e.g. split into its
  own PR) instead of implementing it.

## Linear

Never set, change, or clear the `estimate` (story points) field on Linear issues. Estimates are
set manually by the user. If a write to an issue causes Linear to reapply a team-default estimate,
leave it alone and mention it rather than clearing it.

## What a spawned worker actually receives

Measured 2026-09-22 with a nonce canary (`~/Documents/knowledge-base-remote/Pi/docs/plans/mas-flow-test/RESULTS.md`).
The four channels are **orthogonal, default-off under `slim`, and never inherited** — not by a
worker, not by a grandchild, not across `team_recycle`. Pass each one explicitly at every spawn.

| Want the worker to have | Pass | Notes |
|---|---|---|
| A skill | `skills: ["name"]` | Survives `slim`. Injects name/description/path only — the **body is not in the prompt**, the worker must `read` it |
| MCP tools (Linear, Confluence, Slack, Sentry…) | `extensions: ["mcp"]` | Without this a worker sent to read a ticket has **no way to fetch it** and will improvise or report it unreachable. Expands to `-e builtin:mcp -e builtin:codemode -e builtin:tool-search`; tools are named `mcp__<server>__<tool>` and are reached through `tool_search` or a `codemode` script, not pre-declared |
| These house rules | `contextFiles: true` | Off by default. A sub-orchestrator without it will not follow the process rules in this file |
| Everything | `slim: false` | Expensive; prefer naming what is needed |

**`~/.pi/agent/APPEND_SYSTEM.md` is a fifth channel and it is not optional.** Measured 2026-09-23
with a canary: it reaches *every* pi process, including a `team_verify` skeptic launched with the
full isolation set (`--no-extensions --no-skills --no-context-files --no-session`). `pi --help`
offers no flag that suppresses it — `--no-context-files` disables AGENTS.md/CLAUDE.md only. So put
nothing there that a blind verifier must not see: it is the one channel that bypasses the
isolation the verifier design depends on. Global output-style rules are fine; repo conventions,
project framing and anything resembling an argument are not.

**Always confirm a skill was read, never that it was passed.** A name that does not resolve from
the worker's `cwd` is **silently dropped** (`agent-orchestrator/config.ts:488` —
`if (path) argv.push(...)`, no else) and the spawn still returns success. Confirm by grepping the
worker log for the skill path. Passing a skill is not evidence; reading it is.

### Give the verifier every tool it needs

A verifier is **clean context, full tooling** — the isolation that matters is that it never sees the
worker's reasoning, not that it is denied the means to check. A verifier without the tools to open
the sources cannot verify; it can only agree. Spawn it with `extensions: ["mcp"]` whenever the
sources are Confluence/Linear/Slack/Sentry/web, plus any skill it needs to interpret them, plus
`contextFiles: true`.

`team_verify`'s built-in skeptics **cannot be configured** — they are hard-coded to
`--no-extensions --no-skills --no-context-files --no-session` (`verify.ts:164`). Measured
2026-09-22: they **do** have `read`/`bash`, so local files and repo paths are fine (a skeptic
checked a file's mtime unprompted). They have **no MCP**, so a ticket, Confluence page or URL is
out of reach. Use `team_verify` for claims checkable on disk or by reasoning; for anything behind
MCP, spawn a dedicated verifier instead.

One claim per verification call — a compound finding can pass while hiding a defect inside it.

## Skills must actually load in the worker

**All skills live in the pi skill directories: `~/.pi/agent/skills/` or a skill directory listed in
`~/.pi/agent/settings.json`. Never keep a skill inside a repo's `.claude/`, and never symlink one in.**
A repo-local skill name only resolves if the directory is visible from the worker's `cwd`. A
gitignored skill directory is absent from a freshly created worktree, so the name resolves to
nothing — silently. The spawn still returns success and the worker invents its own conventions. A
force-added copy in a subdirectory *does* appear in worktrees, which masks the gap.

When spawning:

1. Pass skills by name (they resolve from `~/.pi/agent/skills/` and the settings skill directories)
   or by absolute path. Never by a repo-relative path.
2. If a skill you need still only exists in a repo, **move it into a pi skill directory first**
   (`~/.pi/agent/skills/` for personal skills, the project layer's skill directory for project
   ones) rather than pointing at it in place.
3. Verify it loaded before trusting the output: grep its log
   (`grep -c <skill-name> ~/.pi/orchestrator-teams/*/logs/<agent>.log`). Zero hits means it never read
   the skill, whatever it claims. Do not ask the worker to restate the skill's headings instead — one
   that never read it can still produce plausible ones.

## Do not dictate PR descriptions in a task brief

Never enumerate what a PR body "must state". The template owns the shape, and a bespoke list in the
brief overrides it — the worker follows the more specific, more recent instruction and produces a
sprawling essay that violates the template's explicit limits. Instead write: *"Fill the PR body from
<the project's PR conventions skill, by absolute path>; read that file before writing it."*

Depth belongs in the ticket and the plan documents, not the PR body.

## Team worker reliability

A `team_spawn`/`team_recycle` call returning success does NOT mean the worker is healthy — workers
can die immediately on a turn/lifecycle limit and the spawn still returns ok. After every
spawn/recycle, verify the worker actually started before moving on: a quick `team_status` (or
`team_diagnose`) to confirm it is alive and progressing, not already `exited`. If it exited without
reporting done, `team_recycle` it again with a handoff telling the replacement to checkpoint early
and work in smaller increments.

Sleep protection has one holder: the launchd service `com.ycao.pi-agent-caffeinate`
(`~/.pi/agent/bin/agent-caffeinate.sh`). Every 5s it checks for live spawned agents and for
interactive sessions mid-turn, which the `no-sleep-while-working` extension marks with a file in
`~/.pi/agent/run/active/<pid>`. It holds `caffeinate -dis` while a marker is live and `-is` while
only agents are, and releases when neither is. Dead pids are ignored and their markers deleted.
Check `~/.pi/agent/logs/agent-caffeinate.log` for HOLD/RELEASE lines, which name the reason, if a
worker stalls. This does not
survive a lid close — for that, `sudo pmset -a disablesleep 1` (and set it back to `0` after).

Do not assume completion. A worker that goes quiet may have died without its report reaching the
lead. When picking up results, if an expected `done` message never arrived, check `team_status`
rather than waiting indefinitely.

## Stacked PRs

When a repo uses GitHub's **native** stacked PRs, install the official extension once:
`gh ext install github/gh-stack`, and follow the rules below.

**Never hand-rebase a chain of dependent PRs.** If you change a PR low in a stack, do NOT loop
`git rebase` + `git push --force-with-lease` branch by branch — that is how the chain ends up
broken half-way. Use `gh stack sync` (fetch, cascade-rebase onto parents, atomic force-with-lease
push, re-link the stack), or `gh stack rebase` + `gh stack push` when you need a non-interactive
path. `gh stack view` reports `⚠ Needs rebase` per branch.

Other traps: `gh pr edit --base` is refused on any stack member; `gh stack link` only appends, so
inserting mid-stack needs `gh stack unstack <n>` then relinking bottom-to-top; `link` can silently
flip drafts to ready; and `gh stack` cannot run while stack branches are held by other worktrees
(detach them, do not remove).

**Scope rebases to what changed.** A bare `gh stack rebase` fast-forwards trunk and rebases the
whole stack bottom-up, so an upstack edit rewrites every PR below it — force-pushing them and
**dismissing their approvals**. For a change to one PR use
`gh stack checkout <pr>` then `gh stack rebase --upstack --no-trunk`, which leaves lower branches'
SHAs untouched. Only rebase the whole stack deliberately (e.g. before merge), and flag it first.

**Use ONE worktree for stacked work.** `gh stack` moves between branches in a single checkout and
refuses to touch a branch another worktree holds; a worktree-per-branch layout fights it constantly.

**Never script conflict resolution across a cascade.** The same file conflicts on each branch but
the hunks differ, and git's marker style varies (`<<<<<<< HEAD` vs `<<<<<<< ours`) — a loop that
matches one silently commits conflict markers with the other. Resolve one at a time; after each,
confirm `grep -c '<<<<<<<'` is 0 and the file parses.

**Verify before `gh stack push`**, on every branch: no committed conflict markers, and specs
actually run. `0 examples, 0 failures, 1 error occurred outside of examples` is a load error, not a
pass — it is easy to skim as green.

**Whenever a task involves more than one dependent PR, load
`~/.pi/agent/skills/github-stacked-prs/SKILL.md` before starting, and pass it to any worker you
spawn.** Note that `team_recycle` does NOT carry over a worker's `skills` — re-state them in the
recycle context.

## PR draft state

Never convert a pull request that is open for review back to draft — not during a rebase, not
while repairing a stack, not "temporarily". Reviewers lose it from their queue. This applies to
side effects too: if a tool flips state, report it rather than toggling it back. Marking a draft
*ready* is fine when the human has asked for review.
