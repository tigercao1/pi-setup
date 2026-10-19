#!/usr/bin/env python3
"""Skim test for a message Tiger will post.

usage: skim-test.py <message.md> --kind <approve|choose|do|answer|fyi> --intent "<the one decision or action you want>" [--title "<thread parent>"]

--kind is what the reader must do: approve a proposed change, choose between options, do a task,
answer a factual question, or nothing (fyi).

A busy reader sees the title, the opening and the closing line, and little else. This script cuts
the message down to exactly that, hands only the cut to a fresh reader with no context, and asks
what it is being asked to do. A second fresh reader gets the full message and is asked what would
change versus today. A third compares both answers with the intent. Exit code 0 = PASS, 1 = FAIL.
"""
import argparse
import concurrent.futures as cf
import json
import re
import subprocess
import sys

MODEL = "vercel-ai-gateway/anthropic/claude-haiku-5.5"
OPENING_WORDS = 25
KINDS = {
    "approve": "approve or reject a change to how things work today",
    "choose": "pick between options",
    "do": "do a task",
    "answer": "answer a factual question",
    "confirm": "confirm the current design or behaviour is right, no change proposed",
    "fyi": "nothing, it is for information",
}


def run_reader(prompt):
    out = subprocess.run(
        ["pi", "-p", "--model", MODEL, "--thinking", "off", "--no-tools", "--no-extensions", "--no-skills",
         "--no-context-files", "--no-prompt-templates", "--no-session", prompt],
        capture_output=True, text=True, timeout=180,
    )
    return out.stdout.strip() or out.stderr.strip()


def sentences(text):
    flat = " ".join(line.strip() for line in text.splitlines() if line.strip() and not line.strip().startswith(("cc ", "cc@")))
    return [s for s in re.split(r"(?<=[.?!])\s+", flat) if s]


def skim_view(text, title):
    parts = sentences(text)
    words = " ".join(parts).split()
    opening = " ".join(words[:OPENING_WORDS]) + (" …" if len(words) > OPENING_WORDS else "")
    closing = parts[-1] if len(parts) > 1 and len(words) > OPENING_WORDS else ""
    lines = []
    if title:
        lines.append(f"[thread parent, already known to you] {title}")
    lines.append(f"[first line] {opening}")
    if closing and closing not in opening:
        lines.append(f"[last line] {closing}")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("message")
    ap.add_argument("--intent", required=True)
    ap.add_argument("--title", default="")
    ap.add_argument("--kind", required=True, choices=list(KINDS))
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--reader", default="a busy product manager",
                    help="who receives the message, e.g. 'an engineer on the billing team who asked the question in the thread parent'")
    args = ap.parse_args()
    text = open(args.message).read().strip()
    view = skim_view(text, args.title)
    with cf.ThreadPoolExecutor() as pool:
        results = list(pool.map(lambda _: evaluate(text, view, args), range(args.runs)))
    passes = sum(r["passed"] for r in results)
    passed = passes * 2 > args.runs
    print("SKIM VIEW (all the skimmer saw):\n" + view + "\n")
    for i, r in enumerate(results, 1):
        print(f"--- run {i}: {'PASS' if r['passed'] else 'FAIL'}")
        print("SKIMMER: " + r["skim"].replace("\n", " | "))
        print(f"KIND: wanted {args.kind}, skimmer saw {r['kind_seen']}")
        print("WHY: " + r["why"] + "\n")
    print("FULL READER (run 1): " + results[0]["full"].replace("\n", " | ") + "\n")
    print(f"VERDICT: {'PASS' if passed else 'FAIL'} ({passes}/{args.runs} runs passed)")
    sys.exit(0 if passed else 1)


def evaluate(text, view, args):

    skim_prompt = (
        "You are " + args.reader + ", skimming Slack between meetings. Below is ALL you read of a "
        "message Tiger sent you:\n\n" + view + "\n\n"
        "Answer in exactly three lines.\n"
        "KIND: what Tiger's message asks of you, one word from " + ", ".join(KINDS) + " (" + "; ".join(f"{k} = {v}" for k, v in KINDS.items()) + "), or UNCLEAR\n"
        "ASK: what Tiger is telling or asking you, in one sentence\n"
        "REPLY: what you would reply right now"
    )
    full_prompt = (
        "You are " + args.reader + ". Tiger sent you this Slack message. Read it once.\n\n---\n" + text + "\n---\n\n"
        "Answer in at most three short lines. 1) What would change compared to today, if anything? "
        "2) Which parts already happen today? 3) What are they asking you to decide?"
    )
    with cf.ThreadPoolExecutor() as pool:
        skim_answer, full_answer = pool.map(run_reader, [skim_prompt, full_prompt])

    judge_prompt = (
        "An author wants this from the reader:\n" + args.intent + "\n\n"
        "A skimming reader who saw only the opening and closing lines understood:\n" + skim_answer + "\n\n"
        "A reader who read everything understood:\n" + full_answer + "\n\n"
        "Reply with JSON only: {\"skim_pass\": true/false, \"full_pass\": true/false, \"why\": \"<one sentence>\"}. "
        "skim_pass is true if the skimmer's ASK is the same decision or action as the intent; the skimmer "
        "is not expected to know details or mechanism, only what reply is wanted. "
        "full_pass is true only if the full reader got the intended decision and did not mistake an "
        "existing behaviour for the proposed change or vice versa."
    )
    verdict_raw = run_reader(judge_prompt)
    match = re.search(r"\{.*\}", verdict_raw, re.S)
    try:
        verdict = json.loads(match.group(0)) if match else {}
    except json.JSONDecodeError:
        verdict = {}
    kind_seen = (re.search(r"KIND:\s*(\w+)", skim_answer) or [None, "UNCLEAR"])[1].lower()
    kind_ok = kind_seen == args.kind
    passed = kind_ok and bool(verdict.get("skim_pass")) and bool(verdict.get("full_pass"))

    return {"passed": passed, "skim": skim_answer, "full": full_answer, "kind_seen": kind_seen,
            "why": verdict.get("why") or f"(unparsed: {verdict_raw[:200]})"}


if __name__ == "__main__":
    main()
