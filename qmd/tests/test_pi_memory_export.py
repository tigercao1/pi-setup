#!/usr/bin/env python3
"""Tests for bin/pi-memory-export.  Run: python3 -B ~/.pi/agent/qmd/tests/test_pi_memory_export.py"""
import argparse
import fcntl
import importlib.machinery
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

EXPORTER = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__)))),
                        "bin", "pi-memory-export")

PERSONAL_RULES = "\n".join([
    "skip\t/tmp*",
    "path\t$HOME/agent\tpi",
    "signal\t^(edit|write) .*\"path\": \"$HOME/agent/\tpi\t1\t100",
    "mixed\t$HOME\tpi",
    "fallback\t\tmisc",
]) + "\n"
WORK_RULES = "\n".join([
    "path\t$HOME/work\twork",
    "strong\t\\bABC-[0-9]{2,5}\\b\twork",
    "strong\t\\bacme-org\\b\twork",
    "signal\t\\bABC-[0-9]{3,5}\\b\twork\t10",
]) + "\n"


class Fixture:
    def __init__(self):
        self.root = tempfile.mkdtemp(prefix="pme-test-")
        self.home = os.path.join(self.root, "home")
        self.agent = os.path.join(self.root, "agent")
        self.layer = os.path.join(self.root, "layer")
        self.memory = os.path.join(self.root, "memory")
        self.sessions = os.path.join(self.root, "sessions")
        for d in (self.home, self.agent + "/qmd", self.layer + "/qmd", self.memory, self.sessions + "/slug"):
            os.makedirs(d, exist_ok=True)
        self.write(self.agent + "/qmd/segments.tsv", PERSONAL_RULES)
        self.write(self.layer + "/qmd/segments.tsv", WORK_RULES)
        self.env = {"HOME": self.home, "PI_AGENT_DIR": self.agent, "PI_LAYER_DIR": self.layer,
                    "PI_MEMORY_DIR": self.memory, "PI_SESSIONS_DIR": self.sessions}

    @staticmethod
    def write(path, text):
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)

    def session(self, sid, cwd, *messages, extra=()):
        path = os.path.join(self.sessions, "slug", f"{sid}.jsonl")
        lines = [{"type": "session", "id": sid, "cwd": cwd, "timestamp": "2026-10-22T20:00:00Z"}]
        lines += [{"type": "message", "message": {"role": role, "content": content}} for role, content in messages]
        lines += list(extra)
        self.write(path, "".join(json.dumps(line) + "\n" for line in lines))
        return path

    def module(self):
        saved = {k: os.environ.get(k) for k in self.env}
        os.environ.update(self.env)
        try:
            loader = importlib.machinery.SourceFileLoader("pme_under_test", EXPORTER)
            spec = importlib.util.spec_from_loader("pme_under_test", loader)
            mod = importlib.util.module_from_spec(spec)
            loader.exec_module(mod)
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        return mod

    def run(self, mod, full=False):
        mod.Exporter(argparse.Namespace(full=full, dry_run=False, quiet=True)).run()

    def exported(self, segment, sid):
        path = os.path.join(self.memory, segment, "sessions", f"2026-10-22-{sid}.md")
        if not os.path.isfile(path):
            return None
        with open(path, encoding="utf-8") as fh:
            return fh.read()


def append(path, role, text):
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"type": "message", "message": {"role": role, "content": text}}) + "\n")


class ConcurrentAppend(unittest.TestCase):
    def test_append_after_read_is_exported_on_next_run(self):
        fx = Fixture()
        path = fx.session("fixture", fx.home + "/agent", ("user", "old text"))
        mod = fx.module()
        original = mod.read_session

        def read_then_append(p, tasks):
            result = original(p, tasks)
            if not getattr(read_then_append, "done", False):
                read_then_append.done = True
                time.sleep(0.01)
                append(p, "user", "NEW TEXT APPENDED DURING EXPORT")
            return result

        mod.read_session = read_then_append
        fx.run(mod)
        first = fx.exported("pi", "fixture")
        mod.read_session = original
        fx.run(mod)
        self.assertIn("NEW TEXT APPENDED DURING EXPORT", fx.exported("pi", "fixture"))
        self.assertIn("old text", first)

    def test_append_after_record_is_exported_on_next_run(self):
        fx = Fixture()
        path = fx.session("fixture", fx.home + "/agent", ("user", "old text"))
        mod = fx.module()
        original_record = mod.Exporter.record

        def record_then_append(self, source, segment, out, text, fp):
            original_record(self, source, segment, out, text, fp)
            if not getattr(record_then_append, "done", False):
                record_then_append.done = True
                append(source, "user", "LATE APPEND")

        mod.Exporter.record = record_then_append
        fx.run(mod)
        mod.Exporter.record = original_record
        fx.run(mod)
        self.assertIn("LATE APPEND", fx.exported("pi", "fixture"))

    def test_unchanged_source_is_not_reread(self):
        fx = Fixture()
        fx.session("fixture", fx.home + "/agent", ("user", "old text"))
        mod = fx.module()
        fx.run(mod)
        calls = []
        original = mod.read_session
        mod.read_session = lambda p, t: calls.append(p) or original(p, t)
        fx.run(mod)
        self.assertEqual(calls, [])


