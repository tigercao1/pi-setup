#!/usr/bin/env python3
"""Review gate engine: lane selection, per-push re-run classifier, spawn budget.

Repo-specific path rules come from a config module passed with --config
(a repo layer supplies one, e.g. ~/.pi/homebase/bin/pr_gate_homebase.py). This file holds no repo paths.

  pr_gate_core.py lanes  --config C --repo R --base REF --head REF (--state F | --dir D --pr N) [...]
  pr_gate_core.py delta  --config C --repo R --base REF --head REF (--state F | --dir D --pr N) [...]
  pr_gate_core.py spawn  check|record|verify|bind|grant|resolve|status (--state F | --dir D --pr N) [...]
"""

import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager

LANES = ("approval", "convention", "necessity", "blast-radius")
OPUS_LANE = "approval-opus"
ALL_LANES = LANES + (OPUS_LANE,)
PRIMARY_MODEL = "openai/gpt-6.1-sol"
OPUS_MODEL = "anthropic/claude-opus-5.5"
DEFAULT_BUDGET = {"rounds": 3, "spawns": 12}
JEV_SKIP_MASS = 0.8
D8_ADDED_LINES = 40
D8_UNFLAGGED_FILES = 3
PASSING_VERDICTS = {"APPROVE", "PASS", "COMMENT"}
FAILING_VERDICTS = {"REQUEST_CHANGES", "FAIL"}
RENAME_LITERALS = {
    "true", "false", "nil", "null", "none", "undefined", "and", "or", "not", "if", "unless",
    "else", "elsif", "return", "raise", "self", "this", "def", "end", "do", "class", "module",
    "public", "private", "protected", "const", "let", "var", "new",
}

JEV_QUESTIONS = {
    "new_behaviour": {
        "type": "boolean",
        "instructions": "Does the change between the two reviewed heads add or alter runtime behaviour "
        "(new method, new branch, changed condition, changed error handling), as opposed to formatting, "
        "naming, or moving code?",
    },
    "spec_rules": {
        "type": "boolean",
        "instructions": "Could the change break a spec convention (foreign-module fixtures, factories, testing "
        "internals) or a code convention (public interface shape, logging, rescue scope, rollout gating)?",
    },
    "scope_growth": {
        "type": "boolean",
        "instructions": "Could the change add work that no acceptance criterion in the ticket covers?",
    },
}
JEV_LANES = {"new_behaviour": ["blast-radius"], "spec_rules": ["convention"], "scope_growth": ["necessity"]}

RULE_TEXT = {
    "D0": "fail-open: the reviewed head or a git signal could not be computed; every lane in the lane set re-runs",
    "D1": "same patch (PR diff byte-identical and patch-id equal, base did not touch PR files): nothing re-runs; "
    "CI must be green on the new head",
    "D2": "pure rebase, base changed a PR file or the patch context: approval re-runs",
    "D7": "risk path touched: all four lanes re-run on the whole PR",
    "D8": "size: more than 40 added app-code lines or more than 3 unflagged app files: every lane in the lane set re-runs",
    "D3": "docs only: precheck and lint only",
    "D4": "rename only (a declaration renamed, every reference to it renamed, new name unused before): "
    "convention re-runs, plus boundary checks",
    "D5": "test only: convention (spec rules) and necessity re-run",
    "D6": "flag overlap: lanes whose flagged files were touched re-run",
    "J": "unplaced small code change: Jev picks the lanes it cannot confidently clear (fail-open on any error)",
}


class GateError(Exception):
    pass


def git(repo, *args, check=True, stdin=None):
    proc = subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, input=stdin)
    if check and proc.returncode != 0:
        raise GateError(f"git {' '.join(args)}: {proc.stderr.strip()}")
    return proc.stdout


def rev(repo, ref):
    return git(repo, "rev-parse", "--verify", f"{ref}^{{commit}}").strip()


def merge_base(repo, a, b):
    return git(repo, "merge-base", a, b).strip()


def sha(text):
    return hashlib.sha256((text or "").encode()).hexdigest()


