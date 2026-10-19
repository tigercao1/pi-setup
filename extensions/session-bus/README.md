# session-bus

Pass context between pi sessions. Leave a note for the session in another repo — whether or not it
is running right now.

```
session_send({ to: "payments", note: "Currency formatting lives in PriceFormatter, not the UI.",
               paths: ["/tmp/finding.md"], shareSession: true })
```

The receiving session sees:

```
✉ from @backend — another pi session (01a0e1b4-…, /tmp/example-project) · just now
Not typed by the user here. Reply with session_send({ to: "01a0e1b4-…", note: "…" }); an answer in this chat does not reach the sender.

Currency formatting lives in PriceFormatter, not the UI.

Referenced files (read them if relevant):
  - /tmp/finding.md

Sender's session: 01a0e1b4-…
  Question it directly: pi --session 01a0e1b4-… -p "<question>"

(session-bus message 1792…-41971-3)
```

The reply address is the sender's full session id, which always resolves to that one session's
personal mailbox, even when the sender is the only session in its folder.

## Delivery: queue or steer

`delivery` decides how a **live** receiver gets the note. Neither mode ever aborts the receiver.

| `delivery` | receiver busy | receiver idle | shown as |
|---|---|---|---|
| `"queue"` (default) | held for its next prompt | held for its next prompt; no turn | a `session-mail` message, rendered when that prompt starts |
| `"steer"` | steering: after the current assistant turn and its tool calls, before the next model call | a turn starts with the note | a user message, listed as `Steering: …` under the editor while queued |

