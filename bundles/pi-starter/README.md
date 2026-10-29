# pi-starter

A starter set of pi extensions for running teams of pi agents and long interactive sessions,
in one package. Every extension keeps its own README in `extensions/<name>/README.md`; this page
is the overview and the one-time setup.

## Install

```bash
hb-registry add pi-starter
```

Restart pi, or run `/reload`. To remove it: `hb-registry remove pi-starter`.

## What you get

| Extension | What it does |
|---|---|
| `agent-orchestrator` | `team_spawn`, `team_message`, `team_await`, `team_status` and friends: spawn pi workers and sub-orchestrators, give them a task contract, pass mail, recycle them with a handoff, verify their findings. Visible agents get a tmux or iTerm2 pane; headless agents run in the background with a log. Ships `models.example.json` for per-persona models. |
| `_shared` | Code the other extensions import (mailbox, pane control, prompts, session registry). Not an extension itself and not listed in `pi.extensions`. |
| `session-bus` | A mailbox between pi sessions: `session_send` leaves a note for the session in another repo, delivered now or the next time it starts. |
| `session-fork` | `/fork-pane` branches this session into a new pane, `/fork-back` hands the result back, `/forks` shows the tree. |
| `tab-title` | Names the session with a short emoji-prefixed summary, shown in the terminal tab and above the prompt (`/tab-title`). |
| `no-sleep-while-working` | Keeps a Mac awake with `caffeinate -w <pi pid>` while a turn runs and while agents you spawned are still working; releases when neither is. |
| `context-watcher` | Shows context size and cost from 200k tokens, suggests `/fresh` at 250k. `/fresh` writes a `RESUME.md` pause note (with `bin/pi-pause-facts`) and continues in a fresh session seeded with it. |
| `lead-output-cap` | Writes big tool results to a file and shows the interactive lead only the head, tail and failure lines. |
| `worktree` | `/wt` and a `worktree` tool over the bundled `wt` script: create, list and clean provisioned git worktrees; `team_spawn` with `cwd: "worktree:ABC-123"` gets its own worktree. |
| `notify` | A desktop notification when the agent finishes and waits for you (OSC 9/99/777, else `osascript`). |
| `jev` | A `jev` tool for TypeSafe AI's Jev evaluation model (triage, routing, rubric scoring) through the Vercel AI Gateway. The orchestrator also uses it to route unprofiled workers. |

Also in the package: the `recall` skill (`skills/recall/SKILL.md`: the pause note format,
RESUME.md, the resume steps and the live check of claims), `bin/pi-pause-facts` (used by `/fresh`),
and `extensions/worktree/bin/wt`.

## One-time setup

- **Models for spawned agents (optional).** Copy `aliases`, `personas` and `unprofiled` from
  `extensions/agent-orchestrator/models.example.json` into `~/.pi/agent/models.json`, beside pi's
  own `providers` key, and point the aliases at models your providers serve. Without it the
  orchestrator uses a built-in table (Anthropic Opus and OpenAI GPT on `vercel-ai-gateway`) and
  says so once in a spawn result; a spawn never fails on it. Pass `model` and `provider` on
  `team_spawn` to override per spawn.
- **Vercel AI Gateway key for jev.** `AI_GATEWAY_API_KEY`, or a `vercel-ai-gateway` provider with an
  `apiKey` in `~/.pi/agent/models.json`. Without it the `jev` tool returns an error and unprofiled
  workers get the fallback model.
- **Profiles that name skills you do not have.** The `reviewer` and `code-review` profiles ask for
  skills such as `pr-approval-review`, `github-cli` and `clear-message`; a name that does not
  resolve is listed as a WARNING in the spawn result and the worker runs without it.
- **Pause notes.** Set `PI_PAUSE_PLANS_ROOT` to a notes folder outside your repos so `/fresh` can
  name `<root>/<TICKET>/RESUME.md` itself; without it the agent picks the folder.
- **`wt` in your shell (optional).** Link `extensions/worktree/bin/wt` onto your `PATH`. Repo
  provisioning profiles are described in `wt --help`.
- Requirements: macOS or Linux, `git`, `python3` (for `pi-pause-facts` and `wt`), `gh` for PR facts.
  `no-sleep-while-working` is macOS only and does nothing elsewhere.

## Terminals: panes and the headless fallback

Panes need **tmux** (pi started inside a tmux session, `tmux` on `PATH`) or **iTerm2** on macOS
(driven through AppleScript; allow the automation prompt the first time). The backend is picked
automatically; force one with `PI_ORCH_BACKEND=tmux|iterm2|headless`.

In any other terminal (Terminal.app, VS Code, Ghostty without tmux) everything falls back to
**headless**:

- `team_spawn` still works; agents run as background processes with output in
  `~/.pi/orchestrator-teams/<team>/logs/<agent>.log`. A sub-orchestrator that must wait for its
  own children needs a pane, so `team_spawn` warns about that combination.
- `/fork-pane` prints a ready-to-run command instead of opening a pane.
- `notify` falls back to an `osascript` notification; `tab-title` sets the title with OSC 0 where
  the terminal honours it and always shows it above the prompt.

## Where things are written

`~/.pi/orchestrator-teams/` (team state, logs, mail), `~/.pi/session-forks/` (fork registry and
handoffs), `~/.pi/agent/session-bus/` (mailboxes), `~/.pi/agent/run/` (sleep markers and capped
tool output).

## Build

This folder is generated by `build.sh` from the extensions in the source repo; `BUILD_INFO` names
the source commit.
