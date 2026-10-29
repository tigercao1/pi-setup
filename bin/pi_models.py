"""Persona model routing from <agent-dir>/models.json, shared by pi-models, pi-doctor and the gate scripts.

pi core reads the same file for `providers`; `aliases`, `personas`, `unprofiled` and `leadTrial` sit
beside it. A missing or invalid persona section falls back to the built-in table and warns once.
"""
import json
import os
import sys
import tempfile

INHERIT = "inherit"
GATEWAY = "vercel-ai-gateway"
FALLBACK = {
    "aliases": {
        "opus": {"model": "anthropic/claude-opus-5.5", "provider": GATEWAY},
        "gpt": {"model": "openai/gpt-6.1-sol", "provider": GATEWAY},
    },
    "personas": {
        "coder": "opus", "pr-author": "opus", "tester": "opus",
        "reviewer": "gpt", "code-review": "gpt", "verifier": "gpt", "verifier-mcp": "gpt",
    },
    "unprofiled": {"router": "none", "fallback": "opus", "reason": "no routing config"},
}

_warned = set()


class ModelsError(ValueError):
    pass


def agent_dir():
    return (os.environ.get("PI_CODING_AGENT_DIR") or os.environ.get("PI_AGENT_DIR")
            or os.path.join(os.path.expanduser("~"), ".pi", "agent"))


def models_path(base=None):
    return os.path.join(base or agent_dir(), "models.json")


def _nonempty(value):
    return isinstance(value, str) and value.strip() != ""


def validate(raw):
    if not isinstance(raw, dict):
        raise ModelsError("top level is not an object")
    aliases, personas = raw.get("aliases"), raw.get("personas")
    if not isinstance(aliases, dict):
        raise ModelsError("no `aliases` object")
    if not isinstance(personas, dict):
        raise ModelsError("no `personas` object")
    for name, ref in aliases.items():
        if name == INHERIT:
            raise ModelsError('alias name "inherit" is reserved')
        if not isinstance(ref, dict) or not _nonempty(ref.get("model")) or not _nonempty(ref.get("provider")):
            raise ModelsError(f'alias "{name}" needs a model and a provider')

    def known(where, alias):
        if not _nonempty(alias) or alias not in aliases:
            raise ModelsError(f'{where} names unknown alias "{alias}"')

    for name, alias in personas.items():
        if alias != INHERIT:
            known(f'persona "{name}"', alias)
    unprofiled = raw.get("unprofiled")
    if unprofiled is not None:
        if not isinstance(unprofiled, dict):
            raise ModelsError("`unprofiled` is not an object")
        if unprofiled.get("router") != "jev":
            raise ModelsError('unprofiled.router must be "jev"')
        for key in ("implementation", "other", "fallback"):
            known(f"unprofiled.{key}", unprofiled.get(key))
        conf, timeout = unprofiled.get("minConfidence"), unprofiled.get("timeoutMs")
        if isinstance(conf, bool) or not isinstance(conf, (int, float)) or not 0 <= conf <= 1:
            raise ModelsError("unprofiled.minConfidence must be a number from 0 to 1")
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or timeout <= 0:
            raise ModelsError("unprofiled.timeoutMs must be a positive number")
    trial = raw.get("leadTrial")
    if trial is not None:
        if not isinstance(trial, list) or not trial:
            raise ModelsError("`leadTrial` must be a non-empty list of aliases")
        for i, alias in enumerate(trial):
            known(f"leadTrial[{i}]", alias)
    return raw


def read_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def load(path=None):
    path = path or models_path()
    try:
        raw = read_json(path)
    except FileNotFoundError:
        return FALLBACK, f"{path} is missing"
    except (OSError, ValueError) as exc:
        return FALLBACK, f"{path} cannot be parsed: {exc}"
    try:
        return validate(raw), None
    except ModelsError as exc:
        return FALLBACK, f"{path} is invalid: {exc}"


def warn_once(problem):
    if problem and problem not in _warned:
        _warned.add(problem)
        print(f"warning: {problem}; using the built-in persona models (run pi-models show)", file=sys.stderr)


def persona_ref(persona, path=None):
    config, problem = load(path)
    warn_once(problem)
    alias = config["personas"].get(persona)
    if not alias or alias == INHERIT:
        return None
    ref = config["aliases"].get(alias)
    return (ref["model"], ref["provider"]) if ref else None


def persona_model(persona, fallback, path=None):
    ref = persona_ref(persona, path)
    return ref[0] if ref else fallback


def store_ids(base=None):
    try:
        store = read_json(os.path.join(base or agent_dir(), "models-store.json"))
    except (OSError, ValueError):
        return None
    out = {}
    for provider, entry in (store.items() if isinstance(store, dict) else []):
        models = entry.get("models") if isinstance(entry, dict) else None
        out[provider] = {m.get("id") for m in models or [] if isinstance(m, dict)}
    return out


def write_json_atomic(path, data):
    directory = os.path.dirname(os.path.abspath(path))
    try:
        mode = os.stat(path).st_mode & 0o7777
    except FileNotFoundError:
        mode = 0o644
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=f".{os.path.basename(path)}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def update_json(path, mutate):
    data = read_json(path)
    before = json.dumps(data, sort_keys=True)
    mutate(data)
    if json.dumps(data, sort_keys=True) == before:
        return False
    write_json_atomic(path, data)
    return True
