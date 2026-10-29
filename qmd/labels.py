"""Validity labels on notes: front matter, inline claim comments, HTML meta tags and data attributes.

The format is defined in ~/.pi/agent/skills/recall/references/validity.md.
"""
import os
import re

STATES = ("confirmed", "acted", "proposed", "transcript", "superseded")
RANK = {state: i for i, state in enumerate(STATES)}
KEYS = ("state", "evidence", "as_of", "superseded_by", "published")
HEAD_BYTES = 65536
PAGES = "pages"

CLAIM = re.compile(r"<!--\s*claim\s+(.*?)-->", re.S)
CLAIM_PAIR = re.compile(r"([a-z_-]+)=(\"[^\"]*\"|'[^']*'|\S+)")
META = re.compile(r"<meta\b[^>]*>", re.I)
ATTR = re.compile(r"([a-z:_-]+)\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)", re.I)
DATA_STATE = re.compile(r"\bdata-state\s*=\s*[\"']?([a-z]+)", re.I)
START_TAG = re.compile(r"<([a-z][\w-]*)\b((?:\"[^\"]*\"|'[^']*'|[^'\">])*)>", re.I)
HEAD_END = re.compile(r"</head\s*>|<body\b", re.I)
ITEM_TAGS = ("li", "tr", "td")
TICK_CHARS = re.compile("[\u2713\u2714\u2611\u2705]")
TICK_CLASS = re.compile(r"\b(done|checked|complete|completed|tick|ticked)\b", re.I)
MD_TICK = re.compile(r"^\s*(?:[-*+]|\d+\.)\s+\[[xX]\]")
TERM = re.compile(r"[a-z0-9]{3,}")


def unquote(value):
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def clean_evidence(value):
    if isinstance(value, str):
        value = [value]
    out = []
    for item in value or []:
        item = unquote(str(item)).strip()
        if item:
            out.append(item)
    return out


def split_list(value):
    value = value.strip()
    if value.startswith("[") and value.endswith("]"):
        return clean_evidence(value[1:-1].split(","))
    return clean_evidence(value)


def front_matter(text):
    text = (text or "").lstrip("\ufeff")
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
            out[key].extend(clean_evidence(item.group(1)))
    return {}


def comment_labels(body):
    out = {}
    for key, value in CLAIM_PAIR.findall(body):
        key = key.lower().replace("-", "_")
        value = unquote(value)
        out[key] = clean_evidence(value.split(",")) if key == "evidence" else value
    return out


def claim_tag(line):
    match = CLAIM.search(line)
    return comment_labels(match.group(1)) if match else None


def tag_attrs(body):
    return {k.lower(): unquote(v) for k, v in ATTR.findall(body)}


def data_labels(attrs):
    out = {"state": attrs.get("data-state", "")}
    if attrs.get("data-evidence"):
        out["evidence"] = clean_evidence(attrs["data-evidence"].split(","))
    for key in ("as_of", "superseded_by"):
        if attrs.get("data-" + key.replace("_", "-")):
            out[key] = attrs["data-" + key.replace("_", "-")]
    return out


def plain(text):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", CLAIM.sub(" ", text))).strip(" -*\t")


def is_claim_element(name, body, attrs):
    if "data-state" in attrs:
        return True
    if name.lower() in ITEM_TAGS:
        return True
    if name.lower() == "input" and attrs.get("type", "").lower() == "checkbox":
        return True
    return bool(TICK_CLASS.search(attrs.get("class", "")) or re.search(r"\bchecked\b", body, re.I))


def html_elements(line):
    out, close_at = [], -1
    for match in START_TAG.finditer(line):
        if match.start() < close_at:
            continue
        name, body = match.group(1), match.group(2)
        attrs = tag_attrs(body)
        if not is_claim_element(name, body, attrs):
            continue
        close = re.compile(r"</" + re.escape(name) + r"\s*>", re.I).search(line, match.end())
        close_at = close.end() if close else len(line)
        labelled = "data-state" in attrs
        out.append({"labels": data_labels(attrs) if labelled else None, "start": match.start(), "end": close_at,
                    "text": plain(line[match.end():close.start() if close else len(line)])})
    return out


def comment_elements(line):
    out, prev = [], 0
    for match in CLAIM.finditer(line):
        out.append({"labels": comment_labels(match.group(1)), "start": match.start(), "text": plain(line[prev:match.start()])})
        prev = match.end()
    return out


def line_elements(line, html):
    elements = comment_elements(line)
    if html:
        tags = html_elements(line)
        for tag in tags:
            inner = [c for c in elements if tag["start"] <= c["start"] < tag["end"]]
            if tag["labels"] is None and inner:
                tag["labels"] = inner[0]["labels"]
        elements = tags + [c for c in elements if not any(t["start"] <= c["start"] < t["end"] for t in tags)]
        if not elements and TICK_CHARS.search(plain(line)):
            elements = [{"labels": None, "start": 0, "text": plain(line)}]
    elif not elements and (MD_TICK.match(line) or TICK_CHARS.search(line)):
        elements = [{"labels": None, "start": 0, "text": plain(line)}]
    return sorted(elements, key=lambda e: e["start"])


