# worktree

Creates and manages provisioned git worktrees, so parallel work (yours or a spawned agent's)
never shares one working tree.

Surfaces three things:

- `/wt` — asks first: list, list with PR status, new, or clean. The list then offers create, check out a PR, remove. `/wt --pr`, `/wt new <spec>` and `/wt clean` skip the first step.
- a `worktree` tool the model can call (`list`, `create`, `path`, `remove`).
- a `team_spawn` hook: a spawn with `cwd: "worktree:PROJ-123"` (or `worktree:pr/1234`) is
  provisioned and rewritten to the real path before the worker starts. Append `+fast` to skip the
  profile's heavy paths.

## How it finds the CLI

The extension is a thin wrapper around the `wt` bash script (`../../bin/wt`). It resolves, in
order:

1. `$WT_BIN`
2. `bin/wt` in the agent dir
3. `wt` on `$PATH`

Each candidate must exist and be executable; a candidate that is not is skipped rather than
treated as fatal. Step 2 means a fresh checkout works with no installation. To get `wt` in your
own shell too:

```sh
ln -sfn ~/.pi/agent/bin/wt ~/.local/bin/wt
```

If none resolves, the extension registers nothing at all — no `worktree` tool, no `/wt`, no
status line — so the model is not offered a capability that cannot work. A `team_spawn` with a
`worktree:` cwd is still allowed through; it runs in the parent's working directory with a
warning, instead of being blocked.

## Profiles

Without a profile, `wt` creates plain git worktrees under `<repo-parent>/<repo-name>-worktrees`.
A JSON profile adds repo-specific provisioning. The first match wins:

1. `<repo>/.pi/worktree.json`
2. any `*.json` in each directory of `$WT_PROFILE_DIRS` (colon-separated; default
   `~/.pi/agent/worktree`, then every `~/.pi/*/worktree`) whose `match` is a substring of the
   repo's `origin` remote URL

| Key | Meaning |
|---|---|
| `match` | substring of the origin URL that selects this profile |
| `root` | where worktrees are created (`~` expanded) |
| `base` | base ref for new branches (default `origin/main`) |
| `prefix` | branch namespace (default: your GitHub login, else the git email's local part) |
| `main` | main checkout used when `wt` runs outside any repo |
| `link[]` | paths symlinked from the main checkout (shared config, credentials) |
| `clone[]` | paths copy-on-write cloned (per-branch mutable state) |
| `heavy[]` | paths cloned unless `--skip-heavy` / `+fast` (dependency folders) |
| `mkdir[]` | empty directories to create |
| `branchCheck` | executable run as `<check> <branch> <ticket>`; non-zero exit refuses the branch. Relative paths resolve from the profile's directory |
| `readyHint` | line printed after `wt new`; `{ticket}` is replaced by the lowercased ticket |

Example:

```json
{
  "match": "my-org/my-app",
  "root": "~/my-app-worktrees",
  "main": "~/my-app",
  "link": [".env", "config/credentials.yml"],
  "clone": ["db/schema.sql"],
  "heavy": ["node_modules"],
  "mkdir": ["log", "tmp/pids"]
}
```

Symlinked means a credential rotation in the main checkout applies to every worktree
immediately. Cloned means a migration or a package install in one worktree cannot corrupt
another. `wt profile` prints what was resolved for the current repo.

Also required: `git`, `jq` or `python3` (to read profiles), and `gh` for the PR-related commands.

## Environment

| Variable | Default |
|---|---|
| `WT_ROOT` | profile `root`, else `<repo-parent>/<repo-name>-worktrees` |
| `WT_MAIN` | profile `main` — main checkout, used when run outside any repo |
| `WT_BASE` | profile `base`, else `origin/main` |
| `WT_PREFIX` | profile `prefix`, else your GitHub login |
| `WT_PROFILE_DIRS` | `~/.pi/agent/worktree` then every `~/.pi/*/worktree` |
| `WT_BIN` | first candidate in CLI resolution |
| `WT_NO_FZF` | `1` forces the built-in picker |

## Changing directory

A child process cannot `cd` its parent shell, so add this to `~/.zshrc`:

```sh
wtcd() {
  local d
  if [ $# -eq 0 ]; then d=$(wt pick) || return 1
  else d=$(wt path "$1") || return 1; fi
  [ -n "$d" ] && cd "$d"
}
```
