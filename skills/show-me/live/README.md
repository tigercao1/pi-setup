# show-me-live

Serves show-me HTML pages with the Agentation toolbar injected, and exposes the Agentation
annotation API as a CLI. Used by the show-me skill (see "annotations" in ../SKILL.md).

- `npm install && npm run build` rebuilds `dist/toolbar.js` (React 18 + agentation, IIFE bundle).
- `bin/show-me-live help` lists commands. `~/.pi/agent/bin/show-me-live` is a symlink to it.
- The Agentation server also speaks MCP over HTTP at `http://localhost:4747/mcp`, if an MCP client
  is preferred over the CLI.
- `site/` is the shared Vercel site: `api/notes.js` implements the Agentation HTTP routes the toolbar
  uses (sessions, annotations, thread, pending) on a private Vercel Blob store, one immutable event
  file per change under `notes/<slug>/`. `share` copies it to `~/.pi/agent/run/show-me-live/site/`,
  adds the exported page and deploys. Page-to-file mapping is in `~/.pi/agent/run/show-me-live/shares.json`.
- Version history: the page server snapshots each `.html` page when it is served and polls tracked
  pages every 2s; a new content hash (sha1) is a new version. Files over 5 MB are skipped and nothing
  is pruned. Storage is `~/.pi/agent/run/show-me-live/history/<rel path with / as __>/`: `v1.html`,
  `v2.html`, ... and `index.json` (versions with `firstSeen`, summary meta, highest `data-iteration`,
  plus a cache of every local Agentation comment seen for the page, kept if Agentation loses it).
  A comment belongs to the version whose `[firstSeen, next firstSeen)` window holds its timestamp;
  v1 has `firstSeen` 0, so comments from before tracking sit on v1. `firstSeen` is the file mtime
  when it is newer than the previous version. Pages with Agentation sessions are tracked from start-up.
- Routes under `/__live/`: `api/pages`, `api/history?path=<rel>`, `snap/<key>/<n>.html` (a stored
  version without the toolbar, with `<base>` set and `src/locate.js` answering `locate` messages),
  and `review[?path=<rel>]`, which serves `src/review.html` (no build step).
- `history <file> [--plain]` prints versions with their comments; `review [file]` opens the review page.
- `SHOW_ME_LIVE_RUN` overrides the run directory, so a scratch instance can use
  `SHOW_ME_LIVE_ROOT`, `SHOW_ME_LIVE_PORT`, `AGENTATION_PORT`, `SHOW_ME_LIVE_RUN` and
  `AGENTATION_STORE=memory` without touching the real servers or `~/.agentation`.
