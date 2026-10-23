# Lanes

Loaded by the `intake` skill at Phase 2.

---

## Phase 2 — Lanes

### EXECUTE — one leaf, one PR
Create a worktree. Invoke the repo's backend or frontend ticket-to-PR skill (as named in the loaded
project rules) with the leaf anchor copied in verbatim and `DONE WHEN` as the evaluation criteria.

**EXECUTE may bail.** If the worker needs a file outside `ALLOWLIST`, it stops and reports
`needs-split` — it must never widen its own scope. Misrouting is expected and recoverable; silent
widening is neither.

Name the work type and copy its row into the anchor's `DONE WHEN` / `NEVER`:

| Work type | Discipline |
|---|---|
| bug | Reproduce first. Commit the failing test before the fix, inside one PR that is green when it opens; never ship a red PR. Drop hypotheses the evidence refutes. |
| refactor | Pin the current behaviour first. Subtract before you add. Deleting the old API is the last PR of the stack, not part of the first. |
| perf | Baseline number first. Measure before and after the same way, and explain the number, not just report it. |
| investigation | This is SCOPE, not EXECUTE. Re-route. |
| prototype | This is SPIKE, not EXECUTE. Re-route; the code is throwaway. |

### SPLIT — narrow the anchor into children
Produce child units from the design's slices (`references/design.md`). Each unit is one behaviour a
person can check by curl or in a browser once it merges. A unit is never one layer. Each unit is
independently mergeable, has its own reviewer and anchor, and shares no file with a *concurrent*
sibling. Unit 0 is the contract: the routes the FE will call, behind the rollout, returning the
agreed shapes. Record deps.

Do not split a single security fix across PRs to satisfy a size heuristic — shipping half a
vulnerability fix is worse than one larger PR. Conversely, keep unrelated cleanups (dead-code
removal, renames) out of the critical unit so they cannot delay it. Then run the **split gate** below. On failure,
feed back the failing invariant and re-split. **Max 3 attempts, then escalate.**

On pass, **ticket the units before any code is written** (see below), then schedule in
dependency waves. Per wave, per unit: a worktree and an EXECUTE agent.
Disjoint allowlists mean parallel workers cannot collide — that falls out of invariant I1 rather
than needing scheduler cleverness.

After each wave: re-read the root anchor, confirm merged units still serve it, update `ledger.md`.

Then **recurse**: any child that is still too large re-enters Phase 1 as its own mission.

### SCOPE — make an ambiguous thing answerable
Spawn parallel read-only agents on distinct questions (current behaviour, data reality, prior art,
stakeholder intent from the ticket thread). Converge on a filled `DONE WHEN` + `ALLOWLIST`, then
**re-enter Phase 1**. SCOPE never writes shipping code.

### SPIKE — resolve one unknown, timeboxed
One question, throwaway branch, findings to `ledger.md`, then re-enter Phase 1. Code here is
evidence, not a deliverable.

---


---

## PR descriptions

Owned by the repo's PR-conventions skill, as named in the loaded project rules, not by `intake`. Short summary,
short test plan, nothing else — plus `## Stack` when the PR is part of a stack.

Do not restate the standard in a worker's task, and do not ask a worker for content the template
forbids. Asking for "a note in the PR description about what is deliberately out of scope" is how
a 47-line description gets written by a worker that was following orders.

Out-of-scope statements, accepted risks and staging live in the **ticket** and in `tree.md`.

---

## Ticketing the units (SPLIT only, after the gate, before any code)

The unit tree is machine state. Linear is where the humans look. Every unit that will become a PR
gets its own issue, created **after the split gate passes and before the first EXECUTE agent
starts**.

Order matters in both directions:

- **After the gate**, because a breakdown that fails verification would litter the tracker with
  issues you then have to close. Three gate attempts have produced three different unit sets in
  practice.
- **Before coding**, because the issue number belongs in the branch name, the commit and the PR,
  and because a human skimming Linear should be able to see the whole plan before work starts
  rather than discovering it as PRs appear.

### Rules

1. **One issue per unit that produces a PR.** Units that are pure human work (production data
   remediation, audits requiring sign-off) also get an issue, marked as such, so they are not
   silently dropped.
2. **Child of the original ticket** (`parentId`), so the parent keeps its role as the story and the
   children carry the work. If the team uses a project for the effort, set that too.
3. **The issue is the human-readable anchor.** Its acceptance criteria are the unit's `DONE WHEN`,
   verbatim. Do not paraphrase them into the ticket and then paraphrase them back into the worker
   task — same anchor, one wording, three places.
4. **Record the issue ID in `tree.md`** next to the unit, and the unit id in the issue. If they
   drift, `tree.md` is machine truth and the issue is the human view — reconcile, do not fork.
5. **Do not restate the parent's context.** Link it. A child issue that re-explains the whole
   vulnerability is the PR-description bloat failure in a new venue.
6. **Never set `estimate`.** If Linear reapplies a team default, leave it and mention it.
7. **Dependencies go in the issue**, as a blocked-by relation where the tracker supports it, or one
   explicit line otherwise. The wave schedule is otherwise invisible to anyone reading Linear.
8. Follow the house ticket format: load the ticket-format skill named in the loaded project rules,
   if any. Children use its short child/sub-issue variant — link the parent, never restate it.
9. **Each unit's branch and PR reference that unit's own issue, never the parent.** A unit PR says
   `Part of <parent>`; only the last unit — or nothing at all — closes the parent. Linear links by
   branch name as well as body text, so a branch named after the parent can close it on merge
   whatever the description says. This is easy to get wrong and expensive when the parent is an
   open security ticket.

### Confirm once, then create

Before creating, show the human the proposed list — titles plus a one-line summary each — and
create on their go-ahead. One cheap confirmation: issues are visible to the whole team, and a bad
batch is tedious to clean up. Once approved, create them all without further prompting and report
the IDs.

This is the one place the system writes to a shared tracker as a matter of course. Everything else
outward-facing still escalates.
