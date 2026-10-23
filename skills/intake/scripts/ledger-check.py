#!/usr/bin/env python3
"""Resolve every evidence pointer in an intake mission ledger.

Usage:
  ledger-check.py LEDGER.md [--repo DIR]... [--gh-repo OWNER/NAME] [--offline]
                  [--events SESSION.jsonl|AGENT.log]...

Exit 0 when every formatted row resolves (and, with --events, every spawn,
push and PR open has a ledger mention); 1 otherwise; 2 on usage errors.
Legacy free-prose lines and jev_classify blocks are reported, never failed.
"""

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

TS = r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})"
ROW_START = re.compile(rf"^- ({TS}) · ")
ROW = re.compile(
    rf"^- (?P<ts>{TS}) · (?P<phase>[^·]+?) · (?P<decision>.+?) · result: (?P<result>.+?) · evidence: (?P<evidence>.+?)\s*$"
)
JEV_HEADING = re.compile(rf"^## {TS} · classify\b")
JEV_RECORD = re.compile(r"<!-- jev-classify (\{.*?\}) -->")
SUPERSEDES = re.compile(rf"supersedes ({TS})")
SHA = re.compile(r"^[0-9a-f]{7,40}$")
REPO_SHA = re.compile(r"^(?P<repo>.+)@(?P<sha>[0-9a-f]{7,40})$")
PR = re.compile(r"^(?:(?P<gh>[\w.-]+/[\w.-]+))?(?:PR)?#(?P<num>\d+)$", re.IGNORECASE)
PATH_LINE = re.compile(r"^(?P<path>.+?):(?P<start>\d+)(?:-(?P<end>\d+))?$")
NO_EVIDENCE_PHASES = {"start", "pause", "resume"}
GIT_PUSH = re.compile(r"\bgit((?:\s+(?:-C|-c|--git-dir|--work-tree)(?:\s+|=)\S+|\s+--[\w-]+)*)\s+push\b([^;&|\n]*)")
GIT_DIR = re.compile(r"(?:-C|--work-tree|--git-dir)(?:\s+|=)(\S+)")
CD_DIR = re.compile(r"(?:^|[;&|(]\s*)cd\s+(\S+)")
STACK = re.compile(r"\bgh\s+stack\s+(push|sync|submit)\b")
STACK_ROW_SLACK_S = 300


def run(cmd, cwd=None):
    try:
        return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=60).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


class Resolver:
    def __init__(self, ledger, repos, gh_repo, offline):
        self.base = ledger.parent
        self.repos = repos
        self.gh_repo = gh_repo
        self.offline = offline

    def sha_in(self, repo, sha):
        return run(["git", "-C", str(repo), "cat-file", "-e", f"{sha}^{{commit}}"])

    def candidates(self, raw):
        p = Path(os.path.expanduser(raw))
        if p.is_absolute():
            return [p]
        return [self.base / p] + [r / p for r in self.repos]

    def resolve(self, pointer):
        if pointer.startswith(("http://", "https://")):
            return True, "url, not checked"
        m = REPO_SHA.match(pointer)
        if m:
            repo = Path(os.path.expanduser(m["repo"]))
            if not (repo / ".git").exists() and not run(["git", "-C", str(repo), "rev-parse"]):
                return False, f"not a git repo: {repo}"
            return (True, "") if self.sha_in(repo, m["sha"]) else (False, f"commit not in {repo}")
        if SHA.match(pointer):
            if not self.repos:
                return False, "SHA given but no --repo to check it in"
            for repo in self.repos:
                if self.sha_in(repo, pointer):
                    return True, ""
            return False, "commit not in " + ", ".join(str(r) for r in self.repos)
        m = PR.match(pointer)
        if m:
            if self.offline:
                return True, "PR, skipped (--offline)"
            cmd = ["gh", "pr", "view", m["num"], "--json", "number"]
            gh = m["gh"] or self.gh_repo
            if gh:
                cmd += ["--repo", gh]
            cwd = str(self.repos[0]) if self.repos and not gh else None
            return (True, "") if run(cmd, cwd=cwd) else (False, "gh pr view failed")
        m = PATH_LINE.match(pointer)
        if m:
            end = int(m["end"] or m["start"])
            for p in self.candidates(m["path"]):
                if p.is_file():
                    with open(p, errors="replace") as fh:
                        count = sum(1 for _ in fh)
                    if 1 <= int(m["start"]) <= end <= count:
                        return True, ""
                    return False, f"line out of range ({count} lines in {p})"
            return False, "path not found"
        for p in self.candidates(pointer):
            if p.exists():
                return True, ""
        return False, "not a SHA, PR#, path:line or existing path"


