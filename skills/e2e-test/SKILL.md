---
name: e2e-test
description: Plan and run an end-to-end test of a web app change in a real browser (Playwright) — locally across several builds, and/or on a deployed shared environment (dev, staging) — and prove what actually happened (status, data created, money charged), not just status codes. Covers the pre-flight questions to ask the human in one message, the deploy-SHA gate, login without ever handling a password, building a combined branch for deploy, isolating local data, an answer key with a baseline build that must reproduce the bug, classifying every failure as regression / pre-existing / environment, pixel-level visual parity between a baseline and a changed build, and verified cleanup. Use when asked to "test this end to end", "run the test steps yourself", "use Playwright to test", "test on dev/staging", "check it looks the same", or to QA a PR or a set of PRs before or after merge.
---

# End-to-end testing

The lead plans, gates and verifies; testers drive the browser. One tester per environment.
`references/worker-brief.md` is the brief template — fill it, don't improvise one.
`scripts/capture-login.js` saves a human's manual login for testers to reuse.
`references/visual-parity.md` covers pixel comparison between two builds; `scripts/capture-states.js`
takes the screenshots and `scripts/visual-diff.sh` diffs them.

Project-specific values (environment names and URLs, how deploys are confirmed, the auth provider,
data and payment proof tools, local DB and cache names, past cases) live in the project's skill
overlay under `## e2e-test`. Read it before planning. Where this file says "the overlay", use it.

## 1. Pre-flight — ask the human everything in ONE message

Before spawning anything, settle these. Each one cost a round trip or a dead worker when it
was discovered late.

| Question | Why it matters |
|---|---|
| Which environments can you deploy a branch to (dev, staging, none)? Which URL? | Do not assume "unmerged code can only run locally". Many projects have branch deploys to a shared environment. |
| What exact code must be tested? | Usually "what `main` will be after these PRs merge" → a combined branch (§3). |
| How will the tester log in? | **Never ask for a password.** Default to §4 (human logs in once in a browser you open). Auth providers can force a password reset, a code or SSO; a pasted password lands in the session log. |
| What does the test account look like? Country, feature flags, existing data? | An account property (country, plan, flag) can silently remove cases from the test. Check eligibility rules against the account before promising coverage. |
| Is payment in test mode? How do we see what was charged? | Status codes do not show money. Decide the proof method per environment *before* the brief (§6). |
| Does the change alter what the user sees, or must it not? | Then add a visual parity pass between the baseline and the changed build (§12). |

## 2. Deploy gate — confirm the SHA yourself, before the tester starts

The human's words are not the gate (a "deploy to staging" has turned out to be dev). The deployed
commit as reported by the environment itself is. The overlay names the source (an APM span
attribute, a version endpoint, the deploy tool). Confirm it is your build, then put the confirmed
SHA and time in the brief. The tester re-checks at start and end and reports if it changed mid-run.
Do not probe for health or version URLs the overlay says do not exist.

## 3. Combined branch for a deploy

When several PRs must be tested together:
- Build it with plumbing, never by checking out over someone's worktree:
  `git merge-tree --write-tree A B` → `git commit-tree` → push to a throwaway branch.
- **Merge latest `main` in right before pushing.** In a busy repo `main` moves dozens of commits an
  hour; deploying a stale branch to a shared environment rolls back everyone else's work while it is
  deployed.
- Prove the content: `diff <(git diff origin/main $C) <(git diff $BASE A_and_B)` must be identical
  to the PRs' own changes. Report the file count.
- If a draft PR is wanted for CI, title it `DO NOT MERGE: …`, keep the ticket ID out of the branch
  name and title when the tracker auto-links on them, and close it with `--delete-branch` after.

## 4. Login without a password

Run `node scripts/capture-login.js <sign-in-url> /tmp/e2e-auth/<env>-state.json` (directory
`chmod 700`; `PLAYWRIGHT_PATH` points at a Playwright install if `playwright` is not resolvable).
It opens a headed Chromium on the sign-in page, waits for the human to land in the app, saves
Playwright storage state (`chmod 600`) and closes. Then **verify it headless** (load the state, open
the dashboard, confirm you are not on sign-in) before handing it over. Testers load it with
`browser.newContext({ storageState })`, never print cookie values, and stop if it expires.

Locally, the auth provider may only accept one host and port; the overlay says which. A local
tester may sign in by forging a session for a local dev user. That's acceptable, but it must be
reported.

