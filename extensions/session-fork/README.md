# session-fork

Branch a pi session into another terminal pane, work there, and hand the result back.

```
/fork-pane try approach B     ⑂ opens a new iTerm2/tmux pane running a fork of this session
/fork-back it works, see …    ⑂ delivers a message to the session you came from, focuses its pane
/forks                        ⑂ tree of related sessions: focus, reopen, fork, become, message, kill
/handoff-pane build the lessons page
                              → opens a pane with a FRESH session seeded from a summary of this one
```

## Why

`/fork` and `/clone` branch a session *in place*: you leave the current line of work to follow the
branch. But the reason to branch is usually that you want **both** — keep the main thread open while
a copy of its full context explores something risky in its own window.

That needs three things pi does not provide on its own:

1. a way to launch a fork as a real process in a pane, with the same model and context;
2. a registry, so a second process can tell which session is which, where its pane is, whether it
   is still alive, and what it was forked from;
3. a channel back, so the branch can return a *bounded* result to a live parent instead of you
   copy-pasting between windows.

## Install

Auto-discovered from `~/.pi/agent/extensions/session-fork/index.ts`. It depends on
`../_shared/` (shared with `agent-orchestrator`), so keep both directories together.

```bash
cd ~/.pi/agent/extensions/session-fork && npm test   # model-free smoke test
```

## Commands

| Command | Description |
|---|---|
| `/fork-pane [label]` | Fork this session into a new pane. Asks where to open it (vertical split, horizontal split, tab, window, or headless to print the command), then for a label (Enter for none). Shortcuts: `--vertical`, `--horizontal`, `--tab`, `--window`, `--headless` |
| `/fork-back [message]` | Send a message to the session this one was forked from and focus its pane. Asks whether the parent should act on it or receive it quietly, whether to exit this session afterwards, then for the message. Submitting the message empty sends the last assistant text. Shortcuts: `--turn`, `--no-turn`, `--exit`; `--to <key>` targets any registered session and has no prompt |
| `/forks` | Overlay of every registered session, as a tree |
| `/handoff-pane [instructions]` | Start a **fresh** session in a new pane from a model-written brief of this one plus your instructions. Asks where to open it (the `/fork-pane` layouts, or replace this session in this pane), whether it starts on the brief or leaves it in its editor, then for instructions (Enter for none). Shortcuts: `--here`, `--draft` and the `/fork-pane` layout flags |

Typing any shortcut flag skips all of a command's selection steps, using the defaults for anything not typed; typing the label or message skips its prompt. Esc at any prompt cancels the command. Without a UI (headless, RPC, spawned agents) nothing prompts and the defaults apply.

### Fork or handoff?

| | `/fork-pane` | `/handoff-pane` |
|---|---|---|
| New session starts with | the whole transcript (`pi --fork`) | only a brief: goal, state, decisions, gotchas, files, open threads, then your instructions |
| Context cost | everything the parent has | a page or two |
| Use when | you want to try something with full context | you want someone new to take over a clear piece of work |

The flow of `/handoff-pane`:
1. If you gave no instructions, an editor asks for them.
2. The current model writes the brief (Esc cancels).
3. You review and edit the whole brief.
4. It is saved under `~/.pi/session-forks/handoffs/<key>.md`, and a new pane starts with the same model and thinking level. The successor submits the brief as its first prompt (once; reopening it does not resend).

The successor is registered as a child of this session, so `/fork-back` reports back here and `/forks` shows it in the tree. Like every session, it is also reachable with `session_send`.

### `/forks` keys

| Key | Action |
|---|---|
| `↑↓` / `jk` | move |
| `⏎` | focus that session's pane |
| `o` | reopen it in a new pane (`--session`; exited sessions only) |
| `f` | fork it into a new pane (always safe) |
| `b` | *become* it in this pane (`switchSession`; exited sessions only) |
| `m` | send it a message |
| `y` | copy its launch command into the editor |
| `d` | peek at its pane or log |
| `x` | kill its process (transcript is kept) |
| `q` | close |

A footer entry appears only when it has something to say: which session you are a fork of, the
fork's label, and any queued messages.

