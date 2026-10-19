# jev

Registers a `jev` tool that calls TypeSafe AI's **Jev** evaluation model through the Vercel AI
Gateway, via pi's built-in classifier API (`ctx.modelRegistry.classify`).

Jev takes a blob of state plus typed questions and returns a choice, a score, or a boolean
probability for each — every question in one round trip, each answer carrying a calibrated
confidence.

## What it is not

Jev is not a chat model. `POST /v1/chat/completions` rejects it with `ModelTypeMismatchError`, and
it will never appear in `/model`. It has **no tools** and a 32k context: it cannot read a file, run
a command, resolve a citation or fetch a URL. Everything it judges must be inline in `state`.

Follow one rule: **Jev decides what gets scrutiny, never what is true.** Use it for triage,
routing, rubric scoring and classification. Never use it in place of a deterministic check, and
never treat its output as verification — a verifier has to be able to open the source.

## Usage

```
jev(
  state: "CI failed: NoMethodError undefined method `slug' for nil at recommender.rb:88.
          The same step passed on the previous commit.",
  questions: [
    { id: "blocks", type: "boolean", instructions: "Does this block merging?" },
    { id: "kind",   type: "choice",
      choices: [ { name: "code_defect", criteria: "a real bug in the changed code" },
                 { name: "flake",       criteria: "nondeterministic, unrelated" } ] },
    { id: "sev",    type: "score",
      scale: ["harmless", "minor", "moderate", "serious", "blocks release"] }
  ]
)
```

```
blocks  bool    p=0.84
kind    choice  code_defect  conf=1.00  [code_defect 1.00, flake 0.00]
sev     score   3.02 of 0..4  conf=0.46
```

`boolean` returns `probability` only. `choice` returns a full probability distribution and a
`confidence`; `score` returns a `confidence`, and its `of 0..N` range comes from the length of
`scale`.

`questions` also accepts the gateway's native record form (`{ id: { type, criteria } }`) and
`criteria` in place of `choices`/`scale`, so a call that expressed the right intent is not
rejected on shape.

`model` takes a `vercel-ai-gateway` model id, bare (`typesafe-ai/jev`) or prefixed
(`vercel-ai-gateway/typesafe-ai/jev`). It is always looked up under `vercel-ai-gateway`, so a ref
for another provider such as `typesafe/jev-latest` fails instead of leaving the gateway.

### Which path each tool takes

`jev` uses the built-in classifier API: pi resolves the key, retries, and prices the usage, so the
tool reports cost as well as tokens. The built-in wire shape differs from the raw gateway's — the
boolean type is `bool` with `criteria: {true, false}`, and `instructions` is required for every
type — so `builtin.ts` maps our schema onto it and supplies default instructions and bool criteria
where ours are optional.

`jev_classify` stays on the direct client in `client.ts`, because the built-in API's score answers
carry only `score` and `confidence`: `parseAnswers` in pi-ai's `system-one-shared.js` drops the
per-rung `probabilities`, and `decisionMass` — the gate the whole routing tree rests on — needs
that distribution. The same goes for the replayable ledger entry.

## `jev_classify`

intake Phase 1. Scores recon evidence on clarity, blast radius, unknowns and parallelism, applies
intake's routing tree, and appends the numbers to `ledger.md`.

```
jev_classify(state: "<recon findings>", unit: "ABC-9002", ledgerPath: "<plans>/ABC-9002/ledger.md")
```

The rubric is fixed in `classify.ts` so scores are comparable across missions. Never restate it in
a prompt. `route()` is pure and unit-tested; the tree in `intake/SKILL.md` is the specification and
the code is its implementation.

### Why the gate is probability mass, not `confidence`

Jev's `confidence` measures how sharply the distribution picks one rung. That is the wrong
statistic for a threshold decision. Measured on a one-file change, blast radius came back
`{0: 0.68, 1: 0.09, 2: 0.23}` — 0.77 of the mass below the threshold of 2, so "small" was not in
doubt — yet `confidence` read 0.54 because the model was split between rungs 0 and 1. Gating on
confidence sent a trivial ticket to UNCERTAIN, and it did so intermittently, because 0.54 sits
inside the run-to-run noise.

The gate is therefore `decisionMassFloor` (default 0.6): the share of probability on the side of
the threshold the score chose. Only the dimension deciding the current branch is gated, so a
near-zero `parallelism` confidence — common, since parallelism is meaningless for a one-file
change — never blocks a route.

UNCERTAIN never falls through to EXECUTE. The lanes differ in how much investigation they buy, and
the cheap error is investigating work that did not need it.

### The ledger entry is replayable

Each entry carries a human table and one machine line:

```
| dimension | score | confidence | p(0 1 2 3 4) |
| blast_radius | 1.85 of 0..4 | 0.72 | 0.00 0.24 0.67 0.09 0.00 |

