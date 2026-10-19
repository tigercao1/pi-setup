---
name: slack-copy
description: Copy a Slack message to Tiger's macOS clipboard so it pastes into Slack with its formatting intact (bullets, numbered lists, `code`, bold, italics, links, quotes, code blocks). Load whenever the user asks to copy, "pb copy", "pbcopy", or put on the clipboard a Slack message, reply, DM or draft — or any text he says he'll paste into Slack. Never use plain `pbcopy` for Slack text.
---

# Copy a Slack message with its formatting

Plain `pbcopy` only puts plain text on the clipboard, so Slack shows the raw `-`, backticks and
`**`. Slack keeps formatting when the clipboard holds HTML. The script below puts both on the
clipboard: HTML for Slack, plain text for anything that can't take HTML.

## Steps

0. If the message is one Tiger will post and you drafted or edited any of it, it must already
   have been through both `~/.pi/agent/skills/tiger-voice/SKILL.md` (+ `examples.md`, and
   `examples-long.md` past about five sentences) and `~/.pi/agent/skills/clear-message/SKILL.md`
   including its skim test, in this session. If either was skipped, do it now and show the user
   the revised draft with its skim-test line before copying.
1. Write the message as Slack-flavoured Markdown to a temp file, e.g. `/tmp/slack-msg.md`
   (use the `write` tool; quoting a long message inside a shell heredoc is error-prone).
   Supported: paragraphs (blank line), `- ` / `* ` bullets (two spaces per nesting level),
   `1. ` lists, `> ` quotes, fenced code blocks, `` `code` ``, `**bold**` or `*bold*`, `_italic_`,
   `~strike~`, `[text](url)` and bare `https://` links.
2. Run:

   ```bash
   python3 ~/.pi/agent/skills/slack-copy/bin/slack-copy.py /tmp/slack-msg.md
   ```

   It exits non-zero if the clipboard doesn't end up holding HTML. `--print` shows the HTML
   without touching the clipboard.
3. Tell the user it's on the clipboard. Repeat the mentions the script lists: `@name` pastes as
   plain text, so the user has to re-type each one in Slack to tag the person.

## Rules

- Copy exactly the text the user approved. Don't re-edit it while copying.
- Never post to Slack yourself; copying is the whole job.
- macOS only (`osascript`). If it fails, say so and fall back to plain `pbcopy`, telling the
  user the formatting won't carry over.