def split_evidence(text):
    return [part.strip().strip("`") for part in re.split(r"\s*[,;]\s*", text) if part.strip()]


def check_ledger(ledger, resolver):
    lines = ledger.read_text(errors="replace").splitlines()
    problems, rows, legacy, jev = [], [], [], 0
    seen_ts = set()
    in_jev = False
    for no, line in enumerate(lines, 1):
        loc = f"{ledger}:{no}"
        if JEV_HEADING.match(line):
            in_jev, jev = True, jev + 1
            continue
        records = JEV_RECORD.findall(line)
        for rec in records:
            try:
                json.loads(rec)
            except ValueError:
                print(f"warning {loc}: jev-classify record does not parse")
        if records:
            in_jev = False
            continue
        if line.startswith("- "):
            in_jev = False
        if ROW_START.match(line):
            in_jev = False
            m = ROW.match(line)
            if not m:
                problems.append(f"{loc}: malformed row (need '- <ts> · <phase> · <decision> · result: <state> · evidence: <pointers>')")
                continue
            rows.append(no)
            phase = m["phase"].strip().lower()
            sup = SUPERSEDES.search(m["decision"])
            if sup and sup[1] not in seen_ts:
                problems.append(f"{loc}: supersedes {sup[1]}, but no earlier row has that timestamp")
            seen_ts.add(m["ts"])
            evidence = m["evidence"].strip()
            if evidence == "-":
                if phase not in NO_EVIDENCE_PHASES:
                    problems.append(f"{loc}: evidence '-' is only allowed on start/pause/resume rows")
                continue
            for pointer in split_evidence(evidence):
                ok, why = resolver.resolve(pointer)
                if not ok:
                    problems.append(f"{loc}: {m['phase'].strip()} · {m['decision'][:60]} -> {pointer}: {why}")
            continue
        if line.startswith("#"):
            in_jev = False
            continue
        if not line.strip() or in_jev:
            continue
        if line[:1].isspace() and rows:
            continue
        if rows:
            problems.append(f"{loc}: unformatted line after the ledger adopted rows (indent it under a row, or make it a row)")
        else:
            legacy.append(no)
    return rows, legacy, jev, problems


