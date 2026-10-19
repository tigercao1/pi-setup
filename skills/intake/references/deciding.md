# Deciding open questions

Loaded by the `intake` skill at Phase 1.5.

---

## Phase 1.5 — DECIDE (run before escalating anything)

Open questions are not all the same kind, and the default failure is treating them as if they are:
dumping fifteen questions on the human, most of which the codebase or the database already
answers. Split them.

| Kind | Test | Who resolves |
|---|---|---|
| **Evidence-resolvable** | A query, a grep, or an existing precedent settles it | **the decider agent** |
| **Value judgement** | Reasonable engineers with the same facts still disagree | the human |

404-vs-403 (what does this codebase already do? what does the security team standardise on?),
which scoping rule (who would it actually lock out?), audit lookback (how far back does the data
go, and how long does the query take?) — all evidence-resolvable. Refund policy, customer
notification, accepting a known interim risk — value judgements. Never guess at those.

Spawn **one decider agent per batch of open questions**, in a fresh context, with the read-only
tools it needs — repo, and a read-only DB client if you have one. Its brief:

1. For each question, find the answer in **code precedent, conventions, or data**. Quote it.
2. **Actively try to falsify the orchestrator's recommendation.** Pass the recommendation in, and
   say so: the job is to break it, not confirm it. A decider that agrees with everything has
   added nothing.
3. Return one of: `RESOLVED` with evidence · `VALUE JUDGEMENT` with the tradeoff stated crisply
   and a recommendation · `NEEDS DATA I CANNOT REACH`.
4. Never decide anything on the escalation list below, however obvious it looks.

Write every resolution to `ledger.md` **with its evidence**, so it is not re-litigated after a
recycle and so a human can audit the reasoning later.

> This exists because armchair recommendations are wrong at a rate that matters. An illustration:
> on an access fix for a photo-sharing app, an orchestrator recommends account-wide share links so
> that people who share from several albums are not locked out; one query over the full sharing
> history shows the affected population is **zero**, and the tighter per-album scope is free. The
> decision takes ninety seconds to settle and would otherwise ship a weaker fix on a
> confident-sounding guess.

Escalate the residue — the genuine value judgements — in **one batch**, each with a
recommendation and the evidence behind it. Do not trickle them out one per turn.