def load_config(path):
    spec = importlib.util.spec_from_file_location("pr_gate_config", path)
    if spec is None or spec.loader is None:
        raise GateError(f"cannot load config {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def matches(patterns, path):
    return any(re.search(p, path) for p in patterns)


def change_lines(diff_text):
    out, in_hunk = [], False
    for line in diff_text.splitlines():
        if line.startswith("diff --git"):
            in_hunk = False
        elif line.startswith("@@"):
            in_hunk = True
        elif in_hunk and line[:1] in "+-":
            out.append(line)
        elif line.startswith("Binary files") or line.startswith("old mode") or line.startswith("new mode"):
            out.append(line)
    return out


def pr_snapshot(repo, base_ref, head):
    mb = merge_base(repo, base_ref, head)
    files = [p for p in git(repo, "diff", "--no-renames", "--name-only", mb, head).splitlines() if p]
    keys = {}
    for path in files:
        diff = git(repo, "diff", "--no-renames", "--no-color", "-U0", mb, head, "--", path)
        keys[path] = sha("\n".join(change_lines(diff)))
    full = git(repo, "diff", "--no-color", mb, head)
    pid = git(repo, "patch-id", "--stable", stdin=full).split()
    return {"head": head, "merge_base": mb, "patch_id": pid[0] if pid else "", "keys": keys}


def summary_of(body):
    if body is None:
        return None
    m = re.search(r"^## Summary\s*$(.*?)(?=^## |\Z)", body, re.M | re.S)
    return (m.group(1) if m else "").strip()


def body_fingerprint(body):
    if body is None:
        return {"body_sha": None, "summary_sha": None}
    return {"body_sha": sha(body), "summary_sha": sha(summary_of(body))}


def read_body(args):
    if getattr(args, "body_file", None):
        with open(args.body_file) as fh:
            return fh.read()
    if getattr(args, "pr", None) and not getattr(args, "no_gh", False):
        proc = subprocess.run(["gh", "pr", "view", str(args.pr), "--json", "body", "--jq", ".body"],
                              capture_output=True, text=True, cwd=args.repo)
        if proc.returncode == 0:
            return proc.stdout
    return None


def state_path(args):
    if getattr(args, "state", None):
        return args.state
    if getattr(args, "dir", None) and getattr(args, "pr", None):
        return os.path.join(args.dir, "gate", f"{args.pr}.json")
    raise GateError("need --state FILE, or --dir <mission or ticket plans folder> with --pr N")


@contextmanager
def locked_state(path, create=False):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path + ".lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if os.path.exists(path):
            with open(path) as fh:
                state = json.load(fh)
        elif create:
            state = {}
        else:
            raise GateError(f"no gate state at {path}; run pr-gate-lanes.sh first")
        box = {"state": state, "dirty": False}
        yield box
        if box["dirty"]:
            fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(path)), prefix=".gate-")
            with os.fdopen(fd, "w") as fh:
                json.dump(box["state"], fh, indent=2, sort_keys=True)
                fh.write("\n")
            os.replace(tmp, path)


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def canonical(lanes):
    return [lane for lane in ALL_LANES if lane in set(lanes)]


def verdict_passes(record):
    if not record:
        return False
    verdict = record.get("verdict", "")
    if verdict in FAILING_VERDICTS:
        return False
    if verdict == "COMMENT" and record.get("blockers"):
        return False
    return verdict in PASSING_VERDICTS


def classify_paths(cfg, paths):
    tests = [p for p in paths if matches(cfg.TEST_PATTERNS, p)]
    docs = [p for p in paths if p not in tests and matches(cfg.DOC_PATTERNS, p)]
    app = [p for p in paths if p not in tests and p not in docs]
    risk = [p for p in app if matches([r for _, r in cfg.RISK_PATTERNS], p)]
    return tests, docs, app, risk


def risk_names(cfg, paths):
    return sorted({name for name, rx in cfg.RISK_PATTERNS for p in paths if re.search(rx, p)})


IDENT_RE = re.compile(r"[A-Za-z_]\w*[!?]?")
DECL_KEYWORDS = r"def|class|module|function|func|fn|interface|struct|enum|trait|type|const|let|var"


def rename_tokens(line):
    out, i, n = [], 0, len(line)
    while i < n:
        c = line[i]
        if c.isspace():
            i += 1
        elif c in "\"'`":
            i = scan_string(line, i, out)
        elif c == ":" and re.match(r"[A-Za-z_]", line[i + 1:i + 2]) and (i == 0 or not re.match(r"[\w:]", line[i - 1])):
            m = IDENT_RE.match(line, i + 1)
            out.append("\0:" + m.group(0))
            i = m.end()
        else:
            m = IDENT_RE.match(line, i) or re.compile(r"\d[\w.]*|\S").match(line, i)
            out.append(m.group(0))
            i = m.end()
    return out


def scan_string(line, i, out):
    quote, j, n, buf = line[i], i + 1, len(line), line[i]
    while j < n:
        ch = line[j]
        if ch == "\\":
            buf += line[j:j + 2]
            j += 2
        elif ch == quote:
            buf += ch
            j += 1
            break
        elif quote != "'" and ch in "#$" and line[j + 1:j + 2] == "{":
            depth, k = 1, j + 2
            while k < n and depth:
                depth += {"{": 1, "}": -1}.get(line[k], 0)
                k += 1
            out.append("\0" + buf + ch + "{")
            out.extend(rename_tokens(line[j + 2:k - 1] if not depth else line[j + 2:k]))
            buf, j = "}", k
        else:
            buf += ch
            j += 1
    out.append("\0" + buf)
    return j


def declares(line, name):
    return re.search(r"(?:^|[^\w.])(?:%s)\s+(?:self\.|(?:\w+::)+)?%s(?![\w!?])" % (DECL_KEYWORDS, re.escape(name)),
                     line) is not None


def rename_only(repo, old, new, touched):
    if not touched:
        return False, {}
    status = git(repo, "diff", "-M", "--name-status", old, new, "--", *touched)
    for line in status.splitlines():
        code = line.split("\t", 1)[0]
        if not code.startswith("R") and code != "M":
            return False, {}
    diff = git(repo, "diff", "-M", "--no-color", "-U0", old, new, "--", *touched)
    mapping, declared = {}, set()
    removed, added = [], []

    def flush():
        if len(removed) != len(added):
            return False
        for a, b in zip(removed, added):
            ta, tb = rename_tokens(a), rename_tokens(b)
            if len(ta) != len(tb):
                return False
            subs = set()
            for x, y in zip(ta, tb):
                if x == y:
                    continue
                if not IDENT_RE.fullmatch(x) or not IDENT_RE.fullmatch(y):
                    return False
                if x.lower() in RENAME_LITERALS or y.lower() in RENAME_LITERALS:
                    return False
                if mapping.setdefault(x, y) != y:
                    return False
                subs.add((x, y))
            declared.update(x for x, y in subs if declares(a, x) and declares(b, y))
        removed.clear()
        added.clear()
        return True

    for line in diff.splitlines():
        if line.startswith("diff --git") or line.startswith("@@"):
            if not flush():
                return False, {}
        elif line.startswith("---") or line.startswith("+++"):
            continue
        elif line.startswith("-"):
            removed.append(line[1:])
        elif line.startswith("+"):
            added.append(line[1:])
        elif line.startswith("Binary files"):
            return False, {}
    if not flush():
        return False, {}
    if not mapping or len(mapping) > 2 or set(mapping) - declared:
        return False, {}
    for old_token, new_token in mapping.items():
        if git(repo, "grep", "-l", "-w", "-F", old_token, new, check=False).strip():
            return False, {}
        if git(repo, "grep", "-l", "-w", "-F", new_token, old, check=False).strip():
            return False, {}
    return True, mapping


