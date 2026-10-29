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

**Label what you write.** A note an agent writes starts as `proposed`, with the front matter (or, for
HTML, the meta tags) from `~/.pi/agent/skills/recall/references/validity.md`. Link to the source of
truth (ticket, PR, Slack permalink) instead of copying its status; a copied status goes stale while
the note still looks current. When a status must be shown, write "as of <date>" next to the link.
Labels change only as the Labels rule in `~/.pi/agent/skills/recall/SKILL.md` allows.

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

Research and analysis split across parallel workers, or across several rounds of my own
investigation, **MUST** follow `~/.pi/agent/skills/swarm/SKILL.md`; read it before fanning out. In
short: the deliverable is one document, ONE adversarial verifier runs over the union of all worker
findings before anything is merged (never after), and disproved or unverifiable claims go in a short
closing section. This supersedes `team_evaluate`'s per-agent grading for research and analysis; for
code work, intake's per-unit gates stay as they are.

## External side effects

Never post outward-facing communication without the user's explicit request for that specific
action. This includes: comments, review replies, or review submissions on GitHub PRs; comments or
status changes on Linear issues; Slack messages; and emails. Review feedback the user pastes into
the session is LOCAL feedback unless they say otherwise — address it with commits only, and put any
proposed reply text in the completion report for the user to post themselves.

Allowed without asking: pushing commits to the agent's own working branch and opening draft PRs.

When asked to copy a Slack message to the clipboard, always use the `slack-copy` skill
(`~/.pi/agent/skills/slack-copy/SKILL.md`) so the formatting survives the paste. Never plain `pbcopy`.

## Ticket work goes through intake

When a message names a ticket ID or a tracker URL and asks for work on it (take, work, fix, build,
ship, figure out), load `~/.pi/agent/skills/intake/SKILL.md` and follow it, even if I did not type
`/skill:intake`. Questions about a ticket (status, what it says) do not trigger it.

## Reviewing a PR when I ask

When I ask for a review of a PR or diff ("review this PR", a PR URL, "review this as well"), do not
review it inline on the lead's model. Spawn one worker with `profile: "code-review"`, which carries the
model (the `code-review` persona in `~/.pi/agent/models.json`; `pi-models show`), the skills (`pr-approval-review`, `github-cli`, `tiger-voice`,
`clear-message`), `extensions: ["mcp"]` for Linear, Datadog and Sentry, and `contextFiles: true`. Give it
the PR URL, the head SHA, and the instruction to follow `pr-approval-review` and write its verdict to a
file, and pass `gateExempt: "review requested by Tiger"`: this review sits outside the PR review gate,
and `team_spawn` refuses a gate-shaped reviewer spawn that carries neither `gate` nor `gateExempt`.
Do not add your own reading of the PR to the brief. Then end the turn. When its report arrives,
relay the verdict and copy-paste comments without rewriting their substance. If you disagree with a
finding, say so separately and name the evidence. The reviewer never posts to GitHub, and you do not
either.

If the gateway rejects the model, say so and ask before falling back to another model. Do not
silently review it yourself instead.

## Convention review before every PR

**The full gate is the `pr-review-gate` skill in the project layer's skill directory
(`~/.pi/homebase/skills/pr-review-gate/SKILL.md`).** Every PR passes its gate lanes
at its current head before it is marked ready: approval (`pr-approval-review`) always; convention
(below), necessity (every hunk maps to the ticket, size budget ~400 added lines) and blast-radius
when the gate's lane script selects them. After a push, `pr-gate-delta.sh` decides which lanes
re-run; any lane that runs reviews the whole PR, never just the delta, and approval re-runs whenever
app code changed. Pass `pr-review-gate` to every
worker that opens or changes PRs. Measured 2026-10-16: a stack that passed per-delta convention
reviews came back with 4 request-changes from one approval review (swallowed failures, non-atomic
writes, missing retries, missing pagination), and one PR had grown to 945 lines across three concerns.

Green CI is not evidence that a change follows the repo's conventions. Before opening a PR, run a
separate convention-review pass: a fresh agent (or a `reviewer`/`code-review` worker in parallel
with implementation, spawned as the gate's convention lane with `gate`, or with
`gateExempt: "convention pre-review"` before the PR exists) whose only job is to diff the changed files against the repo `AGENTS.md` and
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

