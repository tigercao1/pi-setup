import importlib.machinery
import importlib.util
import json
import os
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
loader = importlib.machinery.SourceFileLoader("pi_cost", os.path.join(HERE, "..", "pi-cost"))
spec = importlib.util.spec_from_loader(loader.name, loader)
pc = importlib.util.module_from_spec(spec)
loader.exec_module(pc)

OPUS = "anthropic/claude-opus-5.5"
SOL = "openai/gpt-6.1-sol"
PRICES = {
    "data": [
        {"id": OPUS, "pricing": {"input": "0.000004", "output": "0.00002", "input_cache_read": "0.0000002",
                                 "input_cache_write": "0.000005"}},
        {"id": SOL, "pricing": {"input": "0.000002", "output": "0.00001", "input_cache_read": "0.0000001",
                                "input_cache_write": "0.0000025",
                                "input_tiers": [{"cost": "0.000002", "min": 0, "max": 272001},
                                                {"cost": "0.000004", "min": 272001}],
                                "input_cache_read_tiers": [{"cost": "0.0000001", "min": 0, "max": 272001},
                                                           {"cost": "0.0000002", "min": 272001}]}},
        {"id": "moonshotai/kimi-k3", "pricing": {"input": "0.000003", "output": "0.000015",
                                                 "input_cache_read": "0.0000003"}},
    ]
}


def usage(inp, out, read, write):
    r = {"input": 4e-6, "output": 2e-5, "cacheRead": 2e-7, "cacheWrite": 5e-6}
    cost = {"input": inp * r["input"], "output": out * r["output"], "cacheRead": read * r["cacheRead"],
            "cacheWrite": write * r["cacheWrite"]}
    cost["total"] = sum(cost.values())
    return {"input": inp, "output": out, "cacheRead": read, "cacheWrite": write, "cacheWrite1h": 0, "cost": cost}


def assistant(eid, ts, u, model=OPUS, tool_calls=None, ms=None):
    content = [{"type": "toolCall", "id": tc[0], "name": tc[1], "arguments": tc[2]} for tc in tool_calls or []]
    return {"type": "message", "id": eid, "timestamp": ts,
            "message": {"role": "assistant", "content": content, "provider": "vercel-ai-gateway", "model": model,
                        "usage": u, "stopReason": "toolUse", "timestamp": ms or eid_ms(ts)}}


def eid_ms(ts):
    return int(pc.parse_ts(ts).timestamp() * 1000) - 500


def user(eid, ts, text):
    return {"type": "message", "id": eid, "timestamp": ts,
            "message": {"role": "user", "content": [{"type": "text", "text": text}]}}


def tool_result(eid, ts, call_id, name, text):
    return {"type": "message", "id": eid, "timestamp": ts,
            "message": {"role": "toolResult", "toolCallId": call_id, "toolName": name,
                        "content": [{"type": "text", "text": text}]}}


def write_session(root, folder, start, sid, entries, cwd="/tmp/x"):
    d = os.path.join(root, folder)
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, "%s_%s.jsonl" % (start.replace(":", "-"), sid))
    with open(path, "w") as fh:
        fh.write(json.dumps({"type": "session", "version": 3, "id": sid, "timestamp": start, "cwd": cwd}) + "\n")
        for e in entries:
            fh.write(json.dumps(e) + "\n")
    return path


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        self.sessions = os.path.join(self.root, "sessions")
        self.teams = os.path.join(self.root, "teams")
        self.pricing = pc.Pricing({m["id"]: m["pricing"] for m in PRICES["data"]})

    def tearDown(self):
        self.tmp.cleanup()

    def team(self, name, archive=(), config=()):
        d = os.path.join(self.teams, name)
        os.makedirs(os.path.join(d, "archive"), exist_ok=True)
        with open(os.path.join(d, "archive", "agents.jsonl"), "w") as fh:
            for a in archive:
                fh.write(json.dumps(a) + "\n")
        with open(os.path.join(d, "config.json"), "w") as fh:
            json.dump({"team": name, "agents": list(config)}, fh)

    def ledger(self, worker_logs=False):
        agents = pc.load_agents(self.teams)
        return pc.build_ledger(None, None, sessions_dir=self.sessions, agents=agents, router=None,
                               pricing=self.pricing, worker_logs_dir=self.teams if worker_logs else None)