def added_app_lines(repo, old, new, paths, cfg):
    if not paths:
        return 0
    total = 0
    for line in git(repo, "diff", "-M", "--numstat", old, new, "--", *paths).splitlines():
        parts = line.split("\t")
        if len(parts) < 3 or parts[0] == "-":
            continue
        if matches(cfg.GENERATED_PATTERNS, parts[-1].split(" => ")[-1].rstrip("}")):
            continue
        total += int(parts[0])
    return total


def unflagged_files(repo, old, new, paths, flagged):
    if not paths:
        return []
    out = []
    for line in git(repo, "diff", "-M", "--name-status", old, new, "--", *paths).splitlines():
        names = line.split("\t")[1:]
        if names and not set(names) & flagged:
            out.append(names[-1])
    return sorted(set(out))


FUNCNAME_ATTRIBUTES = "*.rb diff=ruby\n*.rake diff=ruby\n*.py diff=python\n*.go diff=golang\n" \
    "*.rs diff=rust\n*.java diff=java\n*.kt diff=kotlin\n*.php diff=php\n*.cs diff=csharp\n"


def hunk_headers(repo, old, new, paths):
    heads = []
    with tempfile.NamedTemporaryFile("w", suffix=".gitattributes") as attrs:
        attrs.write(FUNCNAME_ATTRIBUTES)
        attrs.flush()
        diff = git(repo, "-c", f"core.attributesFile={attrs.name}", "diff", "-M", "--no-color", "-U0",
                   old, new, "--", *paths)
    for line in diff.splitlines():
        if line.startswith("+++ b/"):
            heads.append(line[6:])
        elif line.startswith("@@"):
            ctx = line.split("@@", 2)[-1].strip()
            if ctx:
                heads.append("  " + ctx)
    return heads


def call_jev(state_text, questions):
    cmd = os.environ.get("PR_GATE_JEV_CMD")
    argv = ["/bin/sh", "-c", cmd] if cmd else [
        "node", "--experimental-strip-types", "--no-warnings",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "pr-gate-jev.ts"),
    ]
    payload = json.dumps({"state": state_text, "questions": questions})
    proc = subprocess.run(argv, input=payload, capture_output=True, text=True, timeout=90)
    if proc.returncode != 0:
        raise GateError(f"jev exited {proc.returncode}: {proc.stderr.strip()[:300]}")
    result = json.loads(proc.stdout)
    answers = result.get("answers") or {}
    probs = {}
    for qid in JEV_QUESTIONS:
        p = (answers.get(qid) or {}).get("probability")
        if not isinstance(p, (int, float)) or not 0 <= p <= 1:
            raise GateError(f"jev answer {qid} has no probability")
        probs[qid] = float(p)
    return probs, result.get("usage")


def jev_decide(repo, old, new, touched, state, signals, lane_set, questions):
    blockers = []
    for lane, rec in sorted((state.get("lanes") or {}).items()):
        for b in (rec.get("blockers") or [])[:3]:
            blockers.append(f"{lane}: {b}")
    false_flags = [k for k in ("D1", "D2", "D7", "D8", "D3", "D4", "D5", "D6") if not signals["flags"].get(k)]
    text = "\n".join([
        "Two reviewed heads of one pull request. Judge only the change between them.",
        "diff --stat:", git(repo, "diff", "-M", "--stat", old, new, "--", *touched).rstrip(),
        "touched paths: " + ", ".join(touched),
        "hunk headers (function context only, no bodies):", *hunk_headers(repo, old, new, touched),
        "last-round blockers per lane: " + ("; ".join(blockers) or "none"),
        "deterministic flags that were false: " + ", ".join(false_flags),
    ])
    entry = {"at": now(), "from": old, "to": new, "state": text, "threshold_false_mass": JEV_SKIP_MASS}
    lanes = {"approval"}
    try:
        probs, usage = call_jev(text, questions)
    except (GateError, json.JSONDecodeError, subprocess.TimeoutExpired, OSError) as exc:
        entry.update({"error": str(exc), "decision": "fail-open", "lanes": canonical(lane_set)})
        return set(lane_set), entry
    masses = {qid: round(1 - p, 4) for qid, p in probs.items()}
    for qid, false_mass in masses.items():
        if false_mass < JEV_SKIP_MASS:
            lanes.update(JEV_LANES[qid])
    if "blast-radius" in lanes:
        lanes.add("approval")
    lanes &= set(lane_set) | {"approval"}
    entry.update({"p_true": probs, "false_mass": masses, "usage": usage, "decision": "jev",
                  "lanes": canonical(lanes)})
    return lanes, entry


