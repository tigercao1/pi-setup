# Validity labels

A note says whether what it records is a plan, something Tiger did, or something a source of truth
shows. Recall reads the label, prints it next to every hit, and ranks by it. A note links to its
source instead of copying the source's status, so the next reader re-checks the source rather than
trusting a stale copy.

## States

| State | Meaning | Who sets it |
|---|---|---|
| `proposed` | An agent drafted or suggested it. Also every unlabelled note. | the writer, or nobody |
| `acted` | Tiger says he did it, and there is no source to check (email, a console, a phone call). | the writer, quoting Tiger |
| `confirmed` | A source of truth shows it, and the evidence link resolves. | the writer or the reconciler |
| `superseded` | A later record replaced it. `superseded_by` names that record. | Tiger approves |
| `transcript` | Default for exported sessions and handoffs (anything under `~/.pi/memory/`). Never a fact on its own. | the collection |

Label changes:

- **Automatic:** only `proposed` (or unlabelled) to `confirmed`, and only with an evidence link that
  resolves now.
- **Waits for Tiger's yes:** everything else. That covers `superseded`, dropping a claim,
  `acted` to `confirmed` (with or without a link), and any downgrade.
- A `confirmed` label with no evidence counts as `proposed`. The search wrapper ranks it that way and
  says so. Empty or blank pointers (`evidence: [""]`, `evidence=""`, `content=" "`) are no evidence.
- A label is never borrowed. A claim's label is its own line's claim comment or its own element's
  `data-*` attributes; otherwise the file's front matter or `<head>` meta tags. A neighbouring line,
  another element on the same line, or a `<meta>` outside `<head>` never labels it. When one line holds
  several claims with different labels and the hit cannot be placed on one, it reads as `proposed`.
- A transcript is always `transcript`. A label quoted inside an exported session or handoff (front
  matter, claim comment, meta tag) is shown as "quoted label, not applied" and never changes the state.
- Generated pages are not Tiger's claims. A tick or "done" rendered by a page generator stays
  `proposed` until it traces back to a statement from Tiger (`acted`) or to a source (`confirmed`).

## Markdown: front matter

The first lines of the file, between two `---` lines. Only these keys are labels; other keys are
left alone.

```yaml
---
state: confirmed
evidence:
  - https://github.com/OWNER/REPO/pull/123
  - OWNER/REPO#124
as_of: 2026-10-22
superseded_by: 2026-10-22-mapping-agreed.md
---
```

| Key | Value |
|---|---|
| `state` | one of the states above |
| `evidence` | one pointer, or a list. Pointers use the intake ledger grammar (`~/.pi/agent/skills/intake/references/ledger.md`): a URL, a SHA, `repo@SHA`, `OWNER/NAME#N` or `#N`, `path:line[-line]`, or a path |
| `as_of` | the date (`YYYY-MM-DD`) the label was last checked against its source |
| `superseded_by` | the record that replaced this one: a path, URL or ledger row timestamp |
| `published` | written by `pi-memory-export` on session exports only: the publishing tool calls in the session (see below). Never hand-edited |

Scalars may be quoted. A list may be written as `[a, b]` or as `- item` lines.

### One claim per line

A note that bundles several claims cannot have one state. Label single claims with an HTML comment at
the end of the line; it renders as nothing in markdown and in HTML:

```markdown
- PR #79433 merged 10/21 <!-- claim state=confirmed evidence=https://github.com/OWNER/REPO/pull/79433 as_of=2026-10-22 -->
- Datadog monitor created <!-- claim state=proposed -->
- Mapping "ship existing" <!-- claim state=superseded superseded_by=ABC-5712 -->
```

Keys are the same as front matter; several evidence pointers are comma-separated with no spaces.
When a search hit's own line carries a claim comment, that label wins over the file's; a comment
on any other line does not.

## HTML (show-me pages): meta tags

In `<head>` (only there; a `<meta>` in the body is ignored), one `<meta>` per key; `show-me:evidence` may repeat:

```html
<meta name="show-me:state" content="confirmed">
<meta name="show-me:evidence" content="https://github.com/OWNER/REPO/pull/123">
<meta name="show-me:evidence" content="OWNER/REPO#124">
<meta name="show-me:as-of" content="2026-10-22">
<meta name="show-me:superseded-by" content="index-v4.html">
```

Single items on the page use data attributes on the element that shows the claim:

```html
<li data-state="confirmed" data-evidence="https://github.com/OWNER/REPO/pull/79433" data-as-of="2026-10-22">#79433 merged</li>
<li data-state="proposed">Datadog monitor created</li>
```

A tick, checkbox or `done` class without `data-state` is `proposed`, whatever the page's meta tags
say; so is any `<li>`, `<tr>` or `<td>` without one. A data label covers only its own element. In
markdown, a checked task item (`- [x] ...`) without a claim comment is `proposed` too. A leading
UTF-8 byte-order mark is ignored.

