# Binding: Claude Code (2.1.277 or later)

Tool names from https://code.claude.com/docs/en/tools-reference.md (fetched 2026-11-03).
Native AGENTS.md reading confirmed on 2.1.317: a project holding only `AGENTS.md` answered a
question about its content in `claude -p`. Everything else below is documented, not yet run.

| Capability | Binding | Notes and fallback |
|---|---|---|
| delegate a worker | `Agent` tool (formerly `Task`) with a prompt that names the output file | No contract check. After it returns, check the file exists and holds each required field, then say whether it did. Background: `claude --bg`. |
| wait for workers | The `Agent` result returns to the caller; background agents notify | Fallback: read the output files. |
| check, steer, stop a worker | `claude agents`, `Monitor`, `TaskStop`, `SendMessage` (agent teams are experimental) | Skip if absent. |
| respawn with context | New `Agent` call with the partial output attached | |
| checkpoint | Write a file with goal, done, next step | |
| grant external tools to a worker | `tools` / `mcpServers` in an agent file under `.claude/agents/`, MCP set up with `claude mcp add` | Fallback: tell the user which MCP server the slice needs. |
| model tier | `model:` in the agent file (`--model` for headless) | Fallback: current model. |
| verify one claim | `Agent` with a fresh prompt holding only the claim and the sources, read-only tools | One skeptic, not 2 of 3; say so. |
| fast judge | `Agent` on a small model, or `claude -p --model <small>` | Fallback: judge against the written rubric yourself. |
| run many tool calls as one script | `Bash` running a script | |
| discover a deferred tool | `ToolSearch` | |
| isolated checkout | `claude -w`, `EnterWorktree`, or `isolation: worktree` on an agent; else `git worktree add` | A branch alone is not isolation. |
| send context to another session | none native outside agent teams | Fallback: write a file and give its path to the user. |
| tell the human | ordinary reply; `Notification` hook if configured | |
| config root | `~/.claude` | Skills: `~/.claude/skills` or `.claude/skills`; the shared skills folder is not read, so symlink or ship a plugin. |
| worker logs | not exposed as files | Use the `Agent` result and the output file. |
| session memory | `CLAUDE.md`, `.claude/rules/`, auto memory | The `recall` skill's qmd indexes do not exist here. |

Rules reach the model through `AGENTS.md` (native). `CLAUDE.md` with `@AGENTS.md` is only needed
before 2.1.277.
