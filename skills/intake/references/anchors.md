# Anchors and anti-drift

Loaded by the `intake` skill. Read before authoring any anchor or
spawning any worker.

---

## The anchor

Every unit of work, at every level, is an **anchor**: the statement of intent that agent carries.

```markdown
<!-- ANCHOR <unit-id> -->
GOAL:      one sentence a stakeholder would recognize
DONE WHEN: - testable bullet
           - testable bullet
NEVER:     - out-of-scope area (the anti-goal)
ALLOWLIST: src/billing/**, test/billing/**
<!-- /ANCHOR -->
```

Rules, non-negotiable:

1. **Never paraphrase an anchor downward.** Copy it byte-for-byte into worker tasks, verifier
   prompts, handoffs, and PR descriptions. Paraphrase *is* drift.
2. **`DONE WHEN` is the only definition of done.** It becomes `taskContract.evaluationCriteria`
   verbatim.
3. **Child anchors narrow, never widen.** Child `ALLOWLIST` ⊆ parent's. Child `NEVER` ⊇ parent's.
4. **`NEVER` carries the weight.** Goals are under-constrained and agents fill the gap with
   ambition. Seed it from `AGENTS.md` plus whatever recon found adjacent and tempting.

---

## Anti-drift during long runs

- Inject the anchor into every worker's opening task, verbatim.
- Checkpoint every ~10 turns and after every wave: worker restates its goal in one sentence;
  compare to `GOAL`. Divergence in the restatement shows up well before it shows up in the diff.
- Every `team_write_handoff` carries the anchor verbatim in `completedWork`.
- Re-read `mission.md` after any recycle. Never reconstruct intent from your own context.
- Log every decision to `ledger.md` so a recycled agent does not re-litigate settled questions.

---

## Allowlists must include the files a change mechanically invalidates

The commonest false fence is a **generated or baseline file** that the anchored work necessarily
dirties: `package_todo.yml`, `schema.rb`, lockfiles, snapshot tests, generated API clients,
CODEOWNERS. The worker is right to stop — but the interruption was avoidable.

When authoring an `ALLOWLIST`, ask: *what does the repo regenerate as a consequence of this
change, and will CI fail without it?* Include those files, and name the command that may touch
them.

When granting one mid-flight, constrain it: **run the regeneration command, never hand-edit**, and
require the diff to be a pure consequence of the unit's own change. Baseline regenerators rewrite
the whole file, so they can silently absorb unrelated drift from other teams. Instruct the worker
to revert and report if the diff reaches beyond its own change — cleaning up drift is someone
else's PR.

---

## A copied anchor goes stale the moment the source changes

"Copy the anchor verbatim" prevents *paraphrase* drift. It does nothing about *version* drift: the
copy in a worker's task is a snapshot, and mid-flight the orchestrator may widen an allowlist,
resolve a decision, or narrow a goal. The worker then ships against one anchor while the verifier
grades against another, and the gate fails on a defect that exists only in the paperwork.

So a copied anchor must always carry its provenance:

```
ANCHOR abc-123-u1 (source of truth: <plans>/ABC-123/tree.md, version 3)
<verbatim block>
Re-read the source before your final check. If it disagrees with this copy, the SOURCE wins —
stop and report the discrepancy rather than guessing which is current.
```

Same discipline for anything else that names a moving target:

- **Pin diff ranges by explicit SHA**, never `HEAD^..HEAD`. Relative refs re-point the instant the
  worker adds a commit, and the verifier silently reviews the wrong change.
- When you amend an anchor mid-flight, note in the ledger which in-flight agents hold a stale copy.
- A gate that fails on a range or file-list mismatch is usually reporting an **orchestrator**
  error. Check your own instructions before you doubt the work.
