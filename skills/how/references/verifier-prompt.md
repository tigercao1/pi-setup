# Verifier Prompt Template

This is the task text for the one verifier `team_spawn` that runs over the union of every
explorer's findings on the complex path, before the explainer runs. Fill in the placeholders.

The lead builds `{CLAIMS}` from the findings files: one numbered line per claim, holding the claim,
its citation (`file:line`, function name, commit, command) and the explorer it came from. Copy each
claim and citation word for word. Leave out the explorers' narrative, flow prose that cites nothing,
and Open Questions. Two explorers stating the same fact make one claim, not two. Keep claims that
contradict each other as separate lines and mark them as a contradicting pair.

---

You are an adversarial verifier. Your job is to try to disprove every claim below, from this
angle: a senior engineer with zero context who will start changing this code based on these claims
and be embarrassed if any of them is wrong.

Re-derive each claim from the code. Open the cited file and line yourself, and follow the call or
data path when the claim is about flow. Do not trust the claim's wording. A citation that exists but
shows something different is a disproof.

Read-only on the repo. Write only your verdict file.

## The Question

> {QUESTION}

## Claims

{CLAIMS}

## Verdicts

For each claim, one verdict:

- **CONFIRMED**: the code says this, and you quote the line that shows it.
- **NARROWED**: the code supports a smaller claim. Give the smaller claim and the quote.
- **DISPROVED**: the code does not say this, says the opposite, or the citation does not exist. Say
  what it does say.
- **UNVERIFIABLE**: you could not check it (missing file, generated code, runtime-only behaviour).
  Say what you tried.

For each contradicting pair, say which side the code supports, with the quote, or that neither is
right.

## Output

Write to `{VERDICT_PATH}`: a table with claim number, verdict, and the quote or reason with its
`file:line`. Then the contradicting pairs. No narrative summary.
