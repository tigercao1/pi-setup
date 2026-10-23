#!/usr/bin/env python3
"""Tests for scripts/ledger-check.py --events.  Run: python3 -B ~/.pi/agent/skills/intake/tests/test_ledger_check.py"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

SCRIPT = os.path.join(os.path.dirname(os.path.dirname(os.path.realpath(__file__))), "scripts", "ledger-check.py")


def check(rows, commands):
    d = tempfile.mkdtemp(prefix="ledger-check-test-")
    ledger = os.path.join(d, "ledger.md")
    with open(ledger, "w") as fh:
        fh.write("".join(f"- {ts} · {phase} · {decision} · result: done · evidence: {d}\n"
                         for ts, phase, decision in rows))
    events = os.path.join(d, "events.jsonl")
    with open(events, "w") as fh:
        for ts, cmd in commands:
            call = {"type": "toolCall", "name": "bash", "arguments": {"command": cmd}}
            fh.write(json.dumps({"type": "message", "timestamp": ts,
                                 "message": {"role": "assistant", "content": [call]}}) + "\n")
    out = subprocess.run([sys.executable, "-B", SCRIPT, ledger, "--offline", "--events", events],
                         capture_output=True, text=True)
    return out.returncode, [line for line in out.stdout.splitlines() if line.startswith("UNLOGGED")]


T0 = "2026-10-22T20:00:00Z"
T1 = "2026-10-22T20:30:00Z"


class StackEvents(unittest.TestCase):
    def test_verifier_fixture_logged_stack_push_passes(self):
        self.assertEqual(check([(T0, "push", "gh stack push stack")], [(T0, "gh stack push")]), (0, []))

    def test_unlogged_stack_push_fails(self):
        code, lines = check([(T0, "start", "lead")], [(T0, "gh stack push")])
        self.assertEqual(code, 1)
        self.assertEqual(len(lines), 1)

    def test_row_for_a_different_verb_does_not_count(self):
        self.assertEqual(check([(T0, "push", "gh stack sync")], [(T0, "gh stack push")])[0], 1)

    def test_row_long_before_the_event_does_not_count(self):
        self.assertEqual(check([(T0, "push", "gh stack push")], [(T1, "gh stack push")])[0], 1)

    def test_one_row_covers_one_event(self):
        code, lines = check([(T0, "push", "gh stack push")], [(T0, "gh stack push"), (T1, "gh stack push")])
        self.assertEqual(code, 1)
        self.assertIn(T1, lines[0])

    def test_two_rows_cover_two_events(self):
        rows = [(T0, "push", "gh stack push"), (T1, "push", "gh stack push")]
        self.assertEqual(check(rows, [(T0, "gh stack push"), (T1, "gh stack push")]), (0, []))

    def test_stack_row_is_matched_by_worktree_when_named(self):
        rows = [(T0, "push", "gh stack push in wt-b"), (T0, "push", "gh stack push in wt-a")]
        cmds = [(T0, "cd /x/wt-a && gh stack push"), (T0, "cd /x/wt-b && gh stack push")]
        self.assertEqual(check(rows, cmds), (0, []))


class GitPush(unittest.TestCase):
    def test_git_dash_c_push_without_refspec_keys_on_worktree(self):
        cmd = "git -C /Users/me/wt/wt-1 push --force-with-lease"
        self.assertEqual(check([(T0, "push", "pushed wt-1 after rebase")], [(T0, cmd)])[0], 0)
        code, lines = check([(T0, "push", "pushed something else")], [(T0, cmd)])
        self.assertEqual(code, 1)
        self.assertIn("wt-1", lines[0])

    def test_qualified_push_keys_on_branch(self):
        cmd = "bash -c \"git -c core.hooksPath=/dev/null push -u origin HEAD:refs/heads/feat-x\""
        self.assertEqual(check([(T0, "push", "feat-x to origin")], [(T0, cmd)])[0], 0)
        self.assertEqual(check([(T0, "push", "other")], [(T0, cmd)])[0], 1)

    def test_plain_push_keys_on_branch(self):
        self.assertEqual(check([(T0, "push", "br-1")], [(T0, "git push origin br-1")])[0], 0)

    def test_cd_then_push_keys_on_directory(self):
        self.assertEqual(check([(T0, "push", "wt-9 pushed")], [(T0, "cd /x/wt-9 && git push")])[0], 0)


if __name__ == "__main__":
    unittest.main(verbosity=1)
