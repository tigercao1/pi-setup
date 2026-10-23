# Tester brief template

Fill every `<…>`. Spawn with `profile: tester`, `contextFiles: true`, `extensions: ["mcp"]` when
the tester must check an MCP source (APM, logs), and any DB-query skill the overlay names for proof
of effect. One tester per environment. Confirm the deploy SHA yourself first (SKILL.md §2).
Values in `<…>` that are fixed per project (Playwright path, SHA source, proof tools) come from the
overlay's `## e2e-test` section.

```
End-to-end test <what> on <environment + URL | local builds>, in a real browser with Playwright
(`require('<playwright path>')`). Run every step yourself and report
what you observed. Checkpoint early: write partial results to the report after each step group.

## What is deployed (confirmed by the lead)
<env> runs <full SHA> = <what it contains>, confirmed via <SHA source from the overlay> at <time>.
Re-check once at the start and once at the end (<exact SHA check from the overlay>). If it differs, STOP.
[Local instead: the builds are <list with refs>; record each HEAD SHA.]

## Login: saved session, you never log in
Load `<state path>` with browser.newContext({ storageState }). Never print or write cookie/token
values. Never attempt password sign-in, reset, code or SSO. If the session expires, STOP and
report. Delete <state dir> only when the whole run is complete.

## Rules
- Shared env: create data only in this user's account/tenant; never change global flags or other
  tenants. If an account property blocks a case (<country / flag>), skip it and say why.
- Payments: confirm the provider's test publishable key (and locally the test secret key) before
  any purchase; STOP on live keys. Use the provider's test card. Count every retry: each one may be another charge.
- Proof of effect on this environment: data via <DB copy | read-only query tool | app JSON/UI only>;
  money via <payment provider test API | DB rows | log tags + code order>. If an amount
  cannot be established, write "charged, amount unverified". Never infer it.
- Never touch git branches, PRs, the issue tracker or chat. Never edit app code.
[Local only: isolation rules from SKILL.md §7, verbatim, with the overlay's DB/cache names.]
[Visual parity only: the capture and diff rules from references/visual-parity.md, verbatim.]

## Answer key
| Step | Request / action | <baseline build> | <build 2> | <build 3> |
|---|---|---|---|---|
| <id> | <exact request or UI path> | <status · data · money> | … | … |
The baseline must reproduce the bug. A deviation anywhere matters most: re-run it once on
fresh data, then report both runs with evidence.

## Deliverables
- Report at <absolute path>: confirmed SHAs (start/end), per-build table (status · data created ·
  money + proof method · ✅/❌), IDs created, skipped cases and why, every fake/seed made (local),
  every deviation with evidence, environment issues, cleanup state.
- Evidence under <absolute dir> (screenshots; network logs with cookies and tokens stripped).
When done, STOP. Do not resume on later messages unless they explicitly ask for a specific change.
```