## What "fork back" means

Two different things, both supported, deliberately named differently:

| You want | Do this |
|---|---|
| Send a result to the parent and return your attention there | `/fork-back <message>` — the parent renders it as a `⑂ handback`, and its pane is focused |
| Continue the parent session *in this pane* | `/forks` → select the parent → `b` (become) |
| Read the parent in a new pane | `/forks` → parent → `o` |

Handbacks are clamped to 4 000 characters. The point of a fork is to keep expensive exploration out
of the parent's context; letting it paste 40 KB back in would defeat that. Point at a file instead.

If the parent is not running, the message waits in its mailbox and arrives when it next starts.

## Registry

```
~/.pi/session-forks/
  sessions/<key>.json     one record per session: session id + file, cwd, pid, pane, parent, label
  mail/<key>/*.json       queued messages, deleted on delivery
  logs/<key>.{pid,log}    pid file and output of sessions this extension spawned
```

- Every pi that loads this extension **registers itself** on `session_start` and refreshes a
  heartbeat every 20s. Records are plain JSON; `PI_FORK_ROOT` relocates the whole tree.
- `<key>` is the spawn id for panes we launched (`fork-<stamp>-<rand>`), else `s-<session-uuid>`.
- A dead record is not garbage — it is exactly what `o` and `b` reopen. Pruning only drops spawns
  that never produced a session (after an hour) and sessions whose file is gone (after 30 days).
- With `agent-orchestrator` installed, spawned teammates are published here too, so `/forks` is one
  view of every pi process related to yours.

## How it works

- **Identity by env.** A forked pane is told `PI_FORK_SPAWN_ID`, `PI_FORK_PARENT`,
  `PI_FORK_PARENT_KEY` and `PI_FORK_LABEL`. That is the whole mechanism behind "fork back": the
  child knows which record to address, and the record knows where the parent's pane is.
- **Orchestrator identity is scrubbed.** Every spawned process is stripped of `PI_ORCH_*` and gets
  `PI_ORCH_NO_ADOPT=1`. A fork of a lead session that kept those vars would impersonate a teammate
  and could adopt — then destroy — a live agent team on exit.
- **Forking is always safe, reopening is guarded.** `pi --fork` copies the transcript, so the source
  is untouched even while it runs. `o`/`b` reuse one file, so they refuse while its process is
  alive (pid file first, recorded pid second) and offer focus-or-fork instead.
- **Faithful replay.** A reopened session is launched from the recorded argv, so it keeps the model,
  provider and context flags it had. Reopening a stripped-down session under your full settings
  would give the same transcript to a materially different agent.
- **Secrets stay off the command line.** Env, including API keys, is passed through a `0600` file
  the child sources and deletes — nothing in `ps` or in pane scrollback.
- **Mail never interrupts.** Delivery uses `deliverAs: "followUp"`, and `triggerTurn` only when the
  sender asked for it (`--turn`). A handback you want to read yourself costs no model turn.
- **A fork knows it is a fork.** On first start it gets a one-time note naming its parent and its
  focus, and telling it about `/fork-back`. Injected without triggering a turn, so the pane opens
  idle and you steer it.

## Limitations

- iTerm2 splits/tabs attach to the *current* window, so deep chains are easier to follow with
  `--tab`.
- On the headless backend (no tmux, no iTerm2) `/fork-pane` prints a ready-to-run command instead of
  spawning something you cannot see.
- `/fork-back` targets the parent by default. A parent that was never registered (forked by hand
  from a shell) is not addressable — use `/forks` → `m`.
- `--exit` terminates the process right after sending; nothing is appended to the session first, so
  no transcript is lost, but there is no confirmation prompt.
- An ephemeral session (`--no-session`) cannot be forked or registered. There is nothing to fork.

## Tests

```bash
npm test                       # this extension: registry, fork-out, fork-back, /forks actions
(cd ../_shared && npm test)    # the shared pane/session/mailbox layer, incl. AppleScript compiles
```

The suite simulates several sessions in one process (one stub `ExtensionAPI` each, one shared
registry on disk), which is exactly the shape of the real thing.
