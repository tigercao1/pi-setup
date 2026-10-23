---
name: intake
description: "Front door for any unit of work handed over with a minimum prompt: a ticket ID, a Linear/Jira URL, or a plain-English description. Does read-only recon, classifies the work, then routes it — small and well-defined goes straight to a single PR; large or multi-part work is split into child units, each verified and recursively re-entered until every leaf is PR-sized; ambiguous work is scoped by a swarm first; unknown feasibility gets a timeboxed spike. Spawns worker and verifier agents, holds them to an anchor so long runs do not drift, bounds every loop, and escalates to the human on security, billing, migrations, or repeated gate failure. Use whenever asked to 'solve', 'take', 'work', 'look at', or 'figure out' a ticket, issue, project, or problem without being told how to break it down."
argument-hint: "[TICKET-ID | URL | description]"
---

# intake

One prompt in, a list of open PRs out — or a specific question for the human when the work needs a
decision only they can make.

You orchestrate: recon, classification, deciding, splitting, scheduling, verification. You do not
write shipping code — leaves are delegated to the repo's backend/frontend ticket-to-PR skill, as named in the loaded
project rules.

**Recursive.** SPLIT produces child units; each re-enters at Phase 1. A well-defined ticket and a
leaf of a large project are the same object: an anchor small enough to fence one agent.

Read the reference file for a phase when you reach it, not before:

| Phase | Reference |
|---|---|
| Authoring anchors, keeping workers on intent | `references/anchors.md` |
| Resolving open questions before escalating | `references/deciding.md` |
| Design before a split: product, architecture, program design, slices; reverse design for existing PRs | `references/design.md` |
| Running the lanes | `references/lanes.md` |
| Split / unit / release gates | `references/gates.md` |
| Ledger rows, pointer check, end-of-mission audit | `references/ledger.md` |

---

## The anchor, in brief

Every unit at every level carries one. Full rules in `references/anchors.md`.

```
GOAL:      one sentence a stakeholder would recognize
DONE WHEN: - testable bullet
NEVER:     - the anti-goal
ALLOWLIST: src/billing/**, test/billing/**
```

Never paraphrase an anchor downward — copy it byte-for-byte into worker tasks, verifier prompts,
handoffs and PR descriptions. Paraphrase *is* drift. `DONE WHEN` is the only definition of done and
becomes `taskContract.evaluationCriteria` verbatim. Child `ALLOWLIST` ⊆ parent's; child `NEVER` ⊇
parent's.

## Mission directory

State lives on disk — you will be recycled and workers will die.

```
~/Documents/knowledge-base-remote/<Project>/docs/plans/<TICKET>/
  mission.md   root anchor + recon findings      tree.md    child units, deps, status, PRs
  ledger.md    append-only decision log          *.sql/.py  audit queries, gate scripts
```

Write `mission.md` before spawning anything. Append to `ledger.md` at every decision and gate
result. Workers get a path, never a paragraph.

One header line per entry, optional indented prose under it:
`- <ISO ts> · <phase> · <decision> · result: <state> · evidence: <SHA | PR# | path:line | file>`.
Add a `start` row whenever a new agent or session picks the mission up. Supersede a wrong row
with a new one; never edit. Details in `references/ledger.md`.

Resuming or pausing a mission: follow the recall skill's pause and resume sections
(`~/.pi/agent/skills/recall/SKILL.md`).

---

## Phase 0 — Recon (always)

Never infer the lane from the title. Spawn **one read-only researcher** with `extensions: ["mcp"]`
and `contextFiles: true`: what is actually being asked, which files/modules it touches, who owns
them, what prior art exists, what is genuinely unknown versus merely unstated. It also builds a
git-blame/PR anchor for the code the change will touch (`git blame`, `git log --follow`, the PR
bodies via `gh pr view`), and lists every source it searched, including the ones that came back
empty.

If recon surfaces a "why is it like this" question about code the change will alter, offer the
`why` skill (`~/.pi/agent/skills/why/SKILL.md`) and ask the human before its full fan-out.

Optional clarity nudge, after recon: one `jev` call with the human's original ask and the recon
summary as `state`, and two questions:

- `restate` (boolean): "Would a competent engineer reading only this ask likely build something
  other than what is wanted?"
- `deepen` (score, lowest rung first): "already specifies inputs, method and an external check" ·
  "specifies inputs and method, no external check" · "names the outcome, not the method" ·
  "names a goal, not the outcome" · "names only a topic".

`restate` p ≥ 0.6: open the report to the human with a one-line restatement of their goal.
`deepen` ≥ 3 (of 0..4): add one line suggesting `/sharpen`; never run it yourself. Append both
answers to `ledger.md`. The thresholds are a starting guess, to be tuned from the ledger.

Where a spec or triage comment already exists, aim recon at **falsifying** it — specs go stale and
a wrong one poisons every unit downstream. Recon is the cheapest phase and its failure is the most
expensive. Do not economise.

## Phase 1 — Classify

Score from recon **evidence**: clarity, blast radius, unknowns, parallelism. Route in this order:

