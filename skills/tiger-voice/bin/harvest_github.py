#!/usr/bin/env python3
"""Harvest Tiger's GitHub PR comments since the github cursor into the voice inbox."""
"""usage: harvest_github.py --repo OWNER/NAME   (or set VOICE_GITHUB_REPO)"""
import argparse, json, os, subprocess, sys
sys.path.insert(0, os.path.dirname(__file__))
import voicelib as v

parser = argparse.ArgumentParser(description="Harvest Tiger's GitHub PR comments into the voice inbox.")
parser.add_argument("--repo", default=os.environ.get("VOICE_GITHUB_REPO"), help="OWNER/NAME; defaults to $VOICE_GITHUB_REPO")
REPO = parser.parse_args().repo
if not REPO:
    parser.error("no repo given: pass --repo OWNER/NAME or set VOICE_GITHUB_REPO")

def gh(path):
    out = subprocess.run(["gh", "api", "--paginate", path], capture_output=True, text=True, check=True).stdout
    return json.loads(out.replace("][", ",")) if out.strip() else []

state = v.load_state()
me = state["github_login"]
since = v.cursor(state, "github")
started = v.now()
prs = subprocess.run(["gh", "api", f"search/issues?q=repo:{REPO}+commenter:{me}+is:pr+updated:>={since:%Y-%m-%d}&per_page=100",
                      "-q", ".items[] | [.number, .user.login] | @tsv"], capture_output=True, text=True, check=True).stdout.split("\n")
items = []
for row in filter(None, prs):
    number, author = row.split("\t")
    own_pr = author == me
    sources = [
        (f"repos/{REPO}/pulls/{number}/comments?per_page=100", "inline"),
        (f"repos/{REPO}/issues/{number}/comments?per_page=100", "conversation"),
        (f"repos/{REPO}/pulls/{number}/reviews?per_page=100", "review body"),
    ]
    for path, where in sources:
        for c in gh(path):
            if c["user"]["login"] != me or not (c.get("body") or "").strip():
                continue
            created = c.get("created_at") or c.get("submitted_at")
            if v.parse_ts(created) <= since:
                continue
            items.append({
                "source": "github",
                "kind": ("reply on own PR" if own_pr else "review comment on someone else's PR") + f" ({where})",
                "url": c.get("html_url"),
                "ref": str(c["id"]),
                "created_at": created,
                "text": c["body"],
                "context": f'#{number} {c.get("path") or ""}:{c.get("line") or c.get("original_line") or ""}'.strip(),
            })
counts = v.ingest(items, state)
state = v.load_state()
state["cursors"]["github"] = started.isoformat()
v.save_state(state)
print(json.dumps({"since": since.isoformat(), "found": len(items), **counts}, indent=2))
