#!/usr/bin/env python3
"""Find Tiger's messages to agents that correct a draft's wording, since the pi cursor."""
import glob, json, os, re, sys
sys.path.insert(0, os.path.dirname(__file__))
import voicelib as v

PATTERN = re.compile(r"\b(too (long|formal|wordy|verbose)|shorter|more casual|less formal|tone|wording|reword|rephrase|"
                     r"how i (write|wrote|actually)|my (voice|style)|writing style|don'?t (say|write|use)|do not (say|write|use)|"
                     r"sounds like|not how i|what i (actually )?posted|i'd say|i would say)\b", re.I)
ALIGN_MARK = "tiger-voice/ALIGN.md"

state = v.load_state()
since = v.cursor(state, "pi")
started = v.now()
items = []
for path in glob.glob(os.path.join(v.SESSIONS, "*", "*.jsonl")):
    if v.dt.datetime.fromtimestamp(os.path.getmtime(path), v.dt.timezone.utc) < since:
        continue
    last_assistant = ""
    lines = open(path, errors="ignore").read()
    if ALIGN_MARK in lines:
        continue
    for line in lines.splitlines():
        try:
            entry = json.loads(line)
        except Exception:
            continue
        message = entry.get("message") or {}
        role = message.get("role")
        texts = [c.get("text", "") for c in message.get("content", []) if isinstance(c, dict) and c.get("type") == "text"] \
            if isinstance(message.get("content"), list) else [str(message.get("content", ""))]
        text = "\n".join(texts).strip()
        if role == "assistant" and text:
            last_assistant = text
        if role != "user" or not text or v.parse_ts(entry["timestamp"]) <= since:
            continue
        if text.startswith("▌ message from") or not PATTERN.search(text) or not last_assistant:
            continue
        items.append({
            "source": "pi",
            "kind": "correction to an agent draft",
            "url": path,
            "ref": entry.get("id"),
            "created_at": entry["timestamp"],
            "text": text[:2000],
            "context": "Preceding agent message (excerpt): " + last_assistant[-1500:],
        })
counts = v.ingest(items, state, check_provenance=False)
state = v.load_state()
state["cursors"]["pi"] = started.isoformat()
v.save_state(state)
print(json.dumps({"since": since.isoformat(), "found": len(items), **counts}, indent=2))
