# _shared

Code used by more than one extension in this directory. Not an extension itself: there is no
`index.ts`, so pi's auto-discovery ignores it.

Consumers: [`agent-orchestrator`](../agent-orchestrator), [`session-fork`](../session-fork), and `prompt.ts` also [`tab-title`](../tab-title), [`worktree`](../worktree), [`notify`](../notify).

| Module | What it owns |
|---|---|
| `pane.ts` | Putting a process on screen: tmux / iTerm2 / headless backends, layout (`split-v`, `split-h`, `tab`, `window`), pid-file liveness, `0600` env files, capture, focus, kill, and `ownPaneId()` for "which pane am I?" |
| `sessions.ts` | Saved pi sessions: locate by id or by display name, read the session id from a JSON log header, replay an argv as `--session`/`--fork`, wait for a pid to exit, run a one-shot `-p` question, strip orchestrator identity from an env |
| `mailbox.ts` | File mailbox between processes, addressed by an opaque string: post, drain (at-most-once), count, watch (`fs.watch` + poll fallback) |
| `mail-render.ts` | TUI renderer factory for mail delivered as a custom message: collapsed one-liner, expanded full body, stable per-sender colour |
| `spawn-env.ts` | The whitelist env a spawned pi gets: credentials yes, identity (`PI_ORCH_*`, `PI_FORK_*`) and parent-model vars no |
| `prompt.ts` | Slash-command prompt steps: `choose` (one single-option selection; first choice is the no-UI default) and `askMessage` (Enter with nothing = `""`, Esc = `null`, no UI = `""`) |
| `fsjson.ts` | Atomic JSON writes (temp file + rename), never-throwing reads, `sleepSync` |

## Rules of the road

- **No extension state.** Nothing here holds a session, a team, or a registry. Callers pass paths
  and addresses. That is what makes the same mailbox work for `(team, agent)` and for session UUIDs.
- **Identity is explicit.** Any function that builds an env for a child process removes inherited
  identity rather than trusting the caller to remember. Two production incidents came from a child
  that believed it was its parent.
- **Degrade, don't throw.** Missing files, half-written JSON, closed panes and absent backends are
  normal in a multi-process system; they return `null`/`false`.
- **AppleScript is compiled in tests.** iTerm2 scripts only fail at runtime, which in production
  looks like "the pane silently never opened", so the suite runs `osacompile` over every script
  shape.

```bash
npm test        # model-free; skips the AppleScript checks where osacompile is unavailable
npx tsc --noEmit
```