## 5. Answer key first, with a baseline that must fail

Write expected results per step × build before anything runs, and pass them in the brief.
- Include a **baseline build** (current `main`) on which the bug must reproduce. It proves the
  steps can detect the defect, which works like a mutation check. A suite that passes on the baseline proves nothing.
- Every step lists **status + data created + money moved**. "422" alone is not a pass if a charge
  could have happened before it.
- Mark each cell ✅ matches / ❌ differs; a deviation is re-run once on fresh data, then reported
  with both runs.

## 6. Proof of effect — pick the method per environment, up front

For each environment, decide before the brief how the tester proves:
- **Data**: a direct read of the environment's database (own DB copy locally, a read-only query
  tool on shared environments), or only the app's own JSON/UI where no DB access exists.
- **Money**: the payment provider's test API (confirm a test secret key first), payment rows in
  the DB, or log tags plus code order. A missing trace span is not proof of no charge unless the
  overlay says that environment traces payment calls.

The overlay has the table for the project. If the amount cannot be established, the report says
"charged, amount unverified" — never infer. Confirm a test publishable key in the page before any
purchase; stop on a live key.

## 7. Isolation (local)

- DB: a copy of the dev database (`createdb -T <dev-db> <copy>`, or `pg_dump | psql` if the
  template is busy); migrate only the copy. Never the human's dev DB, never the shared test DB.
- Cache/queue: a separate database number (e.g. `REDIS_URL=redis://localhost:6379/9`); never `FLUSHALL`.
- One worktree, scratch branches prefixed `e2e/`, nothing pushed. Never `git stash`.
- Free ports; stop only processes you started. Under load, dev servers die and network capture times
  out: run steps sequentially, headless, and count retries (each retry may be another charge).

## 8. Every fake is a finding

A local tester that seeds or fakes data to make a step pass (price rows, reference data, flags,
stubbed packages) has found a difference between local and real environments. For each fake, the
lead checks whether the real environments have it **before** the deployed run. A seed that was
needed locally is often missing on the shared environments too, and there it can fail *after* money
has moved.

## 9. Classify every failure before reporting it

For each ❌ or 500:
1. **Regression**: does the failing code or its inputs differ between `main` and the build? (`git diff origin/main $BUILD -- <file>`)
2. **Pre-existing**: same code on `main` → the bug was already there; give the commit that introduced it (`git log -S`).
3. **Environment**: config/data differs from production → compare the environment's settings and rows with production's.
Only regressions block the PRs. The others become follow-up tickets.

## 10. Worker lifecycle

- Spawn one tester per environment with the full brief. **Don't retarget a running or finished
  worker by message.** A worker that finished while blocked has exited, so messages may never reach it.
  Force-kill it and spawn a fresh one with a new name.
- Secrets cleanup (session files) happens **only on final completion**, not when blocked. A tester
  that deleted the login file while blocked made the next attempt impossible.
- One sign-in attempt at most; never trigger resets, codes or SSO.
- Shared environments: create data only in the test user's own account or tenant, never toggle
  global flags, record every created ID for the report.

## 11. Verify the tester's claims, then clean up

Check, don't trust: worktree branch and status, `e2e/*` branches (local and remote — an
unrelated `e2e/...` remote branch may already exist, so check the author), ports, DB copies, cache
keys, temp/session files, PR heads unchanged. Then offer the human a cleanup list. Drop DBs, flush
the cache DB, close the draft PR, and remove worktrees only when asked.

## 12. Visual parity (when the look must match, or must change only where intended)

Follow `references/visual-parity.md`. In short: the baseline build is the spec and nobody edits it;
capture the same surfaces × states on both builds with `scripts/capture-states.js`; prove
the harness is stable by diffing baseline against baseline (must be 0 pixels); then diff change
against baseline with `scripts/visual-diff.sh`. A nonzero diff outside the regions the change is
meant to touch is a fail, investigated pixel by pixel, never waved through by raising the threshold.

## Report shape

One table per build/environment: step · status · data created · money (amount + proof method) ·
✅/❌. Then deviations with evidence and classification (§9), environment issues, every fake or
skipped item, the SHAs confirmed at start and end, the visual parity table if §12 ran, and cleanup
state. Write evidence (screenshots, diff images, redacted network logs) under the ticket's plans
folder and give full absolute paths.
