---
name: work-report
description: Tiger's daily work log and standup posts. Builds the full daily note (every pi session plus Granola and Gemini meeting notes) into ~/Documents/knowledge-base-remote/Daily/, renders a visual HTML view of it, drafts the short team standup post (Yesterday / Today / Blockers / Feeling), and writes multi-day or weekly summaries. Use when asked for "today's report", "what did I do", "standup", "my update", "summarize my week", "backfill my notes", or to review past days' work.
---

# work-report

One pipeline, four outputs. The script `~/.pi/agent/bin/pi-today` does the deterministic work and
the model calls; this skill adds what the script cannot do itself: fetching meetings and Slack
context through MCP, and judging the result before it reaches the user.

| Ask | Output |
|---|---|
| daily note / "what did I do" | `Daily/YYYY-MM-DD.md` + `.html` (full reference) |
| standup / update | short Slack post, printed + saved to `~/.pi/agent/daily-ledger/standups/<date>.md` |
| week / "past few days" | `Daily/week-<since>_<until>.md` + `.html`, ends with a Slack-ready Post section |
| review / "show me" | the `.html` views (timeline, thread cards, meetings) — print paths, never open them |

`Daily/` is `~/Documents/knowledge-base-remote/Daily/`. `Daily/index.html` links every day and week.

## Never

- Never post to Slack, comment on Linear, or send anything. Print the draft; the user posts it.
- Never `open` an HTML file. Print its absolute path.
- Never put session ids, local paths or knowledge-base links in a standup or week Post.

## Step 1 — meetings for each day in range (MCP)

The script cannot reach MCP, so meetings come in as files. For every working day in the range that
has no `~/.pi/agent/daily-ledger/<date>/meetings/` directory yet (or when asked to refresh):

1. Get the tools: load `mcp__granola__list_meetings`, `mcp__granola__get_meetings`,
   `mcp__google_docs__search`, `mcp__google_docs__list_tabs`, `mcp__google_docs__fetch_tab` with
   `tool_search`, or call them from a `codemode` script.
2. Granola: `mcp__granola__list_meetings` (custom range) with `involvement: {captured_by_me: true, listed_as_participant: true}`.
   Skip weekends and anything clearly personal. `mcp__granola__get_meetings` (≤10 ids per call) for summaries.
3. Gemini: `mcp__google_docs__search` query `Notes by Gemini`, `modifiedAfter` the range start. Use a Gemini doc
   only when no Granola note covers the same meeting (same title and time). Read the "Full notes" tab
   via `mcp__google_docs__list_tabs` + `mcp__google_docs__fetch_tab`; never `mcp__google_docs__fetch` on the whole doc
   (it pulls the full transcript three times over). A recording with no summary is a false start; skip it.
4. Write one file per meeting to `~/.pi/agent/daily-ledger/<date>/meetings/<source>-<slug>.md`,
   under 250 words, exactly:

```
TITLE: <title>
TIME: <HH:MM> ET
SOURCE: Granola (captured by Tiger) | Granola (captured by X; Tiger listed) | Google Meet notes (Gemini)
URL: <note url>
ATTENDEES: <names>
TIGER_ATTENDED: yes | no | unclear — <evidence>
- Purpose: <one line>
- Discussed: <what was covered>
- Decisions: <or "none recorded">
- Tiger's action items: <or "none">
- Other action items: <"Owner: item">
```

Gemini labels shared room audio with odd names (a meeting room's or a stranger's name); if attribution is mixed, mark
`TIGER_ATTENDED: unclear` and do not assign its action items to Tiger.

Work done outside pi and meetings (Slack threads, browser reviews) goes in
`~/.pi/agent/daily-ledger/<date>/log.md`, one line per item, when the user mentions it.

## Step 2 — daily notes

```bash
pi-today <date>          # or: today | yesterday ; one per day, can run in parallel
pi-today <date> --dry-run   # included / excluded sessions, no model calls
```

