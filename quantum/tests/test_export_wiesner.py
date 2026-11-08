import json
import math
import random
import statistics
import subprocess
import sys
from datetime import date
from pathlib import Path

import pytest
import qiskit
import qiskit_aer
import qiskit_ibm_runtime
from numpy.testing import assert_equal
from qiskit import QuantumCircuit, qasm2
from qiskit_aer import AerSimulator
from qiskit_aer.noise import NoiseModel
from qiskit_ibm_runtime.fake_provider import FakeKingston

import quantum.export
import quantum.export_wiesner
import quantum.wiesner
from quantum.chip_wiesner import run_from_passes, ticket_seed
from quantum.export import read_record, simulator_provenance, write_export, write_record
from quantum.export_wiesner import (
    ATTACK,
    CHIP_JOBS,
    EXPORT_PATH,
    IDEAL_BASE_SEED,
    LOGICAL_CIRCUITS_NOTE,
    MEASURES_PER_QUBIT,
    NOISY_BASE_SEED,
    PASS_RULE,
    SHOTS,
    SX_PER_QUBIT,
    SIMULATOR_TICKETS_PER_SHOT,
    binomial_std_err,
    build_export,
    chip_run_with_std_err,
    chip_runs,
    clustered_std_err,
    length_seed,
    limits,
    logical_circuits,
    main,
    noise_model_label,
    noise_simulator,
    noisy_run,
    payouts,
    quietest_qubits,
    refresh_chip_runs,
    sample_point,
    with_std_err,
)
from quantum.wiesner import (
    LENGTHS,
    MAX_LENGTH,
    Ticket,
    compile_forgery,
    exact_pass_per_qubit,
    forgery_binds,
    forgery_circuit,
    random_tickets,
)

PILOT_JOB = "dbnoi58ou4as73b4tcr0"
CHIP_QUBITS = [61, 42, 5, 48, 15, 21, 93, 62]
CHIP_SELECTION = "best-case pick: the qubits with the lowest error in the day's calibration"
EXPECTED_PAYS = {1: 25, 2: 65, 3: 125, 4: 200, 5: 300, 6: 430, 7: 610, 8: 845}
SMALL_LENGTHS = (1, 2, 8)
SMALL_SHOTS = 512
CURRENT_VERSIONS = {
    "qiskitVersion": qiskit.__version__,
    "aerVersion": qiskit_aer.__version__,
    "runtimeVersion": qiskit_ibm_runtime.__version__,
}


def run_named(export, run_id):
    return next(r for r in export["runs"] if r["id"] == run_id)


def point_at(run, length):
    return next(p for p in run["points"] if p["length"] == length)


def limit_at(export, length):
    return next(e["value"] for e in export["limits"]["byLength"] if e["length"] == length)


def simulator_runs(export):
    return [r for r in export["runs"] if r["provenance"]["source"] != "ibm-chip"]


def committed_chip_runs(export):
    return [r for r in export["runs"] if r["provenance"]["source"] == "ibm-chip"]


def small_build():
    """Only the simulators: a chip run's lengths are not this export's."""
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(quantum.export_wiesner, "CHIP_JOBS", ())
        return build_export(lengths=SMALL_LENGTHS, shots=SMALL_SHOTS, today=date(2026, 11, 7))


def assert_honest_chip_run(run):
    provenance = run["provenance"]
    tickets = run["ticketsPerPoint"]
    per_ticket = run["shotsPerTicket"]
    assert run["id"] == "ibm-chip", "the game reads a chip run only under this id"
    assert set(run) == {
        "id",
        "provenance",
        "ticketsPerPoint",
        "shotsPerTicket",
        "points",
        "stdErrMethod",
    }
    assert run["stdErrMethod"].strip()
    assert provenance["source"] == "ibm-chip"
    assert provenance["backend"].startswith("ibm_")
    assert provenance["jobId"].strip()
    assert provenance["noiseModel"] is None
    assert "best-case" in provenance["qubitSelection"]
    assert provenance["shots"] == tickets * per_ticket
    assert run["points"]
    for point in run["points"]:
        assert set(point) == {
            "length",
            "seed",
            "shots",
            "qubits",
            "passes",
            "passRate",
            "ticketPasses",
            "stdErr",
        }
        assert point["length"] in LENGTHS
        assert point["seed"] == ticket_seed(point["length"])
        assert point["shots"] == tickets * per_ticket
        assert point["qubits"] == provenance["qubits"][: point["length"]]
        assert isinstance(point["passes"], int)
        assert 0 <= point["passes"] <= point["shots"]
        assert point["passRate"] == point["passes"] / point["shots"]
        assert len(point["ticketPasses"]) == tickets
        assert sum(point["ticketPasses"]) == point["passes"]
        assert all(0 <= n <= per_ticket for n in point["ticketPasses"])
        assert point["stdErr"] == clustered_std_err(point["ticketPasses"], per_ticket)


