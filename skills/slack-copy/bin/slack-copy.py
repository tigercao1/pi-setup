#!/usr/bin/env python3
"""Put a Slack message on the macOS clipboard as rich text (HTML) plus a plain-text fallback.

Usage:
  slack-copy.py message.md        # read a file
  slack-copy.py - < message.md    # read stdin
  slack-copy.py --print message.md  # print the generated HTML, don't touch the clipboard

Input is Slack-flavoured Markdown:
  - blank line            -> new paragraph
  - "- " or "* " lines    -> bullet list (two leading spaces per nesting level)
  - "1. " lines           -> numbered list
  - "> " lines            -> quote
  - ```fenced```          -> code block
  - `code`, **bold** or *bold*, _italic_, ~strike~, [text](url), bare https:// links
"""
import html
import re
import subprocess
import sys
import tempfile


def inline(text):
    parts = re.split(r"(`[^`]+`)", text)
    out = []
    for part in parts:
        if part.startswith("`") and part.endswith("`") and len(part) > 1:
            out.append("<code>" + html.escape(part[1:-1]) + "</code>")
            continue
        s = html.escape(part, quote=False)
        s = re.sub(r"\[([^\]]+)\]\((https?://[^)\s]+)\)", r'<a href="\2">\1</a>', s)
        s = re.sub(r'(?<!href=")(?<![">])(https?://[^\s<]+)', r'<a href="\1">\1</a>', s)
        s = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", s)
        s = re.sub(r"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])", r"<b>\1</b>", s)
        s = re.sub(r"(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?![\w_])", r"<i>\1</i>", s)
        s = re.sub(r"(?<![\w~])~(?!\s)(.+?)(?<!\s)~(?![\w~])", r"<s>\1</s>", s)
        out.append(s)
    return "".join(out)


LIST_RE = re.compile(r"^( *)([-*]|\d+\.) +(.*)$")


def to_html(md):
    lines = md.replace("\r\n", "\n").split("\n")
    out, para, i = [], [], 0
    list_stack = []  # (indent, tag)

    def flush_para():
        if para:
            out.append("<p>" + "<br>".join(inline(l) for l in para) + "</p>")
            para.clear()

    def close_lists(to_indent=-1):
        while list_stack and list_stack[-1][0] > to_indent:
            out.append(f"</li></{list_stack.pop()[1]}>")

    while i < len(lines):
        line = lines[i]
        if line.strip().startswith("```"):
            flush_para(); close_lists()
            i += 1
            block = []
            while i < len(lines) and not lines[i].strip().startswith("```"):
                block.append(lines[i]); i += 1
            out.append("<pre>" + html.escape("\n".join(block)) + "</pre>")
            i += 1
            continue
        m = LIST_RE.match(line)
        if m:
            flush_para()
            indent, marker, text = len(m.group(1)), m.group(2), m.group(3)
            tag = "ol" if marker[0].isdigit() else "ul"
            if not list_stack or indent > list_stack[-1][0]:
                out.append(f"<{tag}><li>{inline(text)}")
                list_stack.append((indent, tag))
            else:
                close_lists(indent)
                if list_stack and list_stack[-1][0] == indent:
                    out.append(f"</li><li>{inline(text)}")
                else:
                    out.append(f"<{tag}><li>{inline(text)}")
                    list_stack.append((indent, tag))
            i += 1
            continue
        if line.startswith(">"):
            flush_para(); close_lists()
            quote = []
            while i < len(lines) and lines[i].startswith(">"):
                quote.append(lines[i][1:].lstrip()); i += 1
            out.append("<blockquote>" + "<br>".join(inline(q) for q in quote) + "</blockquote>")
            continue
        if not line.strip():
            flush_para(); close_lists()
            i += 1
            continue
        close_lists()
        para.append(line)
        i += 1
    flush_para(); close_lists()
    return '<meta charset="utf-8">' + "\n".join(out)


def to_plain(md):
    s = re.sub(r"\[([^\]]+)\]\((https?://[^)\s]+)\)", r"\1 (\2)", md)
    return s.replace("**", "*")


def main():
    args = [a for a in sys.argv[1:] if a != "--print"]
    show = "--print" in sys.argv[1:]
    src = args[0] if args else "-"
    md = sys.stdin.read() if src == "-" else open(src, encoding="utf-8").read()
    md = md.strip("\n")
    rich = to_html(md)
    if show:
        print(rich)
        return
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as f:
        f.write(to_plain(md))
        plain_path = f.name
    hexdata = rich.encode("utf-8").hex()
    script = (
        f'set the clipboard to {{«class HTML»:«data HTML{hexdata}», '
        f'string:(read POSIX file "{plain_path}" as «class utf8»)}}'
    )
    subprocess.run(["osascript", "-e", script], check=True)
    info = subprocess.run(["osascript", "-e", "clipboard info"], capture_output=True, text=True).stdout
    if "HTML" not in info:
        sys.exit("clipboard does not hold HTML: " + info)
    mentions = sorted(set(re.findall(r"@[A-Za-z][\w.-]*", md)))
    print("copied as rich text" + (f"; re-type these mentions in Slack: {', '.join(mentions)}" if mentions else ""))


if __name__ == "__main__":
    main()
