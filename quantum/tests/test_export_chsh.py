import json
import math
import subprocess
import sys
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
import quantum.export
import quantum.export_chsh
from quantum.chip_chsh import run_from_counts
from quantum.chsh import QUESTION_PAIRS, chsh_circuits, compile_chsh, pair_win_rate, win_rate
from quantum.export import write_record
from quantum.export_chsh import (
    CHIP_JOBS,
    DIAL_GRID,
    EXPORT_PATH,
    IDEAL_BASE_SEED,
    NOISY_BASE_SEED,
    OUTCOMES,
    SHOTS,
    build_export,
    chip_runs,
    dial_seed,
    limits,
    logical_circuits,
    main,
    noisy_run,
    quietest_pair,
    refresh_chip_runs,
    sample_point,
)

QUANTUM_LIMIT = math.cos(math.pi / 8) ** 2
PILOT_JOB = "dbnna5gqtr0c73adbo90"
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


def simulator_runs(export):
    return [r for r in export["runs"] if r["provenance"]["source"] != "ibm-chip"]


def committed_chip_runs(export):
    return [r for r in export["runs"] if r["provenance"]["source"] == "ibm-chip"]


def small_build():
    """Only the simulators: a chip run's dials are not this export's."""
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(quantum.export_chsh, "CHIP_JOBS", ())
        return build_export(dials=(0.25, 0.5), shots=2048, today=date(2026, 11, 7))


def assert_honest_chip_run(run):
    provenance = run["provenance"]
    assert provenance["source"] == "ibm-chip"
    assert provenance["backend"].startswith("ibm_")
    assert provenance["jobId"].strip()
    assert provenance["noiseModel"] is None
    assert "best-case" in provenance["qubitSelection"]
    assert {p["dial"] for p in run["points"]} <= set(DIAL_GRID)
    for point in run["points"]:
        pairs = counts_by_pair(point)
        assert list(pairs) == list(QUESTION_PAIRS)
        assert point["winRate"] == win_rate(pairs)
        for pair in point["pairs"]:
            assert pair["shots"] == provenance["shots"]
            assert sum(pair["counts"].values()) == pair["shots"]
            assert pair["winRate"] == pair_win_rate(pair["counts"], pair["x"], pair["y"])


def chip_run_from(export, job_id="job123", dials=(0.25, 0.5)):
    """Built from an exported simulator's counts, purely to exercise the file handling."""
    source = run_named(export, "ideal")
    counts = {dial: counts_by_pair(point_at(source, dial)) for dial in dials}
    shots = source["provenance"]["shots"]
    return run_from_counts(
        "ibm-chip", "ibm_kingston", [61, 62], shots, date(2026, 11, 7), job_id, counts
    )


@pytest.fixture
def records(monkeypatch, tmp_path):
    """Chip records in a temp folder, listed in CHIP_JOBS as they are written."""
    monkeypatch.setattr(quantum.export, "RUNS_DIR", tmp_path)
    monkeypatch.setattr(quantum.export_chsh, "CHIP_JOBS", ())

    def add(job_id, **fields):
        write_record({"experiment": "chsh", "jobId": job_id, **fields})
        jobs = (*quantum.export_chsh.CHIP_JOBS, job_id)
        monkeypatch.setattr(quantum.export_chsh, "CHIP_JOBS", jobs)

    return add


@pytest.fixture
def export_copy(tmp_path, committed):
    """A copy of the committed file holding its simulators and no chip run."""
    path = tmp_path / "chsh.json"
    bare = {**committed, "runs": simulator_runs(committed)}
    quantum.export.write_export(path, bare)
    return path


@pytest.fixture(scope="module")
def small_export():
    return small_build()


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
    assert small_build() == small_export


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


def test_committed_export_covers_the_whole_grid_for_both_simulators(committed):
    assert committed["schemaVersion"] == 1
    assert committed["experiment"] == "chsh"
    assert committed["outcomeOrder"] == "ba"
    simulators = simulator_runs(committed)
    assert {r["id"] for r in simulators} == {"ideal", "ibm-noise-model"}
    for run in simulators:
        assert [p["dial"] for p in run["points"]] == list(DIAL_GRID)
        assert run["provenance"]["shots"] == SHOTS


def test_committed_chip_runs_are_labelled_and_match_their_counts(committed):
    for run in committed_chip_runs(committed):
        assert_honest_chip_run(run)


def test_the_chip_run_check_passes_a_run_collect_would_write(committed):
    assert_honest_chip_run(chip_run_from(committed))


def test_the_pilot_is_never_listed_for_export():
    assert PILOT_JOB not in CHIP_JOBS


def test_chip_runs_skips_a_job_with_no_run_yet(records, committed):
    run = chip_run_from(committed)
    records("collected", run=run)
    records("queued")
    assert chip_runs() == [run]


def test_build_export_appends_chip_runs_after_the_simulators(records, small_export):
    run = chip_run_from(small_export)
    records("collected", run=run)
    built = build_export(dials=(0.25, 0.5), shots=2048, today=date(2026, 11, 7))
    assert [r["id"] for r in built["runs"]] == ["ideal", "ibm-noise-model", "ibm-chip"]
    assert built["runs"][:2] == small_export["runs"]
    assert built["runs"][2] == run


def test_chip_only_leaves_the_file_alone_with_nothing_collected(records, export_copy):
    records("queued")
    before = export_copy.read_bytes()
    refresh_chip_runs(export_copy)
    assert export_copy.read_bytes() == before


def test_chip_only_adds_the_chip_run_and_keeps_the_simulators(records, export_copy, committed):
    run = chip_run_from(committed)
    records("collected", run=run)
    refresh_chip_runs(export_copy)
    written = json.loads(export_copy.read_text())
    assert written["runs"] == [*simulator_runs(committed), run]
    assert {k: v for k, v in written.items() if k != "runs"} == {
        k: v for k, v in committed.items() if k != "runs"
    }


def test_chip_only_replaces_chip_runs_rather_than_stacking_them(records, export_copy, committed):
    records("first", run=chip_run_from(committed, "first"))
    refresh_chip_runs(export_copy)
    newer = chip_run_from(committed, "second")
    write_record({"experiment": "chsh", "jobId": "first", "run": newer})
    refresh_chip_runs(export_copy)
    assert committed_chip_runs(json.loads(export_copy.read_text())) == [newer]


def test_chip_only_flag_never_regenerates_the_simulators(
    records, export_copy, committed, monkeypatch
):
    def no_regeneration(*_args, **_kwargs):
        raise AssertionError("the simulators were rebuilt")

    monkeypatch.setattr(quantum.export_chsh, "build_export", no_regeneration)
    monkeypatch.setattr(quantum.export_chsh, "EXPORT_PATH", export_copy)
    run = chip_run_from(committed)
    records("collected", run=run)
    main(["--chip-only"])
    assert committed_chip_runs(json.loads(export_copy.read_text())) == [run]


def test_the_exporter_does_not_load_the_chip_module():
    """The live service imports this file, and must stay clear of chip submission."""
    code = "import sys, quantum.export_chsh; sys.exit('quantum.chip' in sys.modules)"
    root = Path(__file__).resolve().parents[2]
    assert subprocess.run([sys.executable, "-c", code], cwd=root, check=False).returncode == 0


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