def classify(repo, cfg, state, base_ref, head, body):
    reviewed = state.get("reviewed")
    if not reviewed:
        raise GateError("no reviewed head in the state file; record round-1 verdicts first")
    lane_set = list(state.get("lane_set") or [])
    flags = {}
    signals = {"flags": flags, "from": reviewed["head"], "to": head}
    try:
        old = rev(repo, reviewed["head"])
        snap = pr_snapshot(repo, base_ref, head)
        old_keys = reviewed["keys"]
        new_keys = snap["keys"]
        touched = sorted(p for p in set(old_keys) | set(new_keys) if old_keys.get(p) != new_keys.get(p))
        base_moved = reviewed["merge_base"] != snap["merge_base"]
        upstream = set()
        if base_moved:
            upstream = {p for p in git(repo, "diff", "--name-only", reviewed["merge_base"],
                                       snap["merge_base"]).splitlines() if p}
        overlap = sorted(upstream & (set(old_keys) | set(new_keys)))
        same_content = not touched
        same_patch = same_content and snap["patch_id"] == reviewed["patch_id"]
        tests, docs, app, risk = classify_paths(cfg, touched)
        flagged = {lane: set(rec.get("flagged_paths") or []) for lane, rec in (state.get("lanes") or {}).items()}
        all_flagged = set().union(*flagged.values()) if flagged else set()
        app_added = added_app_lines(repo, old, head, app, cfg) if app else 0
        unflagged_app = unflagged_files(repo, old, head, app, all_flagged)
        is_rename, mapping = (False, {})
        if touched and not risk:
            is_rename, mapping = rename_only(repo, old, head, touched)
    except (GateError, KeyError) as exc:
        signals["error"] = str(exc)
        return "D0", canonical(set(lane_set) - {OPUS_LANE}), lane_set, signals, None, None

    fp = body_fingerprint(body)
    summary_changed = fp["summary_sha"] is not None and reviewed.get("summary_sha") not in (None, fp["summary_sha"])
    body_changed = fp["body_sha"] is not None and reviewed.get("body_sha") not in (None, fp["body_sha"])
    signals.update({
        "touched": touched, "patch_id_old": reviewed["patch_id"], "patch_id_new": snap["patch_id"],
        "base_moved": base_moved, "upstream_overlap": overlap, "tests": tests, "docs": docs, "app": app,
        "risk_paths": risk, "risk_kinds": risk_names(cfg, risk), "app_added_lines": app_added,
        "unflagged_app_files": unflagged_app, "rename_mapping": mapping, "summary_changed": summary_changed,
        "body_changed": body_changed,
    })
    flags.update({
        "D1": same_patch and not overlap,
        "D2": same_content and (bool(overlap) or not same_patch),
        "D7": bool(risk),
        "D8": app_added > D8_ADDED_LINES or len(unflagged_app) > D8_UNFLAGGED_FILES,
        "D3": bool(touched) and len(docs) == len(touched),
        "D4": is_rename,
        "D5": bool(touched) and len(tests) + len(docs) == len(touched),
        "D6": bool(set(touched) & all_flagged),
    })
    jev_entry = None
    if flags["D1"]:
        rule, lanes = "D1", set()
    elif flags["D2"]:
        rule, lanes = "D2", {"approval"}
    elif flags["D7"]:
        rule, lanes = "D7", set(LANES)
        lane_set = canonical(set(lane_set) | set(LANES))
    elif flags["D8"]:
        rule, lanes = "D8", set(lane_set)
    elif flags["D3"]:
        rule, lanes = "D3", set()
    elif flags["D4"]:
        rule, lanes = "D4", {"convention"}
    elif flags["D5"]:
        rule, lanes = "D5", {"convention", "necessity"}
    elif flags["D6"]:
        rule, lanes = "D6", set()
    else:
        rule = "J"
        questions = {qid: dict(q) for qid, q in JEV_QUESTIONS.items()}
        for qid, text in getattr(cfg, "JEV_INSTRUCTIONS", {}).items():
            questions[qid]["instructions"] = text
        lanes, jev_entry = jev_decide(repo, old, head, touched, state, signals, lane_set, questions)

    additions = {}
    content_changed = rule not in ("D1", "D2")
    if content_changed and app and rule != "D4":
        additions.setdefault("approval", []).append("A1 app code changed")
    for lane, paths in flagged.items():
        if lane in lane_set and paths & set(touched):
            additions.setdefault(lane, []).append("A2 flagged file touched")
    if summary_changed:
        additions.setdefault("convention", []).append("A3 PR Summary changed")
    if content_changed:
        for lane in lane_set:
            if lane in (state.get("lanes") or {}) and not verdict_passes(state["lanes"][lane]):
                additions.setdefault(lane, []).append("A4 last verdict failed")
    pending = state.get("pending") or {}
    for lane in pending.get("lanes") or []:
        if lane not in (pending.get("recorded") or []):
            additions.setdefault(lane, []).append("A5 never recorded at the previous head")
    additions = {k: v for k, v in additions.items() if k in lane_set}
    lanes = set(lanes) | set(additions)
    if not any(a.startswith("A5") for a in additions.get(OPUS_LANE, [])):
        lanes.discard(OPUS_LANE)
    signals["additions"] = additions
    signals["snapshot"] = snap
    signals["fingerprint"] = fp
    return rule, canonical(lanes), lane_set, signals, jev_entry, snap


def open_pending(state, head, snap, fp, lanes, rule):
    state["pending"] = {
        "head": head, "rule": rule, "lanes": lanes, "recorded": [], "spawned": [], "created": now(),
        "merge_base": snap["merge_base"], "patch_id": snap["patch_id"], "keys": snap["keys"],
        "body_sha": fp["body_sha"], "summary_sha": fp["summary_sha"], "round_counted": False,
    }
    if not lanes:
        close_pending(state)


