import json
import math
from datetime import date
from pathlib import Path

import pytest
import qiskit
import qiskit_aer
import qiskit_ibm_runtime
from qiskit import QuantumCircuit
from qiskit_aer import AerSimulator
from qiskit_ibm_runtime.fake_provider import FakeKingston

import quantum.chsh
from quantum.chsh import QUESTION_PAIRS, chsh_circuits, compile_chsh, pair_win_rate, win_rate
from quantum.export_chsh import (
    DIAL_GRID,
    EXPORT_PATH,
    IDEAL_BASE_SEED,
    NOISY_BASE_SEED,
    OUTCOMES,
    SHOTS,
    build_export,
    dial_seed,
    limits,
    logical_circuits,
    noisy_run,
    quietest_pair,
    sample_point,
)

QUANTUM_LIMIT = math.cos(math.pi / 8) ** 2
CURRENT_VERSIONS = {
    "qiskitVersion": qiskit.__version__,
    "aerVersion": qiskit_aer.__version__,
    "runtimeVersion": qiskit_ibm_runtime.__version__,
}


def counts_by_pair(point):
    return {(p["x"], p["y"]): p["counts"] for p in point["pairs"]}


def point_at(run, dial):
    return next(p for p in run["points"] if p["dial"] == dial)


def run_named(export, run_id):
    return next(r for r in export["runs"] if r["id"] == run_id)


@pytest.fixture(scope="module")
def small_export():
    return build_export(dials=(0.25, 0.5), shots=2048, today=date(2026, 11, 7))


@pytest.fixture(scope="module")
def committed():
    return json.loads(Path(EXPORT_PATH).read_text())


@pytest.fixture(params=["small_export", "committed"])
def export(request):
    return request.getfixturevalue(request.param)


def test_grid_has_33_positions_and_lands_on_the_key_dials():
    assert len(DIAL_GRID) == 33
    assert DIAL_GRID[0] == 0 and DIAL_GRID[-1] == 1
    assert {0.25, 0.5, 0.75} <= set(DIAL_GRID)


def test_quietest_pair_is_a_real_coupler_with_the_lowest_combined_error():
    backend = FakeKingston()
    target = backend.target
    cost = lambda a, b: (
        target["cz"][(a, b)].error
        + target["measure"][(a,)].error
        + target["measure"][(b,)].error
    )
    pair = quietest_pair(backend)
    assert pair in target["cz"]
    assert cost(*pair) == min(cost(a, b) for a, b in target["cz"])


def aer_streams(seed):
    """The per-circuit seeds Aer actually uses for one dial's job."""
    circuits = list(chsh_circuits(0.5).values())
    result = AerSimulator().run(circuits, shots=1, seed_simulator=seed).result()
    return [circuit.seed_simulator for circuit in result.results]


def test_every_dial_keeps_its_seed_streams_in_their_own_band():
    bands = sorted(
        aer_streams(dial_seed(base, index))
        for base in (IDEAL_BASE_SEED, NOISY_BASE_SEED)
        for index in range(len(DIAL_GRID))
    )
    assert all(len(band) == len(QUESTION_PAIRS) for band in bands)
    for lower, upper in zip(bands, bands[1:]):
        assert max(lower) < min(upper)


def test_each_run_labels_its_true_source(export):
    ideal = run_named(export, "ideal")["provenance"]
    noisy = run_named(export, "ibm-noise-model")["provenance"]
    for provenance in (ideal, noisy):
        assert provenance["source"] == "pre-run-simulator"
        assert provenance["jobId"] is None
        assert CURRENT_VERSIONS.items() <= provenance.items()
        assert date.fromisoformat(provenance["date"])
    assert ideal["backend"] == "aer_simulator"
    assert ideal["noiseModel"] is None
    assert ideal["qubits"] is None
    assert noisy["backend"] == AerSimulator.from_backend(FakeKingston()).name
    assert noisy["noiseModel"]["name"] == "fake_kingston"
    assert noisy["noiseModel"]["calibrated"].startswith("2026-04-15")
    assert "lowest" in noisy["noiseModel"]["qubitSelection"]


def test_noisy_run_names_the_qubits_it_was_pinned_to(export):
    qubits = run_named(export, "ibm-noise-model")["provenance"]["qubits"]
    assert qubits == list(quietest_pair(FakeKingston()))


def test_noisy_run_really_compiles_onto_the_qubits_it_names(monkeypatch):
    layouts = []

    def spy(dial, backend, layout=None, seed=None):
        layouts.append(layout)
        return compile_chsh(dial, backend, layout=layout, seed=seed)

    monkeypatch.setattr(quantum.chsh, "compile_chsh", spy)
    run = noisy_run((0.0, 0.5), shots=8, today=date(2026, 11, 7))
    assert [list(layout) for layout in layouts] == [run["provenance"]["qubits"]] * 2


def test_pin_holds_at_every_dial_on_the_noisy_backend():
    device = FakeKingston()
    backend = AerSimulator.from_backend(device)
    player, partner = quietest_pair(device)
    for dial in DIAL_GRID:
        for circuit in compile_chsh(dial, backend, layout=(player, partner), seed=1):
            measured = {
                circuit.find_bit(i.clbits[0]).index: circuit.find_bit(i.qubits[0]).index
                for i in circuit.data
                if i.operation.name == "measure"
            }
            assert measured == {0: player, 1: partner}
            assert circuit.count_ops()["cz"] == 1


