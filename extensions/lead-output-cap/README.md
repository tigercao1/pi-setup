# lead-output-cap

Keeps big tool results out of the interactive lead's context. A tool result whose text is over
the threshold is written in full to `~/.pi/agent/run/outputs/<session id>/<toolCallId>.txt` and the
model sees only:

- the first 40 and last 20 lines (lines over 400 characters clipped),
- from the omitted middle, every line matching a failure marker with 2 lines of context either
  side, numbered, up to 60 lines in all,
- the total size and line count,
- the saved path (plus bash's own untruncated log path when bash truncated first),
- one line: read ranges with offset/limit, grep the file, or delegate the digest to a worker.

## When it applies

- Interactive sessions only: `ctx.mode` is `tui` or `rpc`. Print and JSON mode are untouched.
- Never in orchestrator workers: when any of `PI_ORCH_TEAM_NAME`, `PI_ORCH_AGENT_NAME`,
  `PI_ORCH_AGENT_ROLE`, `PI_ORCH_PARENT_NAME` is set the extension registers nothing. (Slim workers
  also run with `--no-extensions`.)

Exempt: `read` with an explicit `limit` of at most `readRangeMaxLines`; results with an image;
errors, and any result whose text matches a failure marker (`error`, `fail`, `Traceback`,
`exception`, `panic`, `fatal`, `not ok`, a non-zero exit), under `errorThresholdBytes`; tools in
`secretTools`, which are also never saved; nested calls (`parentToolCallId`, e.g. codemode scripts, whose
results go to the calling tool and not into context); any tool in `exemptTools`.

When the result has `structuredContent`, it is saved beside the text as
`<toolCallId>.structured.json` and replaced by
`{ leadOutputCap: { truncated, savedPath, structuredPath, bytes, lines } }`, per the rule that a
handler which replaces `content` must also replace `structuredContent`. `details` is left alone.
If the file cannot be written, the result passes through unchanged.

Saved files are written `0600` in `0700` directories. On each `session_start` files older than
`retentionDays` are deleted, and session directories left empty are removed.

## Settings (`~/.pi/agent/settings.json`, key `leadOutputCap`)

| key | default |
|---|---|
| `enabled` | `true` (`"leadOutputCap": false` also turns it off) |
| `thresholdBytes` | `8192` |
| `errorThresholdBytes` | `32768` (errors and failure-marker results under this are exempt) |
| `headLines` | `40` |
| `tailLines` | `20` |
| `maxLineChars` | `400` |
| `readRangeMaxLines` | `400` |
| `exemptTools` | `[]` (exact names, or a prefix ending in `*`) |
| `secretTools` | `[]` (same matching; never saved, never capped) |
| `failureMarkers` | the list above, as case-insensitive regex sources |
| `failureContextLines` | `2` |
| `failureMaxLines` | `60` |
| `retentionDays` | `7` (`0` keeps files forever) |

Settings are read at load and on each `session_start`.

## Tests

```bash
cd ~/.pi/agent/extensions/lead-output-cap && npm test && npx tsc --noEmit -p .
```