def close_pending(state):
    pend = state["pending"]
    state["reviewed"] = {k: pend[k] for k in ("head", "merge_base", "patch_id", "keys", "body_sha", "summary_sha")}
    for lane in state.get("lane_set") or []:
        rec = (state.get("lanes") or {}).get(lane)
        if rec and lane not in pend["lanes"]:
            rec["carried_to"] = pend["head"]
    pend["closed"] = now()


def run_step0(cfg, args, head):
    results = cfg.step0(args.repo, args.base, head, args.pr, args.body_file, args.no_ci)
    for r in results:
        print(f"── step 0: {r['name']} → {'ok' if r['rc'] == 0 else 'FAIL'}", file=sys.stderr)
        if r["rc"] != 0:
            print(r["output"].rstrip(), file=sys.stderr)
    failed = [r["name"] for r in results if r["rc"] != 0]
    if failed:
        print(json.dumps({"step0": "FAIL", "failed": failed,
                          "action": "back to the author; no reviewer is spawned"}, indent=2))
    return not failed


def cmd_delta(args):
    cfg = load_config(args.config)
    path = state_path(args)
    head = rev(args.repo, args.head)
    body = read_body(args)
    if not args.no_step0 and not run_step0(cfg, args, head):
        return 2
    with locked_state(path) as box:
        state = box["state"]
        rule, lanes, lane_set, signals, jev_entry, snap = classify(args.repo, cfg, state, args.base, head, body)
        if rule == "D0":
            snap = pr_snapshot(args.repo, args.base, head)
            signals["fingerprint"] = body_fingerprint(body)
        fp = signals.pop("fingerprint")
        signals.pop("snapshot", None)
        state["lane_set"] = lane_set
        if signals.get("risk_paths"):
            state["risk_paths"] = sorted(set(state.get("risk_paths") or []) | set(signals["risk_paths"]))
        checks = list(cfg.STEP0_CHECKS)
        if rule in ("D4", "D7"):
            checks += list(cfg.BOUNDARY_CHECKS)
        decision = {"at": now(), "rule": rule, "why": RULE_TEXT[rule], "lanes": lanes, "checks": checks,
                    "scope": "whole PR (base...head) for every lane that runs", "signals": signals}
        if jev_entry:
            state.setdefault("jev_log", []).append(jev_entry)
            decision["jev"] = {k: jev_entry.get(k) for k in ("decision", "false_mass", "error")}
        state.setdefault("history", []).append({k: decision[k] for k in ("at", "rule", "lanes")} | {"head": head})
        open_pending(state, head, snap, fp, lanes, rule)
        box["dirty"] = True
    print(json.dumps(decision, indent=2))
    return 0


def cmd_lanes(args):
    cfg = load_config(args.config)
    path = state_path(args)
    head = rev(args.repo, args.head)
    body = read_body(args)
    if not args.no_step0 and not run_step0(cfg, args, head):
        return 2
    snap = pr_snapshot(args.repo, args.base, head)
    files = sorted(snap["keys"])
    tests, docs, app, risk = classify_paths(cfg, files)
    reach = cfg.reach_scan(args.repo, snap["merge_base"], head, files)
    reach["risk_paths"] = risk
    reach["risk_kinds"] = risk_names(cfg, risk)
    code = bool(app or tests) and not all(matches(cfg.NON_REVIEW_PATTERNS, p) for p in app + tests)
    lanes = ["approval"]
    reasons = {"approval": "always"}
    if code:
        lanes += ["convention", "necessity"]
        reasons["convention"] = reasons["necessity"] = "app or spec code touched"
    if reach["reach"] in ("cross-pack", "external") or risk or reach.get("shared_helpers"):
        lanes.append("blast-radius")
        reasons["blast-radius"] = "reach=%s risk=%s shared_helpers=%s" % (
            reach["reach"], reach["risk_kinds"], reach.get("shared_helpers") or [])
    if reach["reach"] == "external" or risk:
        lanes.append(OPUS_LANE)
        reasons[OPUS_LANE] = "round 1 second approval: reach=%s risk=%s" % (reach["reach"], reach["risk_kinds"])
    fp = body_fingerprint(body)
    with locked_state(path, create=True) as box:
        state = box["state"]
        if state and args.reset:
            resets = state.get("resets") or []
            resets.append({"at": now(), "by": args.by, "reason": args.reason, "head": head,
                           "previous": {k: v for k, v in state.items() if k != "resets"}})
            state.clear()
            state["resets"] = resets
        elif state.get("reviewed"):
            raise GateError("this PR already has a reviewed head; use pr-gate-delta.sh "
                            "(a restart needs --reset --by NAME --reason TEXT)")
        if not state.get("lane_set"):
            state.update({
                "pr": args.pr, "repo": os.path.abspath(args.repo), "base_ref": args.base, "created": now(),
                "budget": dict(DEFAULT_BUDGET), "grants": [], "rounds": 0, "spawns": 0, "round_patch_id": None,
                "lane_set": [], "lane_reasons": {}, "lanes": {}, "history": [], "jev_log": [],
                "escalations": [], "spawn_log": [],
            })
        pend = state.get("pending")
        selected = canonical(set(state["lane_set"]) | set(lanes))
        state["lane_set"] = selected
        state["lane_reasons"] = {**reasons, **state.get("lane_reasons", {})}
        state["reach"] = reach
        state["risk_paths"] = sorted(set(state.get("risk_paths") or []) | set(risk))
        if pend and not pend.get("closed") and pend["head"] == head:
            before = list(pend["lanes"])
            pend["lanes"] = canonical(set(before) | set(lanes))
            action = "unchanged" if pend["lanes"] == before else "merged"
        else:
            action = "opened"
            state["history"].append({"at": now(), "rule": "lanes", "lanes": selected, "head": head})
            open_pending(state, head, snap, fp, selected, "lanes")
        box["dirty"] = True
        counters = {"rounds": state["rounds"], "spawns": state["spawns"]}
    print(json.dumps({"step0": "skipped" if args.no_step0 else "ok", "lanes": selected,
                      "reasons": reasons, "reach": reach, "selection": action, "counters": counters,
                      "scope": "whole PR (base...head)", "state": path}, indent=2))
    return 0


