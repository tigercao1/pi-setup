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
             "reviewDecision": "APPROVED", "headRefOid": "0123456789abcdef", "url": "https://github.com/acme/app/pull/7",
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
    "The reviewer is right that routing moved; the guard now lives in the router.\t/s/one.jsonl:1174",
    "2026-10-19T10:00:00Z\ts2\tclipboard\tslack-copy\tclipboard\tok\tbash\tc2\t"
    "Hi all, a short note on the widget export screen before we ship it\t/s/two.jsonl:40",
    "2026-10-19T11:00:00Z\ts2\tslack\tslack.send_message_draft\tC0TEST0CHAN\tok\tmcp\tc3\t"
    "Renewal reminder from the weekly email, how it works\t/s/two.jsonl:90",
    "2026-10-18T09:00:00Z\ts3\tlinear\tlinear.save_comment\tABC-12\terror\tmcp\tc4\tShipped the mapping fix\t/s/three.jsonl:5",
    "2026-10-18T09:05:00Z\ts3\tgithub\tgh pr comment\tacme/app#8\tok\tbash\tc5\tAddressed in abc123: dropped the rescue\t/s/three.jsonl:9",
    "2026-10-18T09:06:00Z\ts3\tgithub\tgh pr comment\tacme/app#70\tok\tbash\tc6\tWrong pull request\t/s/three.jsonl:11",
    "2026-10-18T09:07:00Z\ts3\tlinear\tlinear.save_comment\tABC-120\tok\tmcp\tc7\tA different ticket\t/s/three.jsonl:13",
    "2026-10-18T09:08:00Z\ts3\tgithub\tgh pr comment\tacme/app#9\tunverified\tbash\tc8\tMaybe posted\t/s/three.jsonl:15",
    "2026-10-18T09:09:00Z\ts3\tlinear\tlinear.save_comment\tABC-55\tunverified\tcodemode\tc9\tCaught failure\t/s/three.jsonl:17",
    "2026-10-18T09:10:00Z\ts4\tclipboard\tpbcopy\tclipboard\tunverified\tbash\tc10\tDear vendor, the export finished and all twenty rows matched\t/s/four.jsonl:3",
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
            fh.write("class Oauth\n  def token_details\n  end\nend\n")
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
        rows = self.check([{"claim": "method still on main", "kind": "path", "pointer": "oauth.rb:2", "expect": "token_details"},
                           {"claim": "line out of range", "kind": "path", "pointer": "oauth.rb:40"},
                           {"claim": "removed", "kind": "path", "pointer": "oauth.rb", "expect": "def other"}])
        self.assertEqual([r["verdict"] for r in rows], ["confirmed", "unresolved", "contradicted"])

    def test_mcp_and_verifier_pointers(self):
        rows = self.check([{"claim": "ABC-34 in backlog", "kind": "auto", "pointer": "ABC-34"},
                           {"claim": "reviewer approved", "kind": "auto", "pointer": "https://acme.slack.com/archives/D0/p1"},
                           {"claim": "page v2", "kind": "pr", "pointer": "https://acme.atlassian.net/wiki/pages/5547"},
                           {"claim": "email sent", "kind": "prose", "pointer": ""}], expect_code=0)
        self.assertEqual([r["verdict"] for r in rows], ["needs-mcp", "needs-mcp", "needs-mcp", "needs-verifier"])
        self.assertIn("linear MCP", rows[0]["facts"])
        self.assertIn("slack MCP", rows[1]["facts"])

    def test_sent_lookups(self):
        rows = self.check([
            {"claim": "Codex reply posted", "kind": "sent", "pointer": "pulls/7/comments",
             "expect": "the guard now lives in the router; routing moved"},
            {"claim": "export note sent", "kind": "sent", "pointer": "",
             "expect": "Hi all, a short note on the widget export screen, before we ship"},
            {"claim": "reminder thread posted", "kind": "sent", "pointer": "C0TEST0CHAN"},
            {"claim": "Linear comment posted", "kind": "sent", "pointer": "ABC-12"},
            {"claim": "review drafts posted", "kind": "sent", "pointer": "acme/app#8", "expect": "shared widgets need a guard"},
            {"claim": "reply on #8", "kind": "sent", "pointer": "https://github.com/acme/app/pull/8"},
        ])
        self.assertEqual([r["verdict"] for r in rows], ["sent", "clipboard", "drafted", "attempted", "not-found", "sent"])
        self.assertEqual(rows[0]["evidence"], "/s/one.jsonl:1174")
        self.assertIn("searched 10 rows in 1 evidence file(s)", rows[4]["facts"])
        self.assertIn("not proof it was never sent", rows[4]["facts"])
        self.assertTrue(rows[1]["label"].startswith("ask Tiger whether he sent it"))
        self.assertTrue(rows[0]["label"].startswith("resolve the posted item with a pr/issue claim and an expect"))
        self.assertNotIn("auto:", rows[0]["label"])

    def test_short_draft_alone_does_not_match_unrelated_posts(self):
        rows = self.check([{"claim": "monitor created", "kind": "sent", "pointer": "", "expect": "the mapping fix"},
                           {"claim": "monitor created", "kind": "sent", "pointer": "",
                            "expect": "Widget sync failure rate monitor, alert on the ratio over an hour"}])
        self.assertEqual([r["verdict"] for r in rows], ["unresolved", "not-found"])
        self.assertIn("too short", rows[0]["facts"])

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
            fh.write("id\tclaim\tsource\tkind\tpointer\texpect\tstate\nc1\tmerged\tnote.md:2\tpr\t#7\tmerged\tproposed\n\n")
        proc = subprocess.run([sys.executable, "-B", CHECK, tsv, "--note", note, "--gh-repo", "acme/app",
                               "--evidence", self.evidence, "--format", "json"], env=self.env, capture_output=True, text=True)
        rows = json.loads(proc.stdout)
        self.assertEqual([(r["id"].split("/")[-1], r["verdict"]) for r in rows],
                         [("c1", "confirmed"), ("note.md:2", "resolved"), ("note.md:3", "needs-verifier")])
        self.assertEqual(rows[0]["source"], "note.md:2")

    def run_raw(self, path, *args):
        return subprocess.run([sys.executable, "-B", CHECK, path, "--gh-repo", "acme/app", "--evidence", self.evidence,
                               "--offline", "--format", "json", *args], env=self.env, capture_output=True, text=True)

    def test_malformed_or_empty_claims_fail_loudly(self):
        cases = {
            "procedure.tsv": "#\tclaim\tsource file:line\tkind\tpointer\tlabel now\tlabel proposed\n"
                             "1\tfalse claim\tnote.md:1\tpath\t/missing\tacted\tconfirmed\n",
            "empty.tsv": "",
            "header-only.tsv": "id\tclaim\tsource\tkind\tpointer\texpect\tstate\n",
            "short-row.tsv": "id\tclaim\tsource\tkind\tpointer\texpect\tstate\n1\tx\tpr\t#7\n",
            "bad-kind.tsv": "id\tclaim\tsource\tkind\tpointer\texpect\tstate\n1\tx\t\tticket\tABC-1\t\t\n",
            "bad-state.tsv": "id\tclaim\tsource\tkind\tpointer\texpect\tstate\n1\tx\t\tpr\t#7\t\tdone\n",
            "empty.json": "[]",
            "object.json": "{\"claim\": \"x\", \"kind\": \"pr\"}",
            "unknown-key.json": "[{\"claim\": \"x\", \"kind\": \"pr\", \"label now\": \"acted\"}]",
            "no-kind.json": "[{\"claim\": \"x\"}]",
            "broken.json": "[{\"claim\": ",
        }
        for name, text in cases.items():
            path = os.path.join(self.root, name)
            with open(path, "w") as fh:
                fh.write(text)
            proc = self.run_raw(path)
            self.assertEqual(proc.returncode, 2, (name, proc.stdout, proc.stderr))
            self.assertEqual(proc.stdout, "", name)
            self.assertIn("reconcile-check:", proc.stderr, name)
        note = os.path.join(self.root, "bare.md")
        with open(note, "w") as fh:
            fh.write("# No labels here\n")
        proc = subprocess.run([sys.executable, "-B", CHECK, "--note", note], env=self.env, capture_output=True, text=True)
        self.assertEqual(proc.returncode, 2, proc.stdout)

    def test_reconcile_procedure_example_is_the_machine_schema(self):
        doc = os.path.expanduser("~/.pi/agent/skills/recall/references/reconcile.md")
        with open(doc, encoding="utf-8") as fh:
            block = fh.read().split("```text\n", 1)[1].split("```", 1)[0]
        path = os.path.join(self.root, "doc-claims.tsv")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(block)
        proc = self.run_raw(path)
        rows = json.loads(proc.stdout)
        self.assertEqual([r["kind"] for r in rows], ["pr", "path", "sent", "mcp", "prose"], proc.stderr)
        self.assertTrue(block.startswith("\t".join(("id", "claim", "source", "kind", "pointer", "expect", "state")) + "\n"))

    def test_bom_and_crlf_tsv(self):
        path = os.path.join(self.root, "bom.tsv")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("\ufeffid\tclaim\tsource\tkind\tpointer\texpect\tstate\r\n1\tx\t\tpath\toauth.rb\tclass Oauth\t\r\n")
        proc = self.run_raw(path, "--repo", self.repo)
        self.assertEqual(json.loads(proc.stdout)[0]["verdict"], "confirmed", proc.stderr)

    def test_path_line_checks_only_those_lines(self):
        with open(os.path.join(self.repo, "range.txt"), "w") as fh:
            fh.write("not the claim\nproof appears only here\nthird\n")
        rows = self.check([{"claim": "line one has proof", "kind": "path", "pointer": "range.txt:1", "expect": "proof"},
                           {"claim": "line two has proof", "kind": "path", "pointer": "range.txt:2", "expect": "proof"},
                           {"claim": "range has proof", "kind": "path", "pointer": "range.txt:1-2", "expect": "proof"},
                           {"claim": "third line exists", "kind": "path", "pointer": "range.txt:3"}], expect_code=1)
        self.assertEqual([r["verdict"] for r in rows], ["contradicted", "confirmed", "confirmed", "resolved"])
        self.assertNotIn("auto", rows[0]["label"])
        self.assertTrue(rows[1]["evidence"].endswith("range.txt:2"), rows[1]["evidence"])
        self.assertTrue(rows[2]["evidence"].endswith("range.txt:1-2"), rows[2]["evidence"])
        self.assertIn("line 1 lacks", rows[0]["facts"])

    def test_pr_body_without_expect_is_only_resolved(self):
        row = self.one({"claim": "body says something", "kind": "pr-body", "pointer": "#7"})
        self.assertEqual(row["verdict"], "resolved")
        self.assertFalse(row["label"].startswith("auto"), row["label"])

    def test_confirmed_needs_a_satisfied_expect(self):
        rows = self.check([{"claim": "commit exists", "kind": "sha", "pointer": self.on_main[:11]},
                           {"claim": "file exists", "kind": "path", "pointer": "oauth.rb"},
                           {"claim": "#7 is a PR", "kind": "pr", "pointer": "#7"}])
        self.assertEqual([r["verdict"] for r in rows], ["resolved", "resolved", "resolved"])
        self.assertFalse(any(r["label"].startswith("auto") for r in rows), rows)

    def test_sent_target_identity(self):
        rows = self.check([{"claim": "posted to PR 7", "kind": "sent", "pointer": "https://github.com/acme/app/pull/7"},
                           {"claim": "posted to PR7", "kind": "sent", "pointer": "PR7"},
                           {"claim": "posted to #70", "kind": "sent", "pointer": "acme/app#70"},
                           {"claim": "ticket comment", "kind": "sent", "pointer": "ABC-1"},
                           {"claim": "ticket comment", "kind": "sent", "pointer": "ABC-12"},
                           {"claim": "other repo", "kind": "sent", "pointer": "other/app#8"},
                           {"claim": "channel prefix", "kind": "sent", "pointer": "C0TEST"}])
        self.assertEqual([r["verdict"] for r in rows], ["sent", "sent", "sent", "not-found", "attempted", "not-found", "not-found"])
        self.assertEqual(rows[0]["evidence"], "/s/one.jsonl:1174")
        self.assertEqual(rows[1]["evidence"], "/s/one.jsonl:1174")
        self.assertEqual(rows[2]["evidence"], "/s/three.jsonl:11")

    def test_unverified_rows_are_candidates_never_sent(self):
        rows = self.check([{"claim": "comment on #9", "kind": "sent", "pointer": "acme/app#9"},
                           {"claim": "codemode comment", "kind": "sent", "pointer": "ABC-55"}])
        self.assertEqual([r["verdict"] for r in rows], ["candidate", "candidate"])
        self.assertIn("not observed", rows[0]["facts"])
        self.assertTrue(rows[0]["label"].startswith("ask Tiger whether he sent it"))
        copied = self.one({"claim": "vendor email", "kind": "sent", "pointer": "",
                           "expect": "Dear vendor, the export finished and all twenty rows matched"})
        self.assertEqual(copied["verdict"], "clipboard")

    def test_markdown_output(self):
        out = self.check([{"claim": "#7 merged", "kind": "pr", "pointer": "#7", "expect": "merged"}], fmt="md")
        self.assertIn("| 1 | #7 merged | pr | confirmed |", out)
        self.assertIn("Verdicts: confirmed 1", out)

    def test_usage_error(self):
        proc = subprocess.run([sys.executable, "-B", CHECK], env=self.env, capture_output=True, text=True)
        self.assertEqual(proc.returncode, 2)


if __name__ == "__main__":
    unittest.main(verbosity=1)
