"""Static checks: only the chip press can reach IBM, and the image matches the tested stack."""

import ast
import re
import tomllib
from importlib.metadata import version
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
API = ROOT / "api"
CHIP = API / "chip.py"
FAKE_PROVIDER = "qiskit_ibm_runtime.fake_provider"
# What the press may import from the runtime: the service, and its not-found error.
CHIP_RUNTIME_IMPORTS = {"qiskit_ibm_runtime", "qiskit_ibm_runtime.exceptions"}


def service_sources() -> list[Path]:
    return [path for path in API.rglob("*.py") if "tests" not in path.parts]


def imported_modules(tree: ast.AST) -> list[str]:
    modules: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules += [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            modules.append(node.module or "")
    return modules


def test_only_the_chip_press_can_reach_the_runtime_service() -> None:
    sources = service_sources()
    assert CHIP in sources
    for path in sources:
        source = path.read_text()
        allowed = {FAKE_PROVIDER} | (CHIP_RUNTIME_IMPORTS if path == CHIP else set())
        if path != CHIP:
            assert "QiskitRuntimeService" not in source, path
        for module in imported_modules(ast.parse(source)):
            is_runtime = module.split(".")[0] == "qiskit_ibm_runtime"
            assert not is_runtime or module in allowed, f"{path}: {module}"


def test_the_runtime_service_is_built_in_one_function_only() -> None:
    tree = ast.parse(CHIP.read_text())
    builders = {
        function.name
        for function in ast.walk(tree)
        if isinstance(function, ast.FunctionDef)
        for call in ast.walk(function)
        if isinstance(call, ast.Call)
        and isinstance(call.func, ast.Name)
        and call.func.id == "QiskitRuntimeService"
    }
    calls = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "QiskitRuntimeService"
    ]
    assert builders == {"runtime_service"}
    assert len(calls) == 1


def test_chip_code_from_quantum_is_loaded_only_by_the_press() -> None:
    """quantum.chip* also holds the offline CLI, which writes records and reads local credentials."""
    for path in service_sources():
        for module in imported_modules(ast.parse(path.read_text())):
            if module.startswith("quantum.chip"):
                assert path in (CHIP, API / "main.py"), f"{path}: {module}"
                assert module in ("quantum.chip", "quantum.chip_chsh"), f"{path}: {module}"


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