def tool_calls(path):
    for raw in Path(path).read_text(errors="replace").splitlines():
        try:
            d = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(d, dict):
            continue
        if d.get("type") not in (None, "message", "message_end"):
            continue
        m = d.get("message")
        if not isinstance(m, dict) or m.get("role") != "assistant":
            continue
        ts = d.get("timestamp") or m.get("timestamp") or "?"
        if isinstance(ts, (int, float)):
            ts = datetime.fromtimestamp(ts / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        for c in m.get("content") or []:
            if isinstance(c, dict) and c.get("type") == "toolCall":
                yield ts, c.get("name"), c.get("arguments") or {}


def unquote(word):
    return word.strip("'\"")


def push_key(push, cmd):
    words = [unquote(w) for w in push[2].split() if not w.startswith("-") and not re.search(r"[<>]", w)]
    if len(words) >= 2:
        ref = words[-1].lstrip("+").split(":")[-1]
        return re.sub(r"^refs/heads/", "", ref)
    where = GIT_DIR.search(push[1]) or None
    if not where:
        cds = [m for m in CD_DIR.finditer(cmd) if m.start() < push.start()]
        where = cds[-1] if cds else None
    if where:
        return os.path.basename(unquote(where[1]).rstrip("/")) or push.group(0).strip()
    return push.group(0).strip()


def parse_ts(ts):
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except ValueError:
        return None


def stack_rows(text):
    rows = []
    for line in text.splitlines():
        m = ROW.match(line)
        if m and STACK.search(m["decision"]):
            rows.append((parse_ts(m["ts"]), STACK.search(m["decision"])[1], m["decision"]))
    return rows


def unlogged_stack(stack_events, rows):
    taken, missing = set(), []
    for ts, kind, key, path in sorted(stack_events, key=lambda e: str(e[0])):
        when = parse_ts(ts)
        verb = kind.split()[-1]
        match = None
        for i, (row_ts, row_verb, decision) in enumerate(rows):
            if i in taken or row_verb != verb:
                continue
            if when and row_ts and (row_ts - when).total_seconds() < -STACK_ROW_SLACK_S:
                continue
            if key != "?" and key not in decision and any(
                    j not in taken and rows[j][1] == verb and key in rows[j][2] for j in range(len(rows))):
                continue
            match = i
            break
        if match is None:
            missing.append((ts, kind, key, path))
        else:
            taken.add(match)
    return missing


def events(paths):
    found = []
    for path in paths:
        for ts, name, args in tool_calls(path):
            if name in ("team_spawn", "team_recycle"):
                found.append((ts, name, str(args.get("name", "?")), path))
            elif name == "bash":
                cmd = str(args.get("command", ""))
                for push in GIT_PUSH.finditer(cmd):
                    found.append((ts, "git push", push_key(push, cmd), path))
                for pr in re.finditer(r"gh\s+pr\s+(create|ready)\b[^;&|\n]*", cmd):
                    head = re.search(r"--head[= ]+(\S+)", pr.group(0))
                    num = re.search(r"\bready\s+(\d+)\b", pr.group(0))
                    key = head[1] if head else num[1] if num else pr.group(0).strip()
                    found.append((ts, f"gh pr {pr[1]}", key, path))
                for sp in STACK.finditer(cmd):
                    cds = [m for m in CD_DIR.finditer(cmd) if m.start() < sp.start()]
                    key = os.path.basename(unquote(cds[-1][1]).rstrip("/")) if cds else "?"
                    found.append((ts, f"gh stack {sp[1]}", key, path))
    seen, unique = set(), []
    for e in found:
        if e[:3] not in seen:
            seen.add(e[:3])
            unique.append(e)
    return unique


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ledger", type=Path)
    ap.add_argument("--repo", action="append", default=[], help="git repo or worktree that SHAs and relative paths live in")
    ap.add_argument("--gh-repo", help="OWNER/NAME for PR# pointers (default: the first --repo's remote)")
    ap.add_argument("--offline", action="store_true", help="skip gh pr view")
    ap.add_argument("--events", action="append", default=[], help="session JSONL or team log to audit against the ledger")
    a = ap.parse_args()
    if not a.ledger.is_file():
        print(f"no such ledger: {a.ledger}", file=sys.stderr)
        return 2
    repos = [Path(os.path.expanduser(r)) for r in a.repo]
    rows, legacy, jev, problems = check_ledger(a.ledger, Resolver(a.ledger, repos, a.gh_repo, a.offline))

    unlogged = []
    if a.events:
        text = a.ledger.read_text(errors="replace")
        found = events(a.events)
        stack = [e for e in found if e[1].startswith("gh stack ")]
        missing = [e for e in found if e not in stack and (e[2] == "?" or e[2] not in text)]
        missing += unlogged_stack(stack, stack_rows(text))
        for ts, kind, key, path in sorted(missing, key=lambda e: str(e[0])):
            unlogged.append(f"{ts} {kind} {key}  ({path})")

    for p in problems:
        print(f"UNRESOLVED {p}")
    for u in unlogged:
        print(f"UNLOGGED   {u}")
    if legacy:
        print(f"legacy, not checked: {len(legacy)} free-prose lines (lines {legacy[0]}-{legacy[-1]})")
    print(
        f"{a.ledger}: {len(rows)} rows, {len(problems)} unresolved, "
        f"{jev} jev_classify blocks, {len(legacy)} legacy lines"
        + (f", {len(unlogged)} unlogged events" if a.events else "")
    )
    return 1 if problems or unlogged else 0


if __name__ == "__main__":
    sys.exit(main())
