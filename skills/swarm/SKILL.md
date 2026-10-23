---
name: swarm
description: "Required process whenever research or analysis is split across parallel workers or several rounds: frame, fan out with team_spawn contracts (outputPath, requiredFields), aggregate with team_await (GAP, respawn once), run ONE verifier over the union of findings before consolidating, then write one document. Also covers races (first pass, rank all, best-of), team sizing, monitoring and cleanup. Use for /swarm, 'swarm this', 'fan out', parallel coverage, races and gauntlets."
---

# Swarm

Adapted from pstack (MIT, Lauren Tan). Merged with the house rule "Verify, then consolidate".

The deliverable of a swarm is **one document**, never "see these four files". Per-worker outputs are
raw material. The order is fixed: workers produce findings, one verifier checks the union, then you
consolidate what survived. Verification happens before consolidation, never after.

Open a plan file (or a todo list) with one entry per phase before launching anything:

1. Frame
2. Fan out
3. Aggregate
4. Verify
5. Consolidate

## Phase A: Frame

1. State the done predicate and the one document the swarm must return, with its absolute path
   under the project's plans folder.
2. Choose the shape:
   - **Slices**: partition the work so every slice has one owner and one output file. Coverage
     needs a result for every slice.
   - **Race**: N workers on identical briefs. Declare the selection rule before spawning:
     `first pass` (stop at the first result that meets the done predicate), `rank all` (score every
     result against criteria written down now), or `best-of` (pick one, graft nothing). For a
     rubric race, keep the 3 to 6 criteria out of the workers' briefs; only the picker sees them.
   - **Mixed**: slices, with a race inside the slice that is contested.
3. Size the team. Up to 5 independent tasks: spawn workers directly. More than 5, or work that
   clusters: spawn sub-orchestrators (`profile: "manager"` or `canSpawn: true`), each with a
   stated parallelism budget ("at most 3 workers at once"). The whole team shares the live-agent
   cap; a spawn over a cap is queued and starts by itself, so do not retry it.
4. Pick models with profiles (`researcher`, `coder`, `reviewer`, `verifier`, `verifier-mcp`, or a
   `team.profiles` entry in `~/.pi/agent/settings.json`). `reviewer` and `code-review` carry
   `pr-approval-review`, so `team_spawn` refuses them without `gateExempt: "<reason>"` (e.g.
   `"swarm research"`) outside the PR review gate. Omit `model` to inherit yours. For a model
   race, name each arm's model up front.
5. When workers verify or measure commits, each brief names the exact SHAs. A measurement brief
   also names the method: sample count, what one sample is, order. The worker records both.

## Phase B: Fan out

Spawn every worker with `team_spawn`. Every brief stands alone: goal, scope, the exact slice or
race arm, how to verify, and what to report. The worker cannot see your conversation.

Every spawn carries:

- `taskContract.outputPath`: an absolute path, one per worker. Never give two workers the same
  write target. A spawn without one returns a WARNING, and `team_write_status('done')` refuses a
  missing, empty or misplaced file.
- `taskContract.evaluationCriteria`: specific and testable. Bad: "the file should be well
  written". Good: "covers all 5 sections listed in the task; each cites a file:line or URL".
- `taskContract.requiredFields`: the strings the result must contain, so a miss is caught
  mechanically. Literals match case-insensitively; `/regex/flags` for patterns. Examples:
  `["head SHA", "method:"]`, `["/\\b[0-9a-f]{7,40}\\b/"]`, `["Sources"]`. This checks presence,
  not truth; truth is Phase D's job.
- The channels the work needs, passed explicitly (none is inherited by a worker or grandchild;
  `team_recycle` re-passes the original spawn's): `skills` by name (tell the worker to read each file; only the name
  reaches its prompt), `extensions: ["mcp"]` for Linear, Confluence, Slack, Sentry, Datadog,
  `contextFiles: true` for house rules and for every sub-orchestrator.

