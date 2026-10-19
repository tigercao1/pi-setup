#!/usr/bin/env python3
"""Flag mannered prose - figures of speech standing in for literal statements.

  prose-check.sh FILE [FILE...]     # or pipe text on stdin
  prose-check.sh --threshold 0.6 FILE

Sentences are extracted mechanically (no hand-picking), then scored by
typesafe-ai/jev through the Vercel AI Gateway, ~40 per request. Jev's output
tokens are free and input is $0.042/M, so a whole document costs a fraction of
a cent.

Exit code 1 if any sentence scores at or above the threshold.
"""
import json
import os
import re
import subprocess
import sys
import urllib.request

ENDPOINT = "https://ai-gateway.vercel.sh/v1/evaluate"
BATCH = 40
QUESTION = (
    "Does this sentence substitute a figure of speech, metaphor, or idiom for a "
    "plain literal statement? Judge this sentence only."
)

# Structural markdown that is not prose: code fences, tables, headings, link-only
# lines, and checkbox test-plan rows.
SKIP = re.compile(r"^\s*(```|~~~|\||#{1,6}\s|[-*]\s*\[[ x]\]|>|\d+\.\s*$)")


def api_key() -> str:
    for var in ("AI_GATEWAY_API_KEY", "VERCEL_AI_GATEWAY_KEY"):
        if os.environ.get(var):
            return os.environ[var]
    models = os.path.join(os.path.expanduser("~"), ".pi", "agent", "models.json")
    try:
        cmd = json.load(open(models))["providers"]["vercel-ai-gateway"]["apiKey"]
    except (OSError, KeyError, ValueError):
        cmd = ""
    if not cmd.startswith("!"):
        if cmd:
            return cmd
        sys.exit("no API key: set AI_GATEWAY_API_KEY or configure vercel-ai-gateway in ~/.pi/agent/models.json")
    out = subprocess.run(cmd[1:], shell=True, capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit("no API key: the apiKey command in ~/.pi/agent/models.json failed")
    return out.stdout.strip()


def sentences(text: str) -> list[str]:
    if text.startswith("---\n"):
        end = text.find("\n---", 4)
        if end != -1:
            text = text[end + 4:]
    body, fenced = [], False
    for line in text.splitlines():
        if line.lstrip().startswith(("```", "~~~")):
            fenced = not fenced
            continue
        if fenced or SKIP.match(line):
            continue
        body.append(line)
    joined = re.sub(r"\s+", " ", " ".join(body))
    joined = re.sub(r"`[^`]*`", "CODE", joined)
    parts = re.split(r"(?<=[.!?])\s+(?=[A-Z(\"'])", joined)
    return [p.strip() for p in parts if len(p.strip().split()) >= 5]


def score(key: str, batch: list[str]) -> dict[str, float]:
    state = "Sentences from a technical document. Judge each independently.\n\n" + "\n".join(
        f"S{i}: {s}" for i, s in enumerate(batch)
    )
    payload = {
        "model": "typesafe-ai/jev",
        "state": state,
        "questions": {f"S{i}": {"type": "boolean", "instructions": f"S{i}: {QUESTION}"} for i in range(len(batch))},
    }
    req = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {key}", "content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.load(resp)
    if "answers" not in data:
        sys.exit(f"gateway error: {json.dumps(data.get('error', data))[:300]}")
    return {k: v.get("probability", 0.0) for k, v in data["answers"].items()}


def main() -> int:
    args = sys.argv[1:]
    threshold = 0.5
    if "--threshold" in args:
        i = args.index("--threshold")
        threshold = float(args[i + 1])
        del args[i:i + 2]

    text = "\n".join(open(p, encoding="utf-8").read() for p in args) if args else sys.stdin.read()
    sents = sentences(text)
    if not sents:
        print("no prose sentences found")
        return 0

    key = api_key()
    flagged, total = [], 0.0
    for start in range(0, len(sents), BATCH):
        batch = sents[start:start + BATCH]
        probs = score(key, batch)
        for i, sentence in enumerate(batch):
            p = probs.get(f"S{i}", 0.0)
            total += p
            if p >= threshold:
                flagged.append((p, sentence))

    flagged.sort(reverse=True)
    for p, sentence in flagged:
        print(f"\033[33m{p:.2f}\033[0m  {sentence[:160]}")
    print(f"\n{len(flagged)}/{len(sents)} sentences flagged at >={threshold:.2f}"
          f"  ·  mean {total / len(sents):.3f}")
    return 1 if flagged else 0


if __name__ == "__main__":
    sys.exit(main())
