import math
import random
from itertools import product
from typing import Any

import pytest
from qiskit import QuantumCircuit, qasm2
from qiskit.quantum_info import Statevector
from qiskit_aer import AerSimulator
from qiskit_ibm_runtime.fake_provider import FakeKingston

from quantum.export_wiesner import noise_simulator
from quantum.wiesner import (
    ATTACKER_ANGLES,
    BANK_ANGLES,
    BASES,
    LENGTHS,
    Ticket,
    compile_forgery,
    exact_pass_per_qubit,
    forgery_binds,
    forgery_circuit,
    forgery_template,
    passed,
    random_tickets,
    run_forgery,
    split_outcome,
)

LAYOUT = [50, 148, 21, 68, 151, 8, 142, 25]
SINGLE_QUBIT_CASES = list(product((0, 1), BASES, BASES))


def shot_noise_tolerance(rate, shots, sigmas=4):
    return sigmas * math.sqrt(rate * (1 - rate) / shots)


def sample(ticket, shots, seed):
    circuit = forgery_circuit(ticket)
    return AerSimulator().run(circuit, shots=shots, seed_simulator=seed).result().get_counts()


def pass_rate(counts, length):
    return sum(n for key, n in counts.items() if passed(key, length)) / sum(counts.values())


def measured_qubits(circuit, register):
    """Clbit index to physical qubit, read off the compiled measure instructions."""
    measured = {}
    for instruction in circuit.data:
        if instruction.operation.name != "measure":
            continue
        location = circuit.find_bit(instruction.clbits[0])
        if location.registers[0][0].name == register:
            measured[location.registers[0][1]] = circuit.find_bit(instruction.qubits[0]).index
    return measured


# Physics


@pytest.mark.parametrize(
    "bit, basis, label", [(0, "Z", "0"), (1, "Z", "1"), (0, "X", "+"), (1, "X", "-")]
)
def test_bank_angles_make_the_four_wiesner_states(bit, basis, label):
    circuit = QuantumCircuit(1)
    circuit.ry(BANK_ANGLES[(bit, basis)], 0)
    assert Statevector.from_instruction(circuit).equiv(Statevector.from_label(label))


def test_attacker_angles_undo_the_x_basis_and_leave_z_alone():
    assert ATTACKER_ANGLES == {"Z": 0.0, "X": math.pi / 2}


def test_exact_pass_per_qubit_is_three_quarters():
    assert exact_pass_per_qubit() == pytest.approx(0.75, abs=1e-12)


# Circuit shape


@pytest.mark.parametrize("length", LENGTHS)
def test_template_has_one_angle_pair_per_qubit_and_two_named_registers(length):
    template = forgery_template(length)
    assert template.num_qubits == length
    assert len(template.parameters) == 2 * length
    assert [(r.name, r.size) for r in template.qregs] == [("chip", length)]
    assert [(r.name, r.size) for r in template.cregs] == [
        ("attacker", length),
        ("cashier", length),
    ]
    assert template.count_ops() == {"ry": 4 * length, "barrier": 2, "measure": 2 * length}


def test_template_is_laid_out_in_the_order_of_the_protocol():
    names = [i.operation.name for i in forgery_template(1).data]
    assert names == ["ry", "barrier", "ry", "measure", "ry", "barrier", "ry", "measure"]
    assert list(measured_qubits(forgery_template(1), "attacker")) == [0]
    assert list(measured_qubits(forgery_template(1), "cashier")) == [0]


def test_forgery_circuit_is_fully_bound_and_writes_as_qasm2():
    ticket = Ticket((0, 1, 1), ("Z", "X", "Z"), ("X", "X", "Z"))
    circuit = forgery_circuit(ticket)
    assert not circuit.parameters
    rebuilt = QuantumCircuit.from_qasm_str(qasm2.dumps(circuit))
    assert rebuilt.count_ops()["measure"] == 6


