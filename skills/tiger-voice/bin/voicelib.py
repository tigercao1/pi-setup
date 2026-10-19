"""Shared paths, scope filters, provenance and inbox writes for the tiger-voice harvesters."""
import datetime as dt
import difflib
import glob
import hashlib
import json
import os
import re

DATA = os.path.expanduser("~/Documents/knowledge-base-remote/Pi/voice")
INBOX = os.path.join(DATA, "inbox")
ARCHIVE = os.path.join(DATA, "archive")
STATE = os.path.join(DATA, "state.json")
STATS = os.path.join(DATA, "stats.jsonl")
SESSIONS = os.path.expanduser("~/.pi/agent/sessions")
WINDOW_DAYS = 14
EXPIRE_DAYS = 60

DEFAULT_STATE = {
    "cursors": {},
    "last_aligned": None,
    "reminded_on": None,
    "slack_user_id": None,
    "github_login": "tigercao1",
    "slack_bot_ids": [],
}

MIN_WORDS = {"github": 4, "slack": 6, "linear": 4, "pi": 3}


def now():
    return dt.datetime.now(dt.timezone.utc)


def parse_ts(value):
    return dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def load_state():
    os.makedirs(INBOX, exist_ok=True)
    os.makedirs(ARCHIVE, exist_ok=True)
    state = dict(DEFAULT_STATE)
    if os.path.exists(STATE):
        state.update(json.load(open(STATE)))
    return state


def save_state(state):
    tmp = STATE + ".tmp"
    json.dump(state, open(tmp, "w"), indent=2)
    os.replace(tmp, STATE)


def cursor(state, source, default_days=30):
    value = state["cursors"].get(source)
    return parse_ts(value) if value else now() - dt.timedelta(days=default_days)


def norm(text):
    return " ".join(text.split()).lower()


def out_of_scope(item, state):
    text = item["text"].strip()
    stripped = re.sub(r"```.*?```", "", text, flags=re.S)
    stripped = re.sub(r"<?https?://\S+>?", "", stripped)
    stripped = re.sub(r":[a-z0-9_+-]+:", "", stripped)
    words = re.findall(r"[A-Za-z][A-Za-z'’-]*", stripped)
    if len(words) < MIN_WORDS.get(item["source"], 4):
        return "too short or only code/links/emoji"
    if re.match(r"^@(claude|codex|copilot)\b", text, re.I):
        return "bot trigger"
    lead = re.match(r"^<@(U[A-Z0-9]+)(\|[^>]*)?>", text)
    if lead and lead.group(1) in state["slack_bot_ids"]:
        return "instruction to a bot"
    return None


def label_for(score, n_words):
    if score >= 0.95:
        return "agent-verbatim"
    if n_words < 8:
        return "own"
    if score >= 0.55:
        return "agent-edited"
    if score >= 0.45:
        return "uncertain"
    return "own"


class DraftIndex:
    """Agent-authored text (assistant prose and tool-call arguments) from pi sessions in a time window."""

    def __init__(self, start, end):
        self.entries = []
        for path in glob.glob(os.path.join(SESSIONS, "*", "*.jsonl")):
            try:
                if dt.datetime.fromtimestamp(os.path.getmtime(path), dt.timezone.utc) < start:
                    continue
                for line in open(path, errors="ignore"):
                    if '"assistant"' not in line:
                        continue
                    entry = json.loads(line)
                    message = entry.get("message") or {}
                    if message.get("role") != "assistant":
                        continue
                    ts = parse_ts(entry["timestamp"])
                    if ts < start or ts > end:
                        continue
                    parts = []
                    for chunk in message.get("content", []):
                        if not isinstance(chunk, dict):
                            continue
                        if chunk.get("type") == "text":
                            parts.append(chunk.get("text", ""))
                        elif chunk.get("type") == "toolCall":
                            parts.append(json.dumps(chunk.get("arguments", "")).replace("\\n", " ").replace('\\"', '"'))
                    text = norm(" ".join(parts))
                    if text:
                        self.entries.append((ts, path, text))
            except Exception:
                continue

    def match(self, posted, posted_at):
        p = norm(posted)
        words = p.split()
        anchors = [" ".join(words[i:i + 3]) for i in range(max(1, len(words) - 2))]
        anchors = anchors[::max(1, len(anchors) // 8)]
        best = (0.0, None, "")
        for ts, path, text in self.entries:
            if ts > posted_at or ts < posted_at - dt.timedelta(days=WINDOW_DAYS):
                continue
            for anchor in anchors:
                pos = text.find(anchor)
                if pos < 0:
                    continue
                tokens = text.split()
                at = text[:pos].count(" ")
                start = max(0, at - words.index(anchor.split()[0]))
                window = tokens[start:start + len(words) + 3]
                ratio = difflib.SequenceMatcher(None, words, window, autojunk=False).ratio()
                if ratio > best[0]:
                    best = (ratio, path, " ".join(window))
        score, path, window = best
        label = label_for(score, len(words))
        return {"label": label, "score": round(score, 2), "session": path, "draft": window[:600]}


def item_id(item):
    raw = f'{item["source"]}:{item.get("ref") or item["url"]}:{item["created_at"]}'
    return hashlib.sha1(raw.encode()).hexdigest()[:16]


def already_seen(iid):
    return os.path.exists(os.path.join(INBOX, iid + ".json")) or os.path.exists(os.path.join(ARCHIVE, iid + ".json"))


def ingest(items, state, check_provenance=True):
    """Filter, tag and write items. Returns counts per outcome."""
    counts = {}
    fresh = []
    for item in items:
        item["id"] = item_id(item)
        if already_seen(item["id"]):
            counts["duplicate"] = counts.get("duplicate", 0) + 1
            continue
        reason = out_of_scope(item, state)
        if reason:
            counts[f"skipped: {reason}"] = counts.get(f"skipped: {reason}", 0) + 1
            continue
        fresh.append(item)
    if fresh and check_provenance:
        times = [parse_ts(i["created_at"]) for i in fresh]
        index = DraftIndex(min(times) - dt.timedelta(days=WINDOW_DAYS), max(times))
    for item in fresh:
        if check_provenance:
            item["provenance"] = index.match(item["text"], parse_ts(item["created_at"]))
            if item["provenance"]["label"] in ("agent-verbatim", "agent-edited"):
                with open(STATS, "a") as f:
                    f.write(json.dumps({"source": item["source"], "created_at": item["created_at"],
                                        "label": item["provenance"]["label"], "score": item["provenance"]["score"]}) + "\n")
            if item["provenance"]["label"] == "agent-verbatim":
                counts["dropped: agent text posted as-is"] = counts.get("dropped: agent text posted as-is", 0) + 1
                continue
        item["harvested_at"] = now().isoformat()
        with open(os.path.join(INBOX, item["id"] + ".json"), "w") as f:
            json.dump(item, f, indent=2)
        label = item.get("provenance", {}).get("label", item.get("kind"))
        counts[f"inbox: {label}"] = counts.get(f"inbox: {label}", 0) + 1
    return counts


def expire_old():
    cutoff = now() - dt.timedelta(days=EXPIRE_DAYS)
    removed = 0
    for path in glob.glob(os.path.join(INBOX, "*.json")):
        item = json.load(open(path))
        if parse_ts(item["created_at"]) < cutoff:
            os.replace(path, os.path.join(ARCHIVE, os.path.basename(path)))
            removed += 1
    return removed
