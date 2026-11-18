# no-sleep-while-working

Keeps your Mac awake while pi is working: while an interactive session is mid-turn, and while
agents it spawned with the orchestrator are still running.

## How it works

The extension holds the power assertion itself, with no launchd service or install step:

- While the session is mid-turn it runs `caffeinate -dis -w <pi pid>`. `-d` is included because
  without it USB wired network connections can drop when the display sleeps.
- Between turns, while this session still leads live headless agents, it runs
  `caffeinate -is -w <pi pid>` (the display may sleep, the machine does not).
- With neither, it holds nothing.

`-w <pi pid>` ties the assertion to the pi process, so a crash or `SIGKILL` of pi ends it: no orphan
`caffeinate` can outlive the session. The extension also kills its own `caffeinate` when the mode
changes, at `session_shutdown`, and on process exit, so there is at most one holder per session.

A spawned agent counts when its team's `~/.pi/orchestrator-teams/<team>/config.json` has
`leadPid` equal to this pi's pid, its `paneId` is `pid:<n>` (a headless agent), it has no
`killedAt`, and pid `<n>` is alive and is a `pi`/`node` process (so a recycled pid never counts).
Agents in tmux or iTerm2 panes are interactive sessions of their own and hold their own assertion
while mid-turn. The check runs on each turn event and every 15s (`NO_SLEEP_POLL_MS`).

### Marker files

When a turn starts, the extension also writes the marker

```
~/.pi/agent/run/active/<pid>
```

(write a temp file in `~/.pi/agent/run/`, then `rename` it into place) containing JSON with the pid,
cwd and start time. It is removed when the turn settles, when the session ends, and while pi is
blocked on a UI prompt (waiting on a human is not working). An external watcher can read these
markers; override the directory with `PI_CAFFEINATE_ACTIVE_DIR`. If such a watcher also holds
`caffeinate`, there are two holders; that is harmless (the machine stays awake while either is
held). Set `NO_SLEEP_SELF_HOLD=0` to leave holding to the watcher and keep only the markers.

### Subagent safety

The extension only runs in interactive (TTY) sessions. Subagents, which have piped stdio, are
skipped; their lead holds the assertion for them. Set `NO_SLEEP_FORCE=1` to exercise the logic in
print mode.

### Crash safety

A turn that never settles is released by a 15s idle poll and a 90 minute `NO_SLEEP_MAX_HOLD_MS`
backstop. A pi that dies takes its `caffeinate` with it (`-w`). A stranded marker file holds
nothing by itself.

## Requirements

- **macOS** (a no-op elsewhere)

## Settings (environment)

| Variable | Default | Meaning |
|---|---|---|
| `NO_SLEEP_SELF_HOLD` | on | `0` writes markers only and never runs `caffeinate` |
| `NO_SLEEP_POLL_MS` | `15000` | idle and spawned-agent poll interval |
| `NO_SLEEP_MAX_HOLD_MS` | 90 min | longest a single turn holds |
| `PI_CAFFEINATE_ACTIVE_DIR` | `~/.pi/agent/run/active` | marker directory |
| `PI_CAFFEINATE_TEAMS_DIR` | `~/.pi/orchestrator-teams` | where spawned agents are read from |
| `NO_SLEEP_CAFFEINATE_BIN` | `caffeinate` | the holder binary (the tests use a fake) |

## Events

| Event | Action |
|-------|--------|
| `session_start` | Removes a stale marker for this pid, starts the poll |
| `agent_start` | Writes `run/active/<pid>`, holds `-dis` |
| `agent_end` / `agent_settled` | Removes the marker; holds `-is` if this session leads live agents, else releases |
| `ui_prompt_start` | Same as `agent_end` (waiting on the user) |
| `ui_prompt_end` | Rewrites the marker and holds `-dis` if the agent is still busy |
| `session_shutdown` | Removes the marker, releases, stops the poll |
| `process.exit` | Removes the marker, releases (crash safety net) |

## Test

`npm test` (model-free; uses a fake `caffeinate`, then one real `caffeinate -w` check that it dies
with a `SIGKILL`ed process).
