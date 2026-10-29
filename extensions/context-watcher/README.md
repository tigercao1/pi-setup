# context-watcher

Watches the context size of interactive lead sessions and adds `/fresh`, which writes recall's
pause note and continues in a new session.

## Watcher

After every turn it reads `ctx.getContextUsage()`. Only in interactive mode (`tui`), and never in
orchestrator workers (`PI_ORCH_AGENT_NAME`, `PI_ORCH_TEAM_NAME`, `PI_ORCH_AGENT_ROLE` or
`PI_ORCH_PARENT_NAME` set; `PI_ORCH_NO_ADOPT` alone marks a session-fork successor, which is a lead).

- At `warnTokens` (200k): status line `ctx 212k · ~$0.212/call ($2.65 cache-cold)`, priced from the
  current model's catalog rates (cache read for a warm call, cache write for a cold one, using the
  tier for that context size).
- At `suggestTokens` (250k): the status line adds `/fresh` and one warning notification suggests it.
  It does not repeat until the context drops below `warnTokens` (compaction, new session) and
  crosses again.
- It never pauses, sends a message or switches session on its own.

## /fresh

1. Waits for any running turn, then runs `pi-pause-facts` (`~/.pi/agent/bin/pi-pause-facts`) with
   this session's id, file, pid and context size.
2. Sends the agent one message: finish the current step, follow recall's Pause section with these
   facts copied verbatim, and end with `RESUME: <absolute path>`.
3. After that run settles it switches only if all of these hold: the run was not aborted and its
   last assistant message did not end with `stopReason` `error` or `aborted`; a reply in this run
   ends with a `RESUME: <absolute path>` line (the facts path is not a fallback, and `RESUME: none`
   is a refusal); the file exists and its mtime is not older than the timestamp taken just before
   the pause message was sent. Then it reads the topic from `# Resume: <topic>` and calls
   `ctx.newSession()` with the old session as parent. The new session (same cwd) gets
   `/skill:recall resume <topic>` plus the RESUME.md path.

Any failure before the switch (facts script missing or failing, turn not started, aborted or
errored, `RESUME: none`, no fresh RESUME.md, switch cancelled) leaves the old session as it is and
says why. The switch itself is not transactional: pi closes the old runtime before the new one
starts. So `/fresh` first posts the old session file and the RESUME.md path. If the switch fails
it says whether the old session had already closed (reopen it with `pi --session <file>`), and if
the new session started but the resume message failed, it shows the error there with the manual
`/skill:recall resume` line and the RESUME.md path. When the old UI is gone the message goes to
stderr.

## Settings

`~/.pi/agent/settings.json` (or a project `.pi/settings.json`):

```json
"contextWatcher": {
  "enabled": true,
  "warnTokens": 200000,
  "suggestTokens": 250000,
  "factsScript": "~/.pi/agent/bin/pi-pause-facts",
  "startTimeoutMs": 60000
}
```

All keys are optional; the values above are the defaults. `suggestTokens` below `warnTokens` is
raised to `warnTokens`.

## Tests

```bash
node --experimental-strip-types tests/smoke.ts
../_shared/node_modules/.bin/tsc -p tsconfig.json
(cd ~/.pi/agent/bin/tests && python3 test_pi_pause_facts.py)
```
