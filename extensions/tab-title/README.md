# tab-title

Names the current pi session with a short, emoji-prefixed summary of what you are
working on, and shows it in two places:

- the terminal tab (iTerm2, and any terminal honoring OSC 0)
- inside pi, as a dim line just above the prompt box

Example: `🐛 fix cart rounding bug`

## Behavior

- Nothing is renamed until a real summary exists: the tab, session name, and banner
  stay untouched until the first model-generated label arrives.
- The label is generated **once**, after the first prompt settles, so the tab keeps
  the session's original theme no matter how many follow-up prompts you send.
  One cheap model call per session.
- Resuming a session that already has a name keeps that name; no new call is made.
  A resumed name this extension wrote itself comes back as an auto label; any other
  name (including one set with `/name`) comes back pinned and verbatim, so a manual
  name survives `/resume` unchanged.
- The built-in session name wins. If the name changes to something this extension did
  not write — `/name foo`, `--name foo`, another extension — that name is adopted as
  a pinned label: it is shown verbatim in the tab and the banner (no emoji is added,
  `PI_TAB_TITLE_FORMAT` is not applied), and auto-naming stops. `/tab-title auto`
  resumes auto-naming and overwrites the name again; clearing the session name also
  returns to auto.
- Names this extension writes itself are tracked (compared after pi's own
  newline/trim normalization), so its own writes never look like a user rename.
  The last self-written name is also recorded in the session as a `tab-title`
  custom entry, which is how a resumed session tells its own name from an external
  one. A session with no such entry is treated as externally named.
- `/tab-title off` means hands off: an external rename is left alone and the tab is
  not touched.
- Use `/tab-title now` to re-summarize on demand, or `PI_TAB_TITLE_REFRESH=always`
  to re-summarize after every turn.
- If the model omits an emoji, one is picked from keywords in the label (bug → 🐛,
  test → 🧪, docs → 📝, perf → ⚡, …), defaulting to 💠.
- Also sets the pi session name, so `/resume` shows the same label.

## Command

```
/tab-title            # pick: auto-name now, turn off, or pin your own text (Esc shows current label and mode)
/tab-title now        # force a re-summary (e.g. after the topic really changed)
/tab-title 🚀 ship it # pin a label (emoji optional; stops auto-naming)
/tab-title auto       # resume auto-naming
/tab-title off        # stop touching the title and hide the widget
```

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_TAB_TITLE_MODEL` | active session model | `provider/model-id` used for summaries, e.g. `anthropic/claude-haiku-4-5` |
| `PI_TAB_TITLE_FORMAT` | `{emoji} {summary}` | Title template; supports `{emoji}`, `{summary}`, `{cwd}` |
| `PI_TAB_TITLE_EMOJI` | `1` | Set `0` for text-only labels |
| `PI_TAB_TITLE_REFRESH` | `once` | `once` = name only after the first prompt; `always` = re-summarize each turn |
| `PI_TAB_TITLE_WIDGET` | `aboveEditor` | In-session placement: `aboveEditor`, `belowEditor`, `status` (footer), `off` |
| `PI_TAB_TITLE_STYLE` | `pill` | Banner style: `pill` (bold text on a highlight band), `box` (rounded border), `plain` (bold text only) |
| `PI_TAB_TITLE_COLOR` | `accent` | Any theme foreground token, e.g. `warning`, `success`, `mdHeading` |
| `PI_TAB_TITLE_BG` | `customMessageBg` | Highlight band background token (`pill` style only), e.g. `selectedBg`, `toolSuccessBg` |
| `PI_TAB_TITLE_SESSION_NAME` | `1` | Set `0` to leave the pi session name alone |

```bash
export PI_TAB_TITLE_MODEL="anthropic/claude-haiku-4-5"
export PI_TAB_TITLE_FORMAT="{emoji} {summary} · {cwd}"
export PI_TAB_TITLE_STYLE="box"
export PI_TAB_TITLE_COLOR="warning"
```

The banner renders as a component, so it wraps to the terminal width, pads every
line to the same length, and sits behind a blank spacer line for breathing room.

## Notes

- No-ops when stdout is not a TTY (subagents, pipes, print mode).
- pi rewrites the terminal title on session info changes; on `session_info_changed`
  the extension re-asserts its own title only when the new name is the one it wrote
  last; otherwise the external name is adopted.
- The `tab-title` custom session entry holds only the last self-written name. It is
  excluded from model context and is appended only when that name changes.

## Tests

```bash
npm test   # node --experimental-strip-types tests/smoke.ts
```

Model-free: the stub context returns a canned label instead of calling a provider.
