# Binding: pi (personal extensions)

Tool names are what the model sees. Source: `~/.pi/agent/extensions/*`.

| Capability | Binding | Notes and fallback |
|---|---|---|
| delegate a worker | `team_spawn` with `taskContract` (outputPath, requiredFields, evaluationCriteria), `profile`, `skills`, `extensions`, `contextFiles` | Contract checked by `team_await`. Fallback: do the slice yourself, in order, and say no worker ran. |
| wait for workers | `team_await` (never from the interactive lead; end the turn instead) | Reports also arrive as messages. |
| check, steer, stop a worker | `team_status`, `team_diagnose`, `team_message`, `team_request_shutdown`, `team_force_shutdown` | |
| respawn with context | `team_write_handoff` then `team_recycle` | Fallback: new worker with the partial output attached. |
| checkpoint | `team_write_handoff`, `team_write_status` | Fallback: write a file with goal, done, next step. |
| grant external tools to a worker | `extensions: ["mcp"]` on `team_spawn` | Fallback: tell the user which tool the slice needs. |
| model tier | `profile`: researcher, coder, reviewer, verifier, verifier-mcp, manager | Fallback: current model; say the tier was not honoured. |
| verify one claim | `team_verify` (3 skeptics, 2 of 3) | Only for claims checkable without MCP. Fallback: one worker re-derives from the source; say it is not a 2-of-3 check. |
| grade finished workers | `team_evaluate` | |
| fast judge (classify, score, boolean) | `jev`, `jev_classify` | Fallback: judge against the written rubric yourself; say so. |
| run many tool calls as one script | `codemode` (pi built-in extension) | Fallback: sequential calls. |
| discover a deferred tool | `tool_search` (pi built-in extension) | Fallback: ask the user. |
| isolated checkout | `worktree` tool (wraps `~/.pi/agent/bin/wt`) | Fallback: `git worktree add`; a branch alone is not isolation. |
| send context to another session | `session_list`, `session_send` | Session mail, not a notification to the human. |
| tell the human | ordinary reply; `ding`/`notify` extensions on macOS | |
| config root | `~/.pi/agent` | Skills: `~/.pi/agent/skills`. |
| worker logs | `~/.pi/orchestrator-teams/<team>/logs/<agent>.log` | |
| session memory | `pi-memory-export`, qmd indexes, `RESUME.md`, handoffs | See the `recall` skill. |

Rules reach the model through `AGENTS.md` and `APPEND_SYSTEM.md`. A company layer can add its own rules
through an extension that injects them into the system prompt; check which folders it reads.
