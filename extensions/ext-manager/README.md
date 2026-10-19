# ext-manager

Interactive enable/disable of pi extensions from inside a session.

```
/extensions
```

Opens a checkbox list of every discovered extension — `[✓]` / `[ ]`, mirroring the `/mcp`
server list — with a description panel for whatever row is focused:

```
Extensions  10/11 enabled
› [✓] agent-orchestrator
  [✓] ding
  [ ] jev

  hierarchical multi-agent teams for pi.
  One extension, three roles. The same file is loaded by the lead and by every agent it spawns.
  Provides: /agents /inbox /orch /team
  ~/.pi/agent/extensions/agent-orchestrator/index.ts

↑↓ move · space/enter toggle · esc close (applies after reload)
```

Descriptions are read **statically** by `describe.ts` — the list must describe extensions that are
currently *disabled*, so nothing may be imported or executed. In order: the entry file's header
comment (first sentence), then a sibling README (frontmatter `summary:`, else first paragraph),
then the `registerCommand`/`registerTool`/`registerShortcut` calls found in the source.

```bash
node tests/render.mjs   # headless render assertions, no TUI and no writes
```

## How it works

- Discovery and current on/off state come from pi's own resolver (`DefaultPackageManager.resolve()`), so the list matches exactly what pi loads: `~/.pi/agent/extensions/`, `.pi/extensions/`, explicit `settings.extensions` paths, and package-provided extensions.
- Toggling writes a `+path` / `-path` override pattern into the `extensions` array of the matching settings file, via the real `SettingsManager`:
  - user-scope extension → `~/.pi/agent/settings.json`
  - project-scope extension → `<cwd>/.pi/settings.json`
- Paths are stored relative to their base dir (e.g. `-extensions/ding/index.ts`), the same format `pi config` uses — the two stay in sync.
- Settings writes merge only the `extensions` field, so nothing else in your settings file is touched.

## Notes

- Extensions coming from installed packages (`npm:`/`git:`) are shown with a 🔒 and are read-only; per-package resource filters are better handled by `pi config`.
- Project-scope toggles require the project to be trusted (pi refuses to write `.pi/settings.json` otherwise); you get an error notification instead.
- Changes take effect on reload. On exit, the command asks **Reload now?** and runs the `/reload` flow; otherwise run `/reload` or restart pi.
- Requires TUI mode (`/extensions` is a no-op with an error notice in print/JSON mode).

## Equivalent manual options

| Action | Command |
| --- | --- |
| Same TUI outside a session | `pi config` (Tab switches global/project), `pi config -l` |
| Disable discovery for one run | `pi --no-extensions` (`-ne`) |
| Load a single extension | `pi -ne -e path/to/ext.ts` |