class DedupeTest(Fixture):
    def test_forked_copy_counts_once_and_belongs_to_the_earliest_file(self):
        shared = [user("u1", "2026-10-01T10:00:00.000Z", "hello"),
                  assistant("a1", "2026-10-01T10:00:05.000Z", usage(10, 100, 0, 20000)),
                  assistant("a2", "2026-10-01T10:00:09.000Z", usage(5, 50, 20000, 1000))]
        write_session(self.sessions, "p", "2026-10-01T10:00:00.000Z", "parent", shared)
        write_session(self.sessions, "p", "2026-10-01T11:00:00.000Z", "fork",
                      shared + [assistant("a3", "2026-10-01T11:00:05.000Z", usage(5, 70, 21000, 500))])
        calls = self.ledger()["calls"]
        self.assertEqual(sorted(c["id"] for c in calls), ["a1", "a2", "a3"])
        owner = {c["id"]: c["session"] for c in calls}
        self.assertEqual(owner["a1"], "parent")
        self.assertEqual(owner["a2"], "parent")
        self.assertEqual(owner["a3"], "fork")
        total = sum(c["cost"] for c in calls)
        expected = sum(usage(*u)["cost"]["total"] for u in ((10, 100, 0, 20000), (5, 50, 20000, 1000),
                                                             (5, 70, 21000, 500)))
        self.assertAlmostEqual(total, expected)

    def test_same_id_with_a_different_timestamp_is_a_different_entry(self):
        write_session(self.sessions, "p", "2026-10-01T10:00:00.000Z", "s1",
                      [assistant("a1", "2026-10-01T10:00:05.000Z", usage(1, 1, 0, 1))])
        write_session(self.sessions, "p", "2026-10-02T10:00:00.000Z", "s2",
                      [assistant("a1", "2026-10-02T10:00:05.000Z", usage(1, 1, 0, 1))])
        self.assertEqual(len(self.ledger()["calls"]), 2)

    def test_worker_log_adds_only_calls_missing_from_sessions(self):
        a1 = assistant("a1", "2026-10-01T10:00:05.000Z", usage(10, 100, 0, 20000))
        write_session(self.sessions, "p", "2026-10-01T10:00:00.000Z", "w1", [a1])
        self.team("team-20261001100000-abc0")
        logs = os.path.join(self.teams, "team-20261001100000-abc0", "logs")
        os.makedirs(logs)
        missing = assistant("zz", "2026-10-01T10:05:00.000Z", usage(1, 2, 3, 4))["message"]
        with open(os.path.join(logs, "w.log"), "w") as fh:
            for e in ({"type": "session", "id": "w1"}, {"type": "message_end", "message": a1["message"]},
                      {"type": "message_end", "message": missing}, {"type": "message_end", "message": missing}):
                fh.write(json.dumps(e, separators=(",", ":")) + "\n")
        calls = self.ledger(worker_logs=True)["calls"]
        self.assertEqual(len(calls), 2)
        self.assertEqual([c.get("source") for c in calls].count("worker-log"), 1)


