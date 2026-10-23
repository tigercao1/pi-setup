---
name: clear-message
description: Make a message Tiger will post land with a busy reader who skims - question first, the one change named, plain words, a short-answer ending - and prove it with a skim test before he sees the draft. Run it on EVERY message drafted in Tiger's voice (Slack, PR comments, Linear comments, replies), right after drafting with tiger-voice and before showing or copying it. tiger-voice decides how it sounds; this skill decides whether it gets understood.
---

# Clear message

Busy readers skim: the thread title, the first line, the last line. If the ask is not there, they
answer a different question. An illustration: a message proposing that a library keep a member's
book holds when they pause their card reads, to a skimmer, like a description of how pausing already
works. Written topic-first, it gets misread; written question-first, the reader sees the proposal on
the first pass.

## Order of work

1. Draft with `tiger-voice` (wording and tone), writing the numbered rules of the Writing addendum
   (`~/.pi/agent/APPEND_SYSTEM.md`) in as you go, minus tiger-voice's unslop exemptions. Do not
   draft first and clean up after.
2. Write the intent before touching structure:
   - **kind**: `approve` (a change to how things work), `choose` (between options), `do` (a task),
     `answer` (a factual question), `confirm` (the current design is right, no change), `fyi`.
   - **ask**: one sentence, what the reader must reply or do.
   If you cannot write the ask in one sentence, the message is not ready. Ask Tiger what he wants
   from the reader instead of drafting further.
3. Apply the rules below.
4. Run the skim test. It runs the regex lint first (`bin/slop-lint.py --voice tiger`, no model),
   then the skimmers. Fix and rerun on FAIL, at most 3 rounds. Fix lint warnings that are real
   hits; they never fail the test.
5. Show Tiger the draft with the skim-test line under it, then any lint warnings you left in:
   `Skim test: PASS 3/3. A skimmer reads it as: <the skimmers' ASK>`
   On a FAIL after 3 rounds, show the best draft anyway, say it failed, and quote what the skimmer
   understood so he can decide.
6. Only then copy it (`slack-copy`) or hand it over.

## Rules

1. **The first sentence is the ask.** For approve, choose and answer it is the question itself; for
   do it is the action; for fyi it is the news. A thread's parent line states the question, not the
   topic or the button ("Ok to keep book holds active when a member pauses their card? :thread:",
   not "The `Keep holds` option on the pause dialog :thread:").
2. **Start from the person, not the system.** Say what the member wants or what the reader sees
   ("a member who pauses their card but still wants the books they reserved"), not what the code
   does ("pausing a card purges the hold queue").
3. **Name the one change.** Say what would be new and add "everything else already works". Do not
   list existing behaviour next to the change; the reader cannot tell which part is proposed.
4. **Say what happens to people.** "The member never gets the pickup notice", not "the hold events
   get dropped from the queue". Word choice is the Writing addendum's job.
5. **End with a question that has a short answer** matching the kind: "Ok with that?", "A or B?",
   "Can you take a look by Friday?". Not "thoughts?" on its own, and not "love to hear your thoughts"
   when a decision is needed.
6. **Structure beats voice.** `tiger-voice` sets the wording. When the message covers two or more
   behaviours or options, give each its own sentence or bullet, even though his long messages are
   usually plain paragraphs. Never fold them into one comma-joined list.
7. **Ask and context in about 60 words.** Supporting detail goes in a second paragraph or a thread
   reply, after the ask.
8. **One position per message.** Do not follow up with a softer or opposite position before the
   reader has answered the first.

## Skim test

```bash
~/.pi/agent/skills/clear-message/bin/skim-test.py /tmp/slack-msg.md \
  --kind approve \
  --intent "<the ask from step 2>" \
  [--title "<thread parent line, if the message is a thread reply>"]
```

- It cuts the message to what a skimmer sees (title, first 25 words, last sentence) and gives only
  that to fresh readers with no context. A second fresh reader gets the whole message and must
  separate what changes from what already happens. A judge compares both with the intent.
- Three runs; PASS needs a majority and the skimmer must name the same kind. Exit 0 = PASS.
- `--voice tiger` is the default; pass `--voice none` for text not in his voice, or `--no-lint`.
- About 5 seconds. Uses a small model through the gateway, with no tools, skills or context files.
- A PASS is evidence, not proof. A FAIL is a strong signal: the usual fix is moving the question into
  the first sentence or cutting the existing behaviour out of the change.

Run it for every message, including one-liners: for those the skim view is the whole message and it
costs the same few seconds.

## Example

A worked before/after example (posted message, rewrite, skim scores and the reader's own
restatement) lives with the layer it came from: read `voice/clear-message-example.md` if the loaded
project rules point to one. The pattern: the posted version described the situation and buried the
ask; the rewrite opened with the yes/no question, named the one change, and ended with a short
answer the reader could give.
