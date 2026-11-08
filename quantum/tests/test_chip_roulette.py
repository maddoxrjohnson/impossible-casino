from datetime import date, datetime
from types import SimpleNamespace

import pytest
from qiskit import QuantumCircuit
from qiskit.quantum_info import Operator
from qiskit_aer import AerSimulator
from qiskit_ibm_runtime.fake_provider import FakeKingston

import quantum.chip_roulette
from quantum.chip import NON_GATES
from quantum.chip_roulette import (
    BILLED_JOBS,
    QUBIT_SELECTION,
    TRANSPILE_SEED,
    check_compiled,
    collect,
    compile_job,
    counts_from_result,
    draft_shots,
    edge_risk,
    estimate_seconds,
    job_pubs,
    mix_risk,
    run_from_counts,
    sample,
    submit,
)
from quantum.export_roulette import (
    POCKET_ORDER,
    TIE_PAIRS,
    compile_draft,
    quietest_layout,
    spin_drafts,
)
from quantum.roulette import POCKETS, QUBITS, draft_circuit, exact_wheel, solve

TODAY = date(2026, 11, 7)
CLEARING_LINE = (2, 3, 4, 0)


@pytest.fixture(scope="module")
def device():
    return FakeKingston()


@pytest.fixture(scope="module")
def drafts():
    return spin_drafts(solve())


@pytest.fixture(scope="module")
def layout(device):
    return quietest_layout(device)


@pytest.fixture(scope="module")
def circuits(drafts, device, layout):
    return compile_job(drafts, device, layout)


class Bits:
    """Stands in for a sampler's BitArray, keyed like Qiskit: clbit 0 is the rightmost character."""

    def __init__(self, counts):
        self.counts = counts

    def get_counts(self):
        return dict(self.counts)


def fake_result(per_circuit):
    return [SimpleNamespace(data=SimpleNamespace(pocket=Bits(c))) for c in per_circuit]


def on_logical_qubits(circuit: QuantumCircuit, layout) -> QuantumCircuit:
    """The compiled gates moved back onto five qubits, logical k from layout[k]."""
    logical = {physical: k for k, physical in enumerate(layout)}
    small = QuantumCircuit(QUBITS, global_phase=circuit.global_phase)
    for instruction in circuit.data:
        if instruction.operation.name in NON_GATES or instruction.operation.name == "measure":
            continue
        qubits = [logical[circuit.find_bit(q).index] for q in instruction.qubits]
        small.append(instruction.operation, qubits)
    return small


# Compiling


def test_one_circuit_per_finished_draft_in_spin_order(circuits, drafts, device, layout):
    assert len(drafts) == 108
    assert len(circuits) == len(drafts)
    for draft, circuit in zip(drafts[:6], circuits[:6]):
        expected = compile_draft(draft, device, layout=layout, seed=TRANSPILE_SEED)
        assert circuit == expected


def test_each_compiled_circuit_is_its_logical_draft_up_to_layout(circuits, drafts, layout):
    for draft, circuit in zip(drafts, circuits):
        logical = draft_circuit(draft, measure=False)
        assert Operator(on_logical_qubits(circuit, layout)).equiv(Operator(logical)), draft


def test_compiled_circuits_stay_on_the_layout_and_read_pocket_bit_k_from_qubit_k(circuits, layout):
    for circuit in circuits:
        check_compiled(circuit, layout)


def test_ties_sit_on_couplers_so_no_swaps_are_added(circuits, device, layout):
    for circuit in circuits:
        assert circuit.count_ops().get("cz", 0) <= 2 * len(TIE_PAIRS)
    for a, b in TIE_PAIRS:
        pair = (layout[a], layout[b])
        assert pair in device.target["cz"] or pair[::-1] in device.target["cz"]


def test_check_compiled_refuses_a_circuit_on_other_qubits(circuits, layout):
    other = [*layout[:4], next(q for q in range(156) if q not in layout)]
    with pytest.raises(ValueError, match="qubits"):
        check_compiled(circuits[0], other)


