# qmd indexes for recall

Two local qmd indexes, split by who may see them. The `recall` skill
(`~/.pi/agent/skills/recall/SKILL.md`) is the reader.

| Index | Template | Holds |
|---|---|---|
| `work` | `../../homebase/qmd/work.yml.tmpl` (ships with the company layer), plus `../../homebase/qmd/local/work.local.yml.tmpl` (gitignored in the layer, this machine only) | layer plans, daily notes, layer rules and skills; locally also work sessions/handoffs and other work-repo notes |
| `personal` | `personal.yml.tmpl` | pi setup plans, sessions, handoffs and config; one collection per personal project, plus `<project>-notes` |

Files here:

- `render`: `render --list` names every index; `render <name>` prints its config with `$HOME`
  filled in and any local additions (the layer's `qmd/local/<name>.local.yml.tmpl`, then
  `<name>.local.yml.tmpl` here) inserted after `collections:`. `bootstrap.sh` writes the
  output to `~/.config/qmd/<name>.yml`; `bin/pi-doctor` fails when the two differ.
- `segments.tsv`: how `bin/pi-memory-export` maps a session cwd to a segment folder under
  `~/.pi/memory/`. The layer's `qmd/segments.tsv` is read first. Rule kinds: `skip`, `path`,
  `remote`, `strong`, `signal`, `mixed`, `fallback` (see the file header).
- `session-overrides.tsv`: `<session id><TAB><segment>` pins one session, whatever its cwd or
  content. The layer's `qmd/session-overrides.tsv` is read first and wins. Changing any rules or
  overrides file makes the next export reclassify every source.
- `tests/test_pi_memory_export.py`: exporter tests (`python3 -B tests/test_pi_memory_export.py`).
- `html_pages.py`: the HTML page converter `bin/pi-memory-export` runs after sessions and handoffs.
  Sources are the `*.html` files under the knowledge base (`PI_KB_DIR`, default
  `~/Documents/knowledge-base-remote`) that some template's collection already covers with a `*.md`
  pattern (same path, `.md` read as `.html`, same ignores; `node_modules` skipped). Each page goes to
  `~/.pi/memory/pages/<segment>/<path under the knowledge base>.md`, with the segment from the same
  `segments.tsv` rules applied to the page's folder. Front matter: `title` (`<title>`, else
  `show-me:topic`, else the first `h1`, else the file name), `source` (the HTML path), the `show-me:*`
  labels from `<head>` (unlabelled is `proposed`), `summary`, `updated`. The body keeps headings,
  paragraphs, list items, table rows, links, code and Mermaid blocks; style, script, textarea, hidden
  elements and collapsed older iterations are dropped, and older iterations are only listed, as
  `superseded`, under "Superseded iterations". Items with their own `data-state`, and every tick,
  get a claim comment (see `validity.md`, "Converted HTML pages"). Incremental like the rest: size
  and mtime, and a change to the converter, `labels.py` or any rules file reconverts every page; a
  page that is deleted or no longer covered loses its export. The `pages` collection in each index
  holds its segments: `work` through the layer's local template, `personal` through
  `personal.yml.tmpl`. Tests: `tests/test_html_pages.py`.
- `search`: `qmd search` (or `--query`) with each hit's validity label (state, evidence, as of)
  printed next to it, ranked confirmed > acted > proposed > transcript, superseded hidden unless
  `--all`. Labels are read from the file on disk by `labels.py`; the format is
  `~/.pi/agent/skills/recall/references/validity.md`.
- `reconcile-check`: the deterministic pass of a reconcile. Resolves claim pointers with gh, git and
  the filesystem, answers "was this sent" from `~/.pi/memory/<segment>/evidence.tsv` (the publishing
  tool calls `bin/pi-memory-export` finds in each session), and marks tracker and chat pointers
  `needs-mcp`.
- Tests: `for t in tests/test_*.py; do python3 -B "$t"; done`.
- `refresh`: export, then `qmd --index <name> update` for every index; `--embed` also embeds.
- `com.ycao.pi-memory-index.plist.tmpl`: a launchd agent that runs `refresh --embed` at 12:30 (if the Mac is asleep then, launchd runs it once on wake). It is
  not installed by `bootstrap.sh`. To install it:

  ```bash
  sed "s|\$HOME|$HOME|g" ~/.pi/agent/qmd/com.ycao.pi-memory-index.plist.tmpl \
    > ~/Library/LaunchAgents/com.ycao.pi-memory-index.plist
  launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.ycao.pi-memory-index.plist
  ```

  Remove with `launchctl bootout "gui/$(id -u)/com.ycao.pi-memory-index"`.

The templates pin the three model URIs under `models:`. qmd rewrites a config that lacks them, which
would make `pi-doctor` report it as out of date after every run.

No qmd daemon runs by default. `query` loads its models cold (15-30 s, about 4 GB RAM).