Reports use `PASS`, `ISSUES` or `BLOCKED`, with evidence. A worker that can prove a defect lists
every issue it can prove, not only the first. Each finding is marked with its support: primary
source, inference, or unverifiable.

Read the spawn result. A WARNING about unresolved skills means the worker will not get them: fix
the name and respawn. A resolved skill is still not a read skill; before trusting work that
depends on one, grep the worker log for the skill path
(`grep -c <skill-name> ~/.pi/orchestrator-teams/*/logs/<agent>.log`).

Then wait without blocking. In the interactive lead, end your turn: each report arrives as a
message and wakes you. A headless manager calls `team_await` once, which keeps it alive.

## Monitoring

Do not poll `team_status` in a loop. When an agent looks stuck or a report is overdue:

1. `team_status` or `team_diagnose(name)`: is it alive, what did it do last.
2. Recoverable: `team_message` a correction.
3. Useful partial work: ask for `team_write_handoff`, then `team_recycle`.
4. Off the rails: `team_force_shutdown` and spawn again with a clearer brief.

A startup crash arrives as a "Spawn failed" message. A worker that goes quiet may have died
without its report reaching you; check `team_status` rather than waiting.

## Phase C: Aggregate

Read the `team_await` table (or the incoming reports). Its `contract` column shows `ok` or
`missing: ...` for each done deliverable.

- **GAP** means a done agent missed a required field, or an agent exited without reporting. A gap
  is not a pass.
- Respawn each GAP **once**: `team_recycle` with `additionalContext` naming the missing fields and
  telling it to checkpoint early. Recycle re-passes the task, contract, model, profile, skills,
  extensions, contextFiles and slim the worker was spawned with.
- After a second miss, record the gap in the final document. Do not fill it from your own reading.
- If a worker drops out, proceed with N-1 and say so.
- For a race, apply the selection rule declared in Phase A. Do not change it after seeing results.

Never paste raw worker dumps upward.

## Phase D: Verify

ONE verifier runs over the **union** of all worker findings, before you merge anything. One, not
one per worker: cross-worker contradictions are the most valuable thing to catch, and only a
verifier holding every finding at once can see them.

- Its job is adversarial: try to disprove every claim from a named hostile angle. Default angle:
  a reader with zero context who will repeat these claims out loud and be embarrassed if they are
  wrong.
- It re-derives from primary sources. Give it the claims and the sources, never the workers'
  reasoning or narrative.
- Agreement between workers is not evidence; they may share one wrong source. Overlapping claims
  count as one claim and are checked once, against the source.
- Clean context, full tooling. Sources behind MCP (Linear, Confluence, Slack, Sentry, web): spawn
  it with `profile: "verifier-mcp"` plus any skill it needs to read them. `team_verify` skeptics
  have read and bash but no MCP and cannot be configured, so use `team_verify` only for claims
  checkable on disk or by reasoning, one claim per call.
- This replaces `team_evaluate` for research and analysis. `team_evaluate` answers "did each
  worker do its job", not "is each finding true". For code work, per-unit gates stay as they are.

## Phase E: Consolidate

Write the one document from what survived:

- Every surviving claim keeps its label: primary source, inference, or unverifiable. Inferences
  survive, labelled.
- Contradictions the verifier could not settle stay visible as disagreements, with both sources.
- Gaps and dropouts are listed by slice.
- The race rule, when used, and which arm won.
- A short closing section, "Considered and dropped", lists disproved and unverifiable claims, so
  the reader knows they were checked rather than missed.

Per-worker files may stay on disk, cited as appendices at most, never as the answer.

## Cleanup

1. Every agent is done, or its gap is recorded.
2. Read the deliverables and write the consolidated document.
3. `team_cleanup`. Use `team_request_shutdown` for a graceful stop, `team_force_shutdown` if an
   agent does not exit within about 30 seconds.

## Protect your own context

You are the context-scarce node. Delegate evidence gathering (searching, fetching, wide reads,
log digging) even when it looks small. When a result raises a follow-up question, spawn a fresh
worker for it rather than pulling the raw data into your own window.