class Invalidation(unittest.TestCase):
    def test_rules_change_reclassifies_unchanged_sources(self):
        fx = Fixture()
        fx.session("s1", fx.home, ("user", "talk about the acme-corp launch"))
        fx.run(fx.module())
        self.assertIsNotNone(fx.exported("pi", "s1"))
        with open(fx.layer + "/qmd/segments.tsv", "a", encoding="utf-8") as fh:
            fh.write("strong\tacme-corp\twork\n")
        fx.run(fx.module())
        self.assertIsNone(fx.exported("pi", "s1"))
        self.assertIsNotNone(fx.exported("work", "s1"))

    def test_override_change_moves_session(self):
        fx = Fixture()
        fx.session("s2", fx.home, ("user", "plain personal chat"))
        fx.run(fx.module())
        self.assertIsNotNone(fx.exported("pi", "s2"))
        fx.write(fx.layer + "/qmd/session-overrides.tsv", "# comment\ns2\twork\n")
        fx.run(fx.module())
        self.assertIsNone(fx.exported("pi", "s2"))
        self.assertIsNotNone(fx.exported("work", "s2"))


class Classification(unittest.TestCase):
    def test_single_strong_signal_in_user_text_routes_to_work(self):
        fx = Fixture()
        fx.session("s3", fx.home, ("user", "review https://github.com/acme-org/Repo/pull/1"),
                   ("assistant", [{"type": "text", "text": "ok"}]))
        fx.run(fx.module())
        self.assertIsNotNone(fx.exported("work", "s3"))

    def test_strong_work_signal_beats_personal_edits(self):
        fx = Fixture()
        edit = {"type": "toolCall", "name": "edit", "arguments": {"path": fx.home + "/agent/x.md"}}
        fx.session("s4", fx.home, ("user", "fix the skill, see ABC-5008"), ("assistant", [edit]))
        fx.run(fx.module())
        self.assertIsNotNone(fx.exported("work", "s4"))

    def test_personal_override_applies_when_layer_is_silent(self):
        fx = Fixture()
        fx.session("s5", fx.home, ("user", "ABC-1234 mentioned in passing"))
        fx.write(fx.agent + "/qmd/session-overrides.tsv", "s5\tpi\n")
        fx.run(fx.module())
        self.assertIsNotNone(fx.exported("pi", "s5"))

    def test_layer_override_wins_over_personal_override(self):
        fx = Fixture()
        fx.session("s6", fx.home, ("user", "plain"))
        fx.write(fx.agent + "/qmd/session-overrides.tsv", "s6\tpi\n")
        fx.write(fx.layer + "/qmd/session-overrides.tsv", "s6\twork\n")
        fx.run(fx.module())
        self.assertIsNotNone(fx.exported("work", "s6"))

    def test_cwd_path_rule_is_not_overridden_by_content(self):
        fx = Fixture()
        fx.session("s7", fx.home + "/agent", ("user", "ABC-5008"))
        fx.run(fx.module())
        self.assertIsNotNone(fx.exported("pi", "s7"))


class Locking(unittest.TestCase):
    def test_second_export_waits_for_the_lock(self):
        fx = Fixture()
        fx.session("s8", fx.home + "/agent", ("user", "hello"))
        env = dict(os.environ, **fx.env)
        with open(os.path.join(fx.memory, ".export.lock"), "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            proc = subprocess.Popen([sys.executable, "-B", EXPORTER, "--quiet"], env=env)
            time.sleep(1.0)
            self.assertIsNone(proc.poll())
            fcntl.flock(lock, fcntl.LOCK_UN)
        self.assertEqual(proc.wait(timeout=30), 0)
        self.assertIsNotNone(fx.exported("pi", "s8"))


if __name__ == "__main__":
    unittest.main(verbosity=1)