def test_check_compiled_refuses_a_circuit_that_reads_pockets_out_of_order(circuits, layout):
    swapped = [layout[1], layout[0], *layout[2:]]
    with pytest.raises(ValueError, match="reads"):
        check_compiled(circuits[0], swapped)


# Counts


def test_counts_land_in_pocket_order_with_bit_k_from_qubit_k():
    """Only qubit 0 set is pocket 1; only qubit 4 set is pocket 16."""
    result = fake_result([{"00001": 3, "10000": 5}, {"11000": 8}])
    got = counts_from_result(result, [(0, 1, 2, 3), (1, 0, 2, 3)], [8, 8])
    assert got[0][1] == 3 and got[0][16] == 5
    assert got[1][24] == 8
    assert all(len(c) == POCKETS for c in got)
    assert "bit k is qubit k" in POCKET_ORDER


def test_sampled_clearing_line_lands_only_on_its_limit_pockets():
    """The clearing line spreads only qubits 3 and 4, so reversed bits would show."""
    backend = AerSimulator()
    circuits = compile_job([CLEARING_LINE], backend, None)
    result = sample(circuits, backend, shots=256, max_seconds=30).result()
    counts = counts_from_result(result, [CLEARING_LINE], [256])[0]
    lit = {p for p, chance in enumerate(exact_wheel(CLEARING_LINE)) if chance > 0}
    assert lit == {0, 8, 16, 24}
    assert {p for p, n in enumerate(counts) if n} == lit


def test_counts_from_result_refuses_the_wrong_number_of_circuits():
    result = fake_result([{"00000": 8}])
    with pytest.raises(ValueError, match="expected 2"):
        counts_from_result(result, [(0, 1, 2, 3), (1, 0, 2, 3)], [8, 8])


def test_counts_from_result_refuses_the_wrong_number_of_shots():
    result = fake_result([{"00000": 8}, {"00000": 7}])
    with pytest.raises(ValueError, match="shots"):
        counts_from_result(result, [(0, 1, 2, 3), (1, 0, 2, 3)], [8, 8])


def test_counts_from_result_refuses_shots_that_do_not_match_each_circuits_plan():
    """The right total in the wrong places still fails: each circuit is checked on its own."""
    result = fake_result([{"00000": 512}, {"00000": 8192}])
    with pytest.raises(ValueError, match="expected 8192"):
        counts_from_result(result, [(0, 1, 2, 3), (1, 0, 2, 3)], [8192, 512])


# Runs


def test_run_from_counts_matches_the_export_shape_with_a_chip_label(drafts, layout):
    shots = draft_shots(solve(), drafts, 512, 8192)
    counts = [[0] * (POCKETS - 1) + [n] for n in shots]
    run = run_from_counts("ibm-chip", "ibm_kingston", layout, shots, TODAY, "job123", drafts, counts)
    assert set(run) == {"id", "provenance", "points"}
    assert run["id"] == "ibm-chip"
    provenance = run["provenance"]
    assert provenance["source"] == "ibm-chip"
    assert provenance["backend"] == "ibm_kingston"
    assert provenance["jobId"] == "job123"
    assert provenance["noiseModel"] is None
    assert provenance["qubits"] == list(layout)
    assert provenance["qubitSelection"] == QUBIT_SELECTION
    assert provenance["shots"] == 8192
    assert [p["draft"] for p in run["points"]] == [list(d) for d in drafts]
    for point, n in zip(run["points"], shots):
        assert set(point) == {"draft", "seed", "shots", "counts"}
        assert point["seed"] is None
        assert point["shots"] == n == sum(point["counts"])


def test_qubit_selection_says_it_was_a_best_case_pick_from_the_days_calibration():
    assert QUBIT_SELECTION.startswith("best-case pick")
    assert "day's calibration" in QUBIT_SELECTION
    assert "snapshot" not in QUBIT_SELECTION