### Converted HTML pages

`pi-memory-export` converts knowledge-base HTML pages to markdown under `~/.pi/memory/pages/`, so qmd
indexes their text and not their markup. These files are not transcripts: their labels are read like
any note's, from their own front matter and claim comments.

- Front matter `state`, `evidence`, `as_of` and `superseded_by` come from the page's `show-me:*` meta
  tags in `<head>`; no `show-me:state` writes `state: proposed`. `source` is the HTML file, and the
  search wrapper prints it: open the source for the layout and for anything not converted.
- An element with its own `data-state` (or `data-evidence`) gets a claim comment with that label on
  its line, or right after its text when it sits inside a line.
- A tick (`data-default`, a checked checkbox, a `done` class, a ✓) without its own `data-state` gets
  `<!-- claim state=proposed -->`. So does every other list item and table row without a label when
  the page itself is not `proposed`, because a page label never covers an item.
- Only the current iteration is converted. Older iterations (a `<details>` holding a stored page, or
  a `data-iteration` lower than the newest) are listed by their summary under "Superseded
  iterations", each line `state=superseded` with `superseded_by` naming the current iteration; their
  content is not indexed. A separate snapshot file (`v1-snapshot.html`) is a page of its own and
  keeps its own labels.
- Page text that looks like a claim comment is escaped (`&lt;!--`), so it never labels anything.

## Session exports: `published:`

`pi-memory-export` adds front matter to an exported session only when the session made a publishing
tool call. It never writes `state:` there; the `transcript` default comes from the path. There is one
entry per tool and target, at its latest call, with `count` when the call repeated; after 30 entries
`published_more` gives the number left out.

```yaml
---
published:
  - {at: 2026-10-20T19:55:12Z, tool: "gh pr comment", target: "OWNER/REPO#79433", result: ok}
  - {at: 2026-10-20T20:01:40Z, tool: "slack.send_message_draft", target: "C0C4VA8RRUM", result: ok}
  - {at: 2026-10-20T21:10:02Z, tool: "git push", target: "OWNER/REPO origin my-branch", result: ok, count: 4}
---
```

The full rows, with an excerpt of what was sent, go to `~/.pi/memory/<segment>/evidence.tsv`
(columns: `ts session channel tool target result via call_id excerpt source`). `--help` and
`--dry-run` calls are not rows. `result` is that write's own observed status: `ok` only when its exit
status decides the call's (alone, last, or followed only by `&&`), its output shows it (a comment URL,
"Merged pull request", a push's ref update, the new PR's URL), or it was a direct MCP or
`session_send` call that succeeded; `unverified` when it ran inside a pipe, a `;` or `||` list, a
shell branch, codemode (which can catch a failed write) or with `--web`; `error` when it failed;
`no-result` when the session ended first. An `ok` row proves that the write ran, not that anyone read
it. A Slack `*_draft` tool creates a draft, not a sent message. `pbcopy`
and `slack-copy` put text on the clipboard; whether Tiger pasted it is only his word (`acted`).

## Tools

- `~/.pi/agent/qmd/search`: runs `qmd search` or `qmd query`, reads each hit's label, prints state and
  evidence next to it, ranks `confirmed > acted > proposed > transcript`, hides `superseded` unless
  `--all`.
- `~/.pi/agent/qmd/reconcile-check`: resolves claim pointers mechanically (gh, git, paths), looks up
  `evidence.tsv` for "was this sent", marks tracker and chat pointers `needs-mcp` and pointerless
  claims `needs-verifier`, and says which label change is automatic and which needs Tiger. A pointer
  that merely exists is `resolved`, not `confirmed`: an automatic change needs the claim's expected
  state to match the source. The claim file schema is in `reconcile.md` § b; an empty or malformed
  file is an error, not a pass. A `sent` verdict needs an `ok` row on exactly that target and cites
  the session log; confirm by resolving the posted item itself. An `unverified` row is only a
  `candidate`. `not-found` names the rows and filters searched and is never proof of absence.

## What qmd itself does with labels (2.8.3, tested)

qmd stores the whole file, front matter included, as body text. It indexes it for BM25 and embeddings
and shows it in snippets, so `state: confirmed` is searchable as words. It does not parse front matter:
no field reaches `--format json` (the fields are `docid`, `score`, `file`, `line`, `title`, `context`,
`snippet`, `body`), no option filters or boosts by it, and there is no `qmd:` or `metadata:` namespace.
The title comes from the first `#` or `##` heading, not from a `title:` key. HTML files are indexed only
when a collection pattern includes them, as raw text, with the file name as title. So labels are read
by the wrapper from the file on disk.