def test_bound_angles_put_each_qubit_on_its_own_ticket_entry():
    ticket = Ticket((0, 1), ("X", "Z"), ("X", "Z"))
    rotations = [i for i in forgery_circuit(ticket).data if i.operation.name == "ry"]
    circuit = forgery_circuit(ticket)
    angles = {
        (circuit.find_bit(r.qubits[0]).index, position // 2): r.operation.params[0]
        for position, r in enumerate(rotations)
    }
    assert angles == pytest.approx(
        {
            (0, 0): math.pi / 2,
            (1, 0): math.pi,
            (0, 1): -math.pi / 2,
            (1, 1): 0,
            (0, 2): math.pi / 2,
            (1, 2): 0,
            (0, 3): -math.pi / 2,
            (1, 3): -math.pi,
        }
    )


@pytest.mark.parametrize("length", [1, 3, 8])
def test_compiled_template_measures_on_exactly_the_layout_qubits(length):
    compiled = compile_forgery(length, FakeKingston(), layout=LAYOUT, seed=1)
    expected = dict(enumerate(LAYOUT[:length]))
    assert measured_qubits(compiled, "attacker") == expected
    assert measured_qubits(compiled, "cashier") == expected


@pytest.mark.parametrize("length", [1, 8])
def test_compiled_template_has_no_two_qubit_or_dynamic_gates(length):
    compiled = compile_forgery(length, FakeKingston(), layout=LAYOUT, seed=1)
    assert set(compiled.count_ops()) == {"sx", "rz", "barrier", "measure"}
    gates = [i for i in compiled.data if i.operation.name not in ("barrier", "measure")]
    assert all(len(i.qubits) == 1 for i in gates)


# Sampled physics


@pytest.mark.parametrize("bit, basis, attacker", SINGLE_QUBIT_CASES)
def test_one_qubit_case(bit, basis, attacker):
    shots = 4096
    counts = sample(Ticket((bit,), (basis,), (attacker,)), shots, seed=11)
    if attacker == basis:
        assert pass_rate(counts, 1) == 1
        assert {split_outcome(key, 1)[0] for key in counts} == {str(bit)}
    else:
        assert pass_rate(counts, 1) == pytest.approx(0.5, abs=shot_noise_tolerance(0.5, shots))


@pytest.mark.parametrize("index, case", list(enumerate(product(SINGLE_QUBIT_CASES, repeat=2))))
def test_two_qubit_case(index, case):
    bits, bases, attackers = zip(*case)
    shots = 1024
    counts = sample(Ticket(bits, bases, attackers), shots, seed=1000 + index)
    expected = 2.0 ** -sum(a != b for a, b in zip(attackers, bases))
    assert pass_rate(counts, 2) == pytest.approx(
        expected, abs=shot_noise_tolerance(expected, shots)
    )


def test_passing_reads_the_cashier_register_and_not_the_attackers():
    counts = sample(Ticket((1,), ("Z",), ("Z",)), 64, seed=3)
    assert set(counts) == {"0 1"}
    assert pass_rate(counts, 1) == 1


def test_register_order_is_cashier_on_the_left():
    assert split_outcome("011 100", 3) == ("100", "011")
    assert passed("000 111", 3)
    assert not passed("100 000", 3)
    assert not passed("001 000", 3)


@pytest.mark.parametrize("length", LENGTHS)
def test_pass_rate_matches_the_exact_value_at_every_length(length):
    shots = 4096
    expected = 0.75**length
    rate = run_forgery(length, shots, seed=500 + length) / shots
    assert rate == pytest.approx(expected, abs=shot_noise_tolerance(expected, shots))


def test_run_forgery_replays_from_its_seed():
    assert run_forgery(4, 512, seed=9) == run_forgery(4, 512, seed=9)


def test_every_binding_carries_its_own_ticket_in_order():
    length = 3
    rng = random.Random(21)
    tickets = [
        Ticket(t.bits, t.bases, t.bases) for t in random_tickets(length, 64, rng)
    ]
    backend = AerSimulator()
    compiled = compile_forgery(length, backend, seed=1)
    result = backend.run(
        compiled, parameter_binds=[forgery_binds(tickets)], shots=1, seed_simulator=1
    ).result()
    for i, ticket in enumerate(tickets):
        outcome = next(iter(result.get_counts(i)))
        assert passed(outcome, length)
        assert split_outcome(outcome, length)[0] == "".join(map(str, reversed(ticket.bits)))


# Tickets


def test_random_tickets_are_stable_and_drawn_one_at_a_time():
    first = random_tickets(4, 100, random.Random(7))
    assert first == random_tickets(4, 100, random.Random(7))
    assert random_tickets(4, 1, random.Random(7))[0] == first[0]
    assert first != random_tickets(4, 100, random.Random(8))


def test_random_tickets_cover_every_field_evenly():
    shots = 8000
    tickets = random_tickets(1, shots, random.Random(5))
    margin = shot_noise_tolerance(0.5, shots)
    assert sum(t.bits[0] for t in tickets) / shots == pytest.approx(0.5, abs=margin)
    assert sum(t.bases[0] == "X" for t in tickets) / shots == pytest.approx(0.5, abs=margin)
    assert sum(t.attacker_bases[0] == "X" for t in tickets) / shots == pytest.approx(
        0.5, abs=margin
    )
    assert sum(t.bases[0] == t.attacker_bases[0] for t in tickets) / shots == pytest.approx(
        0.5, abs=margin
    )


# Bad input


@pytest.mark.parametrize("length", [0, 9, -1, 1.5, "2"])
def test_bad_lengths_are_rejected(length):
    with pytest.raises(ValueError):
        forgery_template(length)
    with pytest.raises(ValueError):
        run_forgery(length, 8)
    with pytest.raises(ValueError):
        random_tickets(length, 1, random.Random(0))


@pytest.mark.parametrize("shots", [0, -1, 1.5, "8"])
def test_bad_shots_are_rejected(shots):
    with pytest.raises(ValueError):
        run_forgery(1, shots)


@pytest.mark.parametrize(
    "bits, bases, attackers",
    [
        ((0, 1), ("Z",), ("Z", "Z")),
        ((0, 1), ("Z", "Z"), ("Z",)),
        ((0,), ("Z", "Z"), ("Z", "Z")),
        ((), (), ()),
        ((2,), ("Z",), ("Z",)),
        ((0,), ("Y",), ("Z",)),
        ((0,), ("Z",), ("Y",)),
        ((0,) * 9, ("Z",) * 9, ("Z",) * 9),
    ],
)
def test_bad_tickets_are_rejected(bits, bases, attackers):
    with pytest.raises(ValueError):
        Ticket(bits, bases, attackers)


def test_mixed_ticket_lengths_are_rejected():
    one = Ticket((0,), ("Z",), ("Z",))
    two = Ticket((0, 0), ("Z", "Z"), ("Z", "Z"))
    with pytest.raises(ValueError):
        forgery_binds([one, two])
    with pytest.raises(ValueError):
        forgery_binds([])


def test_a_layout_shorter_than_the_chip_is_rejected():
    with pytest.raises(ValueError):
        compile_forgery(3, FakeKingston(), layout=[1, 2])


@pytest.mark.parametrize("outcome", ["0 0", "00", "000 00", "00 000", "0a 00", ""])
def test_malformed_outcomes_are_rejected(outcome):
    with pytest.raises(ValueError):
        passed(outcome, 2)


@pytest.mark.parametrize("batch", [1, 7, 32, 256])
def test_batching_gives_the_same_counts_as_one_job(batch: int) -> None:
    device = FakeKingston()
    qubits = [50, 148, 21, 68]
    backend = noise_simulator(device, qubits)
    whole = run_forgery(4, 256, backend=backend, seed=2024, layout=qubits)
    assert run_forgery(4, 256, backend=backend, seed=2024, layout=qubits, batch=batch) == whole


def test_batching_runs_one_job_per_batch() -> None:
    backend = AerSimulator()
    jobs: list[int] = []
    run = backend.run

    def counting_run(*args: Any, **kwargs: Any) -> Any:
        jobs.append(len(next(iter(kwargs["parameter_binds"][0].values()))))
        return run(*args, **kwargs)

    backend.run = counting_run  # type: ignore[method-assign]
    run_forgery(2, 70, backend=backend, seed=5, batch=32)
    assert jobs == [32, 32, 6]


def test_batching_keeps_a_fresh_ticket_per_shot() -> None:
    backend = AerSimulator()
    passes = run_forgery(1, 4096, backend=backend, seed=5, batch=32)
    assert abs(passes / 4096 - 0.75) < 0.05


@pytest.mark.parametrize("batch", [0, -1, 1.5])
def test_batching_refuses_a_bad_size(batch: Any) -> None:
    with pytest.raises(ValueError, match="batch"):
        run_forgery(1, 8, seed=1, batch=batch)
