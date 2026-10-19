# Notify Extension

Desktop notification when the agent finishes and is waiting for input.

Uses OSC 9 for iTerm2, OSC 99 for Kitty, and OSC 777 for Ghostty, WezTerm, and other terminals that support it. The terminal is detected via `TERM_PROGRAM`.

If the current terminal doesn't support OSC escape sequences (e.g. VS Code's integrated terminal), the extension falls back to `osascript` to send a native macOS notification. On Windows Terminal (`WT_SESSION`) it sends a PowerShell toast.

## What it does

Fires a native OS notification at the end of every agent turn with a summary of the last assistant message. The title includes the current project directory name so you can tell instances apart. Useful when you kick off a long task and switch to another window.

It also listens for the `"notify:send"` global event, allowing other extensions to trigger notifications mid-turn. This is used by extensions like `guard` to alert you when they are blocked waiting for your input.

```ts
pi.events.emit("notify:send", { title: "guard", body: "Waiting for approval" });
```

## Setup

Run `/notify` to send a test notification: it asks for the text, and Enter with nothing sends the default (or type `/notify some text`). It reports which protocol was used and the detected `TERM_PROGRAM`, which is enough to confirm notifications are enabled for your terminal in **System Settings → Notifications**.

## Notes

- Hooks `agent_settled` rather than `agent_end`, so it doesn't fire on intermediate retries, auto-compaction, or queued follow-ups.
- Notification bodies are sanitised of control characters and truncated to 140 characters.
