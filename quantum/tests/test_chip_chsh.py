from datetime import date, datetime
from types import SimpleNamespace

import pytest
from qiskit_aer import AerSimulator
from qiskit_ibm_runtime.fake_provider import FakeKingston

import quantum.chip_chsh
from quantum.chsh import QUESTION_PAIRS, compile_chsh, pair_win_rate, split_outcome
from quantum.chip_chsh import (
    QUBIT_SELECTION,
    TRANSPILE_SEED,
    check_budget,
    check_compiled,
    chip_provenance,
    collect,
    compile_job,
    counts_from_result,
    run_from_counts,
    sample,
    submit,
)
from quantum.export_chsh import OUTCOMES, build_export, quietest_pair

TODAY = date(2026, 11, 7)


def ideal_counts(dial, shots=4096):
    point = next(
        p
        for p in build_export(dials=[dial], shots=shots, today=TODAY)["runs"][0]["points"]
    )
    return {(p["x"], p["y"]): p["counts"] for p in point["pairs"]}


def test_compile_job_orders_circuits_by_dial_then_question_pair():
    backend = FakeKingston()
    circuits = compile_job([0.25, 0.5], backend, quietest_pair(backend))
    names = [c.name for c in circuits]
    expected = [f"chsh_dial{d:g}_x{x}_y{y}" for d in (0.25, 0.5) for x, y in QUESTION_PAIRS]
    assert names == expected


def test_compiled_circuits_stay_on_the_chosen_pair_and_read_player_first():
    backend = FakeKingston()
    layout = quietest_pair(backend)
    for circuit in compile_job([0.5], backend, layout):
        check_compiled(circuit, layout)


def test_check_compiled_refuses_a_circuit_on_other_qubits():
    backend = FakeKingston()
    layout = quietest_pair(backend)
    circuit = compile_chsh(0.5, backend, layout=layout, seed=TRANSPILE_SEED)[0]
    other = (layout[0], next(q for q in range(100) if q not in layout))
    with pytest.raises(ValueError, match="qubits"):
        check_compiled(circuit, other)


def test_check_compiled_refuses_a_circuit_that_reads_the_partner_first():
    backend = FakeKingston()
    layout = quietest_pair(backend)
    circuit = compile_chsh(0.5, backend, layout=layout, seed=TRANSPILE_SEED)[0]
    with pytest.raises(ValueError, match="classical"):
        check_compiled(circuit, tuple(reversed(layout)))


def test_sampler_counts_land_on_the_right_question_pairs_and_answers():
    """Dial 0.25 wins differently per pair, so a mixed-up order would show."""
    backend = AerSimulator()
    circuits = compile_job([0.25, 0.5], backend, None)
    result = sample(circuits, backend, shots=4096, max_seconds=30).result()
    got = counts_from_result(result, [0.25, 0.5], 4096)
    for dial in (0.25, 0.5):
        assert set(got[dial]) == set(QUESTION_PAIRS)
        expected = ideal_counts(dial)
        for pair in QUESTION_PAIRS:
            measured = pair_win_rate(got[dial][pair], *pair)
            assert measured == pytest.approx(pair_win_rate(expected[pair], *pair), abs=0.04)


def test_counts_from_result_refuses_a_result_of_the_wrong_size():
    backend = AerSimulator()
    circuits = compile_job([0.5], backend, None)
    result = sample(circuits, backend, shots=16, max_seconds=30).result()
    with pytest.raises(ValueError, match="expected 8"):
        counts_from_result(result, [0.25, 0.5], 16)
    with pytest.raises(ValueError, match="shots"):
        counts_from_result(result, [0.5], 32)


def test_outcome_keys_use_the_exported_ba_order():
    assert split_outcome("10") == (0, 1)
    assert set(OUTCOMES) == {"00", "01", "10", "11"}


