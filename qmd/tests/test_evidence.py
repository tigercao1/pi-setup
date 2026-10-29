#!/usr/bin/env python3
"""Tests for the publishing-evidence rows in bin/pi-memory-export.  Run: python3 -B ~/.pi/agent/qmd/tests/test_evidence.py"""
import json
import os
import subprocess
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from test_pi_memory_export import Fixture  # noqa: E402

TS = "2026-10-20T19:55:12.000Z"


def call(cid, name, arguments):
    return {"type": "message", "timestamp": TS,
            "message": {"role": "assistant", "content": [{"type": "toolCall", "id": cid, "name": name, "arguments": arguments}]}}


def result(cid, error=False):
    return {"type": "message", "timestamp": TS,
            "message": {"role": "toolResult", "toolCallId": cid, "toolName": "x", "isError": error,
                        "content": [{"type": "text", "text": "done"}]}}


def output(cid, text, error=False):
    entry = result(cid, error)
    entry["message"]["content"] = [{"type": "text", "text": text}]
    return entry


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def bash(cid, command):
    return call(cid, "bash", {"command": command})


class Rows(unittest.TestCase):
    def rows(self, *entries, cwd=None):
        fx = Fixture()
        path = fx.session("s1", cwd or fx.home + "/agent", ("user", "hello"), extra=entries)
        mod = fx.module()
        return mod.read_session(path, {})[5]

    def only(self, *entries, **kw):
        rows = self.rows(*entries, **kw)
        self.assertEqual(len(rows), 1, rows)
        return rows[0]

    def test_pr_comment_body_file_from_earlier_write(self):
        row = self.only(call("w", "write", {"path": "/tmp/reply.md", "content": "Addressed in abc123."}), result("w"),
                        bash("b", "gh pr comment 12 -R acme/app --body-file /tmp/reply.md"), result("b"))
        self.assertEqual((row["channel"], row["tool"], row["target"], row["result"]),
                         ("github", "gh pr comment", "acme/app#12", "ok"))
        self.assertEqual(row["excerpt"], "Addressed in abc123.")
        self.assertTrue(row["source"].endswith(".jsonl:5"), row["source"])

    def test_pr_url_target(self):
        row = self.only(bash("b", "gh pr review https://github.com/acme/app/pull/7 --approve -b 'lgtm'"), result("b"))
        self.assertEqual((row["tool"], row["target"], row["excerpt"]), ("gh pr review", "acme/app#7", "lgtm"))

    def test_heredoc_piped_to_pbcopy(self):
        row = self.only(bash("b", "cat <<'EOF' | pbcopy\nHi Frankie,\n\nWe reran the test.\nEOF"), result("b"))
        self.assertEqual((row["channel"], row["tool"]), ("clipboard", "pbcopy"))
        self.assertEqual(row["excerpt"], "Hi Frankie, We reran the test.")

    def test_slack_copy_reads_heredoc_written_file(self):
        row = self.only(bash("b", "cat > /tmp/slack-msg.md <<'EOF'\nHey team, a quick alignment\nEOF\n"
                                  "python3 ~/.pi/agent/skills/slack-copy/bin/slack-copy.py /tmp/slack-msg.md"), result("b"))
        self.assertEqual((row["tool"], row["excerpt"]), ("slack-copy", "Hey team, a quick alignment"))

    def test_git_push_target_drops_redirects(self):
        row = self.only(bash("b", "git -C /work/abc-1 push -u origin tiger/abc-1 2>&1 | tail -3"), result("b"))
        self.assertEqual((row["channel"], row["target"]), ("git", "abc-1 origin tiger/abc-1"))

    def test_mentions_and_dry_runs_are_not_publishing(self):
        rows = self.rows(bash("a", "grep -n 'git push' notes.md; echo gh pr comment 3"), result("a"),
                         bash("b", "git push --dry-run origin main"), result("b"),
                         bash("c", "gh pr view 12 --json state && gh api repos/acme/app/pulls/12"), result("c"),
                         bash("d", "gh api graphql -f query='query { viewer { login } }'"), result("d"),
                         call("e", "linear_get_issue", {"id": "ABC-1"}), result("e"),
                         call("f", "codemode", {"code": "return await describeTool('mcp__slack__slack_send_message')"}),
                         result("f"))
        self.assertEqual(rows, [])

    def test_gh_api_writes(self):
        rows = self.rows(bash("a", "gh api repos/acme/app/pulls/1/comments/2/replies -f body='Fixed in abc'"), result("a"),
                         bash("b", "gh api -X PATCH repos/acme/app/pulls/1 -F body=@/tmp/b.md"), result("b"),
                         bash("c", "gh api graphql -f query='mutation { addComment(input:{}) { clientMutationId } }'"),
                         result("c"))
        self.assertEqual([(r["tool"], r["target"]) for r in rows],
                         [("gh api POST", "repos/acme/app/pulls/1/comments/2/replies"),
                          ("gh api PATCH", "repos/acme/app/pulls/1"), ("gh api POST", "graphql")])
        self.assertEqual(rows[0]["excerpt"], "Fixed in abc")

    def test_mcp_write_error_and_missing_result(self):
        rows = self.rows(call("a", "linear_save_comment", {"issueId": "ABC-1", "body": "Shipped."}), result("a", error=True),
                         call("b", "mcp__slack__slack_send_message_draft", {"channel_id": "C1", "message": "draft text"}))
        self.assertEqual([(r["channel"], r["tool"], r["target"], r["result"]) for r in rows],
                         [("linear", "linear.save_comment", "ABC-1", "error"),
                          ("slack", "slack.send_message_draft", "C1", "no-result")])

    def test_codemode_mcp_calls(self):
        code = ("const r = await tools.mcp__atlassian__updateConfluencePage({cloudId: 'x', pageId: \"3654\", body, "
                "versionMessage: 'v2'});\nawait tools.mcp__linear__save_status_update({project: 'Disposition', "
                "body: `On track`, health: 'onTrack'});\nreturn await tools.mcp__linear__get_issue({id: 'ABC-2'});")
        rows = self.rows(call("a", "codemode", {"code": code}), result("a"))
        self.assertEqual([(r["channel"], r["tool"], r["target"], r["excerpt"], r["via"]) for r in rows],
                         [("confluence", "atlassian.updateConfluencePage", "3654", "(body)", "codemode"),
                          ("linear", "linear.save_status_update", "Disposition", "On track", "codemode")])

    def test_help_and_dry_run_are_not_rows(self):
        rows = self.rows(bash("a", "gh pr create --help"), result("a"),
                         bash("b", "gh pr create -R acme/app --dry-run -t Draft"), result("b"),
                         bash("c", "gh pr comment 7 -R acme/app --help"), result("c"),
                         bash("d", "git push --help"), result("d"),
                         bash("e", "git push -h"), result("e"),
                         bash("f", "gh api repos/acme/app/pulls/1/comments -f body=x --help"), result("f"),
                         bash("g", "gh pr merge 7 -h"), result("g"))
        self.assertEqual(rows, [])

    def test_result_is_ok_only_when_that_write_decides_the_exit(self):
        rows = self.rows(bash("a", "false && gh pr comment 8 -R acme/app -b never; true"), result("a"),
                         bash("b", "gh pr comment 9 -R acme/app -b x || true"), result("b"),
                         bash("c", "git push origin main 2>&1 | tail -3"), result("c"),
                         bash("d", "if false; then gh pr comment 10 -R acme/app -b x; fi"), result("d"),
                         bash("e", "cd /w && git fetch && gh pr comment 11 -R acme/app -b x"), result("e"),
                         bash("f", "gh pr comment 12 -R acme/app -b x && echo posted"), result("f"),
                         bash("g", "gh pr comment 13 -R acme/app -b x"), result("g", error=True),
                         bash("h", "gh pr comment 14 -R acme/app -b x; gh pr comment 15 -R acme/app -b y"), result("h"),
                         bash("i", "gh pr create -R acme/app -t T --web"), result("i"),
                         bash("j", "true || gh pr comment 16 -R acme/app -b x"), result("j"))
        self.assertEqual([(r["target"], r["result"]) for r in rows],
                         [("acme/app#8", "unverified"), ("acme/app#9", "unverified"), ("agent origin main", "unverified"),
                          ("acme/app#10", "unverified"), ("acme/app#11", "ok"), ("acme/app#12", "ok"),
                          ("acme/app#13", "error"), ("acme/app#14", "unverified"), ("acme/app#15", "ok"),
                          ("acme/app new", "unverified"), ("acme/app#16", "unverified")])

    def test_comments_are_not_commands(self):
        rows = self.rows(bash("a", "echo hi # ; gh pr comment 3 -R acme/app -b x\n# git push origin main"), result("a"))
        self.assertEqual(rows, [])

    def test_observed_output_proves_a_write_inside_a_script(self):
        rows = self.rows(
            bash("a", "git push -u origin tiger/x 2>&1 | tail -3"),
            output("a", "To github.com:acme/app.git\n * [new branch]      tiger/x -> tiger/x\n"),
            bash("b", "git push origin main 2>&1 | tail -2"),
            output("b", "To github.com:acme/app.git\n ! [rejected]        main -> main (fetch first)\n"),
            bash("c", "gh pr comment 21 -R acme/app -b x | cat; echo"),
            output("c", "https://github.com/acme/app/pull/21#issuecomment-123\n"),
            bash("d", "gh pr comment 22 -R acme/app -b x | cat; echo"),
            output("d", "https://github.com/acme/app/pull/23#issuecomment-123\n"),
            bash("e", "gh pr merge 24 -R acme/app --squash 2>&1 | tail -1; gh pr view 24 --json state"),
            output("e", "MERGED\n"),
            bash("f", "gh pr merge 25 -R acme/app --squash | tail -1"),
            output("f", "\u2713 Squashed and merged pull request acme/app#25 (Title)\n"),
            bash("g", "cd /w && gh pr create -R acme/app -t T -b body"),
            output("g", "https://github.com/acme/app/pull/77\n"),
            bash("h", "gh pr edit 26 -R acme/app --body-file /tmp/b.md 2>&1 | tail -1"),
            output("h", "https://github.com/acme/app/pull/26\n"),
            bash("i", "gh pr edit 27 -R acme/app -b x | cat; gh pr view 27 -R acme/app --json url -q .url"),
            output("i", "https://github.com/acme/app/pull/27\n"))
        self.assertEqual([(r["target"], r["result"]) for r in rows],
                         [("agent origin tiger/x", "ok"), ("agent origin main", "error"), ("acme/app#21", "ok"),
                          ("acme/app#22", "unverified"), ("acme/app#24", "unverified"), ("acme/app#25", "ok"),
                          ("acme/app#77 new", "ok"), ("acme/app#26", "ok"), ("acme/app#27", "unverified")])

    def test_codemode_writes_are_unverified_and_strings_are_not_calls(self):
        code = ("try { await tools.mcp__linear__save_comment({issueId:\"ABC-1\",body:\"This draft was not posted\"}); }"
                " catch(e) { return \"failed\"; }\n"
                "const note = \"await tools.mcp__linear__save_comment({issueId: 'ABC-2'})\";\n"
                "// await tools.mcp__slack__slack_send_message({channel_id: 'C1'})\n"
                "/* tools.mcp__linear__save_issue({id: 'ABC-3'}) */\n"
                "d = d.replace(/<a [^>]*href=\"[^\"]*\">/g, \"\").replace(/'/g, '');\n"
                "await tools.mcp__linear__save_project({id: 'P-5', description: d / 2});\n")
        rows = self.rows(call("a", "codemode", {"code": code}), result("a"),
                         call("b", "codemode", {"code": "await tools.mcp__linear__save_comment({issueId: 'ABC-4', body: 'x'})"}),
                         result("b", error=True))
        self.assertEqual([(r["target"], r["result"]) for r in rows], [("ABC-1", "unverified"), ("P-5", "unverified"), ("ABC-4", "unverified")])

    def test_session_send(self):
        row = self.only(call("a", "session_send", {"to": "s-01a1", "note": "Tiger confirmed"}), result("a"))
        self.assertEqual((row["channel"], row["target"], row["excerpt"]), ("pi-session", "s-01a1", "Tiger confirmed"))