class RoleTest(Fixture):
    def worker_session(self, sid, start, title=None):
        entries = [user("k" + sid, start, "Begin the assignment in your system prompt now."),
                   assistant("x" + sid, start.replace("00.000Z", "05.000Z"), usage(1, 1, 0, 100))]
        if title:
            entries.insert(0, {"type": "session_info", "id": "i" + sid, "timestamp": start, "name": title})
        write_session(self.sessions, "w", start, sid, entries)

    def test_roles_from_config_profile_spawn_call_name_and_title(self):
        lead_entries = [user("u1", "2026-10-01T09:00:00.000Z", "do it"),
                        assistant("s1", "2026-10-01T09:59:58.000Z", usage(1, 1, 0, 100),
                                  tool_calls=[("t1", "team_spawn", {"name": "alpha", "profile": "code-review"})])]
        write_session(self.sessions, "l", "2026-10-01T09:00:00.000Z", "lead1", lead_entries)
        self.team("team-20261001100000-abc0",
                  archive=[{"name": "alpha", "sessionId": "wa", "createdAt": "2026-10-01T10:00:00.000Z", "task": ""},
                           {"name": "widget-impl", "sessionId": "wb", "createdAt": "2026-10-01T10:00:00.000Z",
                            "task": ""}],
                  config=[{"name": "gamma", "sessionId": "wc", "profile": "verifier",
                           "createdAt": "2026-10-01T10:00:00.000Z"}])
        for sid in ("wa", "wb", "wc"):
            self.worker_session(sid, "2026-10-01T10:00:00.000Z")
        self.worker_session("wd", "2026-10-01T10:00:00.000Z", title="team-20261001100000-zzz0:deep-research")
        self.worker_session("we", "2026-10-01T10:00:00.000Z")
        roles = {c["session"]: c["role"] for c in self.ledger()["calls"]}
        self.assertEqual(roles["lead1"], "lead")
        self.assertEqual(roles["wa"], "reviewer")
        self.assertEqual(roles["wb"], "coder")
        self.assertEqual(roles["wc"], "verifier")
        self.assertEqual(roles["wd"], "researcher")
        self.assertEqual(roles["we"], "other")

    def test_profile_wins_over_name(self):
        self.assertEqual(pc.role_for({"name": "fix-review", "profile": "coder"}, True), "coder")
        self.assertEqual(pc.role_for({"name": "fix-review"}, True), "reviewer")
        self.assertEqual(pc.role_for(None, False), "lead")


class PricingTest(Fixture):
    def test_reprice_matches_published_rates(self):
        tokens = {"input": 1000, "output": 2000, "cacheRead": 100_000, "cacheWrite": 10_000}
        p = self.pricing.cost(OPUS, tokens)
        self.assertAlmostEqual(p["total"], 1000 * 4e-6 + 2000 * 2e-5 + 100_000 * 2e-7 + 10_000 * 5e-6)

    def test_long_context_tier_applies_above_threshold(self):
        small = self.pricing.cost(SOL, {"input": 1000, "output": 0, "cacheRead": 200_000, "cacheWrite": 0})
        big = self.pricing.cost(SOL, {"input": 1000, "output": 0, "cacheRead": 300_000, "cacheWrite": 0})
        self.assertAlmostEqual(small["input"], 1000 * 2e-6)
        self.assertAlmostEqual(big["input"], 1000 * 4e-6)
        self.assertAlmostEqual(big["cacheRead"], 300_000 * 2e-7)

    def test_missing_cache_write_falls_back_to_input_and_is_flagged(self):
        r = self.pricing.rates("moonshotai/kimi-k3")
        self.assertEqual(r["cacheWrite"], r["input"])
        self.assertIn("cacheWrite", r["assumed"])

    def test_reprice_whole_ledger_under_another_model(self):
        calls = [{"input": 10, "output": 100, "cacheRead": 0, "cacheWrite": 20000, "context": 20010}]
        r = pc.reprice(calls, self.pricing, SOL)
        self.assertAlmostEqual(r["total"], 10 * 2e-6 + 100 * 1e-5 + 20000 * 2.5e-6)


class TtlTest(Fixture):
    def call(self, gap, read, write, prev, model=OPUS, role="lead"):
        c = {"model": model, "role": role, "input": 0, "output": 0, "cacheRead": read, "cacheWrite": write,
             "gap_prev_call_s": gap, "prev_context": prev}
        c["context"] = read + write
        c["idle_rewrite_tokens"] = pc.idle_rewrite_tokens(c)
        return c

    def test_idle_rewrite_inside_an_hour_becomes_a_read(self):
        c = self.call(600, 0, 100_000, 99_000)
        self.assertEqual(c["idle_rewrite_tokens"], 99_000)
        r = pc.ttl_counterfactual([c], self.pricing)
        self.assertAlmostEqual(r["actual"], 100_000 * 5e-6)
        self.assertAlmostEqual(r["one_hour"], 1_000 * 8e-6 + 99_000 * 2e-7)

    def test_gap_over_an_hour_still_rewrites_at_the_one_hour_price(self):
        c = self.call(7200, 0, 100_000, 99_000)
        r = pc.ttl_counterfactual([c], self.pricing)
        self.assertAlmostEqual(r["one_hour"], 100_000 * 8e-6)

    def test_warm_call_pays_more_under_one_hour_and_non_anthropic_is_skipped(self):
        warm = self.call(30, 99_000, 1_000, 99_000)
        self.assertEqual(warm["idle_rewrite_tokens"], 0)
        r = pc.ttl_counterfactual([warm, self.call(600, 0, 100_000, 99_000, model=SOL)], self.pricing)
        self.assertAlmostEqual(r["actual"], 99_000 * 2e-7 + 1_000 * 5e-6)
        self.assertAlmostEqual(r["delta"], 1_000 * (8e-6 - 5e-6))

    def test_multiplier_is_configurable(self):
        p = pc.Pricing(self.pricing.models, write_1h_multiplier=1.6)
        self.assertAlmostEqual(p.rates(OPUS)["cacheWrite1h"], 4e-6 * 1.6)


