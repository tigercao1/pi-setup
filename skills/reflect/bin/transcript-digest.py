#!/usr/bin/env python3
"""Turn one pi session JSONL into a readable markdown digest for the reflect reviewers.

Usage: transcript-digest.py <session.jsonl> <out.md> [--result-chars N]

Keeps user and assistant text in full, tool calls as name plus truncated arguments, and tool
results truncated to N characters (default 600). Thinking blocks and the system prompt are dropped.
"""
import json, sys


def text_of(content):
    if isinstance(content, str):
        return content
    return "\n".join(x.get("text", "") for x in content if x.get("type") == "text")


def main():
    args = sys.argv[1:]
    if len(args) < 2:
        sys.exit(__doc__)
    src, out = args[0], args[1]
    limit = 600
    if "--result-chars" in args:
        limit = int(args[args.index("--result-chars") + 1])

    lines, turn, counts = [], 0, {"user": 0, "assistant": 0, "toolCall": 0, "toolResult": 0}
    with open(src) as fh:
        for raw in fh:
            try:
                entry = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if entry.get("type") == "session":
                lines.append(f"# Session {entry.get('id')} · cwd {entry.get('cwd')} · {entry.get('timestamp')}\n")
                continue
            if entry.get("type") != "message":
                continue
            msg = entry["message"]
            role = msg.get("role")
            stamp = entry.get("timestamp", "")
            if role == "user":
                turn += 1
                counts["user"] += 1
                lines.append(f"\n## Turn {turn} · user · {stamp}\n\n{text_of(msg.get('content', ''))}\n")
            elif role == "assistant":
                counts["assistant"] += 1
                content = msg.get("content", [])
                body = text_of(content).strip()
                if body:
                    lines.append(f"\n### assistant · {stamp}\n\n{body}\n")
                for part in content if isinstance(content, list) else []:
                    if part.get("type") == "toolCall":
                        counts["toolCall"] += 1
                        arg = json.dumps(part.get("arguments", {}), ensure_ascii=False)
                        if len(arg) > limit:
                            arg = arg[:limit] + f"… [{len(arg)} chars]"
                        lines.append(f"\n- call `{part.get('name')}` {arg}\n")
            elif role == "toolResult":
                counts["toolResult"] += 1
                body = text_of(msg.get("content", []))
                if len(body) > limit:
                    body = body[:limit] + f"… [{len(body)} chars]"
                flag = " ERROR" if msg.get("isError") else ""
                lines.append(f"\n- result `{msg.get('toolName')}`{flag}:\n\n```\n{body}\n```\n")

    with open(out, "w") as fh:
        fh.write("".join(lines))
    print(json.dumps({"out": out, "turns": turn, **counts}))


if __name__ == "__main__":
    main()
