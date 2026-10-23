---
name: principles
description: "Engineering principles: load after a second failed fix, when debugging, before reporting a measured number, writing retrying jobs, deleting an API, or choosing data structures."
---

# Principles

Adapted from pstack (MIT, Lauren Tan). Read the leaf before you apply or cite a principle; cite
only leaves you read in this session. Each leaf is short.

| Principle | Applies when | Leaf |
|---|---|---|
| Attack the premise | Two or more fixes that share one premise have failed the same gate. Write the premise down and test it before the next fix. | `references/attack-the-premise.md` |
| Fix root causes | Debugging. Trace the symptom to the first wrong decision and fix it there; a guard is a fix only when the state it handles is legitimate. | `references/fix-root-causes.md` |
| Explain the number | Before you trust, report or act on a measured number (speedup, regression, latency, a query count, an eval). Name its limiter and rule out mis-measurement. | `references/explain-the-number.md` |
| Make operations idempotent | Writing jobs, migrations, commands or loops that run amid crashes, restarts and retries. | `references/make-operations-idempotent.md` |
| Encode lessons in structure | You are writing the same instruction a second time, or see a recurring correction. Make it a check, not more text. | `references/encode-lessons-in-structure.md` |
| Separate before serializing shared state | Application code where concurrent actors may write one file, key, row or state object. Remove the sharing before adding a lock. | `references/separate-before-serializing-shared-state.md` |
| Migrate callers, then delete | A new internal API replaces an old one. End the stack with the deletion PR; no compat shim without a ticket that removes it. | `references/migrate-callers-then-delete.md` |
| Data modelling | Choosing core types and data structures, writing stateful logic, code that branches a lot, or code that is hard to trace. | `references/data-modelling.md` |

Not adopted, because a house rule or gate already covers them or they conflict with one: prove it
works, test behavior (see the project's test skill), sequence verifiable units, laziness, guard the
context window, never block on the human, outcome-oriented execution, redesign from first
principles, exhaust the design space, experience first, build the lever, subtract before you add,
boundary and type-system discipline.
