---
name: tiger-voice
description: How Tiger (tigercao1) actually writes text he posts under his name - PR review comments on other people's PRs first, other channels as they get captured. Rules come from what he posted, not from what an agent drafted. Load BEFORE drafting any comment, reply, or message Tiger will post himself, and pass it to any worker that drafts such text. Not for running an alignment; that procedure is ALIGN.md.
---

# Tiger's voice

After drafting, run `~/.pi/agent/skills/clear-message/SKILL.md` on the draft before showing it.
This skill decides how a message sounds; clear-message decides its structure and wins where they
conflict (for example, two behaviours get two sentences even though his long messages are plain
paragraphs).

The curated examples (`examples.md` next to this file says where they live) are the source of truth. The rules below summarise it. If a rule
and an example disagree, the example wins. Read both before drafting.

Each rule is tagged:
- **[confirmed 2026-10-15]**: Tiger agreed with it in a session.
- **[observed]**: seen in his posted text but not yet confirmed. Follow it, and ask about it at the next alignment.

## Unslop exemptions

**[confirmed 2026-10-22]** The numbered rules in the Writing addendum (`~/.pi/agent/APPEND_SYSTEM.md`)
apply to his drafts while you write them, except these:

- 18: Slack emoji codes for tone (`:pray:`, `:sweat_smile:`) are fine.
- 20: "Let me know your thoughts" is fine.
- 22: his openers "Great question," and "Good callout," are fine.
- 33: short fragments are fine ("Primary key is UUID", "Updating.").

Rule 13 is not exempt: **[confirmed 2026-10-22]** no em dash, en dash or spaced hyphen used as a
dash in his drafts, even though one curated example has them (those came from the agent draft).
Rule 28 is not exempt (see the run-on rule below). Rule 24 bans only stacked hedges, so keep his
single hedges. `clear-message/bin/slop-lint.py --voice tiger` skips the same patterns.

## Review comments on someone else's PR

- **[confirmed 2026-10-15]** One or two sentences. Most are a single sentence.
- **[confirmed 2026-10-15]** Point at what you see and let the author draw the conclusion: "seems redundant",
  "intended?", "Which one is the truth?". Do not prescribe the fix or write "Please …".
- **[confirmed 2026-10-15]** Often phrased as a question: "Do we need this file still?", "Do we need to add the
  corresponding `es` translations?"
- **[confirmed 2026-10-15]** Say "we", not "you": "We are already checking…", "we used `and` here".
- **[confirmed 2026-10-15]** Point at both places that disagree: this line vs line 35, the PR description vs the
  code, a column comment vs the implementation.
- **[confirmed 2026-10-15]** No emoji prefix (no `:warning:`), no bold title line, no impact/trigger/evidence
  paragraph, no repro steps unless he ran a repro himself.
- **[confirmed 2026-10-22]** Casual, conversational wording, but break up long run-on sentences. He finds his
  own comma-joined run-ons hard to read, so split a sentence that chains several clauses into two or three
  short ones. Keep the casual words and do not polish them into formal prose. This rule wins over the
  run-ons in the curated examples (the `TextScrubber` comment, for one). Copy their wording, not their
  sentence length.
- **[confirmed 2026-10-15]** Identifiers go in backticks.

## Replies on his own PRs

Every reply is in his voice, whoever the reviewer is.

- **[confirmed 2026-10-15]** To a person: open with a short acknowledgement ("Good callout,", "Great
  question,", "Great callout,"), then answer in one or two plain sentences. No SHA unless the
  reviewer needs it to find the change, no numbering.
- **[confirmed 2026-10-15]** The existing "Addressed in <sha>: …" replies on his PRs are agent drafts and are
  not evidence of his voice.
- **[confirmed 2026-10-21]** Answer only the question asked, often as a fragment ("Primary key is UUID").
  Leave out supporting detail and side points unless the reviewer asked for them.
- **[confirmed 2026-10-21]** When agreeing to a change, write the acknowledgement plus the action and nothing
  else: "Good callout, agreed it reads better. Updating." Don't restate the plan or the reasoning.
- **[confirmed 2026-10-21]** When disagreeing about a name or design, say what the thing is or does ("This is
  recording the user's decision…"), then how the alternative reads to him ("I find X feels more like…").
  Don't write "I'd keep X". The posted original is in the curated examples (PR #79300 rename reply).
- **[confirmed 2026-10-21]** Cite evidence as a link to the PR or source ("[create_schedule_builder_availability_templates](…/pull/77385)"),
  not as a backticked filename.

## Any channel

- **[confirmed 2026-10-15]** When the decision belongs to someone else, ask instead of recommending. Drop
  "I'd suggest…" and "Happy to … if you'd prefer". "confirming this is still the case correct?",
  "Do we want to keep logging these?"
- **[confirmed 2026-10-21]** This also covers conditional offers in PR replies: drop "Happy to split if there's
  a rule I'm missing". Ask the question and stop.
- **[confirmed 2026-10-15]** Hedge what he inferred rather than verified: "seems", "I think", "IIRC", "From
  what I've found", "I would assume".

## Slack messages

- **[confirmed 2026-10-15]** A message to a person opens warmly ("Hey <name>,", ":wave: <name>, thanks for
  running the session!") and uses Slack emoji codes for tone (`:pray:`, `:sweat_smile:`,
  `:rolling_on_the_floor_laughing:`). Light humour is fine.
- **[confirmed 2026-10-15]** Cut what the reader did not ask for: summary lines ("I have 12 PRs open"),
  asides, rationale paragraphs and supporting stats.

## Long messages

Anything longer than about five sentences: also read the long examples (`examples-long.md` next to this file says where they live). They hold
a few complete long messages with notes on how each is built. The rules above still apply; that
file only shows how they carry over to several paragraphs.

## How this skill changes

Raw material (everything Tiger posts on GitHub and Slack, plus his corrections to agent drafts) is
harvested into `~/Documents/knowledge-base-remote/Pi/voice/inbox/`. That inbox is not evidence of
his voice until he reviews it: never read it when drafting. Rules and examples change only through
an alignment session (`ALIGN.md`, started by `/voice-align`), and only after he approves each change.
If he corrects a draft's wording during normal work, apply the correction to that draft and leave
the skill alone; the next alignment will pick the correction up from the session log.
