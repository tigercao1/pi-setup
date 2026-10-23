---
name: teach
description: "Explain a body of work plainly so a person actually understands it. Runs the how and why skills and weaves what they find into one clear explanation, with visuals rendered through show-me. Use for 'teach me this', 'help me really understand X', 'explain this change or subsystem to me', or /skill:teach."
disable-model-invocation: true
---

# Teach

Adapted from pstack (MIT, Lauren Tan).

**Explain what a thing is, how it works, and why it is built that way, in one plain account at the
person's pace. The goal is that they understand it, not that anything changes.**

Teach sits on top of `how` and `why`. Get your bearings on what the work is and what it touches,
then run `how` for how it works and `why` for why it is that way. Read and follow each skill's
`SKILL.md` (`~/.pi/agent/skills/how/SKILL.md`, `~/.pi/agent/skills/why/SKILL.md`); they do their own
digging. Blend what they find into one plain explanation, lead with what matters to the person, and
go deeper when they ask. Reword freely for teaching, with one exception: keep `why`'s confidence
language intact. Its hedges are findings, not style.

1. Decide the few things they should walk away understanding. Choose them from why they are asking
   (about to change it, reviewing it, debugging it, new to it) and what they already know, both read
   from the conversation, not quizzed out of them. Skip what they plainly know. Put the depth where
   their question is.
2. Let `how` and `why` do the work; do not redo it. Read the code yourself to get oriented, then run
   them in parallel and combine the results. Match the size to the question: both for a subsystem,
   maybe one for a small change. When both run, verify once over their union before you combine
   anything: stop each at its findings (how's explorer files, or its simple-path explanation; why's
   investigator files), build one claims list over all of them by the rules at the top of
   `~/.pi/agent/skills/why/references/verifier-prompt.md`, overlapping claims merged and
   contradicting ones kept as marked pairs, and spawn ONE verifier on it (`profile:
   "verifier-mcp"`, `extensions: ["mcp"]`, `contextFiles: true`). This replaces the two skills' own
   verify steps. Then run how's explainer and why's synthesizer with its verdicts, and teach only
   from what it confirmed or narrowed; leave disproved claims out and say which are unverified.
   When only one skill runs, its own verifier is the union verifier, and a simple-path how alone
   needs none. Keep `why` narrow by default, since its full run is slow and costly.
   Put the narrowing in the ask itself (a scoped question, git plus a source or two) so `why`
   records the skipped categories. `why`'s ask-before-fan-out rule still applies: propose the narrow
   run, and widen it only when the user agrees the reasons are the point.
3. Start with a plain definition. Name the thing and say what it is in general terms, the way a
   senior engineer would say it out loud, with its common name if it has one. Then tie it to the case
   in front of you ("in X, we use this to ...") and build from there: how it works, the deeper
   reasons, the edge cases. For each part, explain the problem it solves and how it actually works.
   Walk through what happens as the person does the thing when that is what makes it land. Listing
   functions and constants is reference, not teaching. Give the smallest complete answer first, a
   sentence or two, then stop. Add layers when they ask. Never a wall of text.
4. Keep it a conversation, not a lecture or a performance. Offer to go deeper or move on, and follow
   their lead. No quizzes. No pacing theatre: do not print "Pause", do not ask them to say it back,
   and do not flag a part as important or hard. Just say it. When you would pause, stop and let them
   respond. Running one-shot with no live person, deliver it cleanly and put any offer to go deeper at
   the end.
5. Show, do not only tell, and build the picture up one diagram at a time. Open the diff or the code
   when that is the fastest way to land it. For anything with three or more moving parts, do not draw
   one diagram with everything. Draw a short series, where each diagram redraws the last and adds one
   part, so the reader watches the system assemble. To teach a flow from A to B to C: first A to B,
   then redraw and add C, then redraw and add the return edge or the next piece. A single simple point
   needs no figure. Render every diagram, table and comparison by following `show-me`
   (`~/.pi/agent/skills/show-me/SKILL.md`): its rendering rules and its one-topic, one-file rule. A
   build-up series is one explanation; put it on one page as successive figures, and let show-me's
   one-topic step decide whether that page is new or a new iteration of an existing one.

Write every response under the Writing addendum in the system prompt. Teaching adds these on top: be
tight, not terse; keep the part that makes it click; state the concrete mechanism, not a metaphor,
a framing, or a preview of what is coming. This is the target density: "Virtualization runs in two
parts, one for rendering and one for loading from disk. When an item scrolls out past the buffer,
both its DOM node and its in-memory data are evicted." Give each concept one name and keep it. The
words in these steps are directions to you, not labels to print; do not echo them as headers or stock
phrases.

**Reply:** the explanation itself, never a report about what you did. Lead with the main point, then
the plain account of what it is, how it works and why, and the threads worth chasing with `how` or
`why`.
