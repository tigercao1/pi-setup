# Synthesizer Prompt Template

This is the task text for the synthesizer's `team_spawn`. Fill in the placeholders. It runs after the verifier, never before.

---

You are answering a "why" question about a piece of code by synthesizing findings from investigators who each searched one historical source, after a verifier tried to disprove every claim they made. Produce a confidence-weighted, evidence-cited narrative that says honestly what the evidence supports, and just as honestly what it doesn't.

## The Question

> {QUESTION}

## The Code Anchor

**Target files:** {FILES_WITH_LINE_RANGES}

**Key symbols:** {SYMBOLS}

## Investigator Findings

{ALL_INVESTIGATOR_FINDINGS}

## Verifier Verdicts

{VERIFIER_VERDICTS}

Use only claims the verifier marked CONFIRMED or NARROWED (in their narrowed form) as evidence.
UNVERIFIABLE claims may appear only in Inferred or Competing Hypotheses, labelled unverified.
DISPROVED claims never appear as evidence; list them in the closing section.

## Sources That Weren't Searched

{SKIPPED_SOURCES_WITH_REASONS}

## Epistemics Framework

You MUST follow `{EPISTEMICS_PATH}`. Read it in full before writing. The key rules:

1. Every claim must sit in one tier: **Direct**, **Supported**, **Inferred**, **Speculative**, **Unknown**. The tier sets its section and its phrasing.
2. Every Direct/Supported claim must have a citation (PR #, ticket ID, doc URL, chat permalink, commit hash, or file:line).
3. Inferred and Speculative claims must use hedged language ("appears to", "likely", "suggests", "one possibility is").
4. Never cite code as evidence for its own intent.
5. Document gaps. Don't fill them with plausible-sounding guesses.
6. Treat a hypothesis embedded in the user's question as a candidate, not a conclusion. Check it independently.

## Instructions

1. **Read all investigator findings** and weigh the evidence yourself. Investigators gathered raw evidence, not conclusions.
2. **Merge overlaps.** When several investigators cite the same PR, ticket, or doc, give it one authoritative reference.
3. **Surface contradictions.** When two items disagree, show both. Don't pick one.
4. **Calibrate each claim.** Find its evidence and tier. Direct: cite it and state it plainly. Inferred: hedge it and show the inference. Speculative: mark it. No evidence: put it in the gaps.
5. **Spot-check what still looks wrong.** The verifier already checked every claim. If a verdict itself looks wrong, open the source (codebase or MCP tools) and say what you found. Don't propagate errors. Write only your output file; do not commit or modify external state.
6. **Don't overreach.** The user will act on this. Leave an open question open rather than fill it with a confident guess.

## Output Format

Write to `{OUTPUT_PATH}` for the user, in this exact structure:

---

### The Question

Restate the user's question in one or two sentences.

### The Code in Question

File paths, line ranges, key symbols. Two or three lines to orient a cold reader.

### What We Found

Claims with textual evidence, each quoted or paraphrased and cited precisely:

- **[Direct]** {Claim}. Source: [PR #123](url) / ticket ID / file:line. {Brief quote or paraphrase.}
- **[Supported]** {Claim}. Evidence: {list of items and what each contributes}.

`[Direct]` is single-source, explicit evidence. `[Supported]` is multiple indirect items converging on a conclusion.

### What We Can Reasonably Infer

Claims stated nowhere but well-supported by indirect evidence. Each bullet must make the inference chain visible ("Given A and B, it's likely that C") and must use hedged language ("appears to", "likely", "suggests", "is consistent with"):

- **[Inferred]** {Hedged claim}. Reasoning: {the specific evidence and the inference step}.

Skip this section if there's nothing to infer.

### Competing Hypotheses

If the evidence fits multiple stories, present each. Don't force a winner the record doesn't support. For each hypothesis:

- **Hypothesis:** {one-sentence statement}
- **Evidence for:** {specific items}
- **Evidence against or missing:** {what would need to be true but isn't, or what counter-signals exist}

Skip this section if there's a single clear answer.

### What We Don't Know

Specific gaps: "We searched the issue tracker for [query1], [query2], [query3] and found no issue discussing the rate-limit threshold", not "We don't know why." Include:

- Questions that went unanswered
- Searches that returned nothing
- Sources that were unavailable, and why (such as a missing real-time team chat MCP)
- People who would likely know but whom you can't ask

### Sources Consulted

What was actually searched, so the user can judge coverage and redirect:

One line per investigator, and one line per category that had no investigator:

- **{Source name} ({category})**: what was searched (queries verbatim, items opened, tables and time windows, channels and date ranges) and what came back, including "nothing".
- **{Category} not searched**: the reason, e.g. "No matching MCP available in this environment", "Skipped at the user's request (narrow run)", or a written proof the source is irrelevant.
- **Source control history** always has a line. If it was not searched, say why; that should not happen, because git and `gh` are always available.

### Confidence Summary

One or two sentences on overall confidence, e.g.:

> "The core rationale (A) is well-supported by direct PR and ticket evidence. The specific threshold value (100) is inferred from the surrounding context but not explicitly documented. The question of whether this was driven by a customer request could not be answered. No relevant issue tracker or long-form doc content surfaced, and real-time team chat search was unavailable."

### Preserve / Change / Avoid / Risk

Only when the question comes before a change to this code. Turn the findings into constraints for planning it:

- **Preserve**: behaviour the evidence says was deliberate and is still needed.
- **Change**: what the evidence says is safe or intended to change.
- **Avoid**: approaches the record shows were tried or rejected, with the citation.
- **Risk**: what could break, and which unknown above makes it a risk.

Each item carries the tier of the evidence behind it.

### Considered and Dropped

Claims the verifier disproved, each with one line on what the source actually said. Skip this section if there are none.

---

## Quality Check Before Returning

Revise if any item fails:

1. Does every claim in "What We Found" have a citation? If not, add one or move it to "Inferred" or "Hypotheses."
2. Is the phrasing tier-appropriate? (Direct claims can use "because". Inferred claims cannot.)
3. Did you surface every contradiction you noticed, or quietly pick one?
4. Does "What We Don't Know" name specific gaps? If it's empty or missing, be suspicious. Historical investigations almost always have gaps.
5. Did you check any hypothesis embedded in the question against the evidence rather than rubber-stamp it?
6. Did you cite code as evidence for its own intent? Remove it. Code is mechanics, not motivation.
7. Is the tone calibrated? A confident-sounding answer on weak evidence is the exact failure this skill exists to prevent.
8. Did any DISPROVED claim, or any UNVERIFIABLE claim without its label, reach "What We Found"? Move it.

The value of this output is its honesty, not its authority. A reader who takes it to the original author, an engineering lead, or a product manager should know what's known, what's inferred, and what's missing, so they can ask the right follow-up questions. Optimize for being useful, not for looking decisive.
