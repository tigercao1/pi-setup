"""Convert HTML pages (show-me pages and other HTML notes) to markdown for the qmd indexes.

Used by bin/pi-memory-export. Sources are the *.html files under the knowledge base that a qmd
collection already covers with a *.md pattern. Each page becomes markdown with front matter (title,
source, the show-me:* labels from <head>, summary, updated) and only its readable current content:
no style, script, textarea, hidden elements or collapsed older iterations. Item labels follow
~/.pi/agent/skills/recall/references/validity.md.
"""
import glob
import json
import os
import re
import time
from html.parser import HTMLParser

import labels

VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
DROP = {"script", "style", "textarea", "template", "noscript", "head", "title", "iframe", "object", "embed", "canvas",
        "button", "select", "option"}
HEADINGS = {"h1": 1, "h2": 2, "h3": 3, "h4": 4, "h5": 5, "h6": 6}
LISTS = {"ul", "ol", "menu"}
BLOCK = {"address", "article", "aside", "blockquote", "body", "details", "dialog", "div", "dl", "dd", "dt", "fieldset",
         "figcaption", "figure", "footer", "form", "header", "hgroup", "html", "hr", "legend", "main", "nav", "p",
         "section", "summary", "caption", "center"}
INLINE = {"a", "abbr", "b", "bdi", "bdo", "cite", "code", "data", "dfn", "em", "font", "i", "kbd", "label", "mark",
          "q", "s", "samp", "small", "span", "strong", "sub", "sup", "time", "u", "var", "del", "ins"}
SPACED = {"a", "small", "label"}
TICK_VALUES = {"1", "true", "yes", "checked", "on", "done"}
HIDDEN_STYLE = re.compile(r"display\s*:\s*none|visibility\s*:\s*hidden", re.I)
KB_DIR_DEFAULT = os.path.join(os.path.expanduser("~"), "Documents", "knowledge-base-remote")


class Node:
    __slots__ = ("tag", "attrs", "children", "parent")

    def __init__(self, tag, attrs=None, parent=None):
        self.tag, self.attrs, self.children, self.parent = tag, attrs or {}, [], parent


