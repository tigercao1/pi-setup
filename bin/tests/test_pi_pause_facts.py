import json
import os
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "pi-pause-facts")


def sh(cwd, *cmd):
    subprocess.run(cmd, cwd=cwd, check=True, capture_output=True, text=True)


def assistant(entry_id, ts, read, write, cost):
    return {"type": "message", "id": entry_id, "timestamp": ts,
            "message": {"role": "assistant", "model": "anthropic/claude-opus-5.5", "provider": "gw",
                        "usage": {"input": 10, "output": 50, "cacheRead": read, "cacheWrite": write,
                                  "cost": {"total": cost}}}}


def put(path, text):
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


def write_jsonl(path, rows):
    with open(path, "w", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps(r) + "\n")


class PauseFactsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = self.tmp.name
        self.t = t
        git_env = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@x", "GIT_COMMITTER_NAME": "t",
                   "GIT_COMMITTER_EMAIL": "t@x"}
        os.environ.update(git_env)
        self.remote = os.path.join(t, "remote.git")
        self.repo = os.path.join(t, "repo")
        sh(t, "git", "init", "-q", "--bare", self.remote)
        sh(t, "git", "init", "-q", "-b", "main", self.repo)
        sh(self.repo, "git", "remote", "add", "origin", self.remote)
        put(os.path.join(self.repo, "a.txt"), "a\n")
        sh(self.repo, "git", "add", "a.txt")
        sh(self.repo, "git", "commit", "-q", "-m", "first")
        sh(self.repo, "git", "checkout", "-q", "-b", "tiger/abc-1234-widget-sync")
        sh(self.repo, "git", "push", "-q", "-u", "origin", "tiger/abc-1234-widget-sync")
        put(os.path.join(self.repo, "b.txt"), "b\n")
        sh(self.repo, "git", "add", "b.txt")
        sh(self.repo, "git", "commit", "-q", "-m", "second")
        put(os.path.join(self.repo, "a.txt"), "changed\n")
        put(os.path.join(self.repo, "new.txt"), "n\n")

        self.plans = os.path.join(t, "plans")
        self.mission = os.path.join(self.plans, "ABC-1234")
        os.makedirs(self.mission)
        with open(os.path.join(self.mission, "ledger.md"), "w") as fh:
            fh.write("# Ledger\n\n" + "".join("- 2026-10-0%d · step · row %d · result: ok · evidence: -\n" % (i, i)
                                              for i in range(1, 8)))
        layer = os.path.join(t, "layer", "rules")
        os.makedirs(layer)
        self.overlay = os.path.join(layer, "skill-overlays.md")
        with open(self.overlay, "w") as fh:
            fh.write("# overlays\n\n## intake\n\n- Plans root for RESUME.md: `/wrong/<TICKET>/`\n\n"
                     "## recall\n\n- Plans root for RESUME.md: `%s/<TICKET>/`.\n\n## other\n" % self.plans)

        self.teams = os.path.join(t, "teams")
        team = os.path.join(self.teams, "team-1")
        os.makedirs(os.path.join(team, "status"))
        live = subprocess.Popen(["sleep", "30"])
        self.addCleanup(live.wait)
        self.addCleanup(live.kill)
        with open(os.path.join(team, "config.json"), "w") as fh:
            json.dump({"team": "team-1", "leadPid": 424242, "agents": [
                {"name": "coder-a", "profile": "coder", "model": "m1", "paneId": "pid:%d" % live.pid},
                {"name": "rev-b", "profile": "code-review", "model": "m2", "paneId": "pid:999999"}]}, fh)
        with open(os.path.join(team, "status", "coder-a.json"), "w") as fh:
            json.dump({"state": "active", "note": "writing tests"}, fh)
        other = os.path.join(self.teams, "team-2")
        os.makedirs(other)
        with open(os.path.join(other, "config.json"), "w") as fh:
            json.dump({"team": "team-2", "leadPid": 1, "agents": [{"name": "not-mine"}]}, fh)

        sessions = os.path.join(t, "sessions", "--repo--")
        os.makedirs(sessions)
        self.parent = os.path.join(sessions, "2026-10-01T00-00-00-000Z_parent.jsonl")
        self.child = os.path.join(sessions, "2026-10-02T00-00-00-000Z_child.jsonl")
        write_jsonl(self.parent, [
            {"type": "session", "id": "parent", "timestamp": "2026-10-01T00:00:00Z", "cwd": self.repo},
            assistant("p1", "2026-10-01T00:01:00Z", 1000, 100, 1.0)])
        write_jsonl(self.child, [
            {"type": "session", "id": "child", "timestamp": "2026-10-02T00:00:00Z", "cwd": self.repo,
             "parentSession": self.parent},
            assistant("p1", "2026-10-01T00:01:00Z", 1000, 100, 1.0),
            assistant("c1", "2026-10-02T00:01:00Z", 200000, 1000, 0.25),
            assistant("c2", "2026-10-02T00:02:00Z", 260000, 2000, 0.5)])

        self.bin = os.path.join(t, "bin")
        os.makedirs(self.bin)
        gh = os.path.join(self.bin, "gh")
        with open(gh, "w") as fh:
            fh.write("#!/bin/sh\necho \"$@\" > %s/gh-args\n"
                     "echo '[{\"number\":77,\"title\":\"Widget sync\",\"isDraft\":true,\"url\":\"https://x/77\","
                     "\"headRefOid\":\"abcdef1234567890\",\"reviewDecision\":\"\"}]'\n" % t)
        os.chmod(gh, 0o755)

    def tearDown(self):
        self.tmp.cleanup()

    def facts(self, *extra, cwd=None, env=None):
        e = dict(os.environ)
        e.update({"PI_PAUSE_OVERLAYS": self.overlay, "PI_SESSIONS_DIR": os.path.join(self.t, "sessions"),
                  "PATH": self.bin + os.pathsep + os.environ["PATH"]})
        e.pop("PI_SESSION_ID", None)
        e.pop("PI_SESSION_FILE", None)
        e.pop("PI_PAUSE_PLANS_ROOT", None)
        e.update(env or {})
        p = subprocess.run([sys.executable, SCRIPT, "--cwd", cwd or self.repo, "--teams-dir", self.teams] + list(extra),
                           capture_output=True, text=True, env=e)
        self.assertEqual(p.returncode, 0, p.stderr)
        return p.stdout

    def test_full_facts(self):
        out = self.facts("--session-file", self.child, "--pid", "424242")
        self.assertIn("- Session: child", out)
        self.assertIn("- Topic: ABC-1234", out)
        self.assertIn("- Branch: tiger/abc-1234-widget-sync", out)
        head = subprocess.run(["git", "-C", self.repo, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        self.assertIn("- HEAD: %s second" % head, out)
        self.assertIn("- Upstream: origin/tiger/abc-1234-widget-sync, ahead 1, behind 0", out)
        self.assertIn("- Dirty files: 2", out)
        self.assertIn("  - ` M a.txt`", out)
        self.assertIn("  - `?? new.txt`", out)
        self.assertIn("- #77 draft Widget sync, head abcdef123456, review none: https://x/77", out)
        with open(os.path.join(self.t, "gh-args")) as fh:
            args = fh.read()
        self.assertIn("pr list --head tiger/abc-1234-widget-sync --state open", args)
        self.assertIn("- Team team-1", out)
        self.assertIn("  - coder-a: active, process alive, coder, m1 - writing tests", out)
        self.assertIn("  - rev-b: unknown, process gone, code-review, m2", out)
        self.assertNotIn("not-mine", out)
        self.assertIn("- Folder: %s (exists)" % self.mission, out)
        self.assertIn("- RESUME.md: %s" % os.path.join(self.mission, "RESUME.md"), out)
        self.assertNotIn("/wrong/", out)
        self.assertIn("Last 5 rows of %s" % os.path.join(self.mission, "ledger.md"), out)
        self.assertNotIn("row 2 ", out)
        self.assertIn("row 3 ", out)
        self.assertIn("row 7 ", out)
        self.assertIn("- Context: 262,010 tokens (last call, anthropic/claude-opus-5.5)", out)
        self.assertIn("- Session cost so far: $0.75 over 2 calls", out)

    def test_env_session_id_and_context_override(self):
        out = self.facts("--no-gh", "--context-tokens", "300000", env={"PI_SESSION_ID": "child"})
        self.assertIn("- Session file: %s" % self.child, out)
        self.assertIn("- Context: 300,000 tokens", out)
        self.assertIn("- Not checked (--no-gh).", out)
        self.assertIn("- None (no team led by pi process", out)

    def test_no_ticket_no_repo(self):
        plain = os.path.join(self.t, "notes")
        os.makedirs(plain)
        out = self.facts("--no-gh", cwd=plain)
        self.assertIn("- Not a git repository.", out)
        self.assertIn("- No ticket in the cwd or branch name.", out)
        self.assertIn("- RESUME.md: not determined", out)
        self.assertIn("- Topic: notes", out)
        self.assertIn("- Session cost: unknown", out)

    def test_absent_mission_folder_and_plans_root_override(self):
        sh(self.repo, "git", "checkout", "-q", "-b", "abc-9999-other")
        out = self.facts("--no-gh")
        self.assertIn("- Folder: %s (absent)" % os.path.join(self.plans, "ABC-9999"), out)
        self.assertIn("ledger.md: absent.", out)
        alt = os.path.join(self.t, "alt")
        os.makedirs(os.path.join(alt, "ABC-9999"))
        out = self.facts("--no-gh", "--plans-root", alt)
        self.assertIn("- Folder: %s (exists)" % os.path.join(alt, "ABC-9999"), out)

    def test_gh_failure_is_reported_not_fatal(self):
        with open(os.path.join(self.bin, "gh"), "w") as fh:
            fh.write("#!/bin/sh\necho 'not logged in' >&2\nexit 1\n")
        out = self.facts()
        self.assertIn("- Not checked: not logged in", out)


if __name__ == "__main__":
    unittest.main()