def test_run_from_counts_matches_the_export_shape_with_a_chip_label():
    counts = {0.5: ideal_counts(0.5)}
    run = run_from_counts(
        "ibm-chip", "ibm_kingston", [61, 62], 4096, TODAY, "job123", counts
    )
    provenance = run["provenance"]
    assert provenance["source"] == "ibm-chip"
    assert provenance["backend"] == "ibm_kingston"
    assert provenance["jobId"] == "job123"
    assert provenance["noiseModel"] is None
    assert provenance["qubits"] == [61, 62]
    assert provenance["qubitSelection"] == QUBIT_SELECTION
    point = run["points"][0]
    assert point["dial"] == 0.5
    assert point["seed"] == TRANSPILE_SEED
    assert [(p["x"], p["y"]) for p in point["pairs"]] == list(QUESTION_PAIRS)


def test_qubit_selection_says_it_was_a_best_case_pick():
    assert QUBIT_SELECTION.startswith("best-case pick")


def test_collect_labels_the_run_with_the_constant_not_the_stored_text(monkeypatch):
    record = {
        "jobId": "job123",
        "experiment": "chsh",
        "backend": "ibm_kingston",
        "qubits": [61, 62],
        "qubitSelection": "lowest CZ plus readout error in that day's calibration",
        "dials": [0.5],
        "shots": 4096,
    }
    job = SimpleNamespace(
        status=lambda: "DONE",
        result=lambda: None,
        usage=lambda: 6,
        creation_date=datetime(2026, 11, 7),
    )
    written = []
    monkeypatch.setattr(quantum.chip_chsh, "read_record", lambda *_: record)
    monkeypatch.setattr(quantum.chip_chsh, "write_record", written.append)
    monkeypatch.setattr(
        quantum.chip_chsh, "QiskitRuntimeService", lambda: SimpleNamespace(job=lambda _: job)
    )
    monkeypatch.setattr(
        quantum.chip_chsh, "counts_from_result", lambda *_: {0.5: ideal_counts(0.5)}
    )
    collect(SimpleNamespace(job_id="job123", run_id="ibm-chip"))
    assert written[0]["run"]["provenance"]["qubitSelection"] == QUBIT_SELECTION


def test_submit_records_the_constant(monkeypatch):
    service = SimpleNamespace(usage=lambda: {"usage_remaining_seconds": 600})
    backend = FakeKingston()
    ready = {"backend": backend, "layout": quietest_pair(backend), "circuits": []}
    written = []
    monkeypatch.setattr(quantum.chip_chsh, "QiskitRuntimeService", lambda: service)
    monkeypatch.setattr(quantum.chip_chsh, "prepare", lambda *_: ready)
    monkeypatch.setattr(
        quantum.chip_chsh, "sample", lambda *_: SimpleNamespace(job_id=lambda: "job123")
    )
    monkeypatch.setattr(quantum.chip_chsh, "write_record", lambda r: written.append(r) or "path")
    args = SimpleNamespace(backend="ibm_kingston", dials=[0.5], shots=8, max_seconds=30)
    submit(args)
    assert written[0]["qubitSelection"] == QUBIT_SELECTION


@pytest.mark.parametrize("name", ["fake_kingston", "aer_simulator", "IBM_kingston"])
def test_only_a_real_chip_name_can_carry_the_chip_label(name):
    with pytest.raises(ValueError, match="chip"):
        chip_provenance(name, [61, 62], QUBIT_SELECTION, 4096, TODAY, "job123")


def test_a_chip_label_needs_a_job_id():
    with pytest.raises(ValueError, match="job"):
        chip_provenance("ibm_kingston", [61, 62], QUBIT_SELECTION, 4096, TODAY, "")


def test_a_chip_label_must_say_how_its_qubits_were_picked():
    with pytest.raises(ValueError, match="qubit"):
        chip_provenance("ibm_kingston", [61, 62], " ", 4096, TODAY, "job123")


def test_budget_check_refuses_a_cap_above_what_is_left():
    check_budget(remaining_seconds=600, max_seconds=30)
    with pytest.raises(ValueError, match="left"):
        check_budget(remaining_seconds=29, max_seconds=30)