def spread(total, tickets=32):
    """Made-up per-ticket passes that add up to total."""
    return [total // tickets + (i < total % tickets) for i in range(tickets)]


def chip_run(job_id="job123", passes=None):
    """Counts made up for this file, purely to exercise the file handling."""
    passes = passes or {4: 300}
    return run_from_passes(
        "ibm-chip",
        "ibm_kingston",
        CHIP_QUBITS,
        CHIP_SELECTION,
        32,
        32,
        date(2026, 11, 7),
        job_id,
        passes,
        {length: spread(count) for length, count in passes.items()},
    )


def exported(run):
    return chip_run_with_std_err(run)


def expected_provenance(run_id, shots, today, device):
    if run_id == "ideal":
        return simulator_provenance("aer_simulator", shots, today)
    return simulator_provenance(
        "aer_simulator_from(fake_kingston)",
        shots,
        today,
        noise_model=noise_model_label(device),
        qubits=quietest_qubits(device, MAX_LENGTH),
    )


def shot_noise_tolerance(rate, shots, sigmas=4):
    return sigmas * math.sqrt(rate * (1 - rate) / shots)


@pytest.fixture
def records(monkeypatch, tmp_path):
    """Chip records in a temp folder, listed in CHIP_JOBS as they are written."""
    monkeypatch.setattr(quantum.export, "RUNS_DIR", tmp_path)
    monkeypatch.setattr(quantum.export_wiesner, "CHIP_JOBS", ())

    def add(job_id, **fields):
        write_record({"experiment": "wiesner", "jobId": job_id, **fields})
        jobs = (*quantum.export_wiesner.CHIP_JOBS, job_id)
        monkeypatch.setattr(quantum.export_wiesner, "CHIP_JOBS", jobs)

    return add


@pytest.fixture
def export_copy(tmp_path, committed):
    """A copy of the committed file holding its simulators and no chip run."""
    path = tmp_path / "wiesner.json"
    write_export(path, {**committed, "runs": simulator_runs(committed)})
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


@pytest.fixture(scope="module")
def device():
    return FakeKingston()


# Shape and labels


def test_export_has_every_top_level_block(export):
    assert set(export) == {
        "schemaVersion",
        "experiment",
        "attack",
        "passRule",
        "simulatorTicketsPerShot",
        "limits",
        "payouts",
        "logicalCircuits",
        "logicalCircuitsNote",
        "runs",
    }
    assert export["schemaVersion"] == 1
    assert export["experiment"] == "wiesner"
    assert export["simulatorTicketsPerShot"] == 1


def test_labels_say_this_is_one_remade_chip_and_not_two_copies(export):
    assert "re-made" in export["attack"]
    assert "one re-made chip" in export["passRule"]
    assert "every qubit" in export["passRule"]
    assert "not" in export["passRule"] and "two copies" in export["passRule"]


def test_each_run_labels_its_true_source(export):
    assert [r["id"] for r in simulator_runs(export)] == ["ideal", "ibm-noise-model"]
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
    assert noisy["backend"] == "aer_simulator_from(fake_kingston)"
    assert noisy["noiseModel"]["name"] == "fake_kingston"
    assert noisy["noiseModel"]["calibrated"].startswith("2026-04-15")
    assert "best-case" in noisy["noiseModel"]["qubitSelection"]
    assert "lowest" in noisy["noiseModel"]["qubitSelection"]
    assert "no decay" in noisy["noiseModel"]["scope"]


def test_points_are_consistent_in_both_exports(export):
    for run in simulator_runs(export):
        assert set(run) == {"id", "provenance", "points", "stdErrMethod"}
        assert run["stdErrMethod"].strip()
        shots = run["provenance"]["shots"]
        for point in run["points"]:
            assert set(point) == {
                "length",
                "seed",
                "shots",
                "qubits",
                "passes",
                "passRate",
                "stdErr",
            }
            assert point["stdErr"] == binomial_std_err(point["passes"], shots)
            assert point["shots"] == shots
            assert isinstance(point["passes"], int)
            assert 0 <= point["passes"] <= shots
            assert point["passRate"] == point["passes"] / shots


def test_each_point_names_exactly_the_qubits_it_used(export):
    for point in run_named(export, "ideal")["points"]:
        assert point["qubits"] is None
    noisy = run_named(export, "ibm-noise-model")
    for point in noisy["points"]:
        assert point["qubits"] == noisy["provenance"]["qubits"][: point["length"]]


def test_seeds_follow_the_spaced_scheme(export):
    for run_id, base in (("ideal", IDEAL_BASE_SEED), ("ibm-noise-model", NOISY_BASE_SEED)):
        for point in run_named(export, run_id)["points"]:
            assert point["seed"] == length_seed(base, point["length"])


def test_provenance_records_the_requested_shots_and_date(small_export, device):
    today = date(2026, 11, 7)
    for run in small_export["runs"]:
        assert run["provenance"] == expected_provenance(run["id"], SMALL_SHOTS, today, device)
        assert [p["length"] for p in run["points"]] == list(SMALL_LENGTHS)


def test_export_is_reproducible(small_export):
    assert small_build() == small_export


def test_committed_export_covers_every_length_for_both_simulators(committed):
    simulators = simulator_runs(committed)
    assert {r["id"] for r in simulators} == {"ideal", "ibm-noise-model"}
    assert [e["length"] for e in committed["limits"]["byLength"]] == list(LENGTHS)
    assert [e["length"] for e in committed["logicalCircuits"]] == list(LENGTHS)
    assert [e["length"] for e in committed["payouts"]["table"]] == list(LENGTHS)
    for run in simulators:
        assert [p["length"] for p in run["points"]] == list(LENGTHS)
        assert run["provenance"]["shots"] == SHOTS


def test_ticket_count_is_labelled_per_shot(export):
    assert export["simulatorTicketsPerShot"] == SIMULATOR_TICKETS_PER_SHOT == 1


def test_committed_shared_blocks_match_the_current_code(committed, device):
    assert committed["limits"] == limits(LENGTHS)
    assert committed["logicalCircuits"] == logical_circuits(LENGTHS)
    assert committed["payouts"] == payouts(limits(LENGTHS)["byLength"])
    assert committed["attack"] == ATTACK
    assert committed["passRule"] == PASS_RULE
    assert committed["logicalCircuitsNote"] == LOGICAL_CIRCUITS_NOTE
    for run in simulator_runs(committed):
        provenance = run["provenance"]
        today = date.fromisoformat(provenance["date"])
        assert provenance == expected_provenance(run["id"], SHOTS, today, device)


# Chip runs


def test_committed_chip_runs_are_labelled_and_consistent(committed):
    for run in committed_chip_runs(committed):
        assert_honest_chip_run(run)


def test_the_chip_run_check_passes_a_run_collect_would_write():
    assert_honest_chip_run(exported(chip_run(passes={2: 500, 4: 300})))


def test_the_chip_run_keeps_its_ticket_split_and_only_its_own_lengths():
    run = chip_run(passes={2: 500, 4: 300})
    assert (run["ticketsPerPoint"], run["shotsPerTicket"]) == (32, 32)
    assert [p["length"] for p in run["points"]] == [2, 4]


def test_the_pilot_is_never_listed_for_export():
    assert PILOT_JOB not in CHIP_JOBS


def test_chip_runs_skips_a_job_with_no_run_yet(records):
    run = chip_run()
    records("collected", run=run)
    records("queued", maxSeconds=20)
    assert chip_runs() == [exported(run)]


def test_chip_runs_refuses_repeated_run_ids(records):
    records("first", run=chip_run("first"))
    records("second", run=chip_run("second"))
    with pytest.raises(ValueError, match="repeat"):
        chip_runs()


def test_build_export_appends_chip_runs_after_the_simulators(records, small_export):
    run = chip_run(passes={2: 500})
    records("collected", run=run)
    built = build_export(lengths=SMALL_LENGTHS, shots=SMALL_SHOTS, today=date(2026, 11, 7))
    assert [r["id"] for r in built["runs"]] == ["ideal", "ibm-noise-model", "ibm-chip"]
    assert built["runs"][:2] == small_export["runs"]
    assert built["runs"][2] == exported(run)


def test_chip_only_leaves_the_file_alone_with_nothing_collected(records, export_copy):
    records("queued", maxSeconds=20)
    before = export_copy.read_bytes()
    refresh_chip_runs(export_copy)
    assert export_copy.read_bytes() == before


def test_chip_only_keeps_every_simulator_byte_and_everything_else(
    records, export_copy, committed
):
    run = chip_run()
    records("collected", run=run)
    before = export_copy.read_bytes()
    simulators = before[: before.rindex(b"\n ]")]
    refresh_chip_runs(export_copy)
    assert export_copy.read_bytes().startswith(simulators + b",\n")
    written = json.loads(export_copy.read_text())
    assert written["runs"] == [*simulator_runs(committed), exported(run)]
    assert {k: v for k, v in written.items() if k != "runs"} == {
        k: v for k, v in committed.items() if k != "runs"
    }


def test_chip_only_replaces_chip_runs_rather_than_stacking_them(records, export_copy):
    records("first", run=chip_run("first"))
    refresh_chip_runs(export_copy)
    newer = chip_run("second")
    write_record({"experiment": "wiesner", "jobId": "first", "run": newer})
    refresh_chip_runs(export_copy)
    assert committed_chip_runs(json.loads(export_copy.read_text())) == [exported(newer)]


def test_chip_only_flag_never_regenerates_the_simulators(records, export_copy, monkeypatch):
    def no_regeneration(*_args, **_kwargs):
        raise AssertionError("the simulators were rebuilt")

    monkeypatch.setattr(quantum.export_wiesner, "build_export", no_regeneration)
    monkeypatch.setattr(quantum.export_wiesner, "EXPORT_PATH", export_copy)
    run = chip_run()
    records("collected", run=run)
    main(["--chip-only"])
    assert committed_chip_runs(json.loads(export_copy.read_text())) == [exported(run)]


def test_the_exporter_does_not_load_the_chip_module():
    """The live service imports this file, and must stay clear of chip submission."""
    code = "import sys, quantum.export_wiesner; sys.exit('quantum.chip' in sys.modules)"
    root = Path(__file__).resolve().parents[2]
    assert subprocess.run([sys.executable, "-c", code], cwd=root, check=False).returncode == 0


# Standard errors


def test_clustered_std_err_matches_a_hand_calculation():
    # fractions 1, 1/2, 1, 1/2: mean 3/4, sample variance (4 * 1/16) / 3, sd sqrt(1/12)
    assert clustered_std_err([4, 2, 4, 2], 4) == pytest.approx(math.sqrt(1 / 48))


def test_clustered_std_err_is_zero_when_every_ticket_passes_alike():
    assert clustered_std_err([3, 3, 3], 4) == 0


def test_clustered_std_err_refuses_what_it_cannot_estimate():
    with pytest.raises(ValueError, match="two tickets"):
        clustered_std_err([2], 4)
    with pytest.raises(ValueError, match="shots"):
        clustered_std_err([2, 5], 4)


def test_binomial_std_err_is_the_textbook_formula():
    assert binomial_std_err(50, 100) == pytest.approx(0.05)
    assert binomial_std_err(0, 100) == 0
    assert binomial_std_err(100, 100) == 0
    assert binomial_std_err(8192 * 3 // 4, 8192) == pytest.approx(math.sqrt(0.75 * 0.25 / 8192))


def test_binomial_std_err_refuses_impossible_counts():
    with pytest.raises(ValueError, match="passes"):
        binomial_std_err(101, 100)


def test_with_std_err_adds_only_the_error():
    point = {"length": 1, "shots": 100, "passes": 50, "passRate": 0.5}
    assert with_std_err(point) == {**point, "stdErr": 0.05}


@pytest.mark.parametrize("name", ["ideal", "ibm-noise-model"])
def test_simulator_runs_say_their_error_is_binomial(small_export, name):
    assert "binomial" in run_named(small_export, name)["stdErrMethod"]


def committed_chip_records():
    return [read_record("wiesner", job_id) for job_id in CHIP_JOBS]


def test_committed_chip_error_follows_the_records_per_ticket_passes(committed):
    records = committed_chip_records()
    assert records
    for record in records:
        run = record["run"]
        exported_run = next(r for r in committed_chip_runs(committed) if r["id"] == run["id"])
        assert "clustered" in exported_run["stdErrMethod"]
        for stored, point in zip(run["points"], exported_run["points"], strict=True):
            assert sum(stored["ticketPasses"]) == stored["passes"]
            assert len(stored["ticketPasses"]) == record["tickets"]
            fractions = [n / record["shotsPerTicket"] for n in stored["ticketPasses"]]
            expected = statistics.stdev(fractions) / math.sqrt(len(fractions))
            assert point["stdErr"] == pytest.approx(expected, rel=1e-12)


def test_the_committed_chip_error_is_wider_than_independent_shots_would_give(committed):
    """Replayed tickets make shots dependent, so the honest error is not the binomial one."""
    for run in committed_chip_runs(committed):
        for point in run["points"]:
            assert point["stdErr"] > 0
            assert point["stdErr"] > binomial_std_err(point["passes"], point["shots"])


def test_committed_chip_error_is_near_the_hand_calculation(committed):
    run = committed_chip_runs(committed)[0]
    expected = {1: 0.024, 2: 0.029, 4: 0.020}
    for length, value in expected.items():
        assert point_at(run, length)["stdErr"] == pytest.approx(value, abs=0.002)


def test_chip_run_with_std_err_refuses_per_ticket_passes_that_do_not_add_up():
    run = chip_run(passes={4: 300})
    run["points"][0]["ticketPasses"][0] += 1
    with pytest.raises(ValueError, match="passes"):
        chip_run_with_std_err(run)


def test_chip_run_with_std_err_refuses_a_point_with_no_per_ticket_passes():
    run = run_from_passes(
        "ibm-chip", "ibm_kingston", CHIP_QUBITS, CHIP_SELECTION, 32, 32,
        date(2026, 11, 7), "job123", {4: 300},
    )
    with pytest.raises(ValueError, match="ticketPasses"):
        chip_run_with_std_err(run)


def test_chip_run_with_std_err_leaves_its_input_alone():
    run = chip_run()
    before = json.dumps(run)
    chip_run_with_std_err(run)
    assert json.dumps(run) == before


# Seeds


def full_job_band(seed):
    """The first and last per-binding seeds Aer really uses for a job of full size."""
    backend = AerSimulator()
    binds = forgery_binds(random_tickets(1, SHOTS, random.Random(1)))
    result = backend.run(
        compile_forgery(1, backend, seed=1),
        parameter_binds=[binds],
        shots=1,
        seed_simulator=seed,
    ).result()
    assert len(result.results) == SHOTS
    return result.results[0].seed_simulator, result.results[-1].seed_simulator


def test_every_length_keeps_its_seed_stream_in_its_own_band():
    first, last = full_job_band(length_seed(IDEAL_BASE_SEED, 1))
    assert first == length_seed(IDEAL_BASE_SEED, 1)
    span = last - first
    assert full_job_band(length_seed(NOISY_BASE_SEED, 8)) == (
        length_seed(NOISY_BASE_SEED, 8),
        length_seed(NOISY_BASE_SEED, 8) + span,
    )
    starts = sorted(
        length_seed(base, length)
        for base in (IDEAL_BASE_SEED, NOISY_BASE_SEED)
        for length in LENGTHS
    )
    assert span > 0
    for lower, upper in zip(starts, starts[1:]):
        assert lower + span < upper
    assert starts[-1] + span < 2**31


# Limits


def test_limits_come_from_the_statevector(export):
    per_qubit = export["limits"]["perQubit"]
    assert per_qubit["value"] == exact_pass_per_qubit()
    assert per_qubit["value"] == pytest.approx(0.75, abs=1e-12)
    assert "statevector" in per_qubit["method"].lower()


def test_limit_by_length_is_the_per_qubit_power(export):
    per_qubit = export["limits"]["perQubit"]["value"]
    for entry in export["limits"]["byLength"]:
        assert entry["value"] == per_qubit ** entry["length"]


# Circuits


def test_shipped_circuits_are_rebuilt_exactly_from_their_tickets(export):
    for entry in export["logicalCircuits"]:
        ticket = entry["ticket"]
        rebuilt = Ticket(
            tuple(ticket["bits"]), tuple(ticket["bases"]), tuple(ticket["attackerBases"])
        )
        assert rebuilt.length == entry["length"]
        assert entry["qasm"] == qasm2.dumps(forgery_circuit(rebuilt))


def test_shipped_tickets_open_the_ideal_runs_stream(export):
    for entry in export["logicalCircuits"]:
        length = entry["length"]
        seed = point_at(run_named(export, "ideal"), length)["seed"]
        first = random_tickets(length, 1, random.Random(seed))[0]
        assert tuple(entry["ticket"]["bits"]) == first.bits
        assert tuple(entry["ticket"]["bases"]) == first.bases
        assert tuple(entry["ticket"]["attackerBases"]) == first.attacker_bases


def test_shipped_qasm_loads_with_both_registers(export):
    for entry in export["logicalCircuits"]:
        circuit = QuantumCircuit.from_qasm_str(entry["qasm"])
        assert circuit.num_qubits == entry["length"]
        assert [r.name for r in circuit.cregs] == ["attacker", "cashier"]
        assert circuit.count_ops()["measure"] == 2 * entry["length"]


# Qubit choice and noise


def qubit_cost(device, qubit):
    target = device.target
    return (
        MEASURES_PER_QUBIT * target["measure"][(qubit,)].error
        + SX_PER_QUBIT * target["sx"][(qubit,)].error
    )


def test_quietest_qubits_really_are_the_lowest_cost(device):
    chosen = quietest_qubits(device, 8)
    costs = [qubit_cost(device, q) for q in chosen]
    others = [qubit_cost(device, q) for q in range(device.num_qubits) if q not in chosen]
    assert len(set(chosen)) == 8
    assert costs == sorted(costs)
    assert costs[-1] <= min(others)


@pytest.mark.parametrize("length", [1, 8])
def test_cost_weights_match_what_each_qubit_really_goes_through(device, length):
    compiled = compile_forgery(length, device, layout=quietest_qubits(device, 8), seed=1)
    assert compiled.count_ops()["sx"] == SX_PER_QUBIT * length
    assert compiled.count_ops()["measure"] == MEASURES_PER_QUBIT * length


def test_recorded_qubits_are_the_quietest(export, device):
    qubits = run_named(export, "ibm-noise-model")["provenance"]["qubits"]
    assert qubits == quietest_qubits(device, 8)


def test_noisy_run_really_compiles_onto_the_qubits_it_names(monkeypatch):
    layouts = []
    real = quantum.wiesner.compile_forgery

    def spy(length, backend, layout=None, seed=None):
        layouts.append(layout)
        return real(length, backend, layout=layout, seed=seed)

    monkeypatch.setattr(quantum.wiesner, "compile_forgery", spy)
    run = noisy_run((1, 8), shots=8, today=date(2026, 11, 7))
    assert [list(layout) for layout in layouts] == [run["provenance"]["qubits"]] * 2


def test_restricted_noise_gives_the_same_counts_as_the_full_model(device):
    qubits = quietest_qubits(device, 8)
    bindings = 64
    compiled = compile_forgery(8, device, layout=qubits, seed=4)
    binds = forgery_binds(random_tickets(8, bindings, random.Random(4)))

    def counts(backend):
        result = backend.run(
            compiled, parameter_binds=[binds], shots=1, seed_simulator=4
        ).result()
        return [result.get_counts(i) for i in range(bindings)]

    assert counts(noise_simulator(device, qubits)) == counts(AerSimulator.from_backend(device))


def noise_entries(noise_model, qubits):
    """A model's entries on the given qubits, without the random id of each."""
    chosen = set(qubits)
    entries = [
        {key: value for key, value in entry.items() if key != "id"}
        for entry in noise_model.to_dict()["errors"]
        if all(chosen.issuperset(gate) for gate in entry["gate_qubits"])
    ]
    return sorted(entries, key=lambda e: (e["type"], e["operations"], e["gate_qubits"]))


def test_restricted_noise_has_the_full_models_entries_on_the_chosen_qubits(device):
    qubits = quietest_qubits(device, 8)
    restricted = noise_entries(noise_simulator(device, qubits).options.noise_model, qubits)
    full = noise_entries(NoiseModel.from_backend(device), qubits)
    assert restricted
    assert_equal(restricted, full)


def test_restricted_noise_only_covers_the_chosen_qubits(device):
    qubits = quietest_qubits(device, 8)
    noise_model = noise_simulator(device, qubits).options.noise_model
    assert set(noise_model.noise_qubits) == set(qubits)


# Committed numbers


def test_committed_ideal_run_matches_the_limit_within_shot_noise(committed):
    for point in run_named(committed, "ideal")["points"]:
        limit = limit_at(committed, point["length"])
        assert point["passRate"] == pytest.approx(
            limit, abs=shot_noise_tolerance(limit, point["shots"])
        )


@pytest.mark.parametrize("length", LENGTHS)
def test_committed_ideal_points_replay_exactly(committed, length):
    stored = point_at(run_named(committed, "ideal"), length)
    point = sample_point(length, stored["shots"], stored["seed"], AerSimulator())
    assert with_std_err(point) == stored


@pytest.fixture(scope="module")
def committed_noise(committed):
    device = FakeKingston()
    qubits = run_named(committed, "ibm-noise-model")["provenance"]["qubits"]
    return noise_simulator(device, qubits), qubits


@pytest.mark.parametrize("length", LENGTHS)
def test_committed_noisy_points_replay_exactly(committed, committed_noise, length):
    stored = point_at(run_named(committed, "ibm-noise-model"), length)
    backend, _ = committed_noise
    layout = stored["qubits"]
    point = sample_point(length, stored["shots"], stored["seed"], backend, layout)
    assert with_std_err(point) == stored


def test_replay_notices_a_dropped_or_changed_layout(committed, committed_noise):
    stored = point_at(run_named(committed, "ibm-noise-model"), 1)
    backend, qubits = committed_noise
    args = (1, stored["shots"], stored["seed"], backend)
    assert sample_point(*args, None)["passes"] != stored["passes"]
    assert sample_point(*args, qubits[1:])["passes"] != stored["passes"]


# Payouts


def test_payouts_pay_the_expected_table(export):
    table = export["payouts"]["table"]
    assert export["payouts"]["status"] == "accepted"
    assert export["payouts"]["stake"] == 100
    assert export["payouts"]["rule"]
    assert {row["length"]: row["pays"] for row in table} == {
        length: EXPECTED_PAYS[length] for length in (row["length"] for row in table)
    }


def test_payouts_are_strictly_below_fair_and_keep_a_house_edge(export):
    table = export["payouts"]["table"]
    for row in table:
        assert row["pays"] < row["fairPays"]
        assert 0.04 < row["houseEdge"] < 0.08
    pays = [row["pays"] for row in table]
    assert pays == sorted(set(pays))


def test_payout_fields_are_recomputed_from_the_limits(export):
    for row in export["payouts"]["table"]:
        limit = limit_at(export, row["length"])
        fair_total = 100 / limit
        assert row["fairPays"] == pytest.approx(fair_total - 100, abs=1e-9)
        assert row["pays"] == math.floor((fair_total * 0.95 - 100) / 5) * 5
        assert row["breakEven"] == pytest.approx(100 / (100 + row["pays"]), abs=1e-12)
        assert row["houseEdge"] == pytest.approx(
            1 - (100 + row["pays"]) / 100 * limit, abs=1e-12
        )


def test_payouts_use_the_limit_they_are_given():
    assert payouts([{"length": 1, "value": 0.5}])["table"][0]["pays"] == 90
