# Meeting notes and transcripts (example: Granola; adapt for any meeting-notes MCP)

## What this source contains

- Notes and transcripts from design reviews, planning meetings, standups and 1:1s
- Decisions said out loud that never reached a doc or a ticket
- Who was in the room, and when

Treat it as part of the conversational record, next to team chat. It is strongest when the ticket and
PR trail is thin and the change followed a meeting.

## How to search it

Find the tools with `tool_search`. Read each tool's schema before calling it.

1. **Date-bounded search.** Meetings in the two to four weeks before the PR merged or the ticket was
   created.
2. **Keyword search.** The feature name, the ticket ID, the key symbol, and the business term the
   ticket uses.
3. **Attendee search.** Meetings the PR author or ticket owner attended in that window.
4. **Read the transcript, not only the summary.** Generated summaries drop the reason and keep the
   decision.

## Common pitfalls

- **Speaker attribution is unreliable.** A shared room microphone can merge several speakers into
  one. Quote the line and say the speaker is uncertain when it is.
- **Talk is not a decision.** "We could just cache it" is an option someone raised, not a choice the
  team made. Look for a stated conclusion.
- **Coverage gaps.** Many meetings are not recorded. An empty search here is weak evidence of
  nothing.

## What to return

For each relevant meeting: title, date, attendees as recorded, the verbatim lines that bear on the
question with their timestamp, and whether the attribution is reliable.