class CapTest(Fixture):
    def test_cap_restarts_and_keeps_per_turn_growth(self):
        shape = [(0, 30_000), (30_000, 80_000), (110_000, 10_000), (120_000, 0), (0, 120_000)]
        calls = [{"ts": "2026-10-01T10:%02d:00Z" % i, "model": OPUS, "input": 0, "output": 0, "cacheRead": r,
                  "cacheWrite": w, "context": r + w} for i, (r, w) in enumerate(shape)]
        r = pc.cap_counterfactual(calls, self.pricing, cap=100_000, handoff_tokens=20_000, base_cap=50_000)
        self.assertEqual(r["restarts"], 1)
        self.assertAlmostEqual(r["actual"], 0.15 + 0.406 + 0.072 + 0.024 + 0.6)
        self.assertAlmostEqual(r["capped"], 0.15 + 0.406 + 0.3 + 0.012 + 0.3)
        uncapped = pc.cap_counterfactual(calls, self.pricing, cap=10_000_000)
        self.assertEqual(uncapped["restarts"], 0)
        self.assertAlmostEqual(uncapped["capped"], uncapped["actual"])

class LayerConfigTest(unittest.TestCase):
    def probe(self, layer_config):
        import subprocess
        layer = tempfile.mkdtemp()
        if layer_config is not None:
            with open(os.path.join(layer, "pi-cost.json"), "w") as fh:
                json.dump(layer_config, fh)
        code = ("import importlib.machinery, importlib.util, json, datetime as dt\n"
                "l = importlib.machinery.SourceFileLoader('pc', %r)\n"
                "s = importlib.util.spec_from_loader(l.name, l); m = importlib.util.module_from_spec(s); l.exec_module(m)\n"
                "now = dt.datetime.now(dt.timezone.utc)\n"
                "print(json.dumps([m.GH_REPO, m.WORK_SEGMENT, m.ticket_for('/w/abc-77/x', ''),"
                " m.ticket_for('/tmp', 'ABC-12 abc-12 ABC-12 XY-9'), m.gh_merged_prs(now, now)[1] if not m.GH_REPO else None]))"
                % os.path.join(HERE, "..", "pi-cost"))
        env = {k: v for k, v in os.environ.items() if not k.startswith("PI_COST_GH")}
        env["PI_LAYER_DIR"] = layer
        res = subprocess.run([sys.executable, "-B", "-c", code], capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(res.returncode, 0, res.stderr)
        return json.loads(res.stdout)

    def test_without_a_layer_config_nothing_company_specific_is_assumed(self):
        repo, segment, from_cwd, from_text, gh = self.probe(None)
        self.assertEqual((repo, segment, from_cwd, from_text), ("", "work", None, "ABC-12"))
        self.assertTrue(gh.startswith("skipped (no repo"))

    def test_layer_config_supplies_repo_ticket_prefix_and_worktree_pattern(self):
        cfg = {"ghRepo": "acme/widgets", "ticketPrefix": "ABC", "worktreeTicketPattern": "/w/(abc)-(\\d+)",
               "workSegment": "acme"}
        repo, segment, from_cwd, from_text, _ = self.probe(cfg)
        self.assertEqual((repo, segment, from_cwd, from_text), ("acme/widgets", "acme", "ABC-77", "ABC-12"))

if __name__ == "__main__":
    unittest.main()
