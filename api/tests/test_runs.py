import json
import math
import re
from importlib.metadata import version
from pathlib import Path
from typing import Any

import pytest
from qiskit_aer import AerSimulator
from qiskit_ibm_runtime.fake_provider import FakeKingston

from api.engine import CHSH_SHOTS, WIESNER_SHOTS, Engine
from api.tests.conftest import MakeClient
from quantum.chsh import run_chsh
from quantum.export_chsh import DIAL_GRID, quietest_pair
from quantum.export_wiesner import noise_simulator

DATA_DIR = Path(__file__).resolve().parents[2] / "web" / "public" / "data"
CHIP_BACKEND = re.compile(r"^ibm_[a-z0-9_]+$")


def exported(name: str) -> Any:
    return json.loads((DATA_DIR / f"{name}.v1.json").read_text())


def exported_run(name: str) -> dict[str, Any]:
    return next(run for run in exported(name)["runs"] if run["id"] == "ibm-noise-model")


def check_provenance(provenance: dict[str, Any]) -> None:
    """The rules parseProvenance in results.ts applies, plus what live results owe."""
    assert provenance["source"] == "live-simulator"
    assert provenance["jobId"] is None
    assert not CHIP_BACKEND.match(provenance["backend"])
    assert provenance["qiskitVersion"] == version("qiskit")
    assert provenance["aerVersion"] == version("qiskit-aer")
    assert provenance["runtimeVersion"] == version("qiskit-ibm-runtime")
    assert isinstance(provenance["shots"], int) and provenance["shots"] >= 1
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", provenance["date"])
    model = provenance["noiseModel"]
    assert model["name"] == "fake_kingston"
    assert model["calibrated"] and model["qubitSelection"] and model["scope"]


def test_the_ping_does_no_quantum_work(make_client: MakeClient) -> None:
    class Untouchable:
        def chsh(self, dial: float) -> dict[str, Any]:
            raise AssertionError

        def wiesner(self, length: int) -> dict[str, Any]:
            raise AssertionError

    client = make_client(engine_factory=Untouchable)
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_the_grid_matches_the_export() -> None:
    assert list(DIAL_GRID) == [point["dial"] for point in exported_run("chsh")["points"]]


def test_chsh_returns_a_full_live_result(make_client: MakeClient) -> None:
    response = make_client().post("/v1/chsh", json={"dial": 0.5})
    assert response.status_code == 200
    body = response.json()
    assert body["experiment"] == "chsh"
    assert body["dial"] == 0.5
    assert body["outcomeOrder"] == "ba"
    assert body["runId"] == f"live-{body['seed']}"
    assert 0 <= body["winRate"] <= 1
    assert [(p["x"], p["y"]) for p in body["pairs"]] == [(0, 0), (0, 1), (1, 0), (1, 1)]
    for pair in body["pairs"]:
        assert sorted(pair["counts"]) == ["00", "01", "10", "11"]
        assert sum(pair["counts"].values()) == pair["shots"] == CHSH_SHOTS
    check_provenance(body["provenance"])
    assert body["provenance"]["shots"] == CHSH_SHOTS
    assert "circuits" not in body


@pytest.mark.parametrize("dial", [0, 1, 0.03125])
def test_chsh_takes_every_form_a_grid_dial_arrives_in(make_client: MakeClient, dial: float) -> None:
    # JSON.stringify(1) sends an integer.
    assert make_client().post("/v1/chsh", json={"dial": dial}).json()["dial"] == dial


@pytest.mark.parametrize(
    "body",
    [
        {"dial": 0.51},
        {"dial": 1.03125},
        {"dial": -0.03125},
        {"dial": "0.5"},
        {"dial": True},
        {"dial": None},
        {},
        {"dial": 0.5, "shots": 100000},
    ],
)
def test_chsh_refuses_anything_off_the_grid(make_client: MakeClient, body: dict[str, Any]) -> None:
    assert make_client().post("/v1/chsh", json=body).status_code == 422


@pytest.mark.parametrize("raw", ["NaN", "Infinity", "not json", "[]"])
def test_chsh_refuses_bad_json(make_client: MakeClient, raw: str) -> None:
    response = make_client().post(
        "/v1/chsh", content=f'{{"dial": {raw}}}', headers={"content-type": "application/json"}
    )
    assert response.status_code == 422


@pytest.mark.parametrize("length", [1, 8])
def test_wiesner_returns_a_full_live_result(make_client: MakeClient, length: int) -> None:
    response = make_client().post("/v1/wiesner", json={"length": length})
    assert response.status_code == 200
    body = response.json()
    assert body["experiment"] == "wiesner"
    assert body["length"] == length
    assert body["shots"] == WIESNER_SHOTS
    assert 0 <= body["passes"] <= body["shots"]
    assert body["passRate"] == body["passes"] / body["shots"]
    assert body["runId"] == f"live-{body['seed']}"
    run = exported_run("wiesner")
    point = next(p for p in run["points"] if p["length"] == length)
    assert body["qubits"] == point["qubits"]
    check_provenance(body["provenance"])
    assert body["provenance"]["qubits"] == point["qubits"]
    assert body["provenance"]["shots"] == WIESNER_SHOTS


@pytest.mark.parametrize(
    "body",
    [
        {"length": 0},
        {"length": 9},
        {"length": 1.5},
        {"length": "3"},
        {"length": True},
        {},
        {"length": 3, "shots": 1},
    ],
)
def test_wiesner_refuses_bad_lengths(make_client: MakeClient, body: dict[str, Any]) -> None:
    assert make_client().post("/v1/wiesner", json=body).status_code == 422


def test_each_run_gets_a_fresh_seed(engine: Engine) -> None:
    assert engine.chsh(0.5)["seed"] != engine.chsh(0.5)["seed"]
    assert engine.wiesner(1)["seed"] != engine.wiesner(1)["seed"]


def test_noise_labels_match_the_table_the_game_previews(engine: Engine) -> None:
    for name, live in (("chsh", engine.chsh(0.5)), ("wiesner", engine.wiesner(8))):
        run = exported_run(name)["provenance"]
        provenance = live["provenance"]
        assert provenance["backend"] == run["backend"]
        assert provenance["qubits"] == run["qubits"]
        for key in ("name", "calibrated", "qubitSelection"):
            assert provenance["noiseModel"][key] == run["noiseModel"][key]


def test_chsh_scope_saves_time_without_changing_the_physics() -> None:
    device = FakeKingston()
    pair = quietest_pair(device)
    full = run_chsh(0.5, 2048, AerSimulator.from_backend(device), seed=7, layout=pair)
    assert run_chsh(0.5, 2048, noise_simulator(device, pair), seed=7, layout=pair) == full


def within_sigmas(value: float, expected: float, shots: int, sigmas: float = 6) -> bool:
    return abs(value - expected) <= sigmas * math.sqrt(expected * (1 - expected) / shots)


def test_live_chsh_keeps_the_character_of_the_export(engine: Engine) -> None:
    points = {p["dial"]: p for p in exported_run("chsh")["points"]}
    for dial in (0.25, 0.5):
        live = engine.chsh(dial)
        assert within_sigmas(live["winRate"], points[dial]["winRate"], CHSH_SHOTS * 4)


def test_live_wiesner_keeps_the_character_of_the_export(engine: Engine) -> None:
    points = {p["length"]: p for p in exported_run("wiesner")["points"]}
    for length in (1, 4):
        live = engine.wiesner(length)
        assert within_sigmas(live["passRate"], points[length]["passRate"], WIESNER_SHOTS)
