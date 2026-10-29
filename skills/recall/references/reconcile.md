# Reconcile: the full procedure

`SKILL.md` § Reconcile is the summary. This file is the procedure, the briefs and the report
format. The label format (front matter, HTML meta tags, evidence rows) is in `validity.md` beside
this file; read it before writing any label.

The model run is the hand reconcile of a work spike folder on 2026-10-22: one reconciler, one
adversarial verifier with MCP, then a drift report. The verifier corrected ten of the reconciler's
findings and found 15 claim groups it missed. Every rule below comes from one of those misses.

## Spawn settings

Every agent is a `team_spawn` with `extensions: ["mcp"]` and `contextFiles: true`, plus any skill
its source needs (the project overlay names CLI skills, for example a warehouse CLI). No agent
writes anything except its own output file: no comments, edits, labels, posts or status changes in
any tool.

| Role | Count | Profile | Brief |
|---|---|---|---|
| Investigator | one per source with claims | `researcher` | the `why` investigator template, adapted (below) |
| Verifier | one, over the union | `verifier-mcp` | below |

Never use `team_verify` for the verifier: its skeptics have no MCP and cannot open a ticket, page,
thread or meeting note.

## a. Inventory every file

```bash
find <folder> -type f | sort            # every file, every depth
```

Read every text file in scope, including `evidence/`, `build/`, `prod-run/`-style subfolders,
`report.md` files, JSON results and generated HTML pages. Write the inventory first, in its own
file (`inventory.md` beside the claim file, not inside it): path, line count, read or skipped. A skipped file needs a reason ("binary", "vendored
copy of X"). "Background" is not a reason; the hand run skipped `evidence/` and `build/` as
background and missed 15 claim groups.

For each generated page, find its generator (a `build_*.py` or similar beside it) and note which
data source feeds each tick or status cell.

## b. Extract claims, one per row

Write two files. The working notes (`claims.md`: the claim, its evidence kind, `label now`,
`label proposed`, remarks) are for you and the verifier. The machine claim file (`claims.tsv`) is
what `reconcile-check` reads, and it has exactly this schema, nothing more:

```text
id	claim	source	kind	pointer	expect	state
c1	PR 123 merged	notes/plan.md:14	pr	OWNER/REPO#123	merged	proposed
c2	the guard is on line 40	notes/plan.md:15	path	app/guard.rb:40	def guard	proposed
c3	reply posted on #123	notes/plan.md:16	sent	OWNER/REPO#123	Thanks, fixed in abc123	acted
c4	ticket moved to Done	notes/plan.md:17	mcp	ABC-12		proposed
c5	Tiger emailed the vendor	notes/plan.md:18	prose			acted
```

- Tab-separated, UTF-8. The first line is that header, exactly; every other non-blank line has
  seven fields. No `#` comment lines, no extra columns. Empty fields are allowed except `claim` and
  `kind`.
- `id` is your row number (`c1`), `source` the note's `file:line`, `state` the claim's label now
  (`proposed`, `acted`, `confirmed`, `superseded`, `transcript`; empty means `proposed`).
- `expect` is what the source must show for the claim to hold: a PR state (`open`, `merged`,
  `closed`, `draft`, `approved`), body text for `pr-body` (`!text` for must-not), `on:<ref>` for a
  SHA, the text a `path` or `path:line[-line]` must contain (only those lines are read), the
  drafted text for `sent`. A row with no `expect` can at best come back `resolved`, never
  `confirmed`.
- JSON is the same schema: a list of objects with those keys (any subset, string values, `claim`
  and `kind` required).
- `reconcile-check` refuses (exit 2, nothing on stdout) an empty file, a missing or different
  header, a wrong field count, an unknown key, kind or state, or a file with no claims. Fix the file;
  never read an empty result as "nothing drifted".

Map each claim's evidence kind to the machine `kind` like this:

| What can check it | `kind` | `pointer` |
|---|---|---|
| PR state | `pr` | URL, `OWNER/REPO#N`, `#N` |
| PR body text | `pr-body` | same |
| GitHub issue | `issue` | URL, `OWNER/REPO#N` |
| commit | `sha` | SHA or `DIR@SHA` |
| file in a repo or on disk | `path` | `path` or `path:line[-line]` |
| a draft that may have been posted | `sent` | target (`OWNER/REPO#N`, channel id, ticket id, `clipboard`) or empty |
| ticket, chat, doc, meeting, dashboard | `mcp` | its URL or ID |
| statement by Tiger, number, local database, anything with no pointer | `prose` | empty |

`auto` infers the kind from the pointer; prefer naming it.

- One claim per row. Split a row that bundles several claims ("restart, login and reorg are all
  open"), a status plus a date, or an action plus its provenance. A bundled row cannot hold one
  state.
- In the working notes, record the evidence kind in words: PR, SHA, path, ticket, chat, doc,
  meeting, metric, local (database, file system), sent (a draft that may have been posted),
  statement (Tiger said he did it), number (a figure copied between notes). The table above maps it
  to the machine `kind`.
- `label now` comes from the claim's own line or element, else the note's front matter or meta tags
  in `<head>`; unlabelled, and any unlabelled tick, is `proposed`. A label on a neighbouring line
  never applies.
- **Generated-page ticks are agent output, not Tiger's claims.** Trace every "done" tick to a line
  where Tiger says he did it (state `acted`) or to a source of truth (state `confirmed`). A tick with
  neither stays `proposed`, and the generator is suspect: the hand run's monitor tick came from a
  positional-argument bug that put a URL into the `done` slot.
- A `number` row is never confirmed by being repeated in another note. It is `not checked` until a
  data check re-measures it, with its definition, population and window stated.

## c. Deterministic checks first

Run `~/.pi/agent/qmd/reconcile-check claims.tsv` (plus the overlay's `--repo`/`--gh-repo`;
`--help` repeats the schema). `--note FILE` adds a note's own labelled claims and ticks.
It resolves PR state and bodies, SHAs, paths and the exporter's sent-evidence rows
(`~/.pi/memory/<segment>/evidence.tsv`) without a model. Rows it marks `needs-mcp` go to the
investigators. Ledger pointers can also go through `~/.pi/agent/skills/intake/scripts/ledger-check.py`.

Verdicts: `confirmed` and `contradicted` decide the claim. `resolved` means the pointer exists but the
claim named no expected state, so it is not confirmed. `needs-mcp` goes to an investigator,
`needs-verifier` goes to the verifier with no pointer to check. For drafts, `sent` means an
evidence row shows that write's own success (exit status or output) on exactly that target (`#7`
never matches `#70`); confirm it by resolving the posted item itself with a `pr`/`issue` row and an
`expect`. `candidate` (the call ran inside a pipe, script, branch, codemode or `--web`, so its
success was not observed), `clipboard` (copied only), `drafted`, `attempted` (the call failed or
had no result) and `not-found` are not proof. Only a `confirmed` row with a satisfied `expect` is
marked for the automatic change. Exit 1 means something was contradicted or unresolved; exit 2
means the claim file is malformed or empty.

## d. One investigator per source

Group the remaining rows by source. Each source with rows gets one investigator; never one agent
covering several sources. Its task is `~/.pi/agent/skills/why/references/investigator-prompt.md`,
filled in with:

- The Question: "For each claim below, find the record in this source that confirms, contradicts or
  supersedes it. Quote it and give a link that resolves."
- The Code Anchor: the folder, the PRs, SHAs and ticket IDs from the claim file.
- The playbook for the source's category from `~/.pi/agent/skills/why/references/source-playbook.md`
  (index) and `~/.pi/agent/skills/why/references/sources/`. The project's `## why` overlay maps MCP
  servers to playbooks. Link them; do not paste a modified copy.
- The rows for that source, verbatim, with their numbers.

Rules every investigator follows, written into its task:

- **Search by content, not by name.** Search for the words the answer would contain (the quoted
  phrase, the number, the decision), not only for a person's name or "sent". A reply Tiger pasted
  into a session is a user turn that may not name its author.
- For sessions, search the exported markdown with qmd first, then fall back to the raw JSONL in
  `~/.pi/agent/sessions/**/*.jsonl` (`rg` for the content), which also holds the tool calls and their
  results. A tool result that shows a post succeeded is evidence; assistant prose saying "posted" is
  not.
- Every negative names its searches: tool, query, filters, result count, and whether the
  response was truncated or paginated. "Not found" is only as wide as those searches.
- A source with no tool (no MCP server, no CLI) is a gap, stated in the report, not a negative.

## e. One verifier over the union

When every investigator has reported, build one list over the union: each claim, its proposed label,
its evidence link, and the deterministic results, contradicting rows kept as pairs. Spawn one
`verifier-mcp` with this task:

> Try to disprove every row from its primary source. Give each row a verdict: CONFIRMED-STATE,
> WRONG-STATE (with the right state and evidence), or UNVERIFIABLE (with the searches that ran).
> Open every evidence link; a link that does not resolve or does not say what the row claims is
> WRONG-STATE. Treat Tiger's own statements and pasted replies as `acted`, not `confirmed`. Then
> read the inventory and list any claim the table missed. Write only your output file.

Nothing is merged, relabelled or reported before this verdict. Disproved and unverifiable rows go
in the report's closing section.

## f. Drift report

Write `<folder>/DRIFT-<topic>.md` (or the plans topic folder for a topic run). Plain words, Tiger is
the reader. Sections in this order:

1. Title with the run date, then one paragraph: folder, steps run, "nothing was written outward".
2. `## Needs you`: a table `| # | Item | Do this |`, one row per action Tiger takes, most blocking
   first. Bold the item's first words. "Do this" is one short instruction or a choice ("Ticket it,
   or drop it").
3. `## Confirmed in a source of truth`: bullets, each with its link.
4. `## Still only your word (no source to check)`: `acted` rows, with the reason no source exists.
5. `## Stale in the notes`: what the note says, what the source says now.
6. `## Not checked`: `number` rows and anything no source covers.
7. `## Label changes waiting for you`: `| file | claim | now | proposed | evidence |`, for every
   change step g may not make alone.
8. `## Searches that found nothing`: one line per negative, with the searches that ran.
9. `## Disproved or unverifiable`: the verifier's rejects, one line each.

The full claim table with verdicts goes in a collapsed appendix or a sibling `RECONCILE-<topic>.md`.

## g. Labels

- The one automatic change is `proposed` to `confirmed`, only when the verifier returned CONFIRMED-STATE and the
  evidence link resolves. Write the front matter or meta tags from `validity.md`, with the link and
  today's date.
- Everything else waits for Tiger's yes: anything to `superseded`, dropping a claim, `acted` to `confirmed`
  without a link, and any change to a note Tiger wrote himself. List them in section 7; apply only
  the rows he approves, in his words ("yes to 1-4").
- Superseding never deletes text. Add the label and the pointer to the newer record.
- For a generated page, fix the generator or its data and rerun it; never hand-edit its output.
- No outward writes: tickets, PRs, chat, docs and dashboards are read, never changed. Proposed
  outward fixes go in Needs you.

## Light pass

The weekly light pass is steps a to c only, over folders changed in the last 7 days, with no
spawns. It reports rows that went stale, `proposed` notes older than 14 days with no evidence, and
`needs-mcp` rows, then offers the full run for any folder that needs it.

## Calibration

Known answers drift too. When scoring a run, check the expected answer against the live source
before calling a mismatch a miss; in the hand run, three of nine "known answers" were stale.
