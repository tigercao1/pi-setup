# Runtime bindings

Skills describe what they need as capabilities in plain words ("delegate a slice to a worker").
Each file here maps those capabilities to the tools of one agent, and states what is lost when a
capability is missing. Skills never name a tool. Load the file for the agent you are running in,
next to AGENTS.md.

| File | Agent |
|---|---|
| `pi.md` | pi with the personal extensions |
| `claude-code.md` | Claude Code 2.1.277 or later (native AGENTS.md) |

Company-specific capabilities (ticket tracker, chat, wiki, metrics) live in the company layer's
`runtimes/` folder, not here.

Rules for a binding file:
- One row per capability; columns are binding, how to call it, and the fallback with the guarantee lost.
- A fallback says what the agent does and what it must tell the reader it could not do.
- Facts about a tool come from its docs or its source; mark anything untested.
