"""Validity labels on notes: front matter, inline claim comments, HTML meta tags and data attributes.

The format is defined in ~/.pi/agent/skills/recall/references/validity.md.
"""
import os
import re

STATES = ("confirmed", "acted", "proposed", "transcript", "superseded")
RANK = {state: i for i, state in enumerate(STATES)}
KEYS = ("state", "evidence", "as_of", "superseded_by", "published")
HEAD_BYTES = 65536

CLAIM = re.compile(r"<!--\s*claim\s+(.*?)-->", re.S)
CLAIM_PAIR = re.compile(r"([a-z_-]+)=(\"[^\"]*\"|'[^']*'|\S+)")
META = re.compile(r"<meta\b[^>]*>", re.I)
ATTR = re.compile(r"([a-z:_-]+)\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)", re.I)
DATA_STATE = re.compile(r"\bdata-state\s*=\s*[\"']?([a-z]+)", re.I)


def unquote(value):
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def split_list(value):
    value = value.strip()
    if value.startswith("[") and value.endswith("]"):
        return [unquote(v) for v in value[1:-1].split(",") if v.strip()]
    return [unquote(value)] if value else []


def front_matter(text):
    if not text.startswith("---"):
        return {}
    lines = text.split("\n")
    if lines[0].strip() != "---":
        return {}
    out, key = {}, None
    for line in lines[1:]:
        if line.strip() in ("---", "..."):
            return out
        top = re.match(r"^([A-Za-z_][\w-]*)\s*:\s*(.*)$", line)
        if top:
            key, value = top.group(1).lower().replace("-", "_"), top.group(2).strip()
            if key in ("evidence", "published"):
                out[key] = split_list(value) if value else []
            elif value:
                out[key] = unquote(value)
            else:
                out[key] = ""
            continue
        item = re.match(r"^\s+-\s+(.*)$", line)
        if item and key and isinstance(out.get(key), list):
            out[key].append(unquote(item.group(1)))
    return {}


def claim_tag(line):
    match = CLAIM.search(line)
    if not match:
        return None
    out = {}
    for key, value in CLAIM_PAIR.findall(match.group(1)):
        key = key.lower().replace("-", "_")
        value = unquote(value)
        out[key] = [v for v in value.split(",") if v] if key == "evidence" else value
    return out


def data_tag(line):
    if not DATA_STATE.search(line):
        return None
    attrs = {k.lower(): unquote(v) for k, v in ATTR.findall(line)}
    out = {"state": attrs.get("data-state", "")}
    if attrs.get("data-evidence"):
        out["evidence"] = [v for v in attrs["data-evidence"].split(",") if v]
    for key in ("as_of", "superseded_by"):
        if attrs.get("data-" + key.replace("_", "-")):
            out[key] = attrs["data-" + key.replace("_", "-")]
    return out


def html_labels(text):
    out = {}
    for tag in META.findall(text):
        attrs = {k.lower(): unquote(v) for k, v in ATTR.findall(tag)}
        name = (attrs.get("name") or attrs.get("property") or "").lower()
        if not name.startswith("show-me:") or "content" not in attrs:
            continue
        key = name[len("show-me:"):].replace("-", "_")
        if key == "evidence":
            out.setdefault("evidence", []).append(attrs["content"])
        elif key in KEYS:
            out[key] = attrs["content"]
    return out


def is_html(path, text):
    return path.lower().endswith((".html", ".htm")) or text.lstrip()[:15].lower().startswith(("<!doctype html", "<html"))


def under(path, root):
    path, root = os.path.realpath(path), os.path.realpath(root)
    return path == root or path.startswith(root.rstrip("/") + "/")


def default_state(path, memory_dir):
    return "transcript" if memory_dir and under(path, memory_dir) else "proposed"


def read_head(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return fh.read(HEAD_BYTES)
    except OSError:
        return None


def read_lines(path, start, count):
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            lines = fh.read().split("\n")
    except OSError:
        return []
    return lines[max(0, start - 1):max(0, start - 1) + count]


def normalise(labels, fallback):
    state = (labels.get("state") or "").strip().lower()
    note = ""
    if state and state not in STATES:
        note = f"unknown state '{state}', read as proposed"
        state = "proposed"
    state = state or fallback
    evidence = labels.get("evidence") or []
    if isinstance(evidence, str):
        evidence = [evidence]
    effective = state
    if state == "confirmed" and not evidence:
        effective = "proposed"
        note = "labelled confirmed with no evidence, ranked as proposed"
    return {"state": state, "effective": effective, "evidence": evidence, "as_of": labels.get("as_of", ""),
            "superseded_by": labels.get("superseded_by", ""), "note": note}


def file_labels(path, memory_dir=None, line=None, span=3):
    text = read_head(path)
    fallback = default_state(path, memory_dir)
    if text is None:
        result = normalise({}, fallback)
        result.update(source="unreadable", claims={})
        return result
    html = is_html(path, text)
    if html:
        labels, source = html_labels(text), "html meta"
        claims = {}
        for state in DATA_STATE.findall(text):
            claims[state.lower()] = claims.get(state.lower(), 0) + 1
    else:
        labels, source = front_matter(text), "front matter"
        claims = {}
        for tag in (claim_tag(l) for l in text.split("\n")):
            if tag and tag.get("state"):
                claims[tag["state"].lower()] = claims.get(tag["state"].lower(), 0) + 1
    if not labels.get("state"):
        source = "path default" if fallback == "transcript" else "unlabelled"
    result = normalise(labels, fallback)
    if line:
        for text_line in read_lines(path, line, span):
            tag = claim_tag(text_line) or (data_tag(text_line) if html else None)
            if tag and tag.get("state"):
                result = normalise(tag, fallback)
                source = "line label"
                break
    result.update(source=source, claims=claims)
    return result