Estimates (story points): follow `~/.pi/homebase/skills/linear-estimate/SKILL.md`. Set the
`estimate` field on issues you create, with its rubric and a one-line reason in your report. On an
existing issue, set it only when it is empty and the user asked for it in that session. Never change
or clear an estimate the user set. If a write causes Linear to reapply a team-default estimate,
leave it alone and mention it rather than clearing it.

## What a spawned worker actually receives

Skills, extensions (`["mcp"]` for Linear, Confluence, Slack, Sentry), `contextFiles` and `slim` are
orthogonal, default-off under `slim`, and never inherited by a worker or a grandchild. Pass each one
explicitly at every spawn; `team_recycle` re-passes what the original spawn had. The details live on `team_spawn`'s
parameters; a skill passes its name and path only, so the worker must `read` the body.

**`~/.pi/agent/APPEND_SYSTEM.md` is a fifth channel and it is not optional.** Measured 2026-09-23
with a canary: it reaches *every* pi process, including a `team_verify` skeptic launched with the
full isolation set (`--no-extensions --no-skills --no-context-files --no-session`). `pi --help`
offers no flag that suppresses it. So put nothing there that a blind verifier must not see.
Global output-style rules are fine; repo conventions, project framing and anything resembling an
argument are not.

**Always confirm a skill was read, never that it was passed.** `team_spawn` lists names that do not
resolve from the worker's `cwd` as a WARNING, but resolving is not reading. Confirm by grepping the
worker log for the skill path (`grep -c <skill-name> ~/.pi/orchestrator-teams/*/logs/<agent>.log`);
zero hits means it never read the skill, whatever it claims. Do not ask the worker to restate the
skill's headings instead.

A verifier is **clean context, full tooling**: it never sees the worker's reasoning, but it has the
means to check. For sources behind MCP, spawn one with `profile: "verifier-mcp"` plus any skill it
needs; `team_verify`'s limits are in its tool guidelines.

## Skills must actually load in the worker

**All skills live in the pi skill directories: `~/.pi/agent/skills/` or a skill directory listed in
`~/.pi/agent/settings.json`. Never keep a skill inside a repo's `.claude/`, and never symlink one in.**
A repo-local skill name only resolves if the directory is visible from the worker's `cwd`, and a
gitignored skill directory is absent from a freshly created worktree. A force-added copy in a
subdirectory *does* appear in worktrees, which masks the gap.

Pass skills by name or by absolute path, never by a repo-relative path. If a skill you need still
only exists in a repo, move it into a pi skill directory first (`~/.pi/agent/skills/` for personal
skills, the project layer's skill directory for project ones) rather than pointing at it in place.

## Do not dictate PR descriptions in a task brief

Never enumerate what a PR body "must state". The template owns the shape, and a bespoke list in the
brief overrides it — the worker follows the more specific, more recent instruction and produces a
sprawling essay that violates the template's explicit limits. Instead write: *"Fill the PR body from
<the project's PR conventions skill, by absolute path>; read that file before writing it."*

Depth belongs in the ticket and the plan documents, not the PR body.

## Team worker reliability

A `team_spawn`/`team_recycle` success does not mean the worker is healthy. A startup crash arrives
as a "Spawn failed" message and an exit without a report shows as GAP in `team_await`; recycle such a
worker once with a handoff telling it to checkpoint early. If an expected `done` message never
arrived, check `team_status` rather than waiting.

Sleep protection has one holder: the launchd service `com.ycao.pi-agent-caffeinate`
(`~/.pi/agent/bin/agent-caffeinate.sh`). Every 5s it checks for live spawned agents and for
interactive sessions mid-turn, which the `no-sleep-while-working` extension marks with a file in
`~/.pi/agent/run/active/<pid>`. It holds `caffeinate -dis` while a marker is live and `-is` while
only agents are, and releases when neither is. Dead pids are ignored and their markers deleted.
Check `~/.pi/agent/logs/agent-caffeinate.log` for HOLD/RELEASE lines, which name the reason, if a
worker stalls. This does not
survive a lid close — for that, `sudo pmset -a disablesleep 1` (and set it back to `0` after).

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
spawn.** `team_recycle` keeps the skills the worker was spawned with, so the replacement gets it
too.

## PR draft state

Never convert a pull request that is open for review back to draft — not during a rebase, not
while repairing a stack, not "temporarily". Reviewers lose it from their queue. This applies to
side effects too: if a tool flips state, report it rather than toggling it back. Marking a draft
*ready* is fine when the human has asked for review.
