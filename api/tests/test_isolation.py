"""Static checks: the service cannot reach IBM, and its image matches the tested stack."""

import ast
import re
import tomllib
from importlib.metadata import version
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
API = ROOT / "api"
FAKE_PROVIDER = "qiskit_ibm_runtime.fake_provider"


def service_sources() -> list[Path]:
    return [path for path in API.rglob("*.py") if "tests" not in path.parts]


def test_nothing_in_the_service_can_reach_the_runtime_service() -> None:
    sources = service_sources()
    assert sources
    for path in sources:
        source = path.read_text()
        assert "QiskitRuntimeService" not in source, path
        for node in ast.walk(ast.parse(source)):
            if isinstance(node, ast.Import):
                modules = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                modules = [node.module or ""]
            else:
                continue
            for module in modules:
                is_runtime = module.split(".")[0] == "qiskit_ibm_runtime"
                assert not is_runtime or module == FAKE_PROVIDER, f"{path}: {module}"


def api_pins() -> dict[str, str]:
    project = tomllib.loads((ROOT / "pyproject.toml").read_text())
    pins = project["project"]["optional-dependencies"]["api"]
    return dict(pin.split("==") for pin in pins)


def test_api_group_uses_exact_pins_that_match_what_was_tested() -> None:
    pins = api_pins()
    assert {"fastapi", "uvicorn", "qiskit", "qiskit-aer", "qiskit-ibm-runtime"} <= set(pins)
    assert {name: version(name) for name in pins} == pins


def lock_pins() -> dict[str, str]:
    lines = (API / "requirements.lock").read_text().splitlines()
    return dict(line.split("==") for line in lines if line and not line.startswith((" ", "#")))


def test_the_lock_holds_the_api_group_and_what_was_tested() -> None:
    locked = lock_pins()
    assert api_pins().items() <= locked.items()
    assert {name: version(name) for name in locked} == locked


def test_the_image_installs_only_from_the_lock() -> None:
    dockerfile = (API / "Dockerfile").read_text()
    assert "-r api/requirements.lock" in dockerfile
    assert "--no-deps" in dockerfile
    assert "==" not in dockerfile


def ignored_secrets_rules() -> list[str]:
    rules = (API / ".gcloudignore").read_text().splitlines()
    return [rule for rule in rules if rule and not rule.startswith("#")]


def test_secret_rules_come_after_the_allow_list() -> None:
    rules = ignored_secrets_rules()
    last_allowed = max(i for i, rule in enumerate(rules) if rule.startswith("!"))
    for rule in (".env*", "*.pem", "*.key", "qiskit-ibm.json"):
        assert rules.index(rule) > last_allowed