def test_collect_writes_the_run_from_the_records_drafts(monkeypatch, drafts):
    record = {
        "jobId": "job123",
        "experiment": "roulette",
        "backend": "ibm_kingston",
        "qubits": [1, 2, 3, 4, 5],
        "qubitSelection": "stored text",
        "drafts": [list(d) for d in drafts],
        "shots": [32, 64] * (len(drafts) // 2),
    }
    counts = [[0] * 8 + [n] + [0] * 23 for n in record["shots"]]
    job = SimpleNamespace(
        status=lambda: "DONE",
        result=lambda: fake_result([{"01000": n} for n in record["shots"]]),
        usage=lambda: 30,
        creation_date=datetime(2026, 11, 7),
    )
    written = []
    monkeypatch.setattr(quantum.chip_roulette, "read_record", lambda *_: record)
    monkeypatch.setattr(quantum.chip_roulette, "write_record", written.append)
    monkeypatch.setattr(
        quantum.chip_roulette, "QiskitRuntimeService", lambda: SimpleNamespace(job=lambda _: job)
    )
    collect(SimpleNamespace(job_id="job123", run_id="ibm-chip"))
    run = written[0]["run"]
    assert written[0]["usageSeconds"] == 30
    assert run["provenance"]["qubitSelection"] == QUBIT_SELECTION
    assert run["provenance"]["date"] == "2026-11-07"
    assert [p["counts"] for p in run["points"]] == counts
    assert [p["shots"] for p in run["points"]] == record["shots"]


def test_collect_refuses_a_result_whose_shots_do_not_match_the_record(monkeypatch, drafts):
    record = {
        "jobId": "job123",
        "experiment": "roulette",
        "backend": "ibm_kingston",
        "qubits": [1, 2, 3, 4, 5],
        "drafts": [list(d) for d in drafts],
        "shots": [512] * len(drafts),
    }
    job = SimpleNamespace(
        status=lambda: "DONE",
        result=lambda: fake_result([{"00000": 512}] * (len(drafts) - 1) + [{"00000": 8192}]),
    )
    written = []
    monkeypatch.setattr(quantum.chip_roulette, "read_record", lambda *_: record)
    monkeypatch.setattr(quantum.chip_roulette, "write_record", written.append)
    monkeypatch.setattr(
        quantum.chip_roulette, "QiskitRuntimeService", lambda: SimpleNamespace(job=lambda _: job)
    )
    with pytest.raises(ValueError, match="expected 512"):
        collect(SimpleNamespace(job_id="job123", run_id="ibm-chip"))
    assert not written


def test_collect_waits_for_a_job_that_is_not_done(monkeypatch):
    job = SimpleNamespace(status=lambda: "RUNNING")
    written = []
    monkeypatch.setattr(quantum.chip_roulette, "read_record", lambda *_: {})
    monkeypatch.setattr(quantum.chip_roulette, "write_record", written.append)
    monkeypatch.setattr(
        quantum.chip_roulette, "QiskitRuntimeService", lambda: SimpleNamespace(job=lambda _: job)
    )
    collect(SimpleNamespace(job_id="job123", run_id="ibm-chip"))
    assert not written


def test_submit_records_every_draft_and_the_cap(monkeypatch, drafts, device, layout):
    service = SimpleNamespace(usage=lambda: {"usage_remaining_seconds": 600})
    shots = draft_shots(solve(), drafts, 512, 8192)
    ready = {"backend": device, "layout": layout, "drafts": drafts, "shots": shots, "pubs": ["pub"]}
    sampled = []
    written = []
    monkeypatch.setattr(quantum.chip_roulette, "QiskitRuntimeService", lambda: service)
    monkeypatch.setattr(quantum.chip_roulette, "pending_seconds", lambda: 0)
    monkeypatch.setattr(quantum.chip_roulette, "prepare", lambda *_: ready)
    monkeypatch.setattr(
        quantum.chip_roulette,
        "sample",
        lambda *a: sampled.append(a) or SimpleNamespace(job_id=lambda: "job123"),
    )
    monkeypatch.setattr(quantum.chip_roulette, "write_record", lambda r: written.append(r) or "path")
    submit(SimpleNamespace(backend="ibm_kingston", shots=512, limit_shots=8192, max_seconds=60))
    assert sampled[0][0] == ["pub"]
    assert sampled[0][2:] == (512, 60)
    record = written[0]
    assert record["experiment"] == "roulette"
    assert record["drafts"] == [list(d) for d in drafts]
    assert record["shots"] == shots
    assert record["maxSeconds"] == 60
    assert record["qubits"] == list(layout)
    assert record["qubitSelection"] == QUBIT_SELECTION


def test_submit_refuses_before_sampling_when_pending_caps_use_the_budget(monkeypatch):
    service = SimpleNamespace(usage=lambda: {"usage_remaining_seconds": 100})
    monkeypatch.setattr(quantum.chip_roulette, "QiskitRuntimeService", lambda: service)
    monkeypatch.setattr(quantum.chip_roulette, "pending_seconds", lambda: 90)
    monkeypatch.setattr(quantum.chip_roulette, "prepare", lambda *_: pytest.fail("must not prepare"))
    monkeypatch.setattr(quantum.chip_roulette, "sample", lambda *_: pytest.fail("must not sample"))
    with pytest.raises(ValueError, match="left"):
        submit(SimpleNamespace(max_seconds=30))


# Shots per draft


def test_limit_drafts_get_the_limit_shots_and_the_rest_the_plain_shots(drafts):
    solution = solve()
    shots = draft_shots(solution, drafts, 512, 8192)
    limit = solution.value[()]
    for draft, n in zip(drafts, shots):
        assert n == (8192 if max(solution.wheels[draft]) >= limit - 1e-9 else 512)
    assert shots.count(8192) == 8
    assert sum(shots) == 8 * 8192 + 100 * 512


def test_job_pubs_carry_each_drafts_shots(circuits):
    pubs = job_pubs(circuits[:2], [512, 8192])
    assert pubs == [(circuits[0], None, 512), (circuits[1], None, 8192)]


def test_the_sampler_honours_each_pubs_own_shots():
    backend = AerSimulator()
    circuits = compile_job([CLEARING_LINE, (2, 3, 4, 5)], backend, None)
    result = sample(job_pubs(circuits, [64, 256]), backend, shots=16, max_seconds=30).result()
    got = counts_from_result(result, [CLEARING_LINE, (2, 3, 4, 5)], [64, 256])
    assert [sum(c) for c in got] == [64, 256]


# Planning arithmetic


def test_estimate_reproduces_the_billed_jobs_it_was_fitted_to():
    for job_id, circuits, shots, billed in BILLED_JOBS:
        low, high = estimate_seconds(circuits, circuits * shots)
        assert low <= billed + 1, job_id
        assert high >= billed - 1, job_id


def test_estimate_grows_with_shots_and_is_a_range():
    low, high = estimate_seconds(108, 108 * 1024)
    assert 20 < low < high < 80
    assert estimate_seconds(108, 108 * 4096)[0] > high


def test_mix_risk_combines_pockets_with_their_own_shots():
    pays, stake = 280, 100
    alone = mix_risk([(0.25, 8192)] * 32, pays, stake)
    assert alone == pytest.approx(edge_risk(0.25, 32, 8192, pays, stake))
    with_rest = mix_risk([(0.25, 8192)] * 32 + [(0.125, 512)] * 100, pays, stake)
    assert alone <= with_rest < alone + 1e-3


def test_edge_risk_is_near_certain_on_a_perfect_wheel_and_small_when_noisy():
    """Sampling alone pushes some limit pocket past the bar on a wheel that sits right at 1 in 4."""
    assert edge_risk(0.25, pockets=32, shots=1024, pays=280, stake=100) > 0.9
    assert edge_risk(0.20, pockets=32, shots=4096, pays=280, stake=100) < 1e-6
    assert edge_risk(0.24, pockets=32, shots=4096, pays=280, stake=100) < edge_risk(
        0.24, pockets=32, shots=1024, pays=280, stake=100
    )
