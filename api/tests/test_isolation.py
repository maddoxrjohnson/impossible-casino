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


def test_the_image_installs_exactly_the_api_group() -> None:
    dockerfile = (API / "Dockerfile").read_text()
    pinned = dict(re.findall(r"\b([a-z][a-z-]+)==([0-9][0-9.]*)", dockerfile))
    assert pinned == api_pins()
