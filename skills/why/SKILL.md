---
name: why
description: "Use for 'why does X work this way', 'why did we pick Y', design rationale, regressions, postmortems, or where a threshold came from. Builds a git/PR anchor, asks before fanning out, then runs one investigator per evidence source (source control, tickets, docs, chat, meeting notes, observability, error tracking, analytics), verifies every claim before synthesis, and returns a cited read split into found / inferred / competing / unknown. Use how for runtime behaviour."
---

# Why

Adapted from pstack (MIT, Lauren Tan).

Investigate the motivation and intent behind code. The companion `how` skill answers what the code
does and how it works. `why` answers what forces led to its shape.

Operate as a careful, cautious and precise investigator. Keep what you know apart from what you are
inferring. `references/epistemics.md` is the confidence framework; the synthesizer must follow it,
and so must you when you present.

## Spawn settings

Every agent below is a `team_spawn` with `extensions: ["mcp"]` and `contextFiles: true`. Without
`mcp` an investigator cannot reach its source and the verifier cannot check a claim. Give each one
its task from the reference template, a findings path in the topic's plans folder, and any skill its
source needs (for example a CLI skill the project overlay names). Confirm each spawn started
(`team_status`). No agent writes anything except its own output file: no comments, edits, labels or
posts in any tool.

| Role | Count | Profile | Template |
|---|---|---|---|
| Investigator | one per source | `researcher` | `references/investigator-prompt.md` + one playbook |
| Verifier | one, over the union | `verifier-mcp` | `references/verifier-prompt.md` |
| Synthesizer | one | none (the default model) | `references/synthesizer-prompt.md` |

Never use `team_verify` for the verifier: its skeptics have no MCP and cannot open a ticket, page or
thread.

## Step 1. Understand the target and the question

The target is usually a chunk of code, a pattern, a feature or a named design decision. The question
is usually a design rationale, a tradeoff, a motivating edge case, an external constraint, dead code,
or a broad history sweep. If the target is vague, make your best guess from the conversation (open
files, recent edits, what was just discussed), state it in one line, and proceed. The user can
redirect.

## Step 2. Build the code anchor

Do this yourself, inline, before anything is spawned: file paths and line ranges, key symbols, the
last few commits touching the target, PR numbers from merge commits (`(#1234)` in the subject), and
linked ticket IDs.

```bash
git blame -L <start>,<end> <file>          # last-touch commits
git log --follow -p -- <file>              # full history through renames
git log --oneline -20 -- <file>            # recent commits, PR numbers visible
git log -1 --format=%B <commit>            # PR number and ticket IDs from one commit
gh pr view <n> --json title,body,author,createdAt,mergedAt,labels,closingIssuesReferences,comments,reviews
```

Pull the PR body and discussion for every substantive commit. The anchor goes to every investigator,
the verifier and the synthesizer.

When the question touches decisions recorded in local notes (plans, ledgers, show-me pages), run
recall's Labels rule and live check (`~/.pi/agent/skills/recall/SKILL.md`) on those notes before
citing them; a `proposed` or `transcript` note is a lead, not evidence.

## Step 3. Find the sources

List the configured MCP servers (the server names in `~/.pi/agent/mcp.json`, confirmed with
`tool_search`, where tools are named `mcp__<server>__<tool>`). Map each to one evidence category.
The project's skill overlay (`## why`) gives the mapping for that project; use it when present.

| Category | Best at |
|---|---|
| Source control (git, `gh`; always available) | rationale captured during implementation and review |
| Issue / ticket tracker | the product or business forcing function |
| Long-form documents | design rationale written before the code |
| Real-time team chat | deliberation that never reached a doc |
| Meeting notes | decisions said out loud in a meeting |
| Infrastructure observability | the runtime signal the code reacts to (timeouts, retries, rate limits) |
| Error / exception tracking | the exceptions behind defensive or corrective code |
| Product analytics (warehouse or tool) | usage, experiments, and where a number came from |

One investigator per source, never one agent covering several. Two sources in the same category (a
warehouse and an analytics tool) get two investigators. A category with no source is a gap, recorded
in Sources Consulted, not a choice.

## Step 4. Ask before the full fan-out

Unless the user already asked for a full why, stop and ask first. Say, in a few lines:

- which investigators would run, one per source, and which categories have no source;
- the rough cost: N investigators plus one verifier plus one synthesizer, each a full worker
  session (the project overlay may give the count for a full run);
- the narrow option: git plus the one or two sources most likely to hold the answer.

Then wait. Do not spawn while waiting. When another skill (`teach`, `intake`) runs `why`, this rule
still applies; the narrow option is the default it proposes.

If the PR description already answers the question completely, say so and offer to stop there. Do
not present that as the full answer unless the user accepts it.

## Step 5. Spawn the investigators

All in one turn, so they run at once. Each task is `references/investigator-prompt.md` filled in,
plus the playbook for its category from `references/source-playbook.md`, plus
`references/sources/incident-postmortem.md` when the target looks defensive (null checks, retries,
timeouts, rate limits, feature flags, egress guards, OOM handlers), plus the anchor and the user's
question in their words.

Skip a source only with a written reason that goes into Sources Consulted: the user chose the narrow
run, no tool exists for it, or it is provably irrelevant ("Error tracking skipped. The target is a
build-time script with no runtime path"). "Probably irrelevant" is not a reason.

## Step 6. Verify before synthesizing

When every investigator has reported, read the findings files and build one claims list over their
union (instructions at the top of `references/verifier-prompt.md`): each claim and its citation word
for word, overlapping claims merged into one, contradicting claims kept as separate lines and marked
as a pair, no inference chains or narrative. Spawn the one verifier on that list. It tries to
disprove every claim from the primary source. Do not reconcile contradictions yourself before it
runs.

## Step 7. Synthesize

Spawn the synthesizer with `references/synthesizer-prompt.md` filled in: the findings files, the
verifier's verdicts, the anchor, the question, the list of skipped sources with reasons, and the
absolute path of `references/epistemics.md`.

## Step 8. Present

Present the synthesizer's output: The Question, The Code in Question, What We Found, What We Can
Reasonably Infer, Competing Hypotheses, What We Don't Know, Sources Consulted, Confidence Summary,
then Preserve / Change / Avoid / Risk when the question comes before a change, then Considered and
Dropped. Light edits for clarity or conversation context are fine. Never rewrite the confidence
language. Keep Sources Consulted at one line per investigator, including empty searches and skipped
categories with the reason.

## Failure modes

- **Recency bias.** The most recent commit is not the authority. The current shape is often many
  earlier decisions piled up. Trace back.
- **Confirming the user's guess.** A hypothesis in the question is a candidate, not a conclusion.
- **Code as its own evidence.** What the code does is mechanics, not motivation.
- **Filling a gap.** "We searched A, B and C and found nothing" is an answer. A confident guess is not.
