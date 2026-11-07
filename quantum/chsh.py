"""The CHSH game: the bet behind the Impossible Tables.

The dealer hands the player a question bit x and the partner a question bit y.
They answer a and b without talking, and win when a XOR b equals x AND y.

Both share a Bell pair and measure in the X-Z plane, at Bloch angles alpha and
beta from Z, which correlates their answers by cos(alpha - beta). The player's
dial turns their own measurement basis, so a single control sweeps the win rate
averaged over the question pairs from 50% (dial 0 or 1) through the classical
limit (dial 0.25 or 0.75) to the quantum limit (dial 0.5). Only at dial 0.5 do
all four pairs win equally often, so the dealer must deal them uniformly.

Classical register order: bit 0 is the player, bit 1 is the partner, so an
outcome string reads "ba".
"""

import math
from collections.abc import Iterator, Mapping
from fractions import Fraction
from itertools import product

from qiskit import QuantumCircuit, transpile
from qiskit.providers import BackendV2
from qiskit_aer import AerSimulator

QUESTION_PAIRS: tuple[tuple[int, int], ...] = ((0, 0), (0, 1), (1, 0), (1, 1))
OPTIMAL_DIAL = 0.5

# Maps a question bit to the answer it gets from one player's fixed plan.
Strategy = tuple[int, int]
Outcomes = Mapping[str, int | float]


def is_win(x: int, y: int, a: int, b: int) -> bool:
    return (a ^ b) == (x & y)


def split_outcome(outcome: str) -> tuple[int, int]:
    """Split an outcome string into (player answer a, partner answer b)."""
    if len(outcome) != 2 or set(outcome) - {"0", "1"}:
        raise ValueError(f"outcome must be two bits, got {outcome!r}")
    return int(outcome[1]), int(outcome[0])


def _check_questions(x: int, y: int) -> None:
    if not all(isinstance(q, int) and q in (0, 1) for q in (x, y)):
        raise ValueError(f"question bits must be 0 or 1, got ({x}, {y})")


def classical_strategies() -> Iterator[tuple[Strategy, Strategy]]:
    """Every deterministic pair of plans. Shared randomness only mixes these."""
    plans = list(product((0, 1), repeat=2))
    return product(plans, plans)


def classical_win_rate(player: Strategy, partner: Strategy) -> Fraction:
    wins = sum(is_win(x, y, player[x], partner[y]) for x, y in QUESTION_PAIRS)
    return Fraction(wins, len(QUESTION_PAIRS))


def best_classical_win_rate() -> Fraction:
    return max(classical_win_rate(a, b) for a, b in classical_strategies())


def measurement_angles(dial: float, x: int, y: int) -> tuple[float, float]:
    """Bloch angles (player, partner) for a dial position and question pair."""
    if not 0 <= dial <= 1:
        raise ValueError(f"dial must be between 0 and 1, got {dial}")
    _check_questions(x, y)
    offset = (dial - OPTIMAL_DIAL) * math.pi
    player = (0.0, math.pi / 2)[x] + offset
    partner = (math.pi / 4, -math.pi / 4)[y]
    return player, partner


def chsh_circuit(dial: float, x: int, y: int) -> QuantumCircuit:
    player, partner = measurement_angles(dial, x, y)
    circuit = QuantumCircuit(2, 2, name=f"chsh_dial{dial:g}_x{x}_y{y}")
    circuit.h(0)
    circuit.cx(0, 1)
    circuit.ry(-player, 0)
    circuit.ry(-partner, 1)
    circuit.measure([0, 1], [0, 1])
    return circuit


def chsh_circuits(dial: float) -> dict[tuple[int, int], QuantumCircuit]:
    return {(x, y): chsh_circuit(dial, x, y) for x, y in QUESTION_PAIRS}


def pair_win_rate(outcomes: Outcomes, x: int, y: int) -> float:
    """Share of one question pair's outcomes that win. Takes counts or probabilities."""
    _check_questions(x, y)
    answers = {key: split_outcome(key) for key in outcomes}
    total = sum(outcomes.values())
    if not total:
        raise ValueError(f"no shots for question pair ({x}, {y})")
    wins = sum(n for key, n in outcomes.items() if is_win(x, y, *answers[key]))
    return wins / total


def win_rate(outcomes_by_pair: Mapping[tuple[int, int], Outcomes]) -> float:
    """Win rate with the dealer's four question pairs equally likely."""
    missing = set(QUESTION_PAIRS) - set(outcomes_by_pair)
    if missing:
        raise ValueError(f"missing question pair(s): {sorted(missing)}")
    rates = [pair_win_rate(outcomes_by_pair[pair], *pair) for pair in QUESTION_PAIRS]
    return sum(rates) / len(rates)


def run_chsh(
    dial: float,
    shots: int,
    backend: BackendV2 | None = None,
    seed: int | None = None,
) -> dict[tuple[int, int], dict[str, int]]:
    """Sample all four question pairs on a simulator backend. Returns counts per pair."""
    if not isinstance(shots, int) or shots < 1:
        raise ValueError(f"shots must be a positive integer, got {shots!r}")
    backend = backend or AerSimulator()
    circuits = chsh_circuits(dial)
    compiled = transpile(list(circuits.values()), backend, seed_transpiler=seed)
    result = backend.run(compiled, shots=shots, seed_simulator=seed).result()
    return {pair: result.get_counts(i) for i, pair in enumerate(circuits)}