```
unknowns present                  → SPIKE      (planning around them produces fiction)
clarity low                       → SCOPE
clarity high ∧ blast radius small → EXECUTE
clarity high ∧ blast radius large → SPLIT
```

A ticket can be *large without being ambiguous* — that is SPLIT, not SCOPE.

**Do not score this yourself.** You wrote the recon summary, so judging it in the same context
anchors on your own framing. Call **`jev_classify`** with the recon findings as `state`, the unit
id, and `ledgerPath` pointing at the mission's `ledger.md`. It applies the tree above and appends
the scores, confidences and thresholds to the ledger, so a wrong route is diagnosable from numbers
rather than being an unexplained decision.

The rubric is fixed in `~/.pi/agent/extensions/jev/classify.ts` so scores stay comparable across
missions — never restate or paraphrase it in a prompt. The tree above is the specification; if the
code disagrees with it, the code is the bug.

A route of **UNCERTAIN** means the deciding dimension sits across its threshold, with too little
of the probability mass on either side to call. Decide that one by hand from the recon and record
why. Never read it as EXECUTE.

## Phase 1.5 — Decide

Most open questions are evidence-resolvable (precedent, a grep, a query), not value judgements.
Resolve those with a decider agent before escalating anything. See `references/deciding.md`.

## Phase 1.75 — Design (SPLIT only)

Before splitting, write the design at the depth `references/design.md` gives for the route: product,
architecture, program design, slices. The PR reviewers read it before any unit is ticketed. Its
slices become the units, and its program design becomes each unit's anchor.

## Phase 2 — Lanes

EXECUTE · SPLIT · SCOPE · SPIKE. See `references/lanes.md`.

SPLIT has a mandatory ordering: **gate → ticket the units in Linear → schedule waves → code.**
Never start an EXECUTE agent on a unit that has no issue. Issues are created only after the split
gate passes, and their acceptance criteria are the unit's `DONE WHEN` verbatim. House ticket format:
the ticket-format skill named in the loaded project rules, if any.

## Gates

Verifiers are **blind**: anchor and diff only, never the worker's narrative. Mechanical checks run
as a script, never by eye. All gates bounded at **3 attempts**, then escalate with the specific
failing bullet. See `references/gates.md`.

Before a unit's 3rd attempt, write down the premise the failed fixes share and test it directly.
Two failures that assume the same thing usually mean that thing is wrong.

A unit is not done when its draft PR opens — that **starts** the PR gate, which is the
`pr-review-gate` skill: its scripts pick the lanes, clear each reviewer spawn, record every verdict
and keep the round and spawn budget in `<mission>/gate/<pr>.json`. Blocking items go back as new
commits and the gate's delta script decides what re-runs. Run that skill's procedure; do not spawn
PR reviewers outside it. The unit gate above stays separate: it checks the anchor and is voided by
any new head. The PR description must meet the standard in `references/lanes.md`: a short
summary and a short test plan, nothing else. See `references/gates.md`.

---

## Escalate — stop and ask

- Security, auth/permissions, billing, payroll
- Migrations; shared/framework code (including any area the project rules mark as shared)
- **Any production data change** — produce a reviewed query or runbook, never execute it
- Any gate failing 3×; low recon confidence; an ambiguity where guessing wrong is expensive
- Anything outward-facing: PR comments, Linear comments, Slack, email

Escalation is a **first-class outcome**. A run that never escalates is silently deciding things it
should have asked about. Batch the escalations, each with a recommendation and its evidence.

## Hard limits

| Limit | Value |
|---|---|
| Gate attempts per unit | 3 |
| Recycles per worker | 2, then escalate |
| Concurrent EXECUTE agents | 4 |
| Split recursion depth | 2 |

After every spawn, confirm the worker actually started (`team_status`) — a successful `team_spawn`
does not mean a healthy worker.

## Never report mutable external state from memory

**Before every status report, re-read the state — do not recall it.** PR state, ticket state, CI,
branch head, deploy status: all of these are edited by other people between your turns. That is the
normal case when working alongside a human, not an edge case.

```bash
gh pr view <n> --json state,isDraft,mergedAt,reviews,statusCheckRollup
mcp__linear__get_issue <ID>    # status, assignee, and whether automation moved it
git log --oneline -1 origin/main
```

A fact about a mutable resource is only valid in the turn you observed it. Carrying it forward
without re-checking produces confident, specific, wrong reports — "the draft PR is awaiting review"
hours after the human merged it. This is the same failure as sampling a live worktree: treating a
snapshot as the present.

When a report would depend on remembered state, either re-read it or say when you last looked.
Write the observed state and its timestamp into `ledger.md`, never only into your own context.

## Report back

The lane and why · the unit tree with status and PR links (**re-read, not recalled**) · gate
results · every escalation with its specific question · the `mission.md` path.

Before reporting, run the end-of-mission audit in `references/ledger.md`: `ledger-check.py` exits
0, every spawn, gate verdict and push of this run has a row, and SPLIT or escalated missions get
the cross-model trail review, which ends with `Attention / reviewed by <model>`.
