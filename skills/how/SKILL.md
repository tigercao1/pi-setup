---
name: how
description: "Use for 'how does X work', a code walkthrough before changing something, and placement / ownership / layering questions ('where should this live', 'which package owns this', 'is this the right layer'). Explains subsystem architecture, runtime flow and the mental model a senior engineer needs to start working in an area. Use why for motivation."
---

# How

Adapted from pstack (MIT, Lauren Tan).

Explore the codebase to answer "how does X work?" questions. Produce an architectural explanation at
the level of a senior engineer onboarding onto a subsystem: enough to build a working mental model,
not so much that it reads like annotated source.

## Spawn settings

Every agent is a `team_spawn` with `contextFiles: true`, the repo as `cwd`, and an output file in the
topic's plans folder. Agents are read-only on the repo: they read, grep and run read-only commands,
and write only their output file. Add `extensions: ["mcp"]` only when the question needs a ticket,
doc or log to explain the flow. Confirm each spawn started (`team_status`).

- **Explorers** use the cheap `researcher` profile.
- **The verifier** (complex only, one over the union) uses the `verifier` profile, or
  `verifier-mcp` with `extensions: ["mcp"]` when a claim cites a ticket, doc or log. Never
  `team_verify`: it takes one claim per call and its skeptics have no MCP.
- **The explainer** uses no profile (the default model).

## 1. Assess complexity

If the scope is ambiguous, state your reading in one line and proceed. The user can redirect.

- **Simple** (one module, a small utility, a narrow question such as "how does function X work"):
  no explorers. Spawn one explainer that explores and explains in one pass, built from
  `references/explainer-prompt.md` without the Explorer Findings section. Go to step 5. The simple
  path has no verifier.
- **Complex** (a subsystem across several files or services, a cross-cutting feature, a full
  architectural overview): go to step 2.

When in doubt, take the simple path.

## 2. Explore (complex only)

Split the question into 2 to 4 angles, each a distinct slice of the subsystem. Spawn all explorers in
one turn, each with `references/explorer-prompt.md` and its angle filled in.

## 3. Verify (complex only)

When every explorer has reported, build one claims list over the union of their findings
(instructions at the top of `references/verifier-prompt.md`): each claim and its citation word for
word, overlapping claims merged into one, contradicting claims kept as separate lines and marked as
a pair, no narrative. Spawn the one verifier on that list. It tries to disprove every claim from the
code. Do not reconcile contradictions yourself, and do not start the explainer, before it reports.

## 4. Explain (complex only)

Spawn one explainer with `references/explainer-prompt.md`, the explorers' findings files and the
verifier's verdict file. The explainer builds only on claims the verifier confirmed or narrowed,
leaves disproved claims out, and marks unverifiable ones as unverified.

## 5. Present

Present the explainer's output. Light edits for clarity or conversation context are fine; do not
substantially rewrite it. If it contains a diagram or a table, render it by following `show-me`'s
rendering rules rather than pasting Mermaid source into the terminal.

## Output format

The sections in `references/explainer-prompt.md`, dropping any that do not apply: Overview, Key
Concepts, How It Works, Where Things Live, Gotchas.
