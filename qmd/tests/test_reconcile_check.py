#!/usr/bin/env python3
"""Tests for qmd/reconcile-check.  Run: python3 -B ~/.pi/agent/qmd/tests/test_reconcile_check.py"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

QMD_DIR = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
CHECK = os.path.join(QMD_DIR, "reconcile-check")

FAKE_GH = r'''#!/usr/bin/env python3
import json, sys
args = sys.argv[1:]
open(sys.argv[0] + ".log", "a").write(" ".join(args) + "\n")
prs = {"7": {"number": 7, "state": "MERGED", "isDraft": False, "mergedAt": "2026-10-21T14:10:54Z",
             "reviewDecision": "APPROVED", "headRefOid": "6713f141baa2f307", "url": "https://github.com/acme/app/pull/7",
             "body": "Run: bundle exec rake 'task[check]'"},
       "8": {"number": 8, "state": "OPEN", "isDraft": True, "mergedAt": None, "reviewDecision": "",
             "headRefOid": "abc", "url": "https://github.com/acme/app/pull/8", "body": ""}}
if args[:2] == ["pr", "view"] and args[2] in prs:
    print(json.dumps(prs[args[2]]))
elif args[:2] == ["issue", "view"] and args[2] == "3":
    print(json.dumps({"number": 3, "state": "CLOSED", "url": "https://github.com/acme/app/issues/3"}))
else:
    sys.stderr.write("GraphQL: Could not resolve to a PullRequest\n")
    sys.exit(1)
'''

EVIDENCE = "\n".join([
    "ts\tsession\tchannel\ttool\ttarget\tresult\tvia\tcall_id\texcerpt\tsource",
    "2026-10-20T19:55:12Z\ts1\tgithub\tgh api POST\trepos/acme/app/pulls/7/comments/9/replies\tok\tbash\tc1\t"
    "Codex is right that routing moved; the guard now lives in the router.\t/s/one.jsonl:1174",
    "2026-10-19T10:00:00Z\ts2\tclipboard\tslack-copy\tclipboard\tok\tbash\tc2\t"
    "Hey team, a quick alignment on the close flow screen two before we close\t/s/two.jsonl:40",
    "2026-10-19T11:00:00Z\ts2\tslack\tslack.send_message_draft\tC0C4VA8RRUM\tok\tmcp\tc3\t"
    "Extend and Close from the day-27 email, how it works\t/s/two.jsonl:90",
    "2026-10-18T09:00:00Z\ts3\tlinear\tlinear.save_comment\tABC-12\terror\tmcp\tc4\tShipped the mapping fix\t/s/three.jsonl:5",
    "2026-10-18T09:05:00Z\ts3\tgithub\tgh pr comment\tacme/app#8\tok\tbash\tc5\tAddressed in abc123: dropped the rescue\t/s/three.jsonl:9",
]) + "\n"


class ReconcileCheck(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="reconcile-check-")
        bindir = os.path.join(cls.root, "bin")
        os.makedirs(bindir)
        cls.gh = os.path.join(bindir, "gh")
        with open(cls.gh, "w") as fh:
            fh.write(FAKE_GH.replace("#!/usr/bin/env python3", "#!" + sys.executable, 1))
        os.chmod(cls.gh, 0o755)
        cls.repo = os.path.join(cls.root, "repo")
        git = lambda *a: subprocess.run(["git", "-C", cls.repo, *a], check=True, capture_output=True, text=True).stdout
        os.makedirs(cls.repo)
        git("init", "-q", "-b", "main")
        git("config", "user.email", "t@example.com")
        git("config", "user.name", "t")
        with open(os.path.join(cls.repo, "oauth.rb"), "w") as fh:
            fh.write("class Oauth\n  def granted_token_details\n  end\nend\n")
        git("add", ".")
        git("commit", "-q", "-m", "one")
        cls.on_main = git("rev-parse", "HEAD").strip()
        git("checkout", "-q", "-b", "side")
        git("commit", "-q", "--allow-empty", "-m", "two")
        cls.side = git("rev-parse", "HEAD").strip()
        git("checkout", "-q", "main")
        cls.evidence = os.path.join(cls.root, "evidence.tsv")
        with open(cls.evidence, "w") as fh:
            fh.write(EVIDENCE)
        cls.env = dict(os.environ, PATH=bindir + os.pathsep + os.environ["PATH"], PI_MEMORY_DIR=os.path.join(cls.root, "mem"))

    def check(self, claims, *args, fmt="json", expect_code=None):
        path = os.path.join(self.root, "claims.json")
        with open(path, "w") as fh:
            json.dump(claims, fh)
        proc = subprocess.run([sys.executable, "-B", CHECK, path, "--repo", self.repo, "--gh-repo", "acme/app",
                               "--evidence", self.evidence, "--format", fmt, *args],
                              env=self.env, capture_output=True, text=True)
        if expect_code is not None:
            self.assertEqual(proc.returncode, expect_code, proc.stdout + proc.stderr)
        return json.loads(proc.stdout) if fmt == "json" else proc.stdout

    def one(self, claim, *args):
        return self.check([claim], *args)[0]

    def test_pr_state_expectations(self):
        rows = self.check([{"claim": "#7 merged", "kind": "pr", "pointer": "https://github.com/acme/app/pull/7", "expect": "merged"},
                           {"claim": "#8 merged", "kind": "pr", "pointer": "#8", "expect": "merged"},
                           {"claim": "#8 draft", "kind": "pr", "pointer": "acme/app#8", "expect": "draft", "state": "acted"},
                           {"claim": "#99", "kind": "pr", "pointer": "#99", "expect": "open"}], expect_code=1)
        self.assertEqual([r["verdict"] for r in rows], ["confirmed", "contradicted", "confirmed", "unresolved"])
        self.assertIn("merged 2026-10-21T14:10:54Z, review approved", rows[0]["facts"])
        self.assertEqual(rows[0]["label"], "auto: proposed -> confirmed (https://github.com/acme/app/pull/7)")
        self.assertTrue(rows[1]["label"].startswith("ask Tiger: source disagrees"))
        self.assertTrue(rows[2]["label"].startswith("ask Tiger: acted -> confirmed"))
        self.assertEqual(rows[3]["label"], "fix the pointer")

    def test_pr_body_contains_and_absent(self):
        rows = self.check([{"claim": "body still has the quoted command", "kind": "pr-body", "pointer": "#7",
                            "expect": "rake 'task[check]'"},
                           {"claim": "body was fixed", "kind": "pr-body", "pointer": "#7", "expect": "!rake 'task[check]'"}])
        self.assertEqual([r["verdict"] for r in rows], ["confirmed", "contradicted"])

    def test_issue(self):
        self.assertEqual(self.one({"claim": "closed", "kind": "issue", "pointer": "#3", "expect": "closed"})["verdict"], "confirmed")

    def test_sha_exists_and_on_ref(self):
        rows = self.check([{"claim": "merged to main", "kind": "sha", "pointer": self.on_main[:11], "expect": "on:main"},
                           {"claim": "side merged", "kind": "sha", "pointer": f"{self.repo}@{self.side[:9]}", "expect": "on:main"},
                           {"claim": "commit exists", "kind": "auto", "pointer": self.side[:9]},
                           {"claim": "bogus", "kind": "sha", "pointer": "deadbeef1"}])
        self.assertEqual([r["verdict"] for r in rows], ["confirmed", "contradicted", "resolved", "unresolved"])
        self.assertTrue(rows[2]["label"].startswith("compare the facts"))

    def test_path_and_contents(self):
        rows = self.check([{"claim": "method still on main", "kind": "path", "pointer": "oauth.rb:2", "expect": "granted_token_details"},
                           {"claim": "line out of range", "kind": "path", "pointer": "oauth.rb:40"},
                           {"claim": "removed", "kind": "path", "pointer": "oauth.rb", "expect": "def other"}])
        self.assertEqual([r["verdict"] for r in rows], ["confirmed", "unresolved", "contradicted"])

    def test_mcp_and_verifier_pointers(self):
        rows = self.check([{"claim": "HIR-5712 in backlog", "kind": "auto", "pointer": "HIR-5712"},
                           {"claim": "Manan approved", "kind": "auto", "pointer": "https://acme.slack.com/archives/D0/p1"},
                           {"claim": "page v2", "kind": "pr", "pointer": "https://acme.atlassian.net/wiki/pages/5547"},
                           {"claim": "email sent", "kind": "prose", "pointer": ""}], expect_code=0)
        self.assertEqual([r["verdict"] for r in rows], ["needs-mcp", "needs-mcp", "needs-mcp", "needs-verifier"])
        self.assertIn("linear MCP", rows[0]["facts"])
        self.assertIn("slack MCP", rows[1]["facts"])

    def test_sent_lookups(self):
        rows = self.check([
            {"claim": "Codex reply posted", "kind": "sent", "pointer": "pulls/7/comments",
             "expect": "the guard now lives in the router; routing moved"},
            {"claim": "close-flow message sent", "kind": "sent", "pointer": "",
             "expect": "Hey team, a quick alignment on the close flow, screen 2"},
            {"claim": "day-27 thread posted", "kind": "sent", "pointer": "C0C4VA8RRUM"},
            {"claim": "Linear comment posted", "kind": "sent", "pointer": "ABC-12"},
            {"claim": "review drafts posted", "kind": "sent", "pointer": "acme/app#8", "expect": "company-owned applications need a guard"},
            {"claim": "reply on #8", "kind": "sent", "pointer": "https://github.com/acme/app/pull/8"},
        ])
        self.assertEqual([r["verdict"] for r in rows], ["confirmed", "clipboard", "drafted", "attempted", "not-found", "confirmed"])
        self.assertEqual(rows[0]["evidence"], "/s/one.jsonl:1174")
        self.assertIn("searched 5 rows in 1 evidence file(s)", rows[4]["facts"])
        self.assertIn("not proof it was never sent", rows[4]["facts"])
        self.assertTrue(rows[1]["label"].startswith("ask Tiger whether he sent it"))

    def test_offline_skips_gh(self):
        with open(self.gh + ".log", "w"):
            pass
        row = self.one({"claim": "#7", "kind": "pr", "pointer": "#7", "expect": "merged"}, "--offline")
        self.assertEqual(row["verdict"], "skipped")
        with open(self.gh + ".log") as fh:
            self.assertEqual(fh.read(), "")

    def test_note_claims_and_tsv_input(self):
        note = os.path.join(self.root, "note.md")
        with open(note, "w") as fh:
            fh.write("# Index\n- PR #7 merged <!-- claim state=proposed evidence=acme/app#7 -->\n"
                     "- monitor created <!-- claim state=proposed -->\n")
        tsv = os.path.join(self.root, "claims.tsv")
        with open(tsv, "w") as fh:
            fh.write("# comment\nclaim\tkind\tpointer\texpect\nmerged\tpr\t#7\tmerged\n")
        proc = subprocess.run([sys.executable, "-B", CHECK, tsv, "--note", note, "--gh-repo", "acme/app",
                               "--evidence", self.evidence, "--format", "json"], env=self.env, capture_output=True, text=True)
        rows = json.loads(proc.stdout)
        self.assertEqual([(r["id"].split("/")[-1], r["verdict"]) for r in rows],
                         [("1", "confirmed"), ("note.md:2", "resolved"), ("note.md:3", "needs-verifier")])

    def test_markdown_output(self):
        out = self.check([{"claim": "#7 merged", "kind": "pr", "pointer": "#7", "expect": "merged"}], fmt="md")
        self.assertIn("| 1 | #7 merged | pr | confirmed |", out)
        self.assertIn("Verdicts: confirmed 1", out)

    def test_usage_error(self):
        proc = subprocess.run([sys.executable, "-B", CHECK], env=self.env, capture_output=True, text=True)
        self.assertEqual(proc.returncode, 2)


if __name__ == "__main__":
    unittest.main(verbosity=1)
