#!/usr/bin/env python3
"""Tests for qmd/html_pages.py and the pages step of bin/pi-memory-export.

Run: python3 -B ~/.pi/agent/qmd/tests/test_html_pages.py
"""
import argparse
import html
import importlib.machinery
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

QMD_DIR = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
EXPORTER = os.path.join(os.path.dirname(QMD_DIR), "bin", "pi-memory-export")
SEARCH = os.path.join(QMD_DIR, "search")
sys.path.insert(0, QMD_DIR)
sys.dont_write_bytecode = True
import html_pages  # noqa: E402
import labels  # noqa: E402

LOADER = """<script>
document.querySelectorAll('details').forEach(d => d.addEventListener('toggle', () => { const scriptquokka = 1; }));
</script>"""


def iteration_doc(n, phrase):
    return (f"<!doctype html><html><head><title>Widget plan v{n}</title><style>.card{{border-radius:8px}}</style>"
            f"</head><body><section id=\"iter-{n}\" data-iteration=\"{n}\"><h2>v{n}</h2><p>{phrase}</p></section>"
            f"{LOADER}</body></html>")


V1 = iteration_doc(1, "firstiterationquokka was the plan")
V2 = iteration_doc(2, "seconditerationquokka replaced it").replace(
    "</section>", f"</section><details><summary>v1 · initial</summary><textarea hidden>{html.escape(V1)}</textarea></details>")