`"steer"` uses `pi.sendUserMessage(text, { deliverAs: "steer" })`, the same path as the user typing
while the agent runs (or `/steer` in pi's examples). `wake: true` is kept as an alias for
`delivery: "steer"`; an explicit `delivery` wins. Mail from older senders that only set `wake` is
steered too, and new mail still sets `wake` so receivers running an older bus wake for it.

During a manual `/compact` pi rejects new prompts, so steering mail is held and delivered when the
compaction ends (acked as `deferred`). Mail left for an offline session is delivered at its next
start by the same rule: queued mail waits for the first prompt, steering mail starts a turn.

**Delivery acknowledgements.** When a receiver injects a message it writes
`acks/<message-id>.json` with what it did: `queued`, `steered` (busy; after its current step),
`started` (idle; a turn started) or `deferred` (compacting), plus its session id, alias and folder.
`seenAt` is added when the message actually enters its conversation. `session_send` waits up to
5 s (`PI_BUS_ACK_WAIT_MS`) and reports exactly that, e.g. *"Delivered as steering to **garden-api**
(session 01a14774, …). It was busy; it will see the note after its current step…"*, or
*"Receiver … was idle; started a turn with the note."* A `started` ack is only reported as started
once `seenAt` confirms the turn began. With no ack in time the reply says which of two things is
true: still unread in the inbox, or taken by a session that did not acknowledge (one still running
an older session-bus, which needs `/reload`), so delivery is unconfirmed. Offline targets are not
waited on.

## Tools and commands

| | |
|---|---|
| `session_list` | other sessions: alias, live/offline, directory, queued count |
| `session_send({ to, note, paths?, shareSession?, delivery?, wake? })` | hand over context; `delivery: "queue"` (default) or `"steer"`; `wake: true` = `"steer"` |
| `/sessions` | same list, as a notification |
| `/inbox-sessions` | deliver queued messages now |

`to` accepts an alias, a directory path, or a session id prefix.

**Several sessions in one directory.** A directory address cannot tell sibling sessions apart, and
a session's own directory is its own address, so siblings in the same folder used to be invisible.
Each session now also has a personal mailbox (`inbox/s-<session-id>/`). `/send` lists every live session
on its own row (no folder grouping), this folder first, in a fixed-height window (at most 12 rows)
that scrolls with the cursor; typing filters by name, id or path, `esc` clears the filter then
cancels. `session_list` (the agent tool) stays compact: other folders with several sessions are one
row, and its `directory` parameter lists the sessions inside one. Send to one session with its id prefix. Rows are fitted to the
terminal width: the fork marker (`⑂abcd`) and the id are never cut, only the name is. A bare directory name or
path still means the directory, delivered to whichever session there reads it first. Session ids
survive `pi --continue` / `--session`, so personal mail survives a resume; a session still running
the old extension receives it after `/reload` or restart.

## Three design decisions

**Files, not a socket.** The most useful message is the one left for a session that is *not*
running — "when you next open the payments repo, here is what I found". A socket can only reach a
live peer. Offline mail waits in `inbox/<address>/` and is delivered on that session's next start,
announced as *"N message(s) arrived while this session was away"*.

**Addressed to a place, not a process.** A session id changes on every restart, so mail addressed
to one would be orphaned the moment the target restarted. Addresses are derived from the working
directory and are stable across restarts. (Found the hard way: the first live test sent to a
session id, the target restarted, and the message vanished.)

**References, not payloads.** Pasting one session's context into another is exactly the cost this
tooling exists to avoid. A message carries a short note plus pointers — file paths, and optionally
the sender's session id so the receiver can interrogate it with `pi --session <id> -p "..."`. Notes
over 4 000 characters are clamped with a nudge to send a path instead. Paths that do not exist are
flagged to the sender at send time, because a reference the receiver cannot open is worse than none.

**Never interrupting.** Cross-session context is rarely urgent, so mail is queued for the
receiver's next prompt (`deliverAs: "nextTurn"`) by default. `delivery: "steer"` hands it over like a
steering message instead (see above). Nothing aborts the receiver's run.

Before 2026-10-16, `wake: true` delivered a hidden-until-later custom message with
`deliverAs: "followUp", triggerTurn: true`. A follow-up only runs after the receiver finishes *all*
pending work, and a custom follow-up is not listed in pi's queued-messages area, so a busy receiver
showed nothing for as long as its run lasted (and pressing Esc cleared the queue, dropping it),
while the sender was told *"It will be interrupted now."*

## Discovery

Targets come from two sources, unioned and collapsed to one row per directory:

1. **The OS** — `pgrep -x pi` for running sessions, `lsof` for each one's working directory.
   (pi's argv is literally `pi`, so `pgrep -f bin/pi` finds nothing.) Spawned orchestrator agents
   are filtered out by checking for `PI_ORCH_AGENT_NAME` in their environment: they are pi
   processes, but not places a human sends context to.
2. **The registry** — sessions that have loaded this extension. These supply the alias and are the
   ones that can *receive* immediately.

Scanning the OS matters because the registry only knows sessions that started *after* the extension
was installed. Measured on a working machine: the registry knew 3 sessions, the OS had 28 across 10
directories. Discovery takes ~1s for 28 processes.

| marker | meaning |
|---|---|
| `● live` | running with the bus loaded — receives immediately |
| `● live x3` | several pi sessions in that directory |
| `◐ live*` | running, but has not loaded the bus — mail queues and lands after it restarts or reloads |
| `○ offline` | not running — mail queues until it next starts |

The `◐` case is called out explicitly when you pick it, because "running" and "will see this now"
are not the same thing.

## Identity

A session's own id comes from `ctx.sessionManager.getSessionId()`, never from `PI_SESSION_FILE`.
That variable describes the pi process that *spawned* this one, so a pi launched from inside
another pi (a bash call, a worker) would register under its parent's id and overwrite it — observed
in testing, with two sessions in different repos collapsing into one registry entry.

## Layout

```
~/.pi/agent/session-bus/
  registry/<session-id>.json   one per session instance (liveness, alias, cwd)
  inbox/<address>/*.json       queued messages, deleted once delivered
  acks/<message-id>.json       what the receiver did with a message; pruned after a day
```

Registry entries are pruned after 14 days. Liveness = pid alive plus a heartbeat within 90s.
Set `PI_BUS_ROOT` to relocate the bus (used by the tests).

## Tests

```bash
npm test         # model-free: smoke.ts (addressing, restart survival, clamping, delivery modes,
                 # acks, wake alias) then pi-session.ts (a real pi AgentSession on a faux model:
                 # steer lands after the running tool call, idle starts a turn, queue starts nothing)
npm run typecheck
```

Both use a temporary `PI_BUS_ROOT` and never touch running sessions.

Verified live with two real pi processes in different directories, including the restart case.
