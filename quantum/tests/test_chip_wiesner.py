import random
from datetime import date

import pytest
from qiskit_aer import AerSimulator
from qiskit_ibm_runtime.fake_provider import FakeKingston

from quantum.chip import sample
from quantum.chip_wiesner import (
    QUBIT_SELECTION,
    check_compiled,
    compile_job,
    add_ticket_passes,
    passes_from_result,
    run_from_passes,
    ticket_passes_from_result,
    ticket_seed,
    ticket_values,
)
from quantum.wiesner import compile_forgery, forgery_binds, random_tickets

TODAY = date(2026, 11, 7)


def test_compile_job_gives_each_length_its_own_tickets_as_a_binding_array():
    backend = AerSimulator()
    pubs = compile_job([1, 3], backend, None, tickets=5)
    assert [pub[0].name for pub in pubs] == ["wiesner_1", "wiesner_3"]
    assert [pub[1].shape for pub in pubs] == [(5, 2), (5, 6)]


def test_ticket_values_line_up_with_the_circuits_own_parameter_order():
    circuit = compile_forgery(2, AerSimulator())
    tickets = random_tickets(2, 7, random.Random(1))
    values = ticket_values(circuit, tickets)
    binds = forgery_binds(tickets)
    for column, parameter in enumerate(circuit.parameters):
        assert list(values[:, column]) == binds[parameter]


def test_ticket_seeds_differ_per_length():
    assert ticket_seed(1) != ticket_seed(2)


def test_compiled_forgery_stays_on_the_chosen_qubits_and_registers():
    backend = FakeKingston()
    layout = [50, 148, 21, 68]
    circuit = compile_forgery(4, backend, layout=layout, seed=1)
    check_compiled(circuit, layout, 4)


def test_check_compiled_refuses_a_register_read_from_the_wrong_qubit():
    backend = FakeKingston()
    layout = [50, 148]
    circuit = compile_forgery(2, backend, layout=layout, seed=1)
    with pytest.raises(ValueError, match="reads"):
        check_compiled(circuit, list(reversed(layout)), 2)


def test_check_compiled_refuses_extra_qubits():
    backend = FakeKingston()
    circuit = compile_forgery(2, backend, layout=[50, 148], seed=1)
    with pytest.raises(ValueError, match="touches"):
        check_compiled(circuit, [50], 1)


def test_sampler_passes_follow_the_three_quarters_rule_per_length():
    backend = AerSimulator()
    pubs = compile_job([1, 2, 3], backend, None, tickets=256)
    result = sample(pubs, backend, shots=16, max_seconds=60).result()
    passes = passes_from_result(result, [1, 2, 3], 4096)
    for length, count in passes.items():
        assert count / 4096 == pytest.approx(0.75**length, abs=0.04)


def test_passes_from_result_refuses_the_wrong_shot_total_or_size():
    backend = AerSimulator()
    pubs = compile_job([1], backend, None, tickets=4)
    result = sample(pubs, backend, shots=4, max_seconds=60).result()
    with pytest.raises(ValueError, match="shots"):
        passes_from_result(result, [1], 17)
    with pytest.raises(ValueError, match="expected 2"):
        passes_from_result(result, [1, 2], 16)


def test_qubit_selection_says_it_was_a_best_case_pick():
    assert QUBIT_SELECTION.startswith("best-case pick")


def test_run_from_passes_matches_the_export_shape_with_a_chip_label():
    run = run_from_passes(
        "ibm-chip",
        "ibm_kingston",
        [61, 62, 63],
        QUBIT_SELECTION,
        32,
        8,
        TODAY,
        "job9",
        {1: 200, 3: 90},
    )
    assert run["provenance"]["source"] == "ibm-chip"
    assert run["provenance"]["qubitSelection"] == QUBIT_SELECTION
    assert run["provenance"]["jobId"] == "job9"
    assert run["provenance"]["shots"] == 256
    assert run["ticketsPerPoint"] == 32
    assert run["shotsPerTicket"] == 8
    assert run["points"] == [
        {
            "length": 1,
            "seed": ticket_seed(1),
            "shots": 256,
            "qubits": [61],
            "passes": 200,
            "passRate": 200 / 256,
        },
        {
            "length": 3,
            "seed": ticket_seed(3),
            "shots": 256,
            "qubits": [61, 62, 63],
            "passes": 90,
            "passRate": 90 / 256,
        },
    ]


def test_ticket_passes_split_each_length_by_ticket_and_add_up_to_its_passes():
    backend = AerSimulator()
    pubs = compile_job([1, 2], backend, None, tickets=6)
    result = sample(pubs, backend, shots=4, max_seconds=60).result()
    split = ticket_passes_from_result(result, [1, 2], 6, 4)
    assert {length: len(each) for length, each in split.items()} == {1: 6, 2: 6}
    assert all(0 <= n <= 4 for each in split.values() for n in each)
    assert {length: sum(each) for length, each in split.items()} == passes_from_result(
        result, [1, 2], 24
    )


def test_ticket_passes_refuse_the_wrong_ticket_count_or_shots_per_ticket():
    backend = AerSimulator()
    pubs = compile_job([1], backend, None, tickets=4)
    result = sample(pubs, backend, shots=4, max_seconds=60).result()
    with pytest.raises(ValueError, match="tickets"):
        ticket_passes_from_result(result, [1], 5, 4)
    with pytest.raises(ValueError, match="shots"):
        ticket_passes_from_result(result, [1], 4, 3)
    with pytest.raises(ValueError, match="expected 2"):
        ticket_passes_from_result(result, [1, 2], 4, 4)


def made_up_run(**changes):
    return run_from_passes(
        "ibm-chip", "ibm_kingston", [61, 62], QUBIT_SELECTION, 2, 4, TODAY, "job9",
        {1: 5, 2: 3}, **changes,
    )


def test_run_from_passes_stores_per_ticket_passes_on_each_point():
    run = made_up_run(ticket_passes={1: [4, 1], 2: [1, 2]})
    assert [p["ticketPasses"] for p in run["points"]] == [[4, 1], [1, 2]]


def test_run_from_passes_refuses_per_ticket_passes_that_do_not_match():
    with pytest.raises(ValueError, match="passes"):
        made_up_run(ticket_passes={1: [4, 2], 2: [1, 2]})
    with pytest.raises(ValueError, match="tickets"):
        made_up_run(ticket_passes={1: [5], 2: [1, 2]})
    with pytest.raises(ValueError, match="lengths"):
        made_up_run(ticket_passes={1: [4, 1]})


def test_add_ticket_passes_only_adds_the_field():
    run = made_up_run()
    filled = add_ticket_passes(run, {1: [4, 1], 2: [1, 2]})
    assert [{k: v for k, v in p.items() if k != "ticketPasses"} for p in filled["points"]] == (
        run["points"]
    )
    assert [p["ticketPasses"] for p in filled["points"]] == [[4, 1], [1, 2]]
    assert "ticketPasses" not in run["points"][0]


def test_add_ticket_passes_refuses_a_split_that_disagrees_with_the_recorded_passes():
    with pytest.raises(ValueError, match="passes"):
        add_ticket_passes(made_up_run(), {1: [4, 1], 2: [1, 1]})
