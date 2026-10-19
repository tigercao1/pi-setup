#!/usr/bin/env python3
"""Print inbox counts and alignment state as JSON."""
import glob, json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
import voicelib as v

state = v.load_state()
expired = v.expire_old()
counts = {}
for path in glob.glob(os.path.join(v.INBOX, "*.json")):
    item = json.load(open(path))
    key = f'{item["source"]}: {item.get("provenance", {}).get("label", item["kind"])}'
    counts[key] = counts.get(key, 0) + 1
since = state["last_aligned"] or "1970"
posted = {"agent-verbatim": 0, "agent-edited": 0}
if os.path.exists(v.STATS):
    for line in open(v.STATS):
        row = json.loads(line)
        if row["created_at"] > since:
            posted[row["label"]] += 1
print(json.dumps({"agent_drafts_posted_since_last_alignment": {"unchanged": posted["agent-verbatim"], "edited": posted["agent-edited"]},
                  "last_aligned": state["last_aligned"], "cursors": state["cursors"], "expired_now": expired,
                  "pending": sum(counts.values()), "by_type": counts}, indent=2))
