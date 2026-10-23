# Data Modelling

Merged from three pstack principles: foundational thinking, model the domain, and minimize reader
load. Apply before writing stateful logic, when choosing core types and data structures, when code
branches a lot or repeats a shape assumption across files, and when reviewing code that is hard to
trace.

## Get the data structures right first

Get the data shape right before writing logic. Define core types early, trace every access pattern,
and choose structures that match the dominant paths. DRY the structure, not every line: types and
data models should converge, and three similar statements still beat a premature abstraction.
Prefer explicit over clever.

Sequence for option value: subtraction first (remove dead code), then scaffold (shared types, test
infrastructure, CI checks), then features. Tests before fixes. Each increment should land a coherent
abstraction or deepen one that exists, not spread a new capability across callers as special-case
coordination.

## Model the domain

Encode the real domain in a data structure instead of scattering it across conditionals. A
structure that matches the domain makes invalid states unrepresentable and deletes branches.
Choosing it at write time is cheap; recovering it later reads as a refactor and gets deferred.

Reach for:

- A state machine instead of scattered booleans, phases or lifecycle checks.
- A typed model (a DTO, a value object) instead of loose parameters or repeated shape assumptions.
- A map, registry, lookup table or discriminated union instead of branching spread across files.
- A reducer or command/event model instead of ad hoc state mutations.
- A module organized around one body of domain knowledge instead of a sequence such as load,
  validate, transform and save. Execution order is not ownership.
- A queue, cache, index, graph, tree or normalized collection where the access pattern calls for it.

Do not force an abstraction. Prefer boring code if the current shape is already clear, local and
unlikely to grow. Be skeptical of an abstraction that adds indirection without removing branches,
duplicated rules, invalid states or lifecycle risk.

You skipped this when a new feature grows an existing if/else chain by one more branch, or adds a
second boolean that must stay in sync with the first, or when phase-named modules repeat the same
domain rules across steps.

## Minimize reader load

Maintainability is the work a reader must do to understand code. Track two axes: **layers to trace**
(indirections between the question and the answer) and **state to hold** (hidden or mutable context
the reader must keep in their head). Line counts and complexity scores are proxies.

- **Collapse layers** that cost more than they save: wrappers with one caller, adapters with no
  second implementation, speculative indirection. Inline them.
- **Make adjacent layers change the abstraction.** A layer that repeats the same methods and
  arguments adds load without compression.
- **Shrink state scope:** returns over mutations, locals over fields, fields over module state,
  module state over globals. Derive instead of sync.
- **Name the invariant at the boundary,** not in every consumer, so the reader learns it once.
- Before adding a layer or a piece of state, ask whether it reduces reader load elsewhere by at
  least as much.

**The test:** can a new reader answer "where does X come from?" and "what can change X?" in under
30 seconds? If not, cut layers or cut state.
