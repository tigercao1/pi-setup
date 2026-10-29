import importlib.util
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.path.abspath(os.path.join(HERE, ".."))
AGENT = os.path.abspath(os.path.join(BIN, ".."))
CLI = os.path.join(BIN, "pi-models")
DOCTOR = os.path.join(BIN, "pi-doctor")
GATE = os.path.join(BIN, "pr_gate_core.py")
SKIM = os.path.join(AGENT, "skills", "clear-message", "bin", "skim-test.py")

GW = "vercel-ai-gateway"
OPUS = "anthropic/claude-opus-5.5"
SONNET = "anthropic/claude-sonnet-5.5"
GPT = "openai/gpt-6.1-sol"
HAIKU = "anthropic/claude-haiku-5.5"
DESIGN = {
    "providers": {GW: {"apiKey": "$UNUSED"}},
    "aliases": {
        "opus": {"model": OPUS, "provider": GW},
        "sonnet": {"model": SONNET, "provider": GW},
        "gpt": {"model": GPT, "provider": GW},
        "haiku": {"model": HAIKU, "provider": GW},
    },
    "personas": {
        "lead": "sonnet", "coder": "opus", "pr-author": "opus", "tester": "opus",
        "reviewer": "gpt", "code-review": "gpt", "verifier": "gpt", "verifier-mcp": "gpt",
        "researcher": "sonnet", "docs-writer": "sonnet", "manager": "inherit", "batch-orchestrator": "inherit",
        "gate-approval-second": "opus", "skim-test": "haiku",
    },
    "unprofiled": {"router": "jev", "implementation": "opus", "other": "sonnet", "fallback": "opus",
                   "minConfidence": 0.8, "timeoutMs": 3000},
    "leadTrial": ["sonnet", "opus"],
}
STORE = {GW: {"models": [{"id": m} for m in (OPUS, SONNET, GPT, HAIKU, "anthropic/claude-opus-5.5-fast")]}}


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def read(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def text(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def write(path, data):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
        fh.write("\n")


class AgentDirCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="pi-models-test-")
        self.dir = os.path.join(self.tmp, "agent")
        os.makedirs(self.dir)
        for name in ("settings.json", "settings.base.json"):
            shutil.copy(os.path.join(AGENT, name), os.path.join(self.dir, name))
        self.models = os.path.join(self.dir, "models.json")
        write(self.models, DESIGN)
        os.chmod(self.models, 0o600)
        write(os.path.join(self.dir, "models-store.json"), STORE)
        self.env = dict(os.environ, PI_CODING_AGENT_DIR=self.dir, PI_AGENT_DIR=self.dir, HOME=self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def settings(self, name="settings.json"):
        return read(os.path.join(self.dir, name))

    def run_cli(self, *args):
        return subprocess.run([sys.executable, "-B", CLI, "--agent-dir", self.dir, *args],
                              capture_output=True, text=True, env=self.env, timeout=60)


class PiModelsCliTest(AgentDirCase):
    def test_show_prints_persona_alias_model(self):
        out = self.run_cli("show")
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertRegex(out.stdout, r"code-review\s+gpt\s+openai/gpt-6\.1-sol\s+vercel-ai-gateway")
        self.assertRegex(out.stdout, r"manager\s+inherit\s+\(inherit\)")
        self.assertIn("unprofiled workers (jev)", out.stdout)

    def test_show_without_a_file_sends_unprofiled_workers_to_the_fallback_alias(self):
        for broken in (lambda: os.remove(self.models), lambda: open(self.models, "w").write("{ invalid")):
            broken()
            out = self.run_cli("show")
            self.assertEqual(out.returncode, 0, out.stderr)
            self.assertIn("showing the built-in fallback table", out.stdout)
            self.assertIn("unprofiled workers (fallback: no routing config): every spawn -> opus, no jev call", out.stdout)
            self.assertNotIn("(jev)", out.stdout)
        pm = load_module("pi_models_fallback", os.path.join(BIN, "pi_models.py"))
        rule = pm.FALLBACK["unprofiled"]
        self.assertEqual(pm.FALLBACK["aliases"][rule["fallback"]], {"model": OPUS, "provider": GW})

    def test_set_alias_then_sync_round_trip_touches_only_the_two_keys(self):
        before = {n: self.settings(n) for n in ("settings.json", "settings.base.json")}
        out = self.run_cli("set-alias", "sonnet", HAIKU)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(read(self.models)["aliases"]["sonnet"], {"model": HAIKU, "provider": GW})
        self.assertEqual(read(self.models)["providers"], DESIGN["providers"], "pi's providers key survives")
        self.assertEqual(stat.S_IMODE(os.stat(self.models).st_mode), 0o600, "the file mode survives the rename")
        for name, old in before.items():
            new = self.settings(name)
            self.assertEqual(new["defaultModel"], HAIKU, name)
            self.assertEqual(new["defaultProvider"], GW, name)
            self.assertEqual({k: v for k, v in new.items() if k not in ("defaultModel", "defaultProvider")},
                             {k: v for k, v in old.items() if k not in ("defaultModel", "defaultProvider")}, name)
        out = self.run_cli("set-alias", "sonnet", SONNET)
        self.assertEqual(out.returncode, 0, out.stderr)
        for name, old in before.items():
            self.assertEqual(self.settings(name), old, f"{name} is back to the original")
        self.assertEqual([f for f in os.listdir(self.dir) if f.endswith(".tmp")], [], "no temp files left")

    def test_set_alias_refuses_an_id_not_in_the_store(self):
        before = text(self.models)
        out = self.run_cli("set-alias", "opus", "anthropic/claude-opus-9")
        self.assertEqual(out.returncode, 1)
        self.assertIn("not a vercel-ai-gateway model in models-store.json", out.stderr)
        self.assertEqual(text(self.models), before)
        self.assertEqual(self.run_cli("set-alias", "opus", OPUS, "--provider", "other").returncode, 1)

    def test_set_persona_syncs_the_lead_and_refuses_inherit_for_it(self):
        out = self.run_cli("set-persona", "lead", "opus")
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(self.settings()["defaultModel"], OPUS)
        self.assertEqual(self.settings("settings.base.json")["defaultModel"], OPUS)
        self.assertEqual(self.run_cli("set-persona", "lead", "inherit").returncode, 1)
        self.assertEqual(self.run_cli("set-persona", "coder", "nope").returncode, 1)
        out = self.run_cli("set-persona", "coder", "inherit")
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(read(self.models)["personas"]["coder"], "inherit")

    def test_sync_rereads_settings_and_keeps_a_concurrent_edit(self):
        path = os.path.join(self.dir, "settings.json")
        data = read(path)
        data["defaultModel"] = "stale/model"
        data["writtenByAnotherSession"] = {"x": 1}
        write(path, data)
        out = self.run_cli("sync")
        self.assertEqual(out.returncode, 0, out.stderr)
        after = read(path)
        self.assertEqual(after["defaultModel"], SONNET)
        self.assertEqual(after["writtenByAnotherSession"], {"x": 1})
        mtime = os.stat(path).st_mtime_ns
        self.assertEqual(self.run_cli("sync").returncode, 0)
        self.assertEqual(os.stat(path).st_mtime_ns, mtime, "an in-sync file is not rewritten")

    def test_sync_refuses_an_invalid_models_file(self):
        write(self.models, {"providers": DESIGN["providers"]})
        before = self.settings()
        out = self.run_cli("sync")
        self.assertEqual(out.returncode, 1)
        self.assertEqual(self.settings(), before)


class CheckTest(AgentDirCase):
    def lines(self, level):
        out = self.run_cli("check")
        return out, [line for line in out.stdout.splitlines() if line.startswith(f"  {level}")]

    def test_clean_copy_passes(self):
        out, fails = self.lines("FAIL")
        self.assertEqual(out.returncode, 0, out.stdout)
        self.assertEqual(fails, [])
        self.assertIn("models.json parses: 4 aliases, 14 personas", out.stdout)

    def test_alias_missing_from_store_fails(self):
        data = read(self.models)
        data["aliases"]["haiku"]["model"] = "anthropic/claude-haiku-9"
        write(self.models, data)
        out, fails = self.lines("FAIL")
        self.assertEqual(out.returncode, 1)
        self.assertTrue(any("alias haiku" in f and "not in models-store.json" in f for f in fails), out.stdout)

    def test_unparseable_models_fails(self):
        with open(self.models, "w") as fh:
            fh.write("{ nope")
        out, fails = self.lines("FAIL")
        self.assertEqual(out.returncode, 1)
        self.assertTrue(any("cannot be parsed" in f for f in fails), out.stdout)

    def test_default_model_drift_fails_in_either_file(self):
        path = os.path.join(self.dir, "settings.base.json")
        data = read(path)
        data["defaultModel"] = OPUS
        write(path, data)
        out, fails = self.lines("FAIL")
        self.assertEqual(out.returncode, 1)
        self.assertTrue(any(f.startswith("  FAIL  settings.base.json defaultModel") for f in fails), out.stdout)

    def test_model_in_settings_profiles_warns(self):
        path = os.path.join(self.dir, "settings.json")
        data = read(path)
        data.setdefault("team", {}).setdefault("profiles", {})["coder"] = {"model": OPUS, "provider": GW}
        write(path, data)
        out, warns = self.lines("warn")
        self.assertEqual(out.returncode, 0, "a settings profile model is a warning, not a failure")
        self.assertTrue(any("team.profiles.coder.model" in w for w in warns), out.stdout)

    def test_pi_doctor_runs_the_checks_and_counts_failures(self):
        data = read(self.models)
        data["aliases"]["gpt"]["model"] = "openai/not-a-model"
        write(self.models, data)
        out = subprocess.run(["bash", DOCTOR], capture_output=True, text=True, env=self.env, timeout=120)
        section = out.stdout.split("persona models (models.json)", 1)
        self.assertEqual(len(section), 2, out.stdout[-2000:])
        body = section[1].split("\n\n", 1)[0]
        self.assertIn("FAIL  alias gpt: vercel-ai-gateway openai/not-a-model is not in models-store.json", body)
        self.assertIn("ok    settings.json defaultModel anthropic/claude-sonnet-5.5 matches the lead persona", body)
        self.assertNotEqual(out.returncode, 0)


class PersonaReadersTest(AgentDirCase):
    def module_value(self, path, expr):
        code = (f"import importlib.util; spec = importlib.util.spec_from_file_location('m', {path!r}); "
                f"m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); print({expr})")
        return subprocess.run([sys.executable, "-B", "-c", code], capture_output=True, text=True,
                              env=self.env, timeout=60)

    def test_gate_models_come_from_personas(self):
        data = read(self.models)
        data["aliases"]["gpt5"] = {"model": "openai/gpt-5", "provider": GW}
        data["personas"]["code-review"] = "gpt5"
        data["personas"]["gate-approval-second"] = "sonnet"
        write(self.models, data)
        out = self.module_value(GATE, "m.PRIMARY_MODEL, m.OPUS_MODEL, m.lane_model('approval-opus')")
        self.assertEqual(out.stdout.strip(), f"openai/gpt-5 {SONNET} {SONNET}", out.stderr)
        self.assertEqual(out.stderr, "")

    def test_gate_models_fall_back_with_one_warning(self):
        os.unlink(self.models)
        out = self.module_value(GATE, "m.PRIMARY_MODEL, m.OPUS_MODEL")
        self.assertEqual(out.stdout.strip(), f"{GPT} {OPUS}")
        self.assertEqual(out.stderr.count("warning:"), 1, out.stderr)

    def test_skim_test_model_comes_from_its_persona(self):
        out = self.module_value(SKIM, "m.MODEL")
        self.assertEqual(out.stdout.strip(), f"{GW}/{HAIKU}", out.stderr)
        data = read(self.models)
        data["personas"]["skim-test"] = "sonnet"
        write(self.models, data)
        self.assertEqual(self.module_value(SKIM, "m.MODEL").stdout.strip(), f"{GW}/{SONNET}")
        data["personas"]["skim-test"] = "inherit"
        write(self.models, data)
        self.assertEqual(self.module_value(SKIM, "m.MODEL").stdout.strip(), f"{GW}/{HAIKU}", "inherit keeps the fallback")

    def test_helper_falls_back_on_an_invalid_file(self):
        pm = load_module("pi_models_under_test", os.path.join(BIN, "pi_models.py"))
        data = read(self.models)
        data["personas"]["coder"] = "missing-alias"
        write(self.models, data)
        config, problem = pm.load(self.models)
        self.assertIs(config, pm.FALLBACK)
        self.assertIn('persona "coder" names unknown alias "missing-alias"', problem)
        self.assertEqual(pm.persona_model("gate-approval-second", "fallback/x", self.models), "fallback/x")


if __name__ == "__main__":
    unittest.main()
