# Gates

Loaded by the `intake` skill before running any gate.

---

## Gates

Verifiers are **blind**: give them the anchor and the diff (or the proposed split). Never the
worker's narrative or self-assessment. A worker's account of its own work is the least reliable
input available and the most persuasive.

**Split gate** — mechanical checks first, they are free:
1. Containment: every child `ALLOWLIST` ⊆ parent's
2. Deps acyclic; no file appears in two units that run in the *same wave* (sequential units may
   legitimately share a file)
3. Inheritance: every child `NEVER` ⊇ parent's
4. No two units give the same file contradictory treatment (one hardens what another deletes)
5. **Coverage** (the expensive one, use a strong model, fresh context): do the children's
   `DONE WHEN` bullets *together* satisfy the parent's? This is the only thing standing between
   you and several tidy PRs that do not add up.

> **Run checks 1–4 as a script, never by eye.** Set operations are only free if a machine computes
> them. An LLM asserting "allowlists are disjoint ✅" without computing the intersection is how two
> contradictory units get scheduled into the same wave. Emit a `check-overlap.py` beside `tree.md`
> and paste its real output.

**Unit gate** — diff satisfies the leaf's `DONE WHEN`; a real test invocation with exit 0 exists in
the session (never accept a self-reported green); no out-of-allowlist files in the diff.

**Release gates.** Some ticket DoD bullets are not agent work — Trust & Security sign-off, staging
verification, old-client drain, finance approval. Give each an explicit owner and place it on the
wave schedule as a gate, not a unit. A DoD bullet with no owning unit *and* no release gate is a
coverage gap, and the usual failure is that it silently becomes nobody's job. No agent may mark a
release gate satisfied or claim a verification it did not perform.

When a gate exposes a bullet nothing can own, prefer **narrowing the anchor with evidence** over
inventing work to cover it — but verify the absence first, and record it.

Use `team_verify` for load-bearing factual claims. All gates bounded at **3 attempts**, then
escalate with the specific failing bullet — not a summary.

---


---

## Never gate a live worktree

A worker reporting `done` is not a frozen worker. It can wake on a queued message, a follow-up, or
its own retry, and keep committing. If you inspect the working tree while that is happening you are
measuring a moving target — and the characteristic failure is concluding a **real** problem was
spurious, because you sampled after the worker already fixed it.

Before any unit gate:

1. Record the SHA under review. Put it in the ledger.
2. Read that SHA, not the tree: `git show <sha>:<path>`, `git diff <sha>^..<sha>`.
3. Re-check `team_status` after gating. If the worker advanced past your SHA, your verdict is
   stale — re-gate against the new head.
4. Treat any disagreement between your finding and the worker's report as a timing question
   first, a correctness question second. Check commit timestamps before concluding the worker
   was wrong.

This also applies to running commands like a boundary checker or a test suite: they execute against
the tree as it is *now*, not against the commit you believe you are reviewing.

---

## PR gate — every draft PR gets an independent review, then loops

A unit is NOT done when the draft PR opens. Opening the PR starts the gate.

1. Spawn an independent reviewer: `profile: code-review` (a different model from the
   implementer — currently `openai/gpt-6.1-sol`) with skills `["pr-approval-review", "github-cli"]`.
2. Give it the **explicit SHA range**, never `HEAD^..HEAD`, and the unit's scope boundary, so it
   does not block on work that later units own.
3. It reviews the **code and the description** (see the description standard in `lanes.md`).
   It must never post to GitHub — verdict and copy-paste text come back to the human.
4. **Blocking items go back to the implementing worker** as new commits, not as a rewrite of the
   commits a reviewer already read. Force-push is not itself forbidden: rebasing a **stale** branch
   onto `origin/main` with `--force-with-lease` is expected, and if no review is recorded on the PR
   yet there is no reviewer diff to preserve, so rebase freely. Always rebase a stale branch rather
   than merging `main` into it.
   Then re-review. **Max 3 rounds**, then escalate with the unresolved item.
5. Non-blocking suggestions are recorded as follow-ups, not actioned. A review loop that
   implements every optional suggestion is scope creep with a second opinion attached.

Distinguish the two checks and run both — they fail differently:

| | Asks | Misses |
|---|---|---|
| **Unit gate** | Does this satisfy its anchor? | Code that meets every bullet and is still bad |
| **PR gate** | Would I approve this? | Requirements the anchor named and the code skipped |

**Do not pre-justify design choices in a review brief.** Give the reviewer the code and the goal. If you tell it "the window is an observability control, do not tighten it", it checks your justification rather than the code, and a second copy of the same construct — where the justification does not apply — gets waved through. That is how a redundant construct survives several review rounds and is caught only by the first human who asks "why is this here?". State scope and deliberate exclusions; do not state why the code is right.

The reviewer must be told what is deliberately out of scope. Otherwise it correctly flags a
staged fix's remaining exposure as a blocking defect, and the loop stalls on a decision that was
already made.
