#!/usr/bin/env python3
"""Tests for qmd/search and qmd/labels.py.  Run: python3 -B ~/.pi/agent/qmd/tests/test_search.py"""
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
SEARCH = os.path.join(QMD_DIR, "search")
sys.path.insert(0, QMD_DIR)
import labels  # noqa: E402


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


def search_module():
    loader = importlib.machinery.SourceFileLoader("qmd_search_under_test", SEARCH)
    spec = importlib.util.spec_from_loader("qmd_search_under_test", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


class Labels(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="qmd-labels-")
        self.memory = os.path.join(self.root, "memory")

    def file(self, rel, text):
        path = os.path.join(self.root, rel)
        write(path, text)
        return path

    def test_front_matter_list_and_scalars(self):
        path = self.file("a.md", "---\nstate: Confirmed\nevidence:\n  - https://x/pull/1\n  - 'o/r#2'\n"
                                 "as_of: \"2026-10-22\"\nother: kept\n---\n# A\n")
        got = labels.file_labels(path, self.memory)
        self.assertEqual((got["state"], got["effective"], got["evidence"], got["as_of"], got["source"]),
                         ("confirmed", "confirmed", ["https://x/pull/1", "o/r#2"], "2026-10-22", "front matter"))

    def test_flow_list_evidence(self):
        got = labels.file_labels(self.file("a.md", "---\nstate: acted\nevidence: [a, \"b\"]\n---\n"), self.memory)
        self.assertEqual(got["evidence"], ["a", "b"])

    def test_unterminated_front_matter_is_ignored(self):
        got = labels.file_labels(self.file("a.md", "---\nstate: confirmed\n# no end\n"), self.memory)
        self.assertEqual((got["state"], got["source"]), ("proposed", "unlabelled"))

    def test_confirmed_without_evidence_ranks_as_proposed(self):
        got = labels.file_labels(self.file("a.md", "---\nstate: confirmed\n---\n"), self.memory)
        self.assertEqual((got["state"], got["effective"]), ("confirmed", "proposed"))
        self.assertIn("no evidence", got["note"])

    def test_unknown_state_reads_as_proposed(self):
        got = labels.file_labels(self.file("a.md", "---\nstate: done\nevidence: x\n---\n"), self.memory)
        self.assertEqual(got["effective"], "proposed")

    def test_memory_dir_defaults_to_transcript_even_with_published_front_matter(self):
        path = os.path.join(self.memory, "pi", "sessions", "s.md")
        write(path, "---\npublished:\n  - {at: t, tool: \"git push\", target: \"r\", result: ok}\n---\n# S\n")
        got = labels.file_labels(path, self.memory)
        self.assertEqual((got["effective"], got["source"]), ("transcript", "path default"))
        self.assertEqual(labels.front_matter(labels.read_head(path))["published"], ['{at: t, tool: "git push", target: "r", result: ok}'])

    def test_claim_comment_on_hit_line_wins(self):
        path = self.file("a.md", "---\nstate: superseded\n---\n# A\n"
                                 "- merged <!-- claim state=confirmed evidence=https://x/1,o/r#2 as_of=2026-10-22 -->\n"
                                 "- monitor <!-- claim state=proposed -->\n")
        got = labels.file_labels(path, self.memory, line=5)
        self.assertEqual((got["effective"], got["evidence"], got["source"]), ("confirmed", ["https://x/1", "o/r#2"], "line label"))
        self.assertEqual(got["claims"], {"confirmed": 1, "proposed": 1})
        self.assertEqual(labels.file_labels(path, self.memory)["effective"], "superseded")

    def test_html_meta_and_data_attributes(self):
        path = self.file("p.html", "<!doctype html><html><head>\n<meta content=\"acted\" name=\"show-me:state\">\n"
                                   "<meta name='show-me:evidence' content='https://x/1'>\n"
                                   "<meta name=\"show-me:evidence\" content=\"o/r#2\">\n"
                                   "<meta name=\"show-me:as-of\" content=\"2026-10-21\"></head><body>\n"
                                   "<li data-state=\"confirmed\" data-evidence=\"https://x/3\">merged</li>\n"
                                   "<li class=\"done\">monitor</li>\n</body></html>\n")
        got = labels.file_labels(path, self.memory)
        self.assertEqual((got["state"], got["evidence"], got["as_of"], got["source"]),
                         ("acted", ["https://x/1", "o/r#2"], "2026-10-21", "html meta"))
        self.assertEqual(got["claims"], {"confirmed": 1})
        line = labels.file_labels(path, self.memory, line=6)
        self.assertEqual((line["effective"], line["evidence"]), ("confirmed", ["https://x/3"]))
        tick = labels.file_labels(path, self.memory, line=7)
        self.assertEqual((tick["effective"], tick["evidence"], tick["source"]), ("proposed", [], "unlabelled item"))
        self.assertEqual(labels.file_labels(path, self.memory, line=2)["effective"], "acted")

    def test_label_is_never_borrowed_from_a_neighbouring_line(self):
        path = self.file("adjacent.md", "# Claims\n- not verified unverifiedquokka\n"
                                        "- merged <!-- claim state=confirmed evidence=https://x/1 -->\n")
        got = labels.file_labels(path, self.memory, line=2, terms=["unverifiedquokka"])
        self.assertEqual((got["effective"], got["evidence"], got["source"]), ("proposed", [], "unlabelled"))
        self.assertEqual(labels.file_labels(path, self.memory, line=3)["effective"], "confirmed")
        self.assertEqual(labels.file_labels(path, self.memory, line=1)["effective"], "proposed")

    def test_transcript_stays_transcript_whatever_it_quotes(self):
        path = os.path.join(self.memory, "pi", "sessions", "t.md")
        write(path, "---\nstate: confirmed\nevidence: https://x/0\n---\n# Session\nuser pasted:\n"
                    "- transcriptquokka <!-- claim state=confirmed evidence=https://x/1 -->\n")
        line = labels.file_labels(path, self.memory, line=7)
        self.assertEqual((line["state"], line["effective"], line["evidence"], line["source"]),
                         ("transcript", "transcript", [], "path default"))
        self.assertEqual((line["asserted"]["state"], line["asserted"]["evidence"]), ("confirmed", ["https://x/1"]))
        self.assertIn("not applied", line["note"])
        whole = labels.file_labels(path, self.memory)
        self.assertEqual((whole["effective"], whole["asserted"]["evidence"]), ("transcript", ["https://x/0"]))
        html = os.path.join(self.memory, "pi", "p.html")
        write(html, "<html><head><meta name=\"show-me:state\" content=\"confirmed\">"
                    "<meta name=\"show-me:evidence\" content=\"https://x/2\"></head><body>\n"
                    "<li data-state=\"confirmed\" data-evidence=\"https://x/3\">x</li>\n</body></html>\n")
        self.assertEqual(labels.file_labels(html, self.memory, line=2)["effective"], "transcript")
        self.assertEqual(labels.file_labels(html, self.memory)["effective"], "transcript")

    def test_unlabelled_ticks_and_items_are_proposed(self):
        page = self.file("tick.html", "<html><head>\n<meta name=\"show-me:state\" content=\"confirmed\">\n"
                                      "<meta name=\"show-me:evidence\" content=\"https://x/1\">\n</head><body>\n"
                                      "<li class=\"done\">untraceable tickquokka</li>\n"
                                      "<input type=\"checkbox\" checked> monitor\n"
                                      "<p>\u2713 shipped</p>\n"
                                      "<li data-state=\"acted\"><span class=\"done\">\u2713</span> emailed</li>\n"
                                      "<p>prose under the page label</p>\n</body></html>\n")
        for line in (5, 6, 7):
            got = labels.file_labels(page, self.memory, line=line)
            self.assertEqual((line, got["effective"], got["evidence"]), (line, "proposed", []))
        self.assertEqual(labels.file_labels(page, self.memory, line=8)["effective"], "acted")
        self.assertEqual(labels.file_labels(page, self.memory, line=9)["effective"], "confirmed")
        note = self.file("ticks.md", "---\nstate: confirmed\nevidence: https://x/1\n---\n- [x] monitor created\n"
                                     "- [x] merged <!-- claim state=confirmed evidence=https://x/2 -->\n")
        self.assertEqual(labels.file_labels(note, self.memory, line=5)["effective"], "proposed")
        self.assertEqual(labels.file_labels(note, self.memory, line=6)["evidence"], ["https://x/2"])

    def test_empty_evidence_is_no_evidence(self):
        variants = {"flow.md": "---\nstate: confirmed\nevidence: [\"\"]\n---\n",
                    "scalar.md": "---\nstate: confirmed\nevidence: \"\"\n---\n",
                    "spaces.md": "---\nstate: confirmed\nevidence: [ , '  ' ]\n---\n",
                    "items.md": "---\nstate: confirmed\nevidence:\n  - \"\"\n  - ''\n---\n"}
        for name, text in variants.items():
            got = labels.file_labels(self.file(name, text), self.memory)
            self.assertEqual((name, got["effective"], got["evidence"]), (name, "proposed", []))
        comment = self.file("c.md", "- x <!-- claim state=confirmed evidence=\"\" -->\n- y <!-- claim state=confirmed evidence=, -->\n")
        for line in (1, 2):
            self.assertEqual(labels.file_labels(comment, self.memory, line=line)["effective"], "proposed")
        page = self.file("m.html", "<html><head><meta name=\"show-me:state\" content=\"confirmed\">"
                                   "<meta name=\"show-me:evidence\" content=\" \"></head><body>\n"
                                   "<li data-state=\"confirmed\" data-evidence=\"\">x</li>\n</body></html>\n")
        self.assertEqual(labels.file_labels(page, self.memory)["effective"], "proposed")
        self.assertEqual(labels.file_labels(page, self.memory, line=2)["effective"], "proposed")

    def test_bom_before_front_matter(self):
        path = self.file("bom.md", "\ufeff---\nstate: superseded\nsuperseded_by: newer.md\n---\n# old\n- line five\n")
        got = labels.file_labels(path, self.memory)
        self.assertEqual((got["effective"], got["superseded_by"]), ("superseded", "newer.md"))
        self.assertEqual(labels.front_matter("\ufeff---\nstate: acted\n---\n")["state"], "acted")
        page = self.file("bom.html", "\ufeff<!doctype html><html><head><meta name=\"show-me:state\" content=\"acted\"></head></html>")
        self.assertEqual(labels.file_labels(page, self.memory)["effective"], "acted")
        numbered = self.file("bomline.md", "\ufeff# t\n- x <!-- claim state=acted -->\n")
        self.assertEqual(labels.file_labels(numbered, self.memory, line=2)["effective"], "acted")

    def test_meta_only_from_head_and_items_only_their_own_attributes(self):
        body_meta = self.file("body.html", "<html><head></head><body>\n<meta name=\"show-me:state\" content=\"confirmed\">"
                                           "<meta name=\"show-me:evidence\" content=\"https://x/1\">\n</body></html>")
        self.assertEqual(labels.file_labels(body_meta, self.memory)["effective"], "proposed")
        same = self.file("same.html", "<html><head></head><body>\n<ul><li data-state=\"proposed\">first quokka</li>"
                                      "<li data-state=\"confirmed\" data-evidence=\"https://x/1\">second item</li></ul>\n</body></html>")
        ambiguous = labels.file_labels(same, self.memory, line=2)
        self.assertEqual((ambiguous["effective"], ambiguous["evidence"]), ("proposed", []))
        self.assertIn("different labels", ambiguous["note"])
        first = labels.file_labels(same, self.memory, line=2, terms=["quokka"])
        self.assertEqual((first["effective"], first["evidence"]), ("proposed", []))
        second = labels.file_labels(same, self.memory, line=2, terms=["second"])
        self.assertEqual((second["effective"], second["evidence"]), ("confirmed", ["https://x/1"]))
        two = self.file("two.md", "- a quokka <!-- claim state=proposed --> - b merged <!-- claim state=confirmed evidence=https://x/1 -->\n")
        self.assertEqual(labels.file_labels(two, self.memory, line=1, terms=["quokka"])["evidence"], [])
        self.assertEqual(labels.file_labels(two, self.memory, line=1, terms=["merged"])["evidence"], ["https://x/1"])

    def test_unreadable_file(self):
        got = labels.file_labels(os.path.join(self.root, "gone.md"), self.memory)
        self.assertEqual((got["effective"], got["source"]), ("proposed", "unreadable"))


class Wrapper(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="qmd-search-")
        self.docs = os.path.join(self.root, "docs")
        self.memory = os.path.join(self.root, "memory")
        self.config = os.path.join(self.root, "config")
        write(os.path.join(self.config, "t.yml"),
              f"global_context: \"x\"\n\ncollections:\n  docs:\n    path: \"{self.docs}\"\n    pattern: \"**/*.md\"\n"
              f"    context:\n      \"/\": \"d\"\n  sess:\n    path: {self.memory}\n    pattern: \"**/*.md\"\n"
              "models:\n  embed: \"hf:x\"\n")
        write(os.path.join(self.docs, "c.md"), "---\nstate: confirmed\nevidence: https://x/pull/1\n---\n# C\n")
        write(os.path.join(self.docs, "a.md"), "---\nstate: acted\n---\n# A\n")
        write(os.path.join(self.docs, "p.md"), "# P\n")
        write(os.path.join(self.docs, "s.md"), "---\nstate: superseded\nsuperseded_by: c.md\n---\n# S\n")
        write(os.path.join(self.memory, "pi", "sessions", "t.md"), "# T\n")
        hits = [{"docid": f"#{n}", "score": 0.9, "file": f"qmd://{f}?index=t", "line": 1, "title": n, "snippet": "@@ x\nline"}
                for n, f in (("T", "sess/pi/sessions/t.md"), ("S", "docs/s.md"), ("P", "docs/p.md"),
                             ("A", "docs/a.md"), ("C", "docs/c.md"), ("X", "gone/x.md"))]
        self.fake = os.path.join(self.root, "fake-qmd")
        write(self.fake, "#!/bin/sh\necho \"$@\" > " + os.path.join(self.root, "args") + "\ncat <<'EOF'\n"
              + json.dumps(hits) + "\nEOF\n")
        os.chmod(self.fake, 0o755)
        self.env = dict(os.environ, QMD_BIN=self.fake, QMD_CONFIG_DIR=self.config, PI_MEMORY_DIR=self.memory)

    def run_search(self, *args):
        return subprocess.run([sys.executable, "-B", SEARCH, *args], env=self.env, capture_output=True, text=True, check=True)

    def test_config_parser(self):
        roots = search_module().collection_paths(os.path.join(self.config, "t.yml"))
        self.assertEqual(roots, {"docs": self.docs, "sess": self.memory})

    def test_rank_hide_superseded_and_pass_args(self):
        out = self.run_search("--index", "t", "-c", "docs", "-n", "7", "disposition", "monitor", "--", "--min-score", "0.2")
        order = [line.split("]")[0].split("[")[1] for line in out.stdout.splitlines() if line[:1].isdigit()]
        self.assertEqual(order, ["confirmed", "acted", "proposed", "proposed", "transcript"])
        self.assertIn("1 superseded hit hidden", out.stdout)
        self.assertIn("evidence (not checked): https://x/pull/1", out.stdout)
        self.assertIn("[unresolved path]", out.stdout)
        with open(os.path.join(self.root, "args"), encoding="utf-8") as fh:
            self.assertEqual(fh.read().split(), ["--index", "t", "search", "disposition", "monitor", "--format", "json",
                                                 "-n", "7", "-c", "docs", "--min-score", "0.2"])

    def test_transcript_quote_is_shown_not_applied(self):
        write(os.path.join(self.memory, "pi", "sessions", "t.md"), "- x <!-- claim state=confirmed evidence=https://x/9 -->\n")
        out = self.run_search("--index", "t", "x").stdout
        self.assertIn("[transcript] qmd://sess/pi/sessions/t.md", out)
        self.assertIn("quoted label, not applied: confirmed evidence https://x/9", out)

    def test_all_shows_superseded_last_and_json(self):
        out = json.loads(self.run_search("--index", "t", "--all", "--json", "--query", "x").stdout)
        self.assertEqual([h["title"] for h in out], ["C", "A", "P", "X", "T", "S"])
        self.assertEqual(out[-1]["label"]["superseded_by"], "c.md")
        with open(os.path.join(self.root, "args"), encoding="utf-8") as fh:
            self.assertEqual(fh.read().split()[2], "query")


@unittest.skipUnless(shutil.which("qmd") or os.environ.get("QMD_BIN"), "qmd not installed")
class RealQmd(unittest.TestCase):
    def test_throwaway_index(self):
        root = tempfile.mkdtemp(prefix="qmd-real-", dir="/tmp")
        docs, memory = os.path.join(root, "docs"), os.path.join(root, "memory")
        write(os.path.join(docs, "plan.md"), "---\nstate: confirmed\nevidence: https://github.com/o/r/pull/9\n"
                                             "as_of: 2026-10-22\n---\n# Plan heading\n\nquokkaword merged\n")
        write(os.path.join(docs, "old.md"), "---\nstate: superseded\nsuperseded_by: plan.md\n---\n# Old\n\nquokkaword old\n")
        write(os.path.join(memory, "pi", "sessions", "2026-10-22-s.md"),
              "---\npublished:\n  - {at: 2026-10-22T00:00:00Z, tool: \"gh pr comment\", target: \"o/r#9\", result: ok}\n"
              "---\n# Session title\n\nquokkaword in a session\n")
        write(os.path.join(root, "cfg", "t.yml"),
              f"collections:\n  docs:\n    path: \"{docs}\"\n    pattern: \"**/*.md\"\n"
              f"  sess:\n    path: \"{memory}\"\n    pattern: \"**/*.md\"\n")
        env = dict(os.environ, QMD_CONFIG_DIR=os.path.join(root, "cfg"), XDG_CACHE_HOME=os.path.join(root, "cache"),
                   PI_MEMORY_DIR=memory)
        qmd = os.environ.get("QMD_BIN") or shutil.which("qmd")
        subprocess.run([qmd, "--index", "t", "update"], env=env, capture_output=True, check=True)
        out = json.loads(subprocess.run([sys.executable, "-B", SEARCH, "--index", "t", "--json", "quokkaword"], env=env,
                                        capture_output=True, text=True, check=True).stdout)
        self.assertEqual([(h["title"], h["label"]["effective"]) for h in out],
                         [("Plan heading", "confirmed"), ("Session title", "transcript")])
        self.assertEqual(out[0]["label"]["evidence"], ["https://github.com/o/r/pull/9"])
        self.assertFalse(os.path.exists(os.path.expanduser("~/.cache/qmd/t.sqlite")))
        raw = json.loads(subprocess.run([qmd, "--index", "t", "search", "quokkaword", "--format", "json"], env=env,
                                        capture_output=True, text=True, check=True).stdout)
        self.assertEqual(sorted(raw[0]), sorted(k for k in raw[0] if k in
                                                ("docid", "score", "file", "line", "title", "context", "snippet")))
        shutil.rmtree(root)

    def test_adversary_queries(self):
        root = tempfile.mkdtemp(prefix="qmd-real-adv-", dir="/tmp")
        docs, memory = os.path.join(root, "docs"), os.path.join(root, "memory")
        write(os.path.join(docs, "adjacent.md"), "# Claims\n- unverifiedquokka never checked\n"
                                                 "- merged <!-- claim state=confirmed evidence=https://x/1 -->\n")
        write(os.path.join(docs, "spoof.md"), "---\nstate: confirmed\nevidence: [\"\"]\n---\n# Spoof\n\nspoofquokka\n")
        write(os.path.join(docs, "bom.md"), "\ufeff---\nstate: superseded\nsuperseded_by: x.md\n---\n# Old\n\nbomquokka\n")
        write(os.path.join(docs, "tick.html"), "<html><head>\n<meta name=\"show-me:state\" content=\"confirmed\">\n"
                                               "<meta name=\"show-me:evidence\" content=\"https://x/1\">\n</head><body>\n"
                                               "<li class=\"done\">tickquokka</li>\n</body></html>\n")
        write(os.path.join(memory, "pi", "sessions", "s.md"),
              "# Session\n\nuser pasted:\n- transcriptquokka <!-- claim state=confirmed evidence=https://x/1 -->\n")
        write(os.path.join(root, "cfg", "t.yml"),
              f"collections:\n  docs:\n    path: \"{docs}\"\n    pattern: \"**/*.{{md,html}}\"\n"
              f"  sess:\n    path: \"{memory}\"\n    pattern: \"**/*.md\"\n")
        env = dict(os.environ, QMD_CONFIG_DIR=os.path.join(root, "cfg"), XDG_CACHE_HOME=os.path.join(root, "cache"),
                   PI_MEMORY_DIR=memory)
        qmd = os.environ.get("QMD_BIN") or shutil.which("qmd")
        subprocess.run([qmd, "--index", "t", "update"], env=env, capture_output=True, check=True)
        got = {}
        for word in ("unverifiedquokka", "spoofquokka", "tickquokka", "transcriptquokka", "bomquokka"):
            out = json.loads(subprocess.run([sys.executable, "-B", SEARCH, "--index", "t", "--all", "--json", word], env=env,
                                            capture_output=True, text=True, check=True).stdout)
            got[word] = [h["label"]["effective"] for h in out]
        self.assertEqual(got, {"unverifiedquokka": ["proposed"], "spoofquokka": ["proposed"], "tickquokka": ["proposed"],
                               "transcriptquokka": ["transcript"], "bomquokka": ["superseded"]})
        shutil.rmtree(root)


if __name__ == "__main__":
    unittest.main(verbosity=1)
