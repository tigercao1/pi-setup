# pi agent configuration

Personal setup for the [pi](https://pi.dev) coding agent: `~/.pi/agent`, pi's agent directory.
House rules, skills, custom extensions, helper scripts, and the tooling to rebuild all of it on a
new Mac. A company layer is optional and kept separate, in its own directory beside this one (see
[Company layer](#company-layer)); this repo holds only the generic, personal parts. `bin/pi-doctor`
checks that separation with a pattern scan, which catches known names and paths but not everything,
so a manual review of the diff is still required before committing.

## Layout

| Path | What it is |
|---|---|
| `AGENTS.md` | House rules, loaded as a context file by pi and by any agent spawned with `contextFiles: true` |
| `APPEND_SYSTEM.md` | Appended to pi's system prompt (writing style, formatting) |
| `settings.json` | pi settings: default model, enabled extensions, extra skill/extension/prompt directories |
| `skills/` | Skills loaded by name, e.g. `intake`, `clear-message`, `github-stacked-prs`, `tiger-voice` |
| `extensions/` | Custom pi extensions: `agent-orchestrator` (multi-agent `team_*` tools), `jev`, `session-bus`, `worktree`, and others |
| `bin/` | Helper scripts: `agent-caffeinate.sh`, `prose-check.sh`, `pi-today`, `pi-doctor`, `publish-package` |
| `bootstrap.sh` | Rebuilds the setup on a new machine (below) |
| `Brewfile` | Homebrew packages the setup needs |
| `pi-version` | The pi version this setup is pinned to |
| `templates/` | The launchd plist for the sleep guard, with `$HOME` placeholders |

Third-party skills (`find-skills`) live in `~/.agents/skills`, installed by `bootstrap.sh`.

## New machine

```bash
git clone <this repo> ~/.pi/agent
~/.pi/agent/bootstrap.sh            # add --company-repo <owner>/<repo> on a work machine
```

`bootstrap.sh` is safe to re-run; each step checks before it acts:

1. Homebrew (installed if missing) and everything in `Brewfile`, plus the `github/gh-stack` gh extension
2. nvm, node 22, and pi at the version in `pi-version` (`npm install -g @earendil-works/pi-coding-agent@<version>`)
3. `npm install` in every extension whose `package.json` declares dependencies; extensions without
   any (and `ext-manager`) get a `node_modules` symlink to `../agent-orchestrator/node_modules`
4. renders `templates/com.ycao.pi-agent-caffeinate.plist.tmpl` into `~/Library/LaunchAgents` and loads it
5. installs the `find-skills` skill into `~/.agents/skills`
6. the company layer, if configured and readable (below); otherwise removes the `../homebase`
   entries from `settings.json` and prints how to configure a model provider
7. links `daily-ledger` to `../homebase/data/daily-ledger` when that data directory exists
8. prints the logins to do by hand, then runs `bin/pi-doctor`

It never writes a secret. The logins it lists: `gh auth login`; pi `/login` (or the key source a
`models.json` points at); `pi mcp login <server>` for each MCP server; `databricks auth login`;
`circleci setup`.

## Health check

`bin/pi-doctor` is read-only and exits non-zero when any check fails:

- `pi --version` matches `pi-version`
- every skill name resolves exactly once across `skills/`, the `skills` directories in
  `settings.json`, and `~/.agents/skills`
- every extension that declares runtime `dependencies` has `node_modules`; `ext-manager`'s symlink resolves
- every local path in `settings.json` (`skills`, `extensions`, `prompts`, `themes`) exists
- separation: no `$HOME` paths, and none of the patterns in the company layer's
  `separation-terms.txt`, in the tree (skips gitignored files, `sessions/`, `run/`, `logs/`,
  `node_modules/`, `session-bus/`, `daily-ledger`, and company-layer path references);
  `PI_DOCTOR_VERBOSE=1` lists the offending lines. This is a pattern check, not a review: it cannot
  recognise a pasted work conversation, so read new examples and narratives before committing.
- `settings.json` equals `settings.base.json` merged with the company layer's
  `settings-fragment.json` (a warning lists the difference otherwise)
- the sleep-guard launchd agent is loaded

## Company layer

A company layer is a separate git repo cloned to `~/.pi/homebase`, beside this one. `settings.json`
is not tracked: bootstrap writes it from `settings.base.json` (tracked, personal) merged with the
layer's `settings-fragment.json`, which carries the company directory entries, relative to the
settings file:

```json
"skills": ["../homebase/skills"],
"extensions": ["+extensions/ding/index.ts", "../homebase/extensions"],
"prompts": ["../homebase/prompts"]
```

plus the layer's orchestrator settings (`agentOrchestrator.contextExtensions`, project skill roots,
profile skills). Change personal settings in `settings.base.json`; `pi-doctor` warns when
`settings.json` has drifted from base + fragment.

pi loads whole directories there (it does not expand globs). Remove the entries and pi runs on the
personal layer alone.

Configuration comes from two `company.env` files, read in order, with environment variables
overriding both:

| File | Tracked? | Holds |
|---|---|---|
| `~/.pi/agent/company.env` | no (gitignored) | `COMPANY_LAYER_REPO`: `owner/repo` of the company layer, written by `bootstrap.sh --company-repo owner/repo` |
| `../homebase/company.env` | yes, in the company layer | `COMPANY_REGISTRY_REPO` (the package registry), `COMPANY_REGISTRY_CLI` (its CLI command), `COMPANY_REGISTRY_INSTALL` (the command that installs the CLI), `COMPANY_REGISTRY_MANIFEST` (file name of the registry manifest staged beside `package.json`) |

So a new work machine needs one argument:

```bash
~/.pi/agent/bootstrap.sh --company-repo <owner>/<repo>
```

With `gh` able to read that repo, `bootstrap.sh` clones the layer to `~/.pi/homebase` (if missing),
reads its `company.env`, adds the layer's directories to `settings.json`, installs the registry
CLI, and copies the layer's `templates/models.json` to `models.json` if there is none. Without a
layer the machine is personal: configure a model provider with pi `/login`, or write a
`models.json` whose key comes from a command (e.g. `!security find-generic-password -s <name> -w`),
never the key itself.

## Publishing a skill or extension to the company registry

```bash
bin/publish-package skill/<name> --dry-run
bin/publish-package extension/<name> --dry-run
bin/publish-package skill/<name>          # really publishes: asks to confirm, or pass --yes
```

Each publishable skill or extension has a sidecar `registry.json` with its registry metadata:
`name` (extensions are prefixed, e.g. `pi-ding` for `extensions/ding`), `version`, `author`,
`description`, `tags`, optional `license`, `requires` (README "Requires" section), `readme`
(a file to publish as the README) and `exclude` (rsync patterns to leave out). The sidecar is never
published.

The script:

1. stages the hosted-package layout in a temp dir: `package.json`, the registry manifest
   (file name from `COMPANY_REGISTRY_MANIFEST`), `.gitignore`,
   `README.md`, and the files (`skills/<name>/…` for a skill, the extension's files at the root)
2. finds the package's latest release tag `<name>@<version>` in the registry, warns if the default
   branch has unreleased changes to it or open PRs mention it, and prints `diff -ruN` from the
   published copy to the staged one, so changes others made are visible before overwriting them
3. warns when the files differ but the version is already published
4. runs the registry CLI's `publish --dry-run`, or `publish` without `--dry-run`

The registry and its CLI come from the company layer's `company.env`. `PUBLISH_CLI` overrides the CLI command (for example a source checkout run with `bun`).

## Sleep protection

`bin/agent-caffeinate.sh`, run by the launchd service `com.ycao.pi-agent-caffeinate`, is the single
holder of the machine's `caffeinate` assertion. It polls every 5s (`PI_CAFFEINATE_POLL`) and holds
an assertion while either exists:

- a marker file `run/active/<pid>` written by the `no-sleep-while-working` extension while an
  interactive session is busy — holds `caffeinate -dis` (`-d` because USB wired network connections
  can drop when the display sleeps)
- a live spawned teammate pid from `~/.pi/orchestrator-teams/*/config.json` — holds `caffeinate -is`

Switching between the two modes restarts `caffeinate`. Markers and teammate pids count only while
the pid is alive and still a `pi`/`node` process; dead markers are deleted, so a crash cannot
strand an assertion. HOLD/RELEASE lines with the reason go to `logs/agent-caffeinate.log`.

`caffeinate` is started with `-w <watcher pid>`, so it exits with the watcher even on `SIGKILL`,
and the watcher records `<watcher pid> <caffeinate pid>` in `run/caffeinate.pid` and kills that pid
at startup if a previous instance left it behind. If the holder scan itself fails, the watcher logs
`ERROR live_holders failed` and keeps the current assertion rather than releasing. Override the
marker directory with `PI_CAFFEINATE_ACTIVE_DIR` (read by both the watcher and the extension).

## Deliberately not committed

See `.gitignore`. Nothing here should ever contain a secret:

- `auth.json`, `mcp-auth.json` — provider credentials and MCP OAuth tokens
- `mcp.json*` — MCP server configuration
- `models.json` — provider config (copied from the company layer, or written per machine)
- `company.env` — which company layer this machine uses
- `sessions/` — conversation transcripts
- `models-store.json`, `trust.json`, `logs/`, `run/`, `session-bus/` — machine-local state
- `daily-ledger` — a symlink into the company layer's data
- `node_modules/`, `__pycache__/`, `.DS_Store`, vendored `rg`/`fd` binaries
