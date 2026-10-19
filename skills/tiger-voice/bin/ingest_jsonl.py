#!/usr/bin/env python3
"""Ingest items fetched through MCP (Slack, Linear). usage: ingest_jsonl.py <source> <file.jsonl> <cursor-iso>
Each line: {"kind","url","ref","created_at","text","context"}. Sets the source cursor to <cursor-iso> after ingesting."""
import json, sys, os
sys.path.insert(0, os.path.dirname(__file__))
import voicelib as v

source, path, new_cursor = sys.argv[1], sys.argv[2], sys.argv[3]
state = v.load_state()
items = [dict(json.loads(l), source=source) for l in open(path) if l.strip()]
counts = v.ingest(items, state)
state = v.load_state()
state["cursors"][source] = new_cursor
v.save_state(state)
print(json.dumps({"found": len(items), **counts}, indent=2))
