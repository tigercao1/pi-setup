---
name: blast-radius
description: "Find what a change could break outside its own diff before it ships, and prove the one fact it is safe because of by running real code. A companion to pr-approval-review, not a replacement. Read-only on the PR; runnable as a reviewer lane. Use for 'blast radius of X', 'what could this break', or a small diff you do not trust yet."
---

# Blast radius

Adapted from pstack (MIT, Lauren Tan).

Find what a change breaks somewhere else, before it ships. Use for "blast radius of X", "what could
this break", or a small diff you do not trust yet.

This is a companion to the approval review (`pr-approval-review`). It does not replace any of that
skill's checks; run both when both apply. `how` says what the code does, `why` says why it is shaped
that way, and blast radius says what it breaks somewhere else.

Listing the callers is not the job. Grep does that in a second. The job is the breakage grep does
not show.

## Read-only

Never change the PR: no commits, no pushes, no edits in its worktree, no review comments. Proof
scripts go in a scratch directory outside any git working tree (`mktemp -d`, or the mission's plans
folder). Nothing is posted anywhere. The report goes to a file.

## Do not trust your own writeup

A writeup that sounds right is worth nothing. It reads as convincing whether or not it is true. So
do not hand back the writeup alone. Find the one or two facts the change's safety depends on and
prove them by running code.

### The rung ladder

Push each load-bearing fact as far down this list as is cheap, and say which rung it reached.

1. You said so. Worth nothing on its own.
2. You pointed at the line. A real `file:line`, or the library's own source.
3. You showed the bad case cannot happen. You walked the failure step by step and it does not reach.
4. You ran it. A script or test that calls the real code and fails loudly if you are wrong.
5. You reproduced it in the running app.

Rung 4 is usually one small script that imports the same library version the app ships and calls the
exact function in question.

## Steps

1. Read the change: the diff, the symbols it adds, changes and deletes, and what it now does
   differently, including what the diff does not spell out. Pull the PR and its commits the way
   `why` step 2 builds its code anchor (`git blame`, `git log`, `gh pr view`).
2. Find the one fact it is safe because of. Most changes that look risky are safe because of a single
   fact, such as "this call only drops cache entries that are already dead". If that fact holds, most
   risky cases clear at once. Spend the time here, not on a long list of maybes.
3. Look where grep stops. Read the source of the library being called, at the pinned version, and
   check for a local patch. Work out when things run: callbacks, transactions, background jobs,
   teardown. Follow what a symbol search misses: the JSON an API returns, a DB column, a wire format,
   another service or language reading the same bytes, a feature flag, code three calls downstream.
4. Be honest about each risk. Give it a real chance of happening and a real cost if it does. Keep the
   risks you confirmed. List the ones you checked and cleared separately. Cite a real `file:line`. An
   empty search is still an answer; record it. Never make up a caller or an API.
5. Prove the one fact. Write a script or test that runs the real code, run it, and paste the output.
6. For a large or wide change, say so in the report and recommend a second blast-radius pass on a
   different model family. Different models catch different real bugs. Do not spawn it yourself
   unless you are the lead.

## Running as a reviewer lane

A lead runs this as one worker: `skills: ["blast-radius"]` plus any skill the repo's code needs,
`extensions: ["mcp"]` when the risk touches tickets, logs or error tracking, `contextFiles: true`,
the PR URL and head SHA in the brief, and an output path for the report. The worker reads this file
itself. In `pr-review-gate` it is lane 4: the gate's scripts select it, it runs beside the approval
review on the whole PR, and the brief carries the gate's reach scan, so start from those callers
and spend the time on the breakage the scan cannot see.

## What to hand back

- **What it does.** What changed, including the part that is not obvious.
- **The one fact it is safe because of.** State it, give the rung it reached, and show the proof. If
  it could not be proven, write "unproven".
- **Risks.** Each names how it breaks, the `file:line`, how likely and how bad, and how to check.
  Paste the proof for the ones that matter.
- **Cleared.** What you checked and why it is fine, including empty searches.
- **Before you merge.** The cheapest test or repro that catches the real bug, including the script
  you wrote and where it lives.

Write it under the Writing addendum. Cite real code. Strip anything private before it goes anywhere
others will read.

**Reply:** the writeup above, with the one safety fact either proven (with its rung) or marked
unproven.
