# Source playbooks

`why` spawns one investigator per available source. Each investigator gets the one playbook for its
source's evidence category, below. The playbooks are worked examples for common tools; adapt the
steps for a different tool in the same category. MCP tools are named `mcp__<server>__<tool>` and are
found with `tool_search`; the project's skill overlay (`## why`) says which configured server fills
which category.

| Category | Playbook | Example it documents |
|---|---|---|
| Source control history | [`code-archaeology.md`](./sources/code-archaeology.md) | git, `gh` (no MCP needed) |
| Issue / ticket tracker | [`linear.md`](./sources/linear.md) | Linear (adapt for Jira, GitHub Issues, Shortcut) |
| Long-form documents | [`notion.md`](./sources/notion.md) | Notion (adapt for Confluence, Google Docs, Coda) |
| Real-time team chat | [`slack.md`](./sources/slack.md) | Slack (adapt for Discord, Teams, Mattermost) |
| Meeting notes (conversational record) | [`meeting-notes.md`](./sources/meeting-notes.md) | Granola (adapt for any meeting-notes tool) |
| Infrastructure observability | [`datadog.md`](./sources/datadog.md) | Datadog (adapt for New Relic, Honeycomb, Grafana) |
| Error / exception tracking | [`sentry.md`](./sources/sentry.md) | Sentry (adapt for Rollbar, Bugsnag) |
| Product analytics warehouse | [`databricks.md`](./sources/databricks.md) | Databricks SQL (adapt for Snowflake, BigQuery) |
| Product analytics tool | [`product-analytics.md`](./sources/product-analytics.md) | Amplitude (adapt for Mixpanel, PostHog) |

Cross-cutting:

- [`incident-postmortem.md`](./sources/incident-postmortem.md). Append it when the target code looks
  defensive (null checks, retries, timeouts, rate limits, feature flags, egress guards, OOM handlers).
