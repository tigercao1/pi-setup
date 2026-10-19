---
name: cli-tools
description: Generic method for driving any command-line tool well, instead of an MCP server or a web tool. Use when asked to "use the X CLI" (gh, circleci, databricks, aws, gcloud, kubectl, jq, ...), when meeting an unfamiliar CLI, or whenever a task can be done from a CLI that is installed and authenticated. Covers discovery, auth/context checks, JSON output with jq, read-before-write, pagination, rate limits, secrets and failure diagnosis.
---

# Using CLI tools

## When to prefer a CLI

Prefer an installed, authenticated CLI over an MCP tool or web fetch when it can do the job:
- Output is exact, scriptable and filterable (JSON + jq), not a summary someone else chose.
- It covers more of the API (e.g. `gh api`, `databricks api`) and you can see the precise call.
- It is reproducible: the command line is the evidence. Quote it in your report.

Fall back to MCP/web when the CLI is missing, not authenticated, or lacks the capability.
Never install a tool or log in on the user's behalf without asking.

## 1. Discover before acting

Do not guess flags from memory; versions drift. Spend one or two calls learning the tool:

```bash
command -v <tool> && <tool> --version         # installed? which version?
<tool> --help                                 # top-level command groups
<tool> <group> --help                         # subcommands
<tool> <group> <sub> --help                   # flags, defaults, examples
man <tool>                                    # when it ships a man page
<tool> help <topic>                           # e.g. gh help formatting
```

Read the help for the exact subcommand you will run, especially defaults (`--limit` default,
default output type, which profile/host is implied). Look for `--json`, `--output`, `--dry-run`,
`--yes`/`--force`, `--debug`.

## 2. Check auth and context first

Before any real call, find out *who* and *where* you are, and say it in your reply
("as GitHub user X on github.com", "Databricks profile Y, host Z"):

```bash
gh auth status                      # account, host, scopes (never print the token)
databricks auth describe -p <prof>  # credential source and host
databricks auth profiles
aws sts get-caller-identity; kubectl config current-context; gcloud config list
```

If several accounts/profiles/contexts exist, pass the one you mean explicitly
(`-p`, `--profile`, `--context`, `--hostname`, `-R owner/repo`) rather than trusting the default.
If the active context looks like production and the task does not need it, stop and ask.

## 3. Prefer machine-readable output

Ask for JSON and filter it, instead of scraping tables:

```bash
gh pr list --json number,title,author --limit 50 | jq -r '.[] | "\(.number)\t\(.title)"'
gh pr view 123 --json state,mergeable -q .state       # built-in jq via -q/--jq
databricks <group> list -o json | jq '.[] | .name'
```

- Flag spellings vary: `--json [fields]`, `-o json`, `--output json`, `--format json`.
- Request only the fields you need; it is faster and keeps context small.
- jq habits: `-r` for raw strings, `-e` to make a null/false result a non-zero exit,
  `length` to count, `select(...)` to filter, `@tsv` for tables.
- Large output: write to a file under `/tmp` and query it, rather than dumping it into context.

## 4. Read-only before write

- Run the read (`list`, `view`, `get`, `describe`, `status`) first and confirm the target exists
  and is what you think.
- Use `--dry-run`, `plan`, `diff`, `validate` or `--help`-documented preview modes when offered.
- **Writes with outward side effects need the user's explicit ask for that specific action**:
  comments, reviews, posts, messages, issue/ticket edits, triggering or cancelling runs, deploys,
  merges, releases, deletes, permission or secret changes. A general "go fix it" is not consent to
  post or deploy. Draft the command and show it instead.
- Local, reversible writes inside the task's scope are fine.
- Never add `--yes`/`--force` to get past a confirmation prompt you have not been cleared for.

## 5. Pagination and limits

- Most list commands cap results silently (`gh ... --limit` defaults to 30). An empty or short
  page is not proof of absence; check the cap and raise it or paginate.
- Raw APIs: `gh api --paginate [--slurp]`, `--page-token`/`next_page_token` loops, `--max-items`.
- Filter server-side (`--search`, `--state`, `--author`, query params) before fetching everything.
- State the limit you used when reporting counts ("first 100 by updated date").

## 6. Rate limits and retries

- On HTTP 429/403-with-rate-limit or "secondary rate limit": back off (respect `Retry-After`),
  then retry a few times with growing delays. Do not hammer in a tight loop.
- Check budget where possible (`gh api rate_limit`).
- Retry only idempotent reads automatically. A write that timed out may have succeeded:
  re-read state before retrying it.
- Batch: one query for many items beats one call per item (GraphQL, `--json` lists, bulk endpoints).

## 7. Secrets

- Never echo, print, log or write tokens, keys or passwords into files, reports or commits.
  Redact them (`***`) if they appear in output you quote.
- Do not run commands whose purpose is to print a credential (`... auth token`, `printenv`,
  `cat` of credential files) unless the user asked and the value stays out of the transcript.
- Pass secrets via the tool's own config/keyring or an environment variable, not as a literal
  argument (arguments land in shell history and process lists).
- `--verbose`/`--debug` output can include auth headers; redact before sharing.

## 8. Diagnosing failures

1. Read the exit code (`echo $?`) and stderr; keep both: `cmd 2>/tmp/err.txt; echo "exit=$?"`.
2. Common causes, in order: wrong context/profile/host, expired auth or missing scope, wrong
   repo/workspace inferred from the cwd, a renamed flag in this version, a silent limit.
3. Turn up detail: `--verbose`, `--debug`, `--log-level debug`, `-i/--include` (HTTP status and
   headers), `GH_DEBUG=api`-style env vars documented in the tool's help.
4. Re-run the smallest command that reproduces it. Then re-read `--help` for that subcommand.
5. Report the exact command, exit code and the relevant stderr line, not a paraphrase.

## 9. Recording a per-tool cheatsheet

Keep this skill generic. When you learn something reusable about one tool (the right flags, a
jq filter, an auth quirk, a pagination trap), record it outside this file:

- **Generic, personal knowledge** → a small companion file next to this skill,
  `tools/<tool>.md` in this skill's directory (create it if missing). Read it before using that tool.
- **Project/company-specific values** (org names, hosts, profiles, workspace IDs, job names) →
  the project layer's overlay or that project's own CLI skill, never this file.
- Keep a cheatsheet short: purpose, auth check, 5–15 proven commands, known traps.
  Only record commands you actually ran successfully, with the tool version.
- If a dedicated skill for the tool exists in the available skills, load it and follow it;
  this skill is the fallback method.

## Checklist

- [ ] Tool installed, version noted, subcommand `--help` read
- [ ] Account/profile/host confirmed and named in the reply
- [ ] JSON output + jq, only needed fields, limits/pagination considered
- [ ] Reads before writes; no outward side effect without an explicit ask
- [ ] No secrets in output, files or reports
- [ ] Failures reported with command, exit code and stderr