class TreeBuilder(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("#root")
        self.stack = [self.root]

    def close_to(self, names, stop):
        for i in range(len(self.stack) - 1, 0, -1):
            tag = self.stack[i].tag
            if tag in names:
                del self.stack[i:]
                return
            if tag in stop:
                return

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if tag == "li":
            self.close_to({"li"}, LISTS)
        elif tag == "tr":
            self.close_to({"tr"}, {"table", "thead", "tbody", "tfoot"})
        elif tag in ("td", "th"):
            self.close_to({"td", "th"}, {"tr", "table"})
        elif tag in ("dt", "dd"):
            self.close_to({"dt", "dd"}, {"dl"})
        elif tag in ("thead", "tbody", "tfoot"):
            self.close_to({"thead", "tbody", "tfoot"}, {"table"})
        if tag in BLOCK or tag in LISTS or tag in HEADINGS or tag in ("table", "pre", "li"):
            self.close_to({"p"}, set(self.tags()) - INLINE - {"p"})
        node = Node(tag, {k.lower(): (v if v is not None else "") for k, v in attrs}, self.stack[-1])
        self.stack[-1].children.append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag.lower() not in VOID and self.stack[-1].tag == tag.lower():
            self.stack.pop()

    def handle_endtag(self, tag):
        tag = tag.lower()
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                return

    def handle_data(self, data):
        self.stack[-1].children.append(data)

    def tags(self):
        return [n.tag for n in self.stack]


def parse(text):
    builder = TreeBuilder()
    builder.feed(text)
    builder.close()
    return builder.root


def walk(node):
    for child in node.children:
        if isinstance(child, Node):
            yield child
            yield from walk(child)


def find(node, tag):
    return next((n for n in walk(node) if n.tag == tag), None)


def raw_text(node):
    out = []
    for child in node.children:
        if isinstance(child, str):
            out.append(child)
        elif child.tag == "br":
            out.append("\n")
        elif child.tag not in ("script", "style", "textarea"):
            out.append(raw_text(child))
    return "".join(out)


def squash(text):
    return re.sub(r"\s+", " ", text or "").strip()


def safe(text):
    return text.replace("<!--", "&lt;!--")


def classes(node):
    return set(node.attrs.get("class", "").lower().split())


def own_label(node):
    attrs = node.attrs
    if "data-state" not in attrs and not attrs.get("data-evidence", "").strip():
        return None
    out = {"state": (attrs.get("data-state") or "").strip().lower() or "proposed"}
    evidence = labels.clean_evidence(attrs.get("data-evidence", "").split(","))
    if evidence:
        out["evidence"] = evidence
    for key in ("as_of", "superseded_by"):
        value = attrs.get("data-" + key.replace("_", "-"), "").strip()
        if value:
            out[key] = value
    return out


def claim(label):
    parts = ["claim"]
    for key in ("state", "evidence", "as_of", "superseded_by"):
        value = label.get(key)
        if isinstance(value, list):
            value = ",".join(v.replace(",", "%2C") for v in value)
        if not value:
            continue
        value = str(value).replace("-->", "--&gt;")
        parts.append(f"{key}={json.dumps(value, ensure_ascii=False) if re.search(r'[\s\"]', value) else value}")
    return "<!-- " + " ".join(parts) + " -->"


PROPOSED = {"state": "proposed"}


class Converter:
    def __init__(self, root, page_label, source):
        self.root, self.page_label, self.source = root, page_label, source
        self.lines, self.para, self.superseded = [], [], []
        iterations = [n for n in walk(root) if re.fullmatch(r"\d+", n.attrs.get("data-iteration", "").strip())]
        self.current = max((int(n.attrs["data-iteration"]) for n in iterations), default=None)
        current = next((n for n in iterations if int(n.attrs["data-iteration"]) == self.current), None)
        anchor = current.attrs.get("id") if current is not None else ""
        self.current_ref = f"{source}#{anchor}" if anchor else source
        self.page_proposed = page_label.get("state", "proposed") == "proposed"

    def hidden(self, node):
        return node.tag in DROP or "hidden" in node.attrs or bool(HIDDEN_STYLE.search(node.attrs.get("style", "")))

    def old_iteration(self, node):
        value = node.attrs.get("data-iteration", "").strip()
        return self.current is not None and value.isdigit() and int(value) < self.current

    def stored_iteration(self, details):
        for n in walk(details):
            if self.old_iteration(n) or n.tag == "textarea" or n.tag == "iframe" and "srcdoc" in n.attrs:
                return True
            if n.tag == "script" and n.attrs.get("type", "").lower() in ("text/html", "text/template"):
                return True
        return False

    def note_superseded(self, node):
        summary = find(node, "summary") if node.tag == "details" else None
        heading = summary or next((n for n in walk(node) if n.tag in HEADINGS), None)
        text = self.flat(heading) if heading is not None else ""
        number = node.attrs.get("data-iteration") or next(
            (n.attrs["data-iteration"] for n in walk(node) if n.attrs.get("data-iteration")), "")
        self.superseded.append(text or (f"iteration {number}" if number else "older iteration"))

    def flat(self, node):
        return squash("".join(t for t, _ in self.inline(node, cell=False)))

    def inline(self, node, cell, skip_lists=False):
        out = []
        for child in node.children:
            if isinstance(child, str):
                text = re.sub(r"\s+", " ", child)
                out.append((safe(text.replace("|", "\\|") if cell else text), None))
                continue
            if self.hidden(child) or self.old_iteration(child):
                continue
            if child.tag == "details" and self.stored_iteration(child):
                continue
            if skip_lists and child.tag in LISTS | {"table", "pre"}:
                continue
            tag = child.tag
            if tag == "br" or tag == "hr":
                out.append((" ", None))
                continue
            if tag == "img":
                alt = child.attrs.get("alt", "").strip()
                if alt:
                    out.append((safe(alt), None))
                continue
            if tag == "input":
                continue
            inner = self.inline(child, cell)
            if tag == "a":
                text = squash("".join(t for t, _ in inner))
                href = child.attrs.get("href", "").strip()
                if text and href and not href.startswith(("#", "javascript:")):
                    inner = [(f"[{text}]({href.replace(' ', '%20').replace(')', '%29')})", None)]
            elif tag == "code" and not any(lab for _, lab in inner):
                text = squash("".join(t for t, _ in inner))
                if text and "`" not in text:
                    inner = [(f"`{text}`", None)]
            label = own_label(child)
            if label:
                text = "".join(t for t, _ in inner)
                inner = [(text, label)]
            if tag not in INLINE or tag in SPACED:
                inner = [(" ", None)] + inner + [(" ", None)]
            out.extend(inner)
        return out

    def emit(self, prefix, segments, label, cell_join=None):
        chunks = []
        for text, lab in segments:
            if chunks and chunks[-1][1] is None and lab is None:
                chunks[-1] = (chunks[-1][0] + text, None)
            else:
                chunks.append((text, lab))
        chunks = [(squash(t), lab) for t, lab in chunks if squash(t)]
        if not chunks:
            return
        if any(lab for _, lab in chunks):
            fallback = label or self.page_label
            body = " ".join(f"{t} {claim(lab or fallback)}" for t, lab in chunks)
        else:
            body = " ".join(t for t, _ in chunks) + (f" {claim(label)}" if label else "")
        if prefix.startswith("#"):
            self.lines.append("")
        self.lines.append(prefix + body)
        if not prefix.lstrip().startswith("-"):
            self.lines.append("")

    def flush(self, label):
        if self.para:
            self.emit("", self.para, label)
            self.para = []

    def block_label(self, node, inherited):
        return own_label(node) or inherited

    def item_label(self, node, inherited, tick):
        own = own_label(node)
        if own:
            return own
        if tick or inherited or not self.page_proposed:
            return PROPOSED
        return None

    def is_tick(self, li):
        if li.attrs.get("data-default", "").strip().lower() in TICK_VALUES or classes(li) & {
                "done", "checked", "complete", "completed", "tick", "ticked"}:
            return True
        for n in self.own_descendants(li):
            if n.tag == "input" and n.attrs.get("type", "").lower() == "checkbox" and "checked" in n.attrs:
                return True
        return bool(labels.TICK_CHARS.search(self.flat(li)))

    def own_descendants(self, node):
        for child in node.children:
            if isinstance(child, Node) and child.tag not in LISTS:
                yield child
                yield from self.own_descendants(child)

    def has_checkbox(self, li):
        return any(n.tag == "input" and n.attrs.get("type", "").lower() == "checkbox" for n in self.own_descendants(li))

    def blocks(self, node, label, depth=0):
        for child in node.children:
            if isinstance(child, str):
                self.para.append((safe(child), None))
                continue
            if self.hidden(child):
                continue
            tag = child.tag
            if self.old_iteration(child) or tag == "details" and self.stored_iteration(child):
                self.flush(label)
                self.note_superseded(child)
                continue
            if tag in HEADINGS:
                self.flush(label)
                self.emit("#" * HEADINGS[tag] + " ", self.inline(child, False), self.block_label(child, label))
            elif tag in LISTS:
                self.flush(label)
                self.list_items(child, label, depth)
            elif tag == "li":
                self.flush(label)
                self.list_item(child, label, depth)
            elif tag == "table":
                self.flush(label)
                self.table(child, label)
            elif tag == "pre" or "mermaid" in classes(child) and tag in BLOCK:
                self.flush(label)
                self.fence(child)
            elif tag == "br":
                self.flush(label)
            elif tag in BLOCK or tag not in INLINE and any(isinstance(c, Node) and c.tag in BLOCK | LISTS | {"table"}
                                                            for c in child.children):
                self.flush(label)
                self.blocks(child, self.block_label(child, label), depth)
                self.flush(self.block_label(child, label))
            else:
                self.para.extend(self.inline(_wrap(child), False))

    def list_items(self, node, label, depth):
        for child in node.children:
            if isinstance(child, Node) and not self.hidden(child):
                if child.tag == "li":
                    self.list_item(child, label, depth)
                elif child.tag in LISTS:
                    self.list_items(child, label, depth + 1)
                else:
                    self.blocks(_wrap(child), label, depth)
                    self.flush(label)

    def list_item(self, li, label, depth):
        tick = self.is_tick(li)
        box = "[x] " if tick else "[ ] " if self.has_checkbox(li) else ""
        self.emit("  " * depth + "- " + box, self.inline(li, False, skip_lists=True), self.item_label(li, label, tick))
        for child in li.children:
            if isinstance(child, Node) and not self.hidden(child):
                if child.tag in LISTS:
                    self.list_items(child, label, depth + 1)
                elif child.tag == "table":
                    self.table(child, label)
                elif child.tag == "pre":
                    self.fence(child)

    def rows(self, node):
        for child in node.children:
            if isinstance(child, Node) and not self.hidden(child):
                if child.tag == "tr":
                    yield child
                elif child.tag in ("thead", "tbody", "tfoot"):
                    yield from self.rows(child)

    def table(self, table, label):
        caption = find(table, "caption")
        if caption is not None:
            self.emit("", self.inline(caption, False), label)
        first = True
        for tr in self.rows(table):
            cells = [c for c in tr.children if isinstance(c, Node) and c.tag in ("td", "th") and not self.hidden(c)]
            texts = [(squash("".join(t for t, _ in self.inline(c, True))), own_label(c)) for c in cells]
            if not any(t for t, _ in texts):
                continue
            row_label = self.item_label(tr, label, False)
            if any(own for _, own in texts):
                fallback = row_label or self.page_label
                line = "| " + " | ".join(f"{t} {claim(own or fallback)}".strip() for t, own in texts) + " |"
            else:
                line = "| " + " | ".join(t for t, _ in texts) + " |" + (f" {claim(row_label)}" if row_label else "")
            self.lines.append(line)
            if first:
                self.lines.append("|" + " --- |" * len(cells))
                first = False

    def fence(self, node):
        text = raw_text(node).strip("\n")
        lines = text.split("\n")
        indent = min((len(l) - len(l.lstrip()) for l in lines if l.strip()), default=0)
        text = "\n".join(l[indent:].rstrip() for l in lines).strip("\n")
        if not text.strip():
            return
        code = find(node, "code")
        names = classes(node) | (classes(code) if code is not None else set())
        lang = "mermaid" if "mermaid" in names or "language-mermaid" in names else next(
            (c[len("language-"):] for c in sorted(names) if c.startswith("language-")), "")
        ticks = "`" * max(3, max((len(m) for m in re.findall(r"`+", text)), default=0) + 1)
        self.lines += [ticks + lang, safe(text), ticks]

    def convert(self):
        body = find(self.root, "body") or self.root
        self.blocks(body, None)
        self.flush(None)
        if self.superseded:
            self.lines += ["", "## Superseded iterations", "",
                           "Older iterations are kept in the source page and are not indexed here."]
            label = {"state": "superseded", "superseded_by": self.current_ref}
            self.lines += [f"- {safe(text)} {claim(label)}" for text in self.superseded]
        return self.lines


def _wrap(node):
    holder = Node("#wrap")
    holder.children = [node]
    return holder


def page_markdown(path, raw, mtime=None):
    text = raw.decode("utf-8", errors="replace").lstrip("\ufeff") if isinstance(raw, bytes) else raw.lstrip("\ufeff")
    meta = labels.html_labels(text)
    head_meta = {}
    for tag in labels.META.findall(labels.html_head(text)):
        attrs = labels.tag_attrs(tag)
        name = (attrs.get("name") or "").lower()
        if name.startswith("show-me:") and "content" in attrs:
            head_meta.setdefault(name[len("show-me:"):], attrs["content"])
    root = parse(text)
    head = find(root, "head")
    title_node = find(head, "title") if head is not None else None
    if title_node is None:
        title_node = next((n for n in walk(root) if n.tag == "title" and not any(
            a.tag == "body" for a in _ancestors(n))), None)
    title = squash(raw_text(title_node)) if title_node is not None else ""
    title = title or squash(head_meta.get("topic", ""))
    first_h1 = find(root, "h1")
    title = title or (squash(raw_text(first_h1)) if first_h1 is not None else "")
    title = title or os.path.splitext(os.path.basename(path))[0]
    state = (meta.get("state") or "").strip().lower() or "proposed"
    page_label = {"state": state}
    evidence = labels.clean_evidence(meta.get("evidence"))
    if evidence:
        page_label["evidence"] = evidence
    for key in ("as_of", "superseded_by"):
        if (meta.get(key) or "").strip():
            page_label[key] = meta[key].strip()
    updated = squash(head_meta.get("updated", ""))
    if not updated and mtime:
        updated = time.strftime("%Y-%m-%d", time.localtime(mtime))
    fm = ["---", f"title: {json.dumps(title, ensure_ascii=False)}", f"source: {json.dumps(path, ensure_ascii=False)}",
          f"state: {state}"]
    if evidence:
        fm.append("evidence:")
        fm += [f"  - {json.dumps(e, ensure_ascii=False)}" for e in evidence]
    for key in ("as_of", "superseded_by"):
        if key in page_label:
            fm.append(f"{key}: {json.dumps(page_label[key], ensure_ascii=False)}")
    summary = squash(head_meta.get("summary", ""))
    if summary:
        fm.append(f"summary: {json.dumps(summary, ensure_ascii=False)}")
    if updated:
        fm.append(f"updated: {updated}")
    fm.append("---")
    lines = Converter(root, page_label, path).convert()
    while lines and not lines[0].strip():
        lines = lines[1:]
    if lines and lines[0].startswith("# ") and squash(re.sub(r"<!--.*?-->", "", lines[0][2:])) == title:
        lines = lines[1:]
    out = fm + [f"# {safe(title)}", ""]
    if summary:
        out += [safe(summary), ""]
    previous_blank = True
    for line in lines:
        blank = not line.strip()
        if blank and previous_blank:
            continue
        out.append(line)
        previous_blank = blank
    return "\n".join(out).rstrip("\n") + "\n"


def _ancestors(node):
    node = node.parent
    while node is not None:
        yield node
        node = node.parent


def expand_braces(pattern):
    match = re.search(r"\{([^{}]*)\}", pattern)
    if not match:
        return [pattern]
    out = []
    for option in match.group(1).split(","):
        out += expand_braces(pattern[:match.start()] + option + pattern[match.end():])
    return out


def glob_regex(pattern):
    out, i = [], 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        elif pattern[i] == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile("".join(out) + r"\Z")


def as_html(pattern):
    return re.sub(r"\.md(?=[,}]|$)", ".html", pattern)


def matches(rel, pattern):
    return any(glob_regex(p).match(rel) for p in expand_braces(pattern))


def template_files(agent_dir, layer_dir):
    files = sorted(glob.glob(os.path.join(layer_dir, "qmd", "*.yml.tmpl")))
    files += sorted(glob.glob(os.path.join(layer_dir, "qmd", "local", "*.local.yml.tmpl")))
    files += sorted(glob.glob(os.path.join(agent_dir, "qmd", "*.yml.tmpl")))
    return files


def collections(files, home):
    out = []
    for path in files:
        try:
            with open(path, encoding="utf-8") as fh:
                lines = fh.read().replace("$HOME", home).split("\n")
        except OSError:
            continue
        local = path.endswith(".local.yml.tmpl")
        inside, current, in_ignore = local, None, False
        for line in lines:
            if re.match(r"^collections:\s*$", line):
                inside = True
                continue
            if line and not line[0].isspace() and not line.startswith("#"):
                inside = False
            if not inside:
                continue
            entry = re.match(r"^  ([^\s#][^:]*):\s*$", line)
            if entry:
                current = {"name": labels.unquote(entry.group(1)), "path": "", "pattern": "**/*.md", "ignore": []}
                out.append(current)
                in_ignore = False
                continue
            field = re.match(r"^    (path|pattern|ignore):\s*(.*?)\s*$", line)
            if field and current is not None:
                in_ignore = field.group(1) == "ignore"
                if not in_ignore:
                    current[field.group(1)] = labels.unquote(field.group(2))
                continue
            item = re.match(r"^      -\s*(.+?)\s*$", line)
            if item and current is not None and in_ignore:
                current["ignore"].append(labels.unquote(item.group(1)))
                continue
            if re.match(r"^    \S", line):
                in_ignore = False
    return [c for c in out if c["path"] and re.search(r"\.md\b", c["pattern"])]


def page_sources(kb_dir, colls, memory_dir):
    kb_dir = os.path.abspath(kb_dir)
    usable = [c for c in colls if not labels.under(c["path"], memory_dir)]
    found = []
    if not os.path.isdir(kb_dir):
        return found
    for dirpath, dirnames, filenames in os.walk(kb_dir):
        dirnames[:] = sorted(d for d in dirnames if d not in ("node_modules", ".git"))
        for name in sorted(filenames):
            if not name.lower().endswith(".html"):
                continue
            path = os.path.join(dirpath, name)
            for coll in usable:
                root = os.path.realpath(os.path.expanduser(coll["path"]))
                if not labels.under(path, root):
                    continue
                rel = os.path.relpath(os.path.realpath(path), root)
                if not matches(rel, as_html(coll["pattern"])):
                    continue
                if any(matches(rel, as_html(p)) for p in coll["ignore"]):
                    continue
                found.append(path)
                break
    return found
