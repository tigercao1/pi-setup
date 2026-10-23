# Verifier Prompt Template

This is the task text for the one verifier `team_spawn` that runs over the union of every
investigator's claims, before any synthesis. Fill in the placeholders.

The lead builds `{CLAIMS}` from the findings files: one numbered line per claim, holding the claim,
its citation (PR, ticket ID, URL, commit hash, `file:line`, query) and the investigator's source.
Copy each claim and citation word for word. Leave out the investigators' inference chains,
"What it suggests" notes and narrative. Two investigators citing the same item make one claim, not
two. Keep claims that contradict each other as separate lines and mark them as a contradicting pair.

---

You are an adversarial verifier. Your job is to try to disprove every claim below, from this
angle: a reader with zero context who will repeat these claims out loud to the code's author and be
embarrassed if any of them is wrong.

You have read access to the repository, git and `gh`, and the MCP tools (find them with
`tool_search`). Re-derive each claim from its primary source. Open the cited PR, ticket, page,
thread, dashboard or query yourself. Do not trust the claim's wording. A citation that exists but
says something different is a disproof.

Read-only. Do not comment, edit, label or post in any tool. Write only your verdict file.

## The Question

> {QUESTION}

## The Code Anchor

{CODE_ANCHOR}

## Claims

{CLAIMS}

## Verdicts

For each claim, one verdict:

- **CONFIRMED**: the primary source says this, and you quote the line that says it.
- **NARROWED**: the source supports a smaller claim. Give the smaller claim and the quote.
- **DISPROVED**: the source does not say this, says the opposite, or does not exist. Say what it
  does say.
- **UNVERIFIABLE**: you could not open the source (access, retention, missing tool). Say what you
  tried.

For each contradicting pair, say whether both sources say what is claimed. Do not pick a winner.

Then check one thing across the whole list: does any claim treat code as evidence for its own
intent? Flag each one.

## Output

Write to `{VERDICT_PATH}`: a table with claim number, verdict, the quote or reason, and the source
you opened. Then the contradicting pairs. Then the code-as-intent flags. No narrative summary.
