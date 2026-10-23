# Design

Loaded by the `intake` skill at Phase 1.75, and for a reverse design (reviewing PRs that were built
without one).

Source: Dex Horthy, "Why Software Factories Fail, part 2" (2026-07). Human-reviewed planning in four
stages, so the code review afterwards is short.

---

## When

| Route from Phase 1 | Design depth |
|---|---|
| EXECUTE | None. One-shot it. |
| SPLIT, small (2 to 4 units, one pack) | Stages 1, 2 and 4 in one document. |
| SPLIT, large (cross-pack, migrations, FE + BE) | All four stages. |
| SCOPE, SPIKE | None until the route comes back as SPLIT. |

If the project layer names a team spec template, the four stages fill that template's sections.
They do not add a second document.

## The four stages

Each stage is one section of `<mission>/design.md`, rendered with `show-me`. Each stage is reviewed
before the next one starts.

| Stage | Answers | Forms (all from `show-me`) |
|---|---|---|
| 1 Product | What the user sees, why, how we know it worked | Problem in user terms, success metric, Given/When/Then scenarios, rough HTML mockups. No technical detail. |
| 2 Architecture | How the pieces talk | Sequence diagram, endpoint and payload shapes, data model with column names, rollout key. |
| 3 Program design | The shape of the code | Call-stack tree in diff syntax, file-tree diff, new types and public signatures. |
| 4 Slices | The order the work lands in | The slice list below, each with a touch test. |

Technical detail that comes up in stage 1 is written down for stage 2, not argued in stage 1.

## Slices

A slice is one behaviour a person can check once it merges, by curl or in a browser. It is not one
layer.

1. Slice 0 is the contract. Every route the FE will call exists behind the rollout and returns the
   agreed shape.
2. Each later slice adds one group of stage 1 scenarios end to end.
3. Each slice names its touch test: the curl command or the browser step.
4. Each slice should stay under the repo's PR size budget. Split a large slice into smaller
   behaviours. Do not split it into layers.

## The reviewer reads it first

The author picks the people who will review the PRs and sends them stages 2 to 4 before any code.
The human sends it; agents never post. Review comments on the design go in `ledger.md`. A design
question that comes up later in PR review is logged as a design miss.

## The design is the anchor

- Each unit's anchor carries its slice of stage 3: files, signatures, call tree.
- The unit gate compares the diff with that slice. A file or public signature that is not in the
  plan is a review trigger. It is not an automatic failure.

---

## Reverse design: PRs that were built without one

Use this when a reviewer with no context must review PRs that already exist.

1. **Mission file.** Write the PR table (number, base, head SHA, size), the slice ids and the PR
   card template into `mission.md`.
2. **Fan out under `swarm`.**
   - One worker writes stages 1 and 2 from the tickets, the design files and the code.
   - Three to five workers write one PR card each, grouped by stack segment.
   - Every worker gets `extensions: ["mcp"]`, so it can read Linear.
3. **Verify.** One verifier runs over the union of all the worker files, before anything is merged
   together.
4. **Render.** One `show-me` page, in this order:
   - start here,
   - settle first,
   - product,
   - architecture,
   - slice map,
   - approval order,
   - review sessions with the PR cards,
   - glossary,
   - decisions log.

PR card template:

```
### #NNNNN · TICKET · title
- Slice(s):
- Purpose (one sentence):
- Rollout off / on:
- Where to look (2–5 items, file:line, why):
- Call tree (diff syntax):
- File tree:
- New public signatures / schemas / routes:
- Tests: what each group proves
- Decisions baked in:
- Known gaps:
```

On the page, show only the slice, purpose, rollout line, where to look, and the verifier's
corrections. Put the rest in a collapsed block.

The reviewer understands the work slice by slice and approves it in stack order. The page shows
both views.