def test_provenance_records_the_requested_shots_and_date(small_export):
    for run in small_export["runs"]:
        assert run["provenance"]["shots"] == 2048
        assert run["provenance"]["date"] == "2026-11-07"


def test_export_is_reproducible(small_export):
    again = build_export(dials=(0.25, 0.5), shots=2048, today=date(2026, 11, 7))
    assert again == small_export


def test_limits_come_from_brute_force_and_the_statevector(export):
    assert export["limits"]["classical"]["value"] == 0.75
    assert export["limits"]["quantum"]["value"] == pytest.approx(QUANTUM_LIMIT, abs=1e-12)
    assert "brute force" in export["limits"]["classical"]["method"]
    assert "statevector" in export["limits"]["quantum"]["method"]


def test_circuits_are_exported_per_dial_and_pair_as_loadable_qasm(small_export):
    assert [entry["dial"] for entry in small_export["logicalCircuits"]] == [0.25, 0.5]
    for entry in small_export["logicalCircuits"]:
        assert [(p["x"], p["y"]) for p in entry["pairs"]] == list(QUESTION_PAIRS)
        for pair in entry["pairs"]:
            circuit = QuantumCircuit.from_qasm_str(pair["qasm"])
            assert circuit.num_qubits == 2
            assert circuit.count_ops()["measure"] == 2


def test_every_counts_table_has_all_four_outcomes(export):
    for run in export["runs"]:
        for point in run["points"]:
            for pair in point["pairs"]:
                assert tuple(pair["counts"]) == OUTCOMES


def test_committed_export_covers_the_whole_grid_for_both_runs(committed):
    assert committed["schemaVersion"] == 1
    assert committed["experiment"] == "chsh"
    assert committed["outcomeOrder"] == "ba"
    assert {r["id"] for r in committed["runs"]} == {"ideal", "ibm-noise-model"}
    for run in committed["runs"]:
        assert [p["dial"] for p in run["points"]] == list(DIAL_GRID)
        assert run["provenance"]["shots"] == SHOTS


def test_committed_shared_blocks_match_the_current_code(committed):
    assert committed["logicalCircuits"] == logical_circuits(DIAL_GRID)
    assert committed["limits"] == limits()


def test_committed_rates_are_exactly_what_the_counts_say(committed):
    for run in committed["runs"]:
        for point in run["points"]:
            pairs = counts_by_pair(point)
            assert list(pairs) == list(QUESTION_PAIRS)
            assert point["winRate"] == win_rate(pairs)
            for pair in point["pairs"]:
                assert pair["shots"] == run["provenance"]["shots"]
                assert sum(pair["counts"].values()) == pair["shots"]
                assert pair["winRate"] == pair_win_rate(pair["counts"], pair["x"], pair["y"])


def test_committed_seeds_follow_the_spaced_scheme(committed):
    for run_id, base in (("ideal", IDEAL_BASE_SEED), ("ibm-noise-model", NOISY_BASE_SEED)):
        points = run_named(committed, run_id)["points"]
        assert [p["seed"] for p in points] == [dial_seed(base, i) for i in range(len(points))]


@pytest.mark.parametrize("dial", [0.0, 0.5, 0.875])
def test_committed_points_replay_exactly_from_their_stored_seeds(committed, dial):
    ideal = run_named(committed, "ideal")
    noisy = run_named(committed, "ibm-noise-model")
    shots = ideal["provenance"]["shots"]
    stored = point_at(ideal, dial)
    assert sample_point(dial, shots, stored["seed"], AerSimulator()) == stored
    stored = point_at(noisy, dial)
    backend = AerSimulator.from_backend(FakeKingston())
    layout = noisy["provenance"]["qubits"]
    assert sample_point(dial, shots, stored["seed"], backend, layout) == stored


def test_committed_ideal_curve_matches_the_game_within_shot_noise(committed):
    run = run_named(committed, "ideal")
    shots = run["provenance"]["shots"] * len(QUESTION_PAIRS)
    margin = 4 * 0.5 / math.sqrt(shots)
    for point in run["points"]:
        expected = (1 + math.sin(point["dial"] * math.pi) / math.sqrt(2)) / 2
        assert point["winRate"] == pytest.approx(expected, abs=margin)


def test_committed_noise_lowers_the_curve_across_the_grid(committed):
    ideal = run_named(committed, "ideal")
    noisy = run_named(committed, "ibm-noise-model")
    gaps = [
        a["winRate"] - b["winRate"] for a, b in zip(ideal["points"], noisy["points"])
    ]
    shots = ideal["provenance"]["shots"] * len(QUESTION_PAIRS) * len(gaps)
    assert sum(gaps) / len(gaps) > 4 * math.sqrt(2) * 0.5 / math.sqrt(shots)


def test_committed_noisy_peak_still_beats_the_classical_limit(committed):
    noisy = point_at(run_named(committed, "ibm-noise-model"), 0.5)["winRate"]
    assert noisy > committed["limits"]["classical"]["value"]