def lane_model(lane):
    return OPUS_MODEL if lane == OPUS_LANE else PRIMARY_MODEL


def unresolved_blockers(state):
    out = {}
    for lane, rec in (state.get("lanes") or {}).items():
        if not verdict_passes(rec):
            out[lane] = rec.get("blockers") or [f"verdict {rec.get('verdict')} with no file:line recorded"]
    return out


def escalate(state, reason):
    entry = {"at": now(), "reason": reason, "rounds": state.get("rounds"), "spawns": state.get("spawns"),
             "unresolved_blockers": unresolved_blockers(state), "resolved": None}
    log = state.setdefault("escalations", [])
    entry["id"] = f"E{len(log) + 1}"
    log.append(entry)
    return entry


def escalation_id(entry, index):
    return entry.get("id") or f"E{index + 1}"


def open_escalations(state):
    return [escalation_id(e, i) for i, e in enumerate(state.get("escalations") or []) if not e.get("resolved")]


def resolve_escalations(state, ids, by, reason, via):
    done = []
    for i, entry in enumerate(state.get("escalations") or []):
        if escalation_id(entry, i) in ids and not entry.get("resolved"):
            entry["id"] = escalation_id(entry, i)
            entry["resolved"] = {"at": now(), "by": by, "reason": reason, "via": via}
            done.append(entry["id"])
    return done


def limits(state):
    budget = state.get("budget") or DEFAULT_BUDGET
    extra_r = sum(g.get("rounds", 0) for g in state.get("grants") or [])
    extra_s = sum(g.get("spawns", 0) for g in state.get("grants") or [])
    return budget["rounds"] + extra_r, budget["spawns"] + extra_s


def spawn_check(args, state):
    pend = state.get("pending")
    lane = args.lane
    if not pend or pend.get("closed"):
        return 4, {"refused": "no open pending decision; run pr-gate-delta.sh for the current head"}
    if args.head and not pend["head"].startswith(args.head) and not args.head.startswith(pend["head"]):
        return 4, {"refused": f"pending decision is for {pend['head'][:12]}, not {args.head}; run pr-gate-delta.sh"}
    if lane not in pend["lanes"]:
        return 4, {"refused": f"lane {lane} is not selected at this head", "selected": pend["lanes"]}
    if lane in pend["spawned"] and not args.retry:
        return 4, {"refused": f"lane {lane} was already spawned at this head (pass --retry for a crashed worker)"}
    max_rounds, max_spawns = limits(state)
    new_round = not pend.get("round_counted") and pend["patch_id"] != state.get("round_patch_id")
    rounds_after = state["rounds"] + (1 if new_round else 0)
    if rounds_after > max_rounds:
        return 3, {"refused": "round budget spent", "escalation": escalate(state, f"round budget {max_rounds} spent")}
    if state["spawns"] + 1 > max_spawns:
        return 3, {"refused": "spawn budget spent", "escalation": escalate(state, f"spawn budget {max_spawns} spent")}
    if new_round:
        state["rounds"] = rounds_after
        state["round_patch_id"] = pend["patch_id"]
    pend["round_counted"] = True
    state["spawns"] += 1
    if lane not in pend["spawned"]:
        pend["spawned"].append(lane)
    log = state.setdefault("spawn_log", [])
    spawn_id = f"S{len(log) + 1}-{lane}"
    log.append({"at": now(), "id": spawn_id, "lane": lane, "head": pend["head"], "model": lane_model(lane),
                "round": state["rounds"], "retry": bool(args.retry), "consumed": None})
    return 0, {"go": lane, "spawn_id": spawn_id, "model": lane_model(lane), "head": pend["head"],
               "round": state["rounds"],
               "spawns": f"{state['spawns']}/{max_spawns}", "rounds": f"{state['rounds']}/{max_rounds}",
               "scope": "whole PR (base...head)"}


def find_ticket(state, spawn_id):
    return next((s for s in state.get("spawn_log") or [] if s.get("id") == spawn_id), None)


def verify_reservation(state, spawn_id, agent=None, team=None):
    ticket = find_ticket(state, spawn_id)
    if not ticket:
        return None, f"spawn id {spawn_id} was never issued by pr-gate-spawn.sh check"
    pend = state.get("pending") or {}
    if not pend or pend.get("closed") or ticket["head"] != pend.get("head"):
        return None, (f"spawn id {spawn_id} is for head {ticket['head'][:12]}, but the PR's recorded head is "
                      f"{(pend.get('head') or '?')[:12]}{' (closed)' if pend.get('closed') else ''}; "
                      "run pr-gate-delta.sh and check again")
    if ticket["lane"] not in (pend.get("lanes") or []):
        return None, f"lane {ticket['lane']} is no longer selected at this head"
    if ticket.get("consumed"):
        return None, f"spawn id {spawn_id} already recorded a verdict"
    bound = ticket.get("bound")
    if bound and (bound.get("agent") != agent or bound.get("team") != team):
        return None, f"spawn id {spawn_id} is already bound to agent {bound.get('agent')} (team {bound.get('team')})"
    return ticket, None