class Export(unittest.TestCase):
    def test_evidence_file_and_front_matter(self):
        fx = Fixture()
        fx.session("pub", fx.home + "/agent", ("user", "post it"),
                   extra=[bash("b", "gh pr comment 5 -R acme/app -b 'Thanks'"), result("b")])
        fx.session("quiet", fx.home + "/agent", ("user", "just read"))
        mod = fx.module()
        fx.run(mod)
        exported = fx.exported("pi", "pub")
        self.assertTrue(exported.startswith("---\npublished:\n  - {at: " + TS + ", tool: \"gh pr comment\", "
                                            "target: \"acme/app#5\", result: ok}\n---\n# post it"), exported)
        self.assertTrue(fx.exported("pi", "quiet").startswith("# just read"))
        with open(os.path.join(fx.memory, "pi", "evidence.tsv"), encoding="utf-8") as fh:
            lines = fh.read().splitlines()
        self.assertEqual(lines[0].split("\t"), list(mod.EVIDENCE_COLUMNS))
        self.assertEqual(lines[1].split("\t")[:6], [TS, "pub", "github", "gh pr comment", "acme/app#5", "ok"])
        self.assertEqual(len(lines), 2)

    def test_unchanged_session_keeps_its_rows_and_a_move_cleans_up(self):
        fx = Fixture()
        fx.session("pub", fx.home + "/agent", ("user", "post it"),
                   extra=[bash("b", "git push origin main"), result("b")])
        mod = fx.module()
        fx.run(mod)
        tsv = os.path.join(fx.memory, "pi", "evidence.tsv")
        first = read(tsv)
        mod.read_session = lambda p, t: self.fail("unchanged session was re-read")
        fx.run(mod)
        self.assertEqual(read(tsv), first)
        fx.write(fx.layer + "/qmd/session-overrides.tsv", "pub\twork\n")
        mod = fx.module()
        fx.run(mod)
        self.assertFalse(os.path.exists(tsv))
        self.assertIn("\tgit push\t", read(os.path.join(fx.memory, "work", "evidence.tsv")))

    def test_front_matter_groups_repeats_and_caps_the_list(self):
        fx = Fixture()
        entries = [bash("p1", "git push origin a"), result("p1"), bash("p2", "git push origin a"), result("p2", error=True)]
        for n in range(35):
            entries += [bash(f"c{n}", f"gh pr comment {n} -R acme/app -b hi"), result(f"c{n}")]
        fx.session("many", fx.home + "/agent", ("user", "x"), extra=entries)
        mod = fx.module()
        fx.run(mod)
        front = fx.exported("pi", "many").split("\n---\n")[0]
        self.assertIn(f'  - {{at: {TS}, tool: "git push", target: "agent origin a", result: error, count: 2}}', front)
        self.assertEqual(front.count("\n  - {"), 30)
        self.assertTrue(front.endswith("published_more: 6"), front[-80:])
        self.assertEqual(len(read(os.path.join(fx.memory, "pi", "evidence.tsv")).splitlines()), 38)

    def test_adversary_session_never_reads_as_sent(self):
        fx = Fixture()
        code = ("try { await tools.mcp__linear__save_comment({issueId:\"ABC-1\",body:\"This draft was not posted because "
                "the write failed\"}); } catch(e) { return \"failed\"; }")
        fx.session("adversary", fx.home + "/agent", ("user", "fixture"), extra=[
            bash("h", "gh pr comment 7 -R acme/app --help"), result("h"),
            bash("d", "gh pr create -R acme/app --dry-run -t Draft"), result("d"),
            bash("skip", "false && gh pr comment 8 -R acme/app -b never; true"), result("skip"),
            call("c", "codemode", {"code": code}), result("c"),
            call("failed", "mcp__linear__save_comment", {"issueId": "ABC-2", "body": "Failed write"}), result("failed", error=True)])
        fx.run(fx.module())
        claims = os.path.join(fx.root, "claims.json")
        with open(claims, "w") as fh:
            json.dump([{"claim": t, "kind": "sent", "pointer": t} for t in ("acme/app#7", "acme/app#8", "ABC-1", "ABC-2")], fh)
        check = os.path.join(os.path.dirname(os.path.dirname(os.path.realpath(__file__))), "reconcile-check")
        proc = subprocess.run([sys.executable, "-B", check, claims, "--evidence", os.path.join(fx.memory, "pi", "evidence.tsv"),
                               "--format", "json"], capture_output=True, text=True)
        self.assertEqual([r["verdict"] for r in json.loads(proc.stdout)], ["not-found", "candidate", "candidate", "attempted"],
                         proc.stderr)

    def test_dry_run_writes_no_evidence(self):
        import argparse
        fx = Fixture()
        fx.session("pub", fx.home + "/agent", ("user", "x"), extra=[bash("b", "git push"), result("b")])
        mod = fx.module()
        mod.Exporter(argparse.Namespace(full=False, dry_run=True, quiet=True)).run()
        self.assertFalse(os.path.exists(os.path.join(fx.memory, "pi", "evidence.tsv")))


if __name__ == "__main__":
    unittest.main(verbosity=1)