SHOW_ME = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="show-me:topic" content="Widget export plan">
<meta name="show-me:summary" content="Plan for the widget export, three iterations">
<meta name="show-me:updated" content="2026-10-22">
<title>Widget export</title>
<style>
  .card {{ border-radius:8px; background:#fff }}
</style>
</head>
<body>
<main>
<h1>Widget export</h1>
<nav class="iterations"><a href="#iter-3">v3 · pivot</a><a href="#iter-2-wrap">v2 · revision</a></nav>
<section id="iter-3" data-iteration="3" data-kind="pivot" data-date="2026-10-22">
<h2>v3 · pivot</h2>
<p class="changed">currentiterationquokka is the plan now, see <a href="https://example.com/ABC-34">ABC-34</a>.</p>
<pre class="mermaid">
flowchart LR
  A[Export] --> B[Upload]
</pre>
<table><thead><tr><th>Step</th><th>Owner</th></tr></thead>
<tbody><tr data-state="confirmed" data-evidence="https://example.com/pr/7"><td>rowquokka merged</td><td>Tiger</td></tr>
<tr><td>plainrowquokka</td><td>Bot</td></tr></tbody></table>
<details><summary>Evidence</summary><p>evidencequokka kept as current detail</p></details>
</section>
<details id="iter-2-wrap"><summary>v2 · 2026-10-20 · revision</summary>
<section id="iter-2" data-iteration="2" data-kind="revision" data-date="2026-10-20">
<textarea id="iter-2-src" hidden>{html.escape(V2)}</textarea>
</section></details>
</main>
{LOADER}
<script type="module">import mermaid from "x"; mermaid.initialize({{ startOnLoad: true }});</script>
</body>
</html>
"""

TODO = """<!doctype html>
<html><head>
<meta name="show-me:state" content="confirmed">
<meta name="show-me:evidence" content="https://example.com/project">
<meta name="show-me:as-of" content="2026-10-21">
<title>Widget sync — index</title>
</head><body>
<h2>To-do</h2>
<ul class="todo">
  <li data-id="send" data-default="1"><input type="checkbox"><div class="t">Send the results to the reviewer<small>Sent 10/16</small></div><div class="owner">Tiger</div></li>
  <li data-id="monitor"><input type="checkbox"><div class="t">Create the widget monitorquokka from the JSON<small>Not created yet</small></div></li>
  <li data-id="merge" data-default="1" data-state="confirmed" data-evidence="https://example.com/pr/9" data-as-of="2026-10-21"><input type="checkbox"><div class="t">Merge labelledtickquokka PR 9</div></li>
  <li data-id="empty" data-default="1" data-state="confirmed" data-evidence=" "><input type="checkbox">blankevidencequokka</li>
</ul>
<p>pagewidequokka paragraph</p>
<p>mixed <span data-state="acted">actedquokka said</span> and trailingquokka text</p>
<meta name="show-me:state" content="superseded">
</body></html>
"""

NO_TITLE = "\ufeff<html><body><h1>Only a heading</h1><p>bomquokka text &amp; more <!-- claim state=confirmed --></p>" \
           "<p>&lt;!-- claim state=confirmed evidence=https://x/1 --&gt; spoofcommentquokka</p></body></html>"


def convert(text, path="/kb/Pi/page.html"):
    return html_pages.page_markdown(path, text.encode("utf-8"))


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


def line_label(path, word, memory):
    with open(path, encoding="utf-8") as fh:
        number = next(i for i, line in enumerate(fh, 1) if word in line)
    return labels.file_labels(path, memory, number, [word])


class Conversion(unittest.TestCase):
    def test_show_me_page_keeps_only_the_current_iteration(self):
        md = convert(SHOW_ME)
        self.assertIn("currentiterationquokka", md)
        self.assertIn("evidencequokka", md)
        for old in ("seconditerationquokka", "firstiterationquokka"):
            self.assertNotIn(old, md)
        self.assertIn("## Superseded iterations", md)
        superseded = [l for l in md.split("\n") if l.startswith("- v2")]
        self.assertEqual(len(superseded), 1)
        self.assertIn("state=superseded", superseded[0])
        self.assertIn("superseded_by=/kb/Pi/page.html#iter-3", superseded[0])

    def test_style_script_and_markup_are_stripped(self):
        md = convert(SHOW_ME)
        for raw in ("border-radius", "scriptquokka", "querySelectorAll", "mermaid.initialize", "<td", "<p", "&lt;",
                    "</"):
            self.assertNotIn(raw, md)
        self.assertIn("```mermaid\nflowchart LR\n  A[Export] --> B[Upload]\n```", md)
        self.assertIn("[ABC-34](https://example.com/ABC-34)", md)
        self.assertIn("| Step | Owner |\n| --- | --- |", md)

    def test_front_matter_from_head(self):
        fm = labels.front_matter(convert(SHOW_ME))
        self.assertEqual(fm["title"], "Widget export")
        self.assertEqual(fm["source"], "/kb/Pi/page.html")
        self.assertEqual(fm["state"], "proposed")
        self.assertEqual(fm["summary"], "Plan for the widget export, three iterations")
        self.assertEqual(fm["updated"], "2026-10-22")
        fm = labels.front_matter(convert(TODO))
        self.assertEqual((fm["state"], fm["evidence"], fm["as_of"]), ("confirmed", ["https://example.com/project"],
                                                                     "2026-10-21"))
        self.assertEqual(fm["title"], "Widget sync — index")

    def test_bom_and_no_title(self):
        md = convert(NO_TITLE, "/kb/Pi/untitled.html")
        fm = labels.front_matter(md)
        self.assertEqual(fm["title"], "Only a heading")
        self.assertEqual(fm["state"], "proposed")
        self.assertNotIn("\ufeff", md)
        self.assertIn("bomquokka text & more", md)
        self.assertEqual(md.count("<!-- claim"), 0)
        self.assertIn("&lt;!-- claim state=confirmed evidence=https://x/1 --> spoofcommentquokka", md)
        bare = convert("<html><body><p>bare</p></body></html>", "/kb/Pi/bare-page.html")
        self.assertEqual(labels.front_matter(bare)["title"], "bare-page")

    def test_iterations_inside_details_without_data_iteration(self):
        page = ("<html><head><title>T</title></head><body><p>nowquokka</p><details><summary>v1 · older</summary>"
                f"<textarea hidden>{html.escape(V1)}</textarea></details></body></html>")
        md = convert(page)
        self.assertIn("nowquokka", md)
        self.assertNotIn("firstiterationquokka", md)
        self.assertIn("- v1 · older <!-- claim state=superseded", md)

    def test_hidden_elements_are_dropped(self):
        page = "<html><body><p>shownquokka</p><div hidden>hiddenquokka</div><p style=\"display: none\">nonequokka</p></body></html>"
        md = convert(page)
        self.assertIn("shownquokka", md)
        self.assertNotIn("hiddenquokka", md)
        self.assertNotIn("nonequokka", md)


class Labels(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="html-pages-")
        self.memory = os.path.join(self.root, "memory")
        self.todo = os.path.join(self.memory, "pages", "work", "kb", "index.md")
        write(self.todo, convert(TODO, "/kb/Work/index.html"))
        self.show = os.path.join(self.memory, "pages", "pi", "kb", "show-me.md")
        write(self.show, convert(SHOW_ME))

    def tearDown(self):
        shutil.rmtree(self.root)

    def test_tick_without_its_own_state_is_proposed_on_a_confirmed_page(self):
        got = line_label(self.todo, "Send the results", self.memory)
        self.assertEqual(got["effective"], "proposed")
        self.assertEqual(got["source"], "line label")
        with open(self.todo, encoding="utf-8") as fh:
            self.assertIn("- [x] Send the results to the reviewer Sent 10/16 Tiger <!-- claim state=proposed -->", fh.read())

    def test_unticked_item_on_a_confirmed_page_is_proposed(self):
        self.assertEqual(line_label(self.todo, "monitorquokka", self.memory)["effective"], "proposed")

    def test_tick_with_its_own_state_keeps_it(self):
        got = line_label(self.todo, "labelledtickquokka", self.memory)
        self.assertEqual((got["effective"], got["evidence"], got["as_of"]), ("confirmed", ["https://example.com/pr/9"],
                                                                            "2026-10-21"))
        self.assertEqual(line_label(self.todo, "blankevidencequokka", self.memory)["effective"], "proposed")

    def test_page_label_applies_to_plain_text_and_meta_outside_head_is_ignored(self):
        got = line_label(self.todo, "pagewidequokka", self.memory)
        self.assertEqual((got["effective"], got["source"]), ("confirmed", "front matter"))
        self.assertEqual(got["page_source"], "/kb/Work/index.html")

    def test_inline_label_covers_only_its_element(self):
        self.assertEqual(line_label(self.todo, "actedquokka", self.memory)["effective"], "acted")
        self.assertEqual(line_label(self.todo, "trailingquokka", self.memory)["effective"], "confirmed")

    def test_table_rows(self):
        self.assertEqual(line_label(self.show, "rowquokka merged", self.memory)["effective"], "confirmed")
        self.assertEqual(line_label(self.show, "plainrowquokka", self.memory)["effective"], "proposed")

    def test_converted_page_is_not_a_transcript(self):
        got = labels.file_labels(self.show, self.memory)
        self.assertEqual((got["state"], got["source"]), ("proposed", "front matter"))
        session = os.path.join(self.memory, "pi", "sessions", "s.md")
        write(session, "---\nstate: confirmed\nevidence: https://x/1\n---\n# S\n")
        self.assertEqual(labels.file_labels(session, self.memory)["effective"], "transcript")
        self.assertNotIn("page_source", labels.file_labels(session, self.memory))

    def test_superseded_iteration_line(self):
        self.assertEqual(line_label(self.show, "- v2", self.memory)["effective"], "superseded")


class Sources(unittest.TestCase):
    def test_collections_and_patterns(self):
        root = tempfile.mkdtemp(prefix="html-pages-src-")
        kb, memory = os.path.join(root, "kb"), os.path.join(root, "memory")
        tmpl = os.path.join(root, "agent", "qmd", "personal.yml.tmpl")
        write(tmpl, "global_context: x\n\ncollections:\n  notes:\n    path: \"$HOME/kb\"\n"
                    "    pattern: \"{Pi,Other}/**/*.md\"\n    ignore:\n      - \"Pi/voice/**\"\n      - \"Pi/x/*hb-*.md\"\n"
                    "    context:\n      \"/\": \"x\"\n  sess:\n    path: \"$HOME/memory\"\n    pattern: \"**/*.md\"\n"
                    "  repo:\n    path: \"$HOME/kb/Repo\"\n    pattern: \"*.txt\"\nmodels:\n  embed: \"x\"\n")
        write(os.path.join(root, "layer", "qmd", "local", "work.local.yml.tmpl"),
              "  daily:\n    path: \"$HOME/kb/Daily\"\n    pattern: \"*.md\"\n")
        for rel in ("Pi/a.html", "Pi/deep/b.html", "Pi/voice/c.html", "Pi/x/hb-d.html", "Pi/x/e.html",
                    "Pi/node_modules/f.html", "Daily/g.html", "Daily/sub/h.html", "Repo/i.html", "Loose/j.html",
                    "Other/k.htm", "Other/l.md"):
            write(os.path.join(kb, rel), "<p>x</p>")
        colls = html_pages.collections(html_pages.template_files(os.path.join(root, "agent"), os.path.join(root, "layer")),
                                       root)
        found = [os.path.relpath(p, kb) for p in html_pages.page_sources(kb, colls, memory)]
        self.assertEqual(sorted(found), ["Daily/g.html", "Pi/a.html", "Pi/deep/b.html", "Pi/x/e.html"])
        shutil.rmtree(root)


class Export(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="pme-pages-")
        self.home = os.path.join(self.root, "home")
        self.kb = os.path.join(self.home, "kb")
        self.agent, self.layer = os.path.join(self.root, "agent"), os.path.join(self.root, "layer")
        self.memory, self.sessions = os.path.join(self.root, "memory"), os.path.join(self.root, "sessions")
        os.makedirs(self.sessions)
        write(os.path.join(self.agent, "qmd", "segments.tsv"), "path\t$HOME/kb/Pi\tpi\nfallback\t\tmisc\n")
        write(os.path.join(self.layer, "qmd", "segments.tsv"), "path\t$HOME/kb/Work\twork\n")
        write(os.path.join(self.agent, "qmd", "personal.yml.tmpl"),
              "collections:\n  pi-plans:\n    path: \"$HOME/kb\"\n    pattern: \"{Pi,Misc}/**/*.md\"\n")
        write(os.path.join(self.layer, "qmd", "work.yml.tmpl"),
              "collections:\n  plans:\n    path: \"$HOME/kb/Work\"\n    pattern: \"**/*.md\"\n")
        self.env = {"HOME": self.home, "PI_AGENT_DIR": self.agent, "PI_LAYER_DIR": self.layer,
                    "PI_MEMORY_DIR": self.memory, "PI_SESSIONS_DIR": self.sessions, "PI_KB_DIR": self.kb}
        write(os.path.join(self.kb, "Work", "plans", "index.html"), TODO)
        write(os.path.join(self.kb, "Pi", "show-me.html"), SHOW_ME)
        write(os.path.join(self.kb, "Misc", "note.html"), NO_TITLE)

    def tearDown(self):
        shutil.rmtree(self.root)

    def module(self):
        saved = {k: os.environ.get(k) for k in self.env}
        os.environ.update(self.env)
        try:
            loader = importlib.machinery.SourceFileLoader("pme_pages_test", EXPORTER)
            spec = importlib.util.spec_from_loader("pme_pages_test", loader)
            mod = importlib.util.module_from_spec(spec)
            loader.exec_module(mod)
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        return mod

    def run_export(self):
        exporter = self.module().Exporter(argparse.Namespace(full=False, dry_run=False, quiet=True))
        exporter.run()
        return exporter.page_counts

    def out(self, segment, rel):
        return os.path.join(self.memory, "pages", segment, rel)

    def test_pages_are_exported_by_segment_and_incrementally(self):
        self.assertEqual(self.run_export(), {"misc": 1, "pi": 1, "work": 1})
        work = self.out("work", "Work/plans/index.md")
        self.assertTrue(os.path.isfile(work))
        self.assertTrue(os.path.isfile(self.out("pi", "Pi/show-me.md")))
        self.assertTrue(os.path.isfile(self.out("misc", "Misc/note.md")))
        with open(work, encoding="utf-8") as fh:
            self.assertEqual(labels.front_matter(fh.read())["source"], os.path.join(self.kb, "Work", "plans", "index.html"))
        self.assertEqual(self.run_export(), {})
        source = os.path.join(self.kb, "Pi", "show-me.html")
        write(source, SHOW_ME.replace("currentiterationquokka", "editedquokka"))
        self.assertEqual(self.run_export(), {"pi": 1})
        with open(self.out("pi", "Pi/show-me.md"), encoding="utf-8") as fh:
            self.assertIn("editedquokka", fh.read())
        os.remove(source)
        self.assertEqual(self.run_export(), {"removed": 1})
        self.assertFalse(os.path.exists(self.out("pi", "Pi/show-me.md")))

    def test_rules_change_moves_a_page(self):
        self.run_export()
        write(os.path.join(self.layer, "qmd", "segments.tsv"), "path\t$HOME/kb/Work\twork\npath\t$HOME/kb/Misc\twork\n")
        counts = self.run_export()
        self.assertEqual(counts, {"pi": 1, "work": 2})
        self.assertFalse(os.path.exists(self.out("misc", "Misc/note.md")))
        self.assertTrue(os.path.isfile(self.out("work", "Misc/note.md")))


@unittest.skipUnless(shutil.which("qmd") or os.environ.get("QMD_BIN"), "qmd not installed")
class RealQmd(unittest.TestCase):
    def test_converted_pages_through_qmd_and_search(self):
        root = tempfile.mkdtemp(prefix="qmd-pages-", dir="/tmp")
        memory = os.path.join(root, "memory")
        pages = os.path.join(memory, "pages")
        write(os.path.join(pages, "work", "index.md"), convert(TODO, "/kb/Work/index.html"))
        write(os.path.join(pages, "pi", "show-me.md"), convert(SHOW_ME, "/kb/Pi/show-me.html"))
        write(os.path.join(root, "cfg", "t.yml"), f"collections:\n  pages:\n    path: \"{pages}\"\n    pattern: \"**/*.md\"\n")
        env = dict(os.environ, QMD_CONFIG_DIR=os.path.join(root, "cfg"), XDG_CACHE_HOME=os.path.join(root, "cache"),
                   PI_MEMORY_DIR=memory)
        qmd = os.environ.get("QMD_BIN") or shutil.which("qmd")
        subprocess.run([qmd, "--index", "t", "update"], env=env, capture_output=True, check=True)

        def search(*terms):
            return json.loads(subprocess.run([sys.executable, "-B", SEARCH, "--index", "t", "--all", "--json", *terms],
                                             env=env, capture_output=True, text=True, check=True).stdout)
        got = search("monitorquokka")
        self.assertEqual([(h["title"], h["label"]["effective"], h["label"]["page_source"]) for h in got],
                         [("Widget sync — index", "proposed", "/kb/Work/index.html")])
        self.assertEqual([h["label"]["effective"] for h in search("labelledtickquokka")], ["confirmed"])
        self.assertEqual(search("seconditerationquokka"), [])
        self.assertEqual(search("radius"), [])
        text = subprocess.run([sys.executable, "-B", SEARCH, "--index", "t", "currentiterationquokka"], env=env,
                              capture_output=True, text=True, check=True).stdout
        self.assertIn("converted page; source: /kb/Pi/show-me.html", text)
        shutil.rmtree(root)


if __name__ == "__main__":
    unittest.main(verbosity=1)