def label_key(labels):
    if labels is None:
        return ("proposed", ())
    return ((labels.get("state") or "").strip().lower(), tuple(clean_evidence(labels.get("evidence"))),
            labels.get("as_of", ""), labels.get("superseded_by", ""))


def pick_element(elements, terms):
    wanted = set(TERM.findall(" ".join(terms or []).lower()))
    if wanted and len(elements) > 1:
        scores = [len(wanted & set(TERM.findall(e["text"].lower()))) for e in elements]
        best = max(scores)
        if best:
            elements = [e for e, score in zip(elements, scores) if score == best]
    if len({label_key(e["labels"]) for e in elements}) == 1:
        return elements[0], ""
    return None, f"{len(elements)} claims with different labels on the hit line, read as proposed"


def html_head(text):
    end = HEAD_END.search(text)
    return text[:end.start()] if end else ""


def html_labels(text):
    out = {}
    for tag in META.findall(html_head(text)):
        attrs = tag_attrs(tag)
        name = (attrs.get("name") or attrs.get("property") or "").lower()
        if not name.startswith("show-me:") or "content" not in attrs:
            continue
        key = name[len("show-me:"):].replace("-", "_")
        if key == "evidence":
            out.setdefault("evidence", []).extend(clean_evidence(attrs["content"]))
        elif key in KEYS:
            out[key] = attrs["content"]
    return out


def is_html(path, text):
    return path.lower().endswith((".html", ".htm")) or text.lstrip("\ufeff \t\r\n")[:15].lower().startswith(("<!doctype html", "<html"))


def under(path, root):
    path, root = os.path.realpath(path), os.path.realpath(root)
    return path == root or path.startswith(root.rstrip("/") + "/")


def is_page(path, memory_dir):
    return bool(memory_dir) and under(path, os.path.join(memory_dir, PAGES))


def default_state(path, memory_dir):
    if is_page(path, memory_dir):
        return "proposed"
    return "transcript" if memory_dir and under(path, memory_dir) else "proposed"


def read_head(path):
    try:
        with open(path, encoding="utf-8-sig", errors="replace") as fh:
            return fh.read(HEAD_BYTES)
    except OSError:
        return None


def read_line(path, number):
    try:
        with open(path, encoding="utf-8-sig", errors="replace") as fh:
            for i, text in enumerate(fh, 1):
                if i == number:
                    return text.rstrip("\n")
    except OSError:
        pass
    return None


def normalise(labels, fallback):
    state = (labels.get("state") or "").strip().lower()
    note = ""
    if state and state not in STATES:
        note = f"unknown state '{state}', read as proposed"
        state = "proposed"
    state = state or fallback
    evidence = clean_evidence(labels.get("evidence"))
    effective = state
    if state == "confirmed" and not evidence:
        effective = "proposed"
        note = "labelled confirmed with no evidence, ranked as proposed"
    return {"state": state, "effective": effective, "evidence": evidence, "as_of": labels.get("as_of", ""),
            "superseded_by": labels.get("superseded_by", ""), "note": note}


def file_labels(path, memory_dir=None, line=None, terms=None):
    text = read_head(path)
    fallback = default_state(path, memory_dir)
    if text is None:
        result = normalise({}, fallback)
        result.update(source="unreadable", claims={})
        return result
    html = is_html(path, text)
    claims = {}
    if html:
        labels, source = html_labels(text), "html meta"
        for state in DATA_STATE.findall(text):
            claims[state.lower()] = claims.get(state.lower(), 0) + 1
    else:
        labels, source = front_matter(text), "front matter"
        for match in CLAIM.finditer(text):
            state = (comment_labels(match.group(1)).get("state") or "").lower()
            if state:
                claims[state] = claims.get(state, 0) + 1
    explicit = bool(labels.get("state"))
    if not explicit:
        source = "unlabelled"
    result = normalise(labels, "proposed" if fallback == "transcript" else fallback)
    hit_line = read_line(path, line) if line else None
    elements = line_elements(hit_line, html) if hit_line is not None else []
    if elements:
        element, why = pick_element(elements, terms)
        explicit = bool(element and element["labels"] and element["labels"].get("state"))
        if element is None:
            result, source = normalise({"state": "proposed"}, "proposed"), "line label"
            result["note"] = why
        elif element["labels"] is None:
            result, source = normalise({"state": "proposed"}, "proposed"), "unlabelled item"
            result["note"] = "a tick or item with no label of its own is proposed"
        else:
            result, source = normalise(element["labels"], "proposed"), "line label"
    if fallback == "transcript":
        quoted = {k: result[k] for k in ("state", "evidence", "as_of", "superseded_by")} if explicit else None
        result, source = normalise({}, "transcript"), "path default"
        if quoted:
            result["asserted"] = quoted
            result["note"] = f"quotes a '{quoted['state']}' label ({'line' if elements else 'file'}); a transcript is never a fact, so it is not applied"
    result.update(source=source, claims=claims)
    if is_page(path, memory_dir) and not html:
        result["page_source"] = front_matter(text).get("source", "")
    return result
