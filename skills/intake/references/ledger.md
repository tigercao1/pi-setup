# The ledger

Loaded by the `intake` skill when writing the first ledger row of a mission and again at Report back.

---

## Row format

`ledger.md` stays in the mission folder. Every entry starts with one header line:

```
- <ISO ts> · <phase> · <decision> · result: <state> · evidence: <pointer>[, <pointer>...]
```

- `ts`: UTC, `2026-10-22T20:01:00Z`.
- `phase`: `start`, `recon`, `classify`, `decide`, `split`, `spawn`, `gate`, `pr`, `push`, `pause`,
  `resume`, `escalate`, `audit`.
- `evidence` is a pointer, never a paragraph: a commit SHA (`de26a02237a`, or `<repo>@<sha>` when
  the mission spans repos), a PR (`#77833` or `owner/name#77833`), `path:line` or `path:start-end`,
  or a file path. Relative paths resolve against the mission folder, then against each `--repo`.
  `-` is allowed only on `start`, `pause` and `resume` rows.
- Reasoning goes in indented prose under the header line. Keep it as long as it needs to be; the
  header is what a script checks.

Rules:

- **`start` row** whenever a new agent or session picks the mission up, so it is clear which run
  wrote which rows.
- **Supersede, never edit.** A wrong row stays. Append a new row whose decision says
  `supersedes <ts of the old row>`.
- Gate verdict rows are keyed `verdict · PR# · head SHA` (see `gates.md`).
- `jev_classify` writes its own `## <ts> · classify` block. Leave it as it is; `parseLedger` reads
  only its `<!-- jev-classify {...} -->` line, and ledger-check skips the block.
- Older ledgers hold free prose. Do not rewrite them; new rows go below the old prose.

```
- 2026-10-22T20:00:00Z · start · lead picks up after recycle · result: active · evidence: -
- 2026-10-22T20:14:00Z · gate · PASS · #77833 · a1b2c3d · result: pass · evidence: a1b2c3d, gate/77833.json
  Blind unit gate against a1b2c3d; rspec exit 0 in the session.
```

## Checking pointers

```bash
~/.pi/agent/skills/intake/scripts/ledger-check.py <mission>/ledger.md --repo <worktree> [--repo <other>] [--offline]
```

It resolves each pointer (`git cat-file -e` in the given repos, read-only `gh pr view`, path exists,
line in range, superseded timestamp exists) and prints one `UNRESOLVED` line per failure. Free
prose before the first row is reported as `legacy, not checked`; prose after the first row that is
not indented under a row is a failure. Exit 1 on any failure.

## End-of-mission audit (before Report back)

1. Run ledger-check with `--events` pointing at this run's own session JSONL
   (`~/.pi/agent/sessions/<cwd-slug>/<ts>_<id>.jsonl`) and its workers' logs
   (`~/.pi/orchestrator-teams/<team>/logs/*.log`). It lists every `team_spawn`, `team_recycle`,
   `git push` (including `git -C <repo> push`), `gh pr create|ready` and `gh stack push|sync|submit`
   whose agent name, branch or PR number does not appear in the ledger. Each `gh stack` event must
   match its own ledger row one-to-one.
2. Walk the gate verdicts by hand: every `<mission>/gate/<pr>.json` round and every unit-gate result
   needs a verdict row with its head SHA.
3. Append a row for each gap, with a timestamp from the log, and a superseding row for each
   unresolved pointer. Then re-run until it exits 0. Audit only this run's stretch of the ledger.
4. **Cross-model trail review, only on SPLIT or escalated missions.** Spawn one `profile:
   "code-review"` worker with `gateExempt: "ledger trail review"` and the ledger, `tree.md` and the
   session JSONL path. It checks that each row matches what the transcript shows and lists forks nobody logged. It writes its report to the
   mission folder, ending with an `Attention / reviewed by <model>` section. Single EXECUTE missions
   skip this; pr-review-gate already gives them independent review.
