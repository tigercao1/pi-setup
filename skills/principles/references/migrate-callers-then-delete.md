# Migrate Callers, Then Delete the Legacy API

When a new internal API replaces an old one, the work is not done until every caller uses the new
API and the old one is gone. A compatibility layer left "for now" is copied by the next agent that
reads the nearest example, and the codebase ends up with two ways to do one thing.

**Pattern:**
- Deliver it as a stack: the new API, then the caller migrations (grouped so each PR stays within
  the ~400-line budget), and **end the stack with the deletion PR**.
- **No compat shim without a ticket that removes it.** If a shim has to ship, the ticket that
  deletes it exists before the shim merges, and the PR that adds the shim links it.
- Update tests to assert the new contract, and delete tests that only protect pre-refactor
  implementation details.

**When this applies:**
- The old API's callers are all in code you can change in this stack.
- The new API is part of a simplification or refactor the ticket covers.

**When it escalates instead:** callers in code another team owns, or in shared or framework code the
project rules list, including a module's public interface that other teams' modules call. Bring Tiger the caller
list and a proposed stack; do not migrate other owners' code under the current ticket.