def spawn_verify(args, state):
    ticket, why = verify_reservation(state, args.spawn_id, args.agent, args.team)
    if not ticket:
        return 4, {"refused": why}
    return 0, {"ok": args.spawn_id, "lane": ticket["lane"], "head": ticket["head"], "model": ticket.get("model"),
               "bound": ticket.get("bound")}


def spawn_bind(args, state):
    ticket, why = verify_reservation(state, args.spawn_id, args.agent, args.team)
    if not ticket:
        return 4, {"refused": why}
    rebind = bool(ticket.get("bound"))
    if not rebind:
        ticket["bound"] = {"agent": args.agent, "team": args.team, "at": now()}
    state["spawn_path"] = "orchestrator"
    return 0, {"bound": args.spawn_id, "agent": args.agent, "team": args.team, "lane": ticket["lane"],
               "head": ticket["head"], "model": ticket.get("model"), "rebind": rebind}


def spawn_record(args, state):
    pend = state.get("pending")
    lane = args.lane
    if not pend or pend.get("closed") or len(args.head) < 7 or not pend["head"].startswith(args.head):
        return 4, {"refused": "verdict head does not match the open pending decision"}
    if lane not in pend["lanes"]:
        return 4, {"refused": f"lane {lane} was not selected at this head"}
    ticket = find_ticket(state, args.spawn_id)
    if not ticket or ticket["lane"] != lane or ticket["head"] != pend["head"]:
        return 4, {"refused": f"spawn id {args.spawn_id} was not issued by check for lane {lane} at this head"}
    if ticket.get("consumed"):
        return 4, {"refused": f"spawn id {args.spawn_id} already recorded a verdict"}
    if state.get("spawn_path") == "orchestrator" and not ticket.get("bound"):
        return 4, {"refused": f"spawn id {args.spawn_id} was never bound to an agent; this gate spawns reviewers "
                              "through team_spawn with gate: {state, spawnId}"}
    verdict = re.sub(r"[\s-]+", "_", args.verdict.strip().upper())
    if verdict not in PASSING_VERDICTS | FAILING_VERDICTS:
        return 4, {"refused": f"unknown verdict {args.verdict}"}
    flagged = sorted({re.sub(r":\d+(-\d+)?$", "", p.strip()) for item in args.flagged or [] for p in item.split(",")
                      if p.strip()})
    rec = {"head": pend["head"], "patch_id": pend["patch_id"], "verdict": verdict, "flagged_paths": flagged,
           "blockers": args.blocker or [], "reviewer": args.reviewer, "model": args.model,
           "model_issued": ticket.get("model"), "spawn_id": args.spawn_id, "at": now(), "round": state.get("rounds"),
           "agent": (ticket.get("bound") or {}).get("agent")}
    ticket["consumed"] = rec["at"]
    if args.safety_fact:
        rec["safety_fact"] = args.safety_fact
    state.setdefault("lanes", {})[lane] = rec
    if lane not in pend["recorded"]:
        pend["recorded"].append(lane)
    notes = []
    lanes = state["lanes"]
    if lane == "blast-radius" and args.safety_fact == "unproven" and state.get("risk_paths"):
        notes.append(escalate(state, "blast-radius safety fact unproven on a risk path"))
    gpt, opus = lanes.get("approval"), lanes.get(OPUS_LANE)
    if lane in ("approval", OPUS_LANE) and gpt and opus and gpt["head"] == opus["head"] == pend["head"] \
            and verdict_passes(gpt) != verdict_passes(opus):
        notes.append(escalate(state, "GPT and Opus approval reviewers disagree on a blocker"))
    br = lanes.get("blast-radius")
    if state.get("rounds") == 1 and gpt and br and gpt["head"] == br["head"] == pend["head"] \
            and verdict_passes(gpt) != verdict_passes(br) and OPUS_LANE not in state["lane_set"]:
        state["lane_set"] = canonical(state["lane_set"] + [OPUS_LANE])
        pend["lanes"] = canonical(pend["lanes"] + [OPUS_LANE])
        notes.append({"added": OPUS_LANE, "reason": "round 1: GPT approval and blast-radius disagree"})
    if all(l in pend["recorded"] for l in pend["lanes"]):
        close_pending(state)
    out = {"recorded": lane, "verdict": verdict, "passes": verdict_passes(rec), "head": pend["head"]}
    if notes:
        out["notes"] = notes
    escalations = [n for n in notes if "reason" in n and "unresolved_blockers" in n]
    return (5 if escalations else 0), out


