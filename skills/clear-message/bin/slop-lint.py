#!/usr/bin/env python3
"""Regex lint for the mechanical rules in the Writing addendum (~/.pi/agent/APPEND_SYSTEM.md).

usage: slop-lint.py <file>... [--voice tiger]   (use - for stdin)

Rule numbers are the addendum's (pstack unslop ids). Hits are warnings: the exit code is always 0.
Only the regex-checkable rules are here; the rest need judgment while drafting. Fenced code, inline
code and URLs are skipped. --voice tiger skips the patterns tiger-voice exempts (its "Unslop
exemptions" list): emoji (18), "Let me know..." (20), his openers
"Great question," / "Good callout," (22) and symbol-speak (33).
"""
import argparse
import re
import sys

I = re.IGNORECASE


def words(*ws):
    return re.compile(r"\b(?:" + "|".join(ws) + r")\b", I)


CHECKS = [
    (7, words("additionally", "crucial", r"delv(?:e|es|ed|ing)", "enduring", r"enhanc(?:e|es|ed|ing|ement)",
              r"foster(?:s|ed|ing)?", r"garner(?:s|ed|ing)?", "interplay", "intricate", "landscape", "pivotal",
              r"showcas(?:e|es|ed|ing)", "tapestry", "testament", r"underscor(?:e|es|ed|ing)", "vibrant"),
     "AI vocabulary", ()),
    (8, words("serves as", "stands as", "boasts?"), "say 'is' or 'has'", ()),
    (9, re.compile(r"\bnot (?:just|only)\b[^.?!\n]{1,60}?,? but\b", I), "'not just X, but Y'", ()),
    (13, re.compile(r"[\u2014\u2013]"), "em/en dash", ()),
    (13, re.compile(r"(?<=\S) (?:-|--) (?=\S)"), "spaced hyphen used as a dash", ()),
    (16, re.compile(r"\*\*[^*\n]+(?::\*\*|\*\*:)"), "bold inline label", ()),
    (19, re.compile(r"[\u201c\u201d\u2018\u2019]"), "curly quote", ()),
    (20, re.compile(r"\b(?:I hope this helps|of course!|certainly!|happy to help|feel free to)", I),
     "chatbot phrase", ()),
    (20, re.compile(r"\blet me know\b", I), "chatbot phrase", ("tiger",)),
    (22, re.compile(r"\byou(?:'re| are) (?:absolutely|totally) right\b|\bexcellent question\b", I),
     "sycophantic", ()),
    (22, re.compile(r"\b(?:great|good) (?:question|callout)\b", I), "sycophantic opener", ("tiger",)),
    (23, re.compile(r"\b(?:in order to|due to the fact that|it is important to note|it's worth noting|"
                    r"it is worth noting)\b", I), "filler", ()),
    (24, re.compile(r"\b(?:could|might|may) (?:potentially|possibly)\b|\bpotentially possibly\b", I),
     "stacked hedge", ()),
    (25, re.compile(r"\b(?:the future looks bright|only time will tell|in conclusion)\b", I),
     "generic conclusion", ()),
    (26, words("substrate", "wedge", "locus", "nexus", "bedrock", "paradigm", "modality", "north star",
               "flywheel", "endgame", "gold-plating", "API surface", "surface area"), "metaphor noun", ()),
    (31, words(r"utiliz(?:e|es|ed|ing|ation)", r"leverag(?:e|es|ed|ing)", r"facilitat(?:e|es|ed|ing)", "numerous",
               "in the event that"), "use the plain word", ()),
    (33, re.compile(r"(?<!-)(?:\u2192|->|=>)(?!>)"), "arrow as symbol-speak", ("tiger",)),
]

TICKS = re.compile(r"`+")
FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
URL = re.compile(r"https?://\S+|\]\([^)]*\)")
HEADING = re.compile(r"^\s{0,3}#{1,6}\s+(.*)")
BULLET = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+(.*)")
EMOJI = re.compile(r"^(?:[\U0001F300-\U0001FAFF\u2600-\u27BF\u2B50\u2705\u274C]|:[a-z0-9_+-]+:)")
SMALL = {"a", "an", "and", "as", "at", "but", "by", "for", "in", "of", "on", "or", "the", "to", "vs", "with"}


def mask_code_spans(line):
    out, pos = [], 0
    runs = list(TICKS.finditer(line))
    i = 0
    while i < len(runs):
        opener = runs[i]
        closer = next((j for j in range(i + 1, len(runs)) if len(runs[j].group(0)) == len(opener.group(0))), None)
        if closer is None:
            i += 1
            continue
        out.append(line[pos:opener.start()])
        out.append(" " * (runs[closer].end() - opener.start()))
        pos = runs[closer].end()
        i = closer + 1
    out.append(line[pos:])
    return "".join(out)


def mask(line):
    return URL.sub(lambda m: " " * len(m.group(0)), mask_code_spans(line))


def title_case(text):
    ws = [w for w in re.findall(r"[A-Za-z][A-Za-z'-]*", text)]
    rest = [w for w in ws[1:] if w.lower() not in SMALL]
    caps = [w for w in rest if w[0].isupper() and not w.isupper()]
    return len(rest) >= 2 and len(caps) * 2 > len(rest) and len(caps) >= 2


def lint(text, voice=None):
    hits = []
    fence = None
    for n, raw in enumerate(text.splitlines(), 1):
        opening = FENCE.match(raw)
        if fence:
            closing = opening and opening.group(1)[0] == fence[0] and len(opening.group(1)) >= len(fence)
            if closing and not raw[opening.end():].strip():
                fence = None
            continue
        if opening and not (opening.group(1)[0] == "`" and "`" in raw[opening.end():]):
            fence = opening.group(1)
            continue
        line = mask(raw)
        for rule, pat, msg, exempt in CHECKS:
            if voice in exempt:
                continue
            for m in pat.finditer(line):
                hits.append((n, rule, msg, m.group(0)))
        head = HEADING.match(line)
        if head and title_case(head.group(1)):
            hits.append((n, 17, "title-case heading", head.group(1).strip()))
        lead = head or BULLET.match(line)
        if lead and voice != "tiger" and EMOJI.match(lead.group(1)):
            hits.append((n, 18, "emoji in heading or bullet", lead.group(1)[:12]))
    return sorted(hits)


def format_hits(hits, name=""):
    prefix = f"{name}:" if name else "line "
    return [f"{prefix}{n}: rule {rule} {msg}: {snippet!r}" for n, rule, msg, snippet in hits]


def main():
    ap = argparse.ArgumentParser(description="Regex lint for the Writing addendum rules. Warnings only.")
    ap.add_argument("files", nargs="+")
    ap.add_argument("--voice", choices=["tiger"], default=None)
    args = ap.parse_args()
    total = 0
    for f in args.files:
        text = sys.stdin.read() if f == "-" else open(f, encoding="utf-8").read()
        hits = lint(text, args.voice)
        total += len(hits)
        for line in format_hits(hits, f):
            print(line)
    print(f"slop-lint: {total} warning(s)" + (f" (voice {args.voice})" if args.voice else ""))


if __name__ == "__main__":
    main()
