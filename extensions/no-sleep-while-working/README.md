# no-sleep-while-working

Keeps your Mac awake while pi is actively working on a task.

## How it works

The extension does **not** hold a power assertion itself. It publishes a marker file and the
launchd service `com.ycao.pi-agent-caffeinate` (`~/.pi/agent/bin/agent-caffeinate.sh`) is the single
process that holds `caffeinate`. One holder means no duplicate or orphaned assertions, and
interactive turns and spawned teammates are covered by the same mechanism.

When the agent starts processing, the extension atomically writes

```
~/.pi/agent/run/active/<pid>
```

(write a temp file in `~/.pi/agent/run/`, then `rename` it into place; a failed rename unlinks the
temp so nothing is left in the scanned directory) containing JSON with the pid, cwd and start time. The marker
is removed when the turn settles, when the session ends, and while pi is blocked on a UI prompt
(waiting on a human is not working). Any stale marker for the current pid is removed at
`session_start`.

The watcher polls every 5s by default (`PI_CAFFEINATE_POLL`), so a turn is protected within a few
seconds of starting. While an interactive marker is live it uses `caffeinate -dis`; `-d` is included
because without it USB wired network connections can drop when the display sleeps. With only
teammates alive it uses `-is`.

Override the marker directory with `PI_CAFFEINATE_ACTIVE_DIR` — the extension and the watcher read
the same variable.

### Subagent safety

The extension only runs in interactive (TTY) sessions. Subagents — which have piped stdio, not a
terminal — are skipped; the watcher already counts them directly from
`~/.pi/orchestrator-teams/*/config.json`. Set `NO_SLEEP_FORCE=1` to exercise the logic in print
mode.

### Crash safety

A marker is a file, so a crash or `SIGKILL` can leave one behind. The watcher ignores any marker
whose pid is dead or is no longer a `pi`/`node` process, and deletes it — a stranded marker can
never pin the machine awake. A `process.on('exit')` handler and a 15s idle poll (plus a 90 minute
`NO_SLEEP_MAX_HOLD_MS` backstop) remove the marker in the normal cases.

## Requirements

- **macOS**
- the `com.ycao.pi-agent-caffeinate` launchd service running

## Events

| Event | Action |
|-------|--------|
| `session_start` | Removes a stale marker for this pid, starts the idle poll |
| `agent_start` | Writes `run/active/<pid>` |
| `agent_end` / `agent_settled` | Removes the marker |
| `ui_prompt_start` | Removes the marker (waiting on the user) |
| `ui_prompt_end` | Rewrites the marker if the agent is still busy |
| `session_shutdown` | Removes the marker, stops the poll |
| `process.exit` | Removes the marker (crash safety net) |