def gate_status(state, head=None):
    reviewed = state.get("reviewed") or {}
    current = head or (state.get("pending") or {}).get("head") or reviewed.get("head")
    rows, ok = {}, True
    pend = state.get("pending") or {}
    if pend and not pend.get("closed"):
        ok = False
    for lane in state.get("lane_set") or []:
        rec = (state.get("lanes") or {}).get(lane)
        at = rec and (rec["head"] == current or rec.get("carried_to") == current)
        passes = verdict_passes(rec)
        rows[lane] = {"verdict": rec and rec["verdict"], "at_current_head": bool(at), "passes": passes,
                      "model": rec and rec.get("model"), "reviewer": rec and rec.get("reviewer")}
        ok = ok and bool(at) and passes
    unresolved = open_escalations(state)
    ok = ok and not unresolved
    max_rounds, max_spawns = limits(state)
    return {"head": current, "gate": "PASS" if ok else "OPEN", "lanes": rows,
            "rounds": f"{state.get('rounds')}/{max_rounds}", "spawns": f"{state.get('spawns')}/{max_spawns}",
            "escalations": len(state.get("escalations") or []), "unresolved_escalations": unresolved}


def cmd_spawn(args):
    path = state_path(args)
    with locked_state(path) as box:
        state = box["state"]
        if args.action == "check":
            code, out = spawn_check(args, state)
            box["dirty"] = True
        elif args.action == "record":
            code, out = spawn_record(args, state)
            box["dirty"] = code in (0, 5)
        elif args.action == "verify":
            code, out = spawn_verify(args, state)
        elif args.action == "bind":
            code, out = spawn_bind(args, state)
            box["dirty"] = code == 0
        elif args.action == "grant":
            state.setdefault("grants", []).append({"at": now(), "spawns": args.spawns, "rounds": args.rounds,
                                                   "by": args.by, "reason": args.reason})
            budget_ids = [escalation_id(e, i) for i, e in enumerate(state.get("escalations") or [])
                          if re.match(r"(round|spawn) budget ", e.get("reason", ""))]
            resolved = resolve_escalations(state, budget_ids, args.by, args.reason, "grant")
            box["dirty"] = True
            code, out = 0, {"granted": {"spawns": args.spawns, "rounds": args.rounds}, "limits": limits(state),
                            "resolved": resolved}
        elif args.action == "resolve":
            resolved = resolve_escalations(state, {args.escalation}, args.by, args.reason, "resolve")
            if resolved:
                box["dirty"] = True
                code, out = 0, {"resolved": resolved, "by": args.by, "open": open_escalations(state)}
            else:
                code, out = 4, {"refused": f"no open escalation {args.escalation}", "open": open_escalations(state)}
        else:
            code, out = 0, gate_status(state, args.head)
    print(json.dumps(out, indent=2))
    return code


def common(p, config=True):
    if config:
        p.add_argument("--config", required=True)
        p.add_argument("--repo", default=".")
        p.add_argument("--base", required=True)
        p.add_argument("--head", default="HEAD")
        p.add_argument("--body-file")
        p.add_argument("--no-gh", action="store_true")
    p.add_argument("--state")
    p.add_argument("--dir")
    p.add_argument("--pr")


def main(argv):
    parser = argparse.ArgumentParser(prog="pr_gate_core.py")
    sub = parser.add_subparsers(dest="cmd", required=True)
    lanes = sub.add_parser("lanes")
    common(lanes)
    lanes.add_argument("--reset", action="store_true")
    lanes.add_argument("--by")
    lanes.add_argument("--reason")
    delta = sub.add_parser("delta")
    common(delta)
    for p in (lanes, delta):
        p.add_argument("--no-step0", action="store_true")
        p.add_argument("--no-ci", action="store_true")
    spawn = sub.add_parser("spawn")
    spawn.add_argument("action", choices=["check", "record", "verify", "bind", "grant", "resolve", "status"])
    common(spawn, config=False)
    spawn.add_argument("--lane", choices=ALL_LANES)
    spawn.add_argument("--head")
    spawn.add_argument("--retry", action="store_true")
    spawn.add_argument("--verdict")
    spawn.add_argument("--flagged", action="append")
    spawn.add_argument("--blocker", action="append")
    spawn.add_argument("--reviewer")
    spawn.add_argument("--model")
    spawn.add_argument("--safety-fact", choices=["proven", "unproven"])
    spawn.add_argument("--spawns", type=int, default=0)
    spawn.add_argument("--rounds", type=int, default=0)
    spawn.add_argument("--spawn-id")
    spawn.add_argument("--escalation")
    spawn.add_argument("--agent")
    spawn.add_argument("--team")
    spawn.add_argument("--by")
    spawn.add_argument("--reason")
    args = parser.parse_args(argv)
    if args.cmd == "spawn" and args.action in ("check", "record") and not args.lane:
        parser.error("--lane is required")
    if args.cmd == "spawn" and args.action == "record" and not args.verdict:
        parser.error("--verdict is required")
    if args.cmd == "spawn" and args.action in ("grant", "resolve") and not (args.by and args.reason):
        parser.error(f"{args.action} needs --by and --reason")
    if args.cmd == "lanes" and args.reset and not (args.by and args.reason):
        parser.error("--reset needs --by and --reason")
    if args.cmd == "spawn" and args.action == "record" and not (args.head and args.spawn_id and args.reviewer
                                                                 and args.model):
        parser.error("record needs --head, --spawn-id (from check), --reviewer and --model")
    if args.cmd == "spawn" and args.action in ("verify", "bind") and not args.spawn_id:
        parser.error(f"{args.action} needs --spawn-id")
    if args.cmd == "spawn" and args.action == "bind" and not args.agent:
        parser.error("bind needs --agent NAME")
    if args.cmd == "spawn" and args.action == "resolve" and not args.escalation:
        parser.error("resolve needs --escalation ID")
    try:
        return {"lanes": cmd_lanes, "delta": cmd_delta, "spawn": cmd_spawn}[args.cmd](args)
    except GateError as exc:
        print(f"pr-gate: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
