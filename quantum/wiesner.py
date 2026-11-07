"""Wiesner chip forgery: the bet behind the Cashier's Cage.

The bank makes an n-qubit chip. Each qubit gets a random bit and a random basis,
so it is one of |0>, |1>, |+>, |->, and only the bank knows which. An attacker
who holds the chip guesses a basis per qubit, measures, and re-makes the qubit
from the outcome. The cashier then checks that one re-made chip in the bank's
bases, and it passes only if every qubit agrees.

A right guess always passes and a wrong guess passes half the time, so each
qubit passes with probability 3/4 and a chip with (3/4)^n. This models one
re-made chip passing the cashier, not both of two copies passing.

A measurement leaves the qubit in the outcome state, which is the resend, so the
attacker needs no feed-forward. The circuit has no dynamic gates and no
two-qubit gates, and each qubit can sit anywhere on a chip.

Every outcome key reads "cashier attacker", and within a register the rightmost
character is qubit 0.
"""

import math
import random
from collections.abc import Sequence
from dataclasses import dataclass
from itertools import product

from qiskit import ClassicalRegister, QuantumCircuit, QuantumRegister, transpile
from qiskit.circuit import Parameter, ParameterVector
from qiskit.circuit.library import RYGate
from qiskit.providers import BackendV2
from qiskit.quantum_info import Statevector
from qiskit_aer import AerSimulator

MAX_LENGTH = 8
LENGTHS: tuple[int, ...] = tuple(range(1, MAX_LENGTH + 1))
BASES: tuple[str, str] = ("Z", "X")

# RY angles that make each bank state from |0>, keyed by (bit, basis).
BANK_ANGLES: dict[tuple[int, str], float] = {
    (0, "Z"): 0.0,
    (1, "Z"): math.pi,
    (0, "X"): math.pi / 2,
    (1, "X"): -math.pi / 2,
}
ATTACKER_ANGLES: dict[str, float] = {"Z": 0.0, "X": math.pi / 2}

BANK_PARAMETERS = ParameterVector("bank", MAX_LENGTH)
ATTACKER_PARAMETERS = ParameterVector("attacker", MAX_LENGTH)


def _check_length(length: int) -> None:
    if not isinstance(length, int) or length not in LENGTHS:
        raise ValueError(f"length must be 1 to {MAX_LENGTH}, got {length!r}")


@dataclass(frozen=True)
class Ticket:
    """One shot's secrets: the bank's bits and bases, and the attacker's bases."""

    bits: tuple[int, ...]
    bases: tuple[str, ...]
    attacker_bases: tuple[str, ...]

    def __post_init__(self) -> None:
        length = len(self.bits)
        _check_length(length)
        if len(self.bases) != length or len(self.attacker_bases) != length:
            raise ValueError("bits, bases and attacker bases must be the same length")
        if set(self.bits) - {0, 1}:
            raise ValueError(f"bits must be 0 or 1, got {self.bits}")
        if set(self.bases + self.attacker_bases) - set(BASES):
            raise ValueError(f"bases must be Z or X, got {self.bases}, {self.attacker_bases}")

    @property
    def length(self) -> int:
        return len(self.bits)

    @property
    def bank_angles(self) -> list[float]:
        return [BANK_ANGLES[pair] for pair in zip(self.bits, self.bases)]

    @property
    def attacker_angles(self) -> list[float]:
        return [ATTACKER_ANGLES[basis] for basis in self.attacker_bases]


def _coin(rng: random.Random) -> int:
    # Only Random.random() promises the same stream across Python versions.
    return int(rng.random() < 0.5)


def random_tickets(length: int, count: int, rng: random.Random) -> list[Ticket]:
    """Draw tickets one after another, so a shorter draw is a prefix of a longer one."""
    _check_length(length)

    def draw() -> Ticket:
        bits = tuple(_coin(rng) for _ in range(length))
        bases = tuple(BASES[_coin(rng)] for _ in range(length))
        attacker_bases = tuple(BASES[_coin(rng)] for _ in range(length))
        return Ticket(bits, bases, attacker_bases)

    return [draw() for _ in range(count)]


