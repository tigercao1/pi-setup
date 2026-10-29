import importlib.machinery
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "pi-cost-trial")
loader = importlib.machinery.SourceFileLoader("pi_cost_trial", SCRIPT)
spec = importlib.util.spec_from_loader(loader.name, loader)
pt = importlib.util.module_from_spec(spec)
loader.exec_module(pt)

SONNET = "anthropic/claude-sonnet-5.5"
OPUS = "anthropic/claude-opus-5.5"


def call(team, name, cost, model, ticket=None, ts=None):
    c = {"team": team, "name": name, "cost": cost, "model": model, "ticket": ticket}
    if ts:
        c["ts"] = ts
    return c


class TrialReportTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.gate = os.path.join(self.tmp, "79763.json")
        with open(self.gate, "w") as fh:
            json.dump({"pr": "79763", "rounds": 2, "spawns": 5}, fh)
        self.records = {
            ("t1", "mgr-s"): {"name": "mgr-s", "parent": "team_lead"},
            ("t1", "w1"): {"name": "w1", "parent": "mgr-s"},
            ("t1", "w2"): {"name": "w2", "parent": "w1", "gate": {"state": self.gate, "spawnId": "x"}},
            ("t1", "other"): {"name": "other", "parent": "team_lead"},
            ("t2", "mgr-o"): {"name": "mgr-o", "parent": "team_lead"},
        }
        self.rows = [
            {"ts": "2026-10-23T03:00:00Z", "team": "t1", "agent": "mgr-s", "arm": "claude-sonnet-5.5", "model": SONNET, "task": "a"},
            {"ts": "2026-10-23T04:00:00Z", "team": "t2", "agent": "mgr-o", "arm": "claude-opus-5.5", "model": OPUS, "task": "b"},
            {"ts": "2026-10-23T05:00:00Z", "team": "t1", "agent": "mgr-s", "arm": "claude-sonnet-5.5", "model": SONNET, "task": "a"},
        ]
        self.calls = [
            call("t1", "mgr-s", 1.0, SONNET),
            call("t1", "w1", 2.0, OPUS, "ABC-1"),
            call("t1", "w2", 3.0, "openai/gpt-6.1-sol"),
            call("t1", "other", 100.0, OPUS, "ABC-9"),
            call("t2", "mgr-o", 4.0, SONNET),
        ]
        self.prs = [{"number": 79763, "ticket": None}, {"number": 5, "ticket": "ABC-1"}, {"number": 6, "ticket": "ABC-9"}]

    def test_agents_subtree_prs_and_gate(self):
        r = pt.trial_report(self.rows, self.calls, self.records, self.prs)
        self.assertEqual(len(r["agents"]), 2, "a repeated log row counts once")
        s = r["agents"][0]
        self.assertEqual((s["own_cost"], s["subtree_cost"], s["subtree_agents"]), (1.0, 6.0, 3))
        self.assertEqual(s["merged_prs"], ["5", "79763"], "ticket and gate attribution, never a sibling's ticket")
        self.assertEqual((s["gate_rounds"], s["gate_spawns"], s["gate_prs"]), (2, 5, ["79763"]))
        self.assertFalse(s["arm_mismatch"])
        o = r["agents"][1]
        self.assertTrue(o["arm_mismatch"], "an opus-arm agent whose calls ran on sonnet is flagged")
        arms = {a["arm"]: a for a in r["arms"]}
        self.assertEqual(arms["claude-sonnet-5.5"]["cost_per_merged_pr"], 3.0)
        self.assertEqual(arms["claude-sonnet-5.5"]["rounds_per_gated_pr"], 2.0)
        self.assertIsNone(arms["claude-opus-5.5"]["cost_per_merged_pr"])

    def test_without_gh_prs_are_unknown_not_zero(self):
        r = pt.trial_report(self.rows, self.calls, self.records, None)
        self.assertIsNone(r["agents"][0]["merged_prs"])
        md = pt.render(r, pt.pc.parse_ts("2026-10-22T00:00:00Z"), pt.pc.parse_ts("2026-11-05T00:00:00Z"), "log", "skipped")
        self.assertIn("## By arm", md)
        self.assertIn("| claude-sonnet-5.5 | anthropic/claude-sonnet-5.5 | 1 | $1.00 |", md)

    def test_window_counts_only_agents_enrolled_inside_it(self):
        rows = [
            {"ts": "2026-10-01T00:00:00Z", "team": "t", "agent": "past", "arm": "a", "model": SONNET, "task": ""},
            {"ts": "2026-10-23T03:00:00Z", "team": "t", "agent": "in", "arm": "a", "model": SONNET, "task": ""},
            {"ts": "2026-11-20T00:00:00Z", "team": "t", "agent": "future", "arm": "a", "model": SONNET, "task": ""},
        ]
        records = {("t", n): {"name": n, "parent": "team_lead"} for n in ("past", "in", "future")}
        calls = [call("t", "in", 4.0, SONNET, ts="2026-10-23T04:00:00Z"),
                 call("t", "in", 50.0, SONNET, ts="2026-10-20T00:00:00Z"),
                 call("t", "past", 9.0, SONNET, ts="2026-10-23T05:00:00Z")]
        since, until = pt.pc.parse_ts("2026-10-22T00:00:00Z"), pt.pc.parse_ts("2026-11-05T00:00:00Z")
        r = pt.trial_report(rows, calls, records, None, since=since, until=until)
        self.assertEqual([a["agent"] for a in r["agents"]], ["in"])
        self.assertEqual(r["excluded"], {"before": 1, "after": 1})
        self.assertEqual(r["agents"][0]["own_cost"], 4.0, "a call before enrollment (an earlier agent with the name) is not charged")
        arms = {a["arm"]: a for a in r["arms"]}
        self.assertEqual((arms["a"]["agents"], arms["a"]["mean_own_cost"]), (1, 4.0))
        md = pt.render(r, since, until, "log", "skipped")
        self.assertIn("1 enrolled before, 1 after", md)

    def test_nested_trial_agents_are_not_double_counted(self):
        rows = [
            {"ts": "2026-10-23T03:00:00Z", "team": "t", "agent": "outer", "arm": "opus", "model": OPUS, "task": ""},
            {"ts": "2026-10-23T03:10:00Z", "team": "t", "agent": "inner", "arm": "sonnet", "model": SONNET, "task": ""},
        ]
        records = {
            ("t", "outer"): {"name": "outer", "parent": "team_lead"},
            ("t", "inner"): {"name": "inner", "parent": "outer"},
            ("t", "leaf"): {"name": "leaf", "parent": "inner"},
        }
        calls = [call("t", "outer", 1.0, OPUS), call("t", "inner", 10.0, SONNET), call("t", "leaf", 5.0, OPUS)]
        r = pt.trial_report(rows, calls, records, None)
        by = {a["agent"]: a for a in r["agents"]}
        self.assertEqual(by["outer"]["subtree_cost"], 1.0)
        self.assertEqual(by["outer"]["subtree_cost_inclusive"], 16.0)
        self.assertEqual(by["outer"]["nested_trial_agents"], ["inner"])
        self.assertEqual(by["inner"]["subtree_cost"], 15.0)
        self.assertEqual(sum(a["subtree_cost"] for a in r["arms"]), 16.0, "arm totals add up to the real spend")

    def test_record_trial_without_log_row_is_reported(self):
        records = {("t", "lost"): {"name": "lost", "parent": "team_lead", "createdAt": "2026-10-23T03:00:00Z",
                                   "task": "Run it\nmore", "trial": {"arm": "claude-sonnet-5.5", "model": SONNET}}}
        r = pt.trial_report([], [call("t", "lost", 2.0, SONNET)], records, None)
        self.assertEqual(r["unlogged"], ["lost"])
        self.assertEqual((r["agents"][0]["arm"], r["agents"][0]["own_cost"], r["agents"][0]["task"]), ("claude-sonnet-5.5", 2.0, "Run it"))
        md = pt.render(r, pt.pc.parse_ts("2026-10-22T00:00:00Z"), pt.pc.parse_ts("2026-11-05T00:00:00Z"), "log", "skipped")
        self.assertIn("WARNING: 1 trial agent(s) have an arm on their record but no trial log row: lost.", md)
        self.assertIn("(UNLOGGED)", md)

    def test_read_trial_log(self):
        path = os.path.join(self.tmp, "lead-trial.tsv")
        with open(path, "w") as fh:
            fh.write("ts\tteam\tagent\tarm\tmodel\ttask\n2026-10-23T03:00:00Z\tt\ta\tx\ty\tdo it\nbroken\n")
        self.assertEqual(pt.read_trial_log(path), [{"ts": "2026-10-23T03:00:00Z", "team": "t", "agent": "a", "arm": "x", "model": "y", "task": "do it"}])
        self.assertEqual(pt.read_trial_log(os.path.join(self.tmp, "missing.tsv")), [])

    def test_cli_runs_read_only_over_empty_dirs(self):
        log = os.path.join(self.tmp, "lead-trial.tsv")
        with open(log, "w") as fh:
            fh.write("ts\tteam\tagent\tarm\tmodel\ttask\n2026-10-23T03:00:00Z\tt\ta\tclaude-opus-5.5\t%s\tdo it\n" % OPUS)
        env = dict(os.environ, PI_SESSIONS_DIR=os.path.join(self.tmp, "s"), PI_TEAMS_DIR=os.path.join(self.tmp, "t"),
                   PI_EXPORT_STATE=os.path.join(self.tmp, "x.json"))
        res = subprocess.run([sys.executable, SCRIPT, "--log", log, "--no-gh", "--json"], capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(res.returncode, 0, res.stderr)
        out = json.loads(res.stdout)
        self.assertEqual(out["agents"][0]["agent"], "a")
        self.assertEqual(out["agents"][0]["own_cost"], 0)


if __name__ == "__main__":
    unittest.main()
