# Product analytics tools (example: Amplitude; adapt for Mixpanel, PostHog, Heap)

## What this source contains

- Event volumes and user behaviour charts the team built
- Saved charts, dashboards and cohorts, with their authors and dates
- Experiment and feature-flag results, when the tool runs them

It complements a data warehouse. The warehouse holds the raw tables; this tool holds the charts the
team actually looked at when it made a call.

## How to search it

Find the tools with `tool_search`. Read each tool's schema before calling it.

1. **Saved charts and dashboards first.** Search by the feature name, the event name the code
   sends, and the ticket ID. A chart saved by the PR author shortly before the merge is strong
   circumstantial evidence of what the decision rested on.
2. **Event trajectory.** Daily volume of the relevant event across about 30 days either side of the
   merge. A step up at the merge suggests a launch; a drop to zero suggests a removal.
3. **Experiments.** Look up the flag or experiment key the code reads. Record the variants, the
   dates and any stated conclusion.

## Common pitfalls

- **Instrumented is not caused.** An event exists because someone wanted to count it, not because
  the code exists for it. Pair it with a PR or ticket citation.
- **Instrumentation changes.** A jump in volume may mean the event started being sent. Check for a
  tracking PR in the same window.
- **Retention.** If the window predates the tool's retention, that is a gap, not a null result.

## What to return

For each finding: chart or query name and link, the window, a compact numeric summary (no raw
rows), its timing relative to the merge date, and how strongly it bears on the question.