def forgery_template(length: int) -> QuantumCircuit:
    _check_length(length)
    chip = QuantumRegister(length, "chip")
    attacker = ClassicalRegister(length, "attacker")
    cashier = ClassicalRegister(length, "cashier")
    circuit = QuantumCircuit(chip, attacker, cashier, name=f"wiesner_{length}")
    qubits = range(length)
    for q in qubits:
        circuit.ry(BANK_PARAMETERS[q], q)
    circuit.barrier()
    for q in qubits:
        circuit.ry(-ATTACKER_PARAMETERS[q], q)
    circuit.measure(chip, attacker)
    for q in qubits:
        circuit.ry(ATTACKER_PARAMETERS[q], q)
    circuit.barrier()
    for q in qubits:
        circuit.ry(-BANK_PARAMETERS[q], q)
    circuit.measure(chip, cashier)
    return circuit


def forgery_binds(tickets: Sequence[Ticket]) -> dict[Parameter, list[float]]:
    """Parameter values for a template, one value per ticket."""
    lengths = {ticket.length for ticket in tickets}
    if len(lengths) != 1:
        raise ValueError(f"tickets must share one length, got {sorted(lengths)}")
    length = lengths.pop()
    binds = {}
    for q in range(length):
        binds[BANK_PARAMETERS[q]] = [ticket.bank_angles[q] for ticket in tickets]
        binds[ATTACKER_PARAMETERS[q]] = [ticket.attacker_angles[q] for ticket in tickets]
    return binds


def forgery_circuit(ticket: Ticket) -> QuantumCircuit:
    binds = {param: values[0] for param, values in forgery_binds([ticket]).items()}
    return forgery_template(ticket.length).assign_parameters(binds)


def compile_forgery(
    length: int,
    backend: BackendV2,
    layout: Sequence[int] | None = None,
    seed: int | None = None,
) -> QuantumCircuit:
    """Transpile the template. A chip of length n uses the first n qubits of layout."""
    template = forgery_template(length)
    if layout is not None:
        if len(layout) < length:
            raise ValueError(f"layout has {len(layout)} qubits, need {length}")
        layout = list(layout[:length])
    return transpile(template, backend, initial_layout=layout, seed_transpiler=seed)


def split_outcome(outcome: str, length: int) -> tuple[str, str]:
    """Split a counts key into (attacker bits, cashier bits)."""
    parts = outcome.split(" ")
    if len(parts) != 2 or any(
        len(part) != length or set(part) - {"0", "1"} for part in parts
    ):
        raise ValueError(f"outcome must be two {length}-bit registers, got {outcome!r}")
    cashier, attacker = parts
    return attacker, cashier


def passed(outcome: str, length: int) -> bool:
    return split_outcome(outcome, length)[1] == "0" * length


def _verifies(state: int, attacker_angle: float, bank_angle: float) -> float:
    """Probability that the qubit re-made from a measured state reads 0 at the cashier."""
    remade = Statevector.from_int(state, 2).evolve(RYGate(attacker_angle))
    return float(remade.evolve(RYGate(-bank_angle)).probabilities()[0])


def exact_pass_per_qubit() -> float:
    """One qubit's pass probability, averaged over every bank state and attacker basis."""
    cases = list(product((0, 1), BASES, BASES))
    total = 0.0
    for bit, basis, attacker_basis in cases:
        bank = BANK_ANGLES[(bit, basis)]
        attacker = ATTACKER_ANGLES[attacker_basis]
        made = Statevector.from_int(0, 2).evolve(RYGate(bank))
        outcomes = made.evolve(RYGate(-attacker)).probabilities()
        total += sum(
            float(probability) * _verifies(m, attacker, bank)
            for m, probability in enumerate(outcomes)
        )
    return total / len(cases)


def run_forgery(
    length: int,
    shots: int,
    backend: BackendV2 | None = None,
    seed: int | None = None,
    layout: Sequence[int] | None = None,
) -> int:
    """Forge one fresh random ticket per shot. Returns the number that pass."""
    _check_length(length)
    if not isinstance(shots, int) or shots < 1:
        raise ValueError(f"shots must be a positive integer, got {shots!r}")
    backend = backend or AerSimulator()
    tickets = random_tickets(length, shots, random.Random(seed))
    compiled = compile_forgery(length, backend, layout=layout, seed=seed)
    result = backend.run(
        compiled, parameter_binds=[forgery_binds(tickets)], shots=1, seed_simulator=seed
    ).result()
    return sum(
        n
        for i in range(shots)
        for outcome, n in result.get_counts(i).items()
        if passed(outcome, length)
    )