rubric v1 (7ee06e35) · scored by typesafe-ai/jev (796 in / 62 out tokens) · thresholds ...

<!-- jev-classify {"at":...,"route":...,"rubric":{...},"thresholds":{...},"scores":{...}} -->
```

`parseLedger()` reads the machine lines back. Because the full per-rung distribution is recorded,
a later threshold change - fixed or relative - can be replayed over every past classification
without a new API call.

`RUBRIC_DIGEST` is a content hash of the rubric text. `RUBRIC_VERSION` is hand-maintained and can
be forgotten; the digest cannot. Two entries with different digests were scored by different
questions, whatever their version numbers say, and their scores are not comparable. The test suite
pins the digest, so an accidental rung edit fails loudly; when the rubric changes on purpose, bump
`RUBRIC_VERSION` and the pin together.

## Cost and limits

| | |
|---|---|
| Model | `typesafe-ai/jev` |
| Endpoint | `POST https://ai-gateway.vercel.sh/v1/evaluate` (`client.ts`; the built-in API uses the registry's own gateway transport) |
| Context | 32000 tokens (`MAX_STATE_CHARS` refuses at 100k chars first) |
| Pricing | input `$0.042/M`, **output free** |
| Measured | ~300 input tokens for a small call, about $0.000013 |
| Privacy | `zdr: "all"`, `no_training: "all"` |

A `503 service_unavailable_error` has been observed. The client retries 5xx and 429 twice with
backoff, then throws a `JevError`. Callers should fail open.

## Files

| | |
|---|---|
| `client.ts` | `evaluate()`, key resolution, retry, `formatAnswers()`. The direct HTTP path, kept for the per-rung probabilities. Import this directly from other extensions. |
| `classify.ts` | The intake rubric, thresholds, pure `route()`, and `ledgerEntry()`. On `client.ts`. |
| `normalise.ts` | Tool-input shapes to the gateway's record form. No pi imports. |
| `builtin.ts` | Our question shapes to pi's built-in `ClassifierContext`, plus the `jev` tool's formatting. |
| `index.ts` | Tool registration, plus `/jev-rubric` to print the rubric. |
| `tests/` | `npm test` runs all three: offline logic plus live calls. |

## API key

For `jev`, pi's model registry resolves the `vercel-ai-gateway` key itself, including the
`!command` form. For `client.ts` (`jev_classify`, direct importers) it is
resolved in order: `AI_GATEWAY_API_KEY`, `VERCEL_AI_GATEWAY_API_KEY`, then the
`vercel-ai-gateway` `apiKey` in `~/.pi/agent/models.json`, which supports a literal, `$VAR`, or a
leading `!command` (e.g. `!security find-generic-password -s my-ai-gateway -w`).
The resolved value is cached for the process.

## Spawned agents

Workers are launched with `--no-extensions` (`agent-orchestrator/config.ts:451`), so a worker only
gets this tool when spawned with `extensions: ["jev"]`. Names that do not resolve are silently
skipped, so confirm it loaded rather than assuming.