Rerunning is cheap: session digests are cached by last entry, so only changed sessions are
re-summarized; the rollup is redone. After each run read the note's **Not covered by summary** and
**Discovery warnings** sections and the **Excluded** list. A real thread excluded or missing is a
bug in scope rules or prompts — fix it in `pi-today`, do not hand-edit the note.

## Step 3 — standup post

1. Previous post: `mcp__slack__slack_search_public_and_private` with `from:<@USER_ID> in:<#CHANNEL_ID>`,
   using Tiger's Slack user id and the standup channel named in the work-report overlay of the
   loaded project rules, sorted by timestamp, newest first. Standup replies sit in threads under the
   daily standup bot message named there. Write the newest reply, with its date, to
   `~/.pi/agent/daily-ledger/standups/last-post.md`. If no standup channel is configured, ask Tiger
   for it instead of guessing.
2. `--since` = the working day after that post (if the last post was Thursday, `--since` is Thursday
   so its "Today" goals are judged by what happened after it).
3. For each blocker the notes mention, search Slack (and the linked ticket) for its latest status
   before drafting: who is involved, ETA, workaround. Notes go stale: a blocker can pick up a review,
   an owner or an ETA in a thread that no session ever recorded. Add what you find to
   `~/.pi/agent/daily-ledger/<today>/log.md`.
4. Make sure notes exist for every working day in that range (Steps 1–2), then:

```bash
pi-today standup --since <date>
```

The draft follows `~/.pi/agent/daily-ledger/standups/style.md` (rules learned from what Tiger
changed) and his last three posts in `standups/posted/`. Treat it as a draft: drop anything Tiger is
not actively driving, and never offer a Today item about other people's PRs based on a local session.

After Tiger posts, he usually pastes the final text back. Then, every time:

1. Save it verbatim to `standups/posted/<date>.md` and, with a `Posted <weekday> <date>` header, to
   `standups/last-post.md` (the goals tomorrow's Yesterday is judged against).
2. Diff it against the draft. For each change that reflects a preference, add or sharpen a rule in
   `standups/style.md`. For each change that contradicts the notes (a fact, an order, a date),
   ask Tiger which is right instead of assuming; fix `corrections.md` once he answers.

Default format, unless the project overlay names the team's own: *Yesterday* (yes / no / partial + why),
*Today* (EOD outcome), *Blockers* (who, what, by when; omit if none), *Feeling*
(:large_green_circle: / :large_yellow_circle: / :red_circle:). Blunt, outcome-oriented, short.

## Step 4 — week / multi-day

```bash
pi-today week --since <date> [--until <date>]
```

Long reference plus a **Post** section for Slack. Default range: Monday of this week to today.

## Step 5 — verify before handing a post over

A standup or week Post is repeated to the team. Before giving it to the user, spawn one verifier
(`extensions: ["mcp"]`, `skills: ["github-cli"]`, `contextFiles: true`) with the post's claims as a
numbered list and the primary sources (gh, Linear, `~/.pi/agent/sessions/*.jsonl`). It must try to
disprove each claim and report verdict + evidence. Then end your turn: tell the user the draft is
being checked and that you will send the corrected version when the report arrives. Do not call
`team_await` from the interactive session; it blocks the user. When the verifier's message wakes
you, apply its corrections and give the user the corrected post, the list of changes, and the HTML
paths.

## Review visually

`pi-today html <date|all>` re-renders views from existing notes without model calls. Day view:
summary, a timeline of session activity and meetings, one card per thread, carry-over, then
collapsed meetings and session tables. For one thread that needs a deeper visual (architecture,
flow, decision tree), use the `show-me` skill on that thread's content and link the result from the
reply.

## Files

- Script: `~/.pi/agent/bin/pi-today` (models via `PI_TODAY_DIGEST_MODEL`, `PI_TODAY_ROLLUP_MODEL`)
- State: `~/.pi/agent/daily-ledger/<date>/{digests/,meetings/,log.md,day.json}`, `standups/`
- Plan and history: `~/Documents/knowledge-base-remote/Pi/docs/plans/daily-work-report.md`
