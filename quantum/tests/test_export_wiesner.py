import json
import math
import random
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

import quantum.wiesner
from quantum.export import simulator_provenance
from quantum.export_wiesner import (
    ATTACK,
    EXPORT_PATH,
    IDEAL_BASE_SEED,
    LOGICAL_CIRCUITS_NOTE,
    MEASURES_PER_QUBIT,
    NOISY_BASE_SEED,
    PASS_RULE,
    SHOTS,
    SX_PER_QUBIT,
    TICKETS_PER_SHOT,
    build_export,
    length_seed,
    limits,
    logical_circuits,
    noise_model_label,
    noise_simulator,
    noisy_run,
    payouts,
    quietest_qubits,
    sample_point,
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


@pytest.fixture(scope="module")
def small_export():
    return build_export(lengths=SMALL_LENGTHS, shots=SMALL_SHOTS, today=date(2026, 11, 7))


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
        "ticketsPerShot",
        "limits",
        "payouts",
        "logicalCircuits",
        "logicalCircuitsNote",
        "runs",
    }
    assert export["schemaVersion"] == 1
    assert export["experiment"] == "wiesner"
    assert export["ticketsPerShot"] == 1


def test_labels_say_this_is_one_remade_chip_and_not_two_copies(export):
    assert "re-made" in export["attack"]
    assert "one re-made chip" in export["passRule"]
    assert "every qubit" in export["passRule"]
    assert "not" in export["passRule"] and "two copies" in export["passRule"]


def test_each_run_labels_its_true_source(export):
    assert [r["id"] for r in export["runs"]] == ["ideal", "ibm-noise-model"]
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
    for run in export["runs"]:
        assert set(run) == {"id", "provenance", "points"}
        shots = run["provenance"]["shots"]
        for point in run["points"]:
            assert set(point) == {"length", "seed", "shots", "qubits", "passes", "passRate"}
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
    again = build_export(lengths=SMALL_LENGTHS, shots=SMALL_SHOTS, today=date(2026, 11, 7))
    assert again == small_export


def test_committed_export_covers_every_length_for_both_runs(committed):
    assert {r["id"] for r in committed["runs"]} == {"ideal", "ibm-noise-model"}
    assert [e["length"] for e in committed["limits"]["byLength"]] == list(LENGTHS)
    assert [e["length"] for e in committed["logicalCircuits"]] == list(LENGTHS)
    assert [e["length"] for e in committed["payouts"]["table"]] == list(LENGTHS)
    for run in committed["runs"]:
        assert [p["length"] for p in run["points"]] == list(LENGTHS)
        assert run["provenance"]["shots"] == SHOTS


def test_ticket_count_is_labelled_per_shot(export):
    assert export["ticketsPerShot"] == TICKETS_PER_SHOT == 1


def test_committed_shared_blocks_match_the_current_code(committed, device):
    assert committed["limits"] == limits(LENGTHS)
    assert committed["logicalCircuits"] == logical_circuits(LENGTHS)
    assert committed["payouts"] == payouts(limits(LENGTHS)["byLength"])
    assert committed["attack"] == ATTACK
    assert committed["passRule"] == PASS_RULE
    assert committed["logicalCircuitsNote"] == LOGICAL_CIRCUITS_NOTE
    for run in committed["runs"]:
        provenance = run["provenance"]
        today = date.fromisoformat(provenance["date"])
        assert provenance == expected_provenance(run["id"], SHOTS, today, device)


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
    assert sample_point(length, stored["shots"], stored["seed"], AerSimulator()) == stored


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
    assert sample_point(length, stored["shots"], stored["seed"], backend, layout) == stored


def test_replay_notices_a_dropped_or_changed_layout(committed, committed_noise):
    stored = point_at(run_named(committed, "ibm-noise-model"), 1)
    backend, qubits = committed_noise
    args = (1, stored["shots"], stored["seed"], backend)
    assert sample_point(*args, None)["passes"] != stored["passes"]
    assert sample_point(*args, qubits[1:])["passes"] != stored["passes"]


# Payouts


def test_payouts_pay_the_expected_table(export):
    table = export["payouts"]["table"]
    assert export["payouts"]["status"] == "proposed"
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
