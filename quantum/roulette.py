"""The Roulette Wheel: gather a fair quantum wheel while the house keeps it fair.

The wheel is five qubits and 32 pockets. Pocket n is the outcome whose bit k is
qubit k. Every round the house first spins the wheel fair, H on every qubit, so
each pocket has a 1 in 32 chance: the wheel is a superposition of all 32.

Then four cards are drafted from one face-up deck of six, one at a time: house,
player, house, player. A drafted card goes straight onto the wheel and leaves
the deck. The deck:

    Sweep           H on all five qubits. On a fair wheel it un-spins every
                    qubit, and the ball lands on pocket 0 every time.
    Spin q0         H on qubit 0. Spins a settled qubit, or settles a spinning one.
    Tie q1-q2, x2   CZ on two qubits. Nothing moves on the wheel, but the pair
    Tie q3-q4, x2   is now entangled and a Sweep can't settle it. The twin card
                    unties it, because CZ twice does nothing.

After the draft the player sees the wheel, puts one straight-up chip on any
pocket, and the wheel spins. The player picks the pocket last, so the house
plays to keep the wheel's best pocket unlikely and the player plays to make it
likely.

Every legal draft (360) is solved exactly. Each wheel is a Qiskit statevector,
and minimax over the draft gives the most the player can force against a
perfect house: 1 in 4. The house opens with a Tie. Sweeping at once is the
trap: the wheel gathers to 4 pockets, then the house spins q0 and leaves 8. The
line that reaches the limit unties with the twin, lets the house tie the other
pair, and Sweeps last, which leaves only the tied pair spread over 4 pockets. A
player who always plays the card that gathers most right now gets 1 in 8, and
random play gets about 1 in 13.

The house can't be trivially beaten: it only plays cards that hold the player
to the most they can still force, chosen at random among those, and a
straight-up pays 280 on 100, priced at the 1 in 4 limit with a 5% edge. No
player strategy, even one that reads the exact wheel, gets back more than 95 per
100 staked. The player can't trivially win: the house plays twice, and after the
house's second card the player has one card left, which can't both untie a pair
and Sweep.

The room clears on a straight-up win on a pocket at the house limit, which
needs the best line and then a 1 in 4 spin. A classical wheel can't gather at
all: if every qubit were measured after the opening and after each card, no
draft would lift any pocket above 1 in 32.
"""

import functools
import itertools
from collections.abc import Callable, Sequence
from dataclasses import dataclass

import numpy as np
from qiskit import ClassicalRegister, QuantumCircuit, QuantumRegister
from qiskit.quantum_info import DensityMatrix, Kraus, Statevector, partial_trace

QUBITS = 5
POCKETS = 2**QUBITS
TURNS: tuple[str, ...] = ("house", "player", "house", "player")
SPIN_TURN = "spin"
# Clifford wheels have chances of 0 or a power of 1/2, which this rounds to exactly.
WHEEL_DECIMALS = 12
TOLERANCE = 1e-9

Draft = tuple[int, ...]


@dataclass(frozen=True)
class Card:
    """A gate card. gate is applied once to each tuple of qubits in targets."""

    id: str
    name: str
    gate: str
    targets: tuple[tuple[int, ...], ...]

    def apply(self, circuit: QuantumCircuit) -> None:
        for qubits in self.targets:
            getattr(circuit, self.gate)(*qubits)


DECK: tuple[Card, ...] = (
    Card("sweep", "Sweep", "h", tuple((q,) for q in range(QUBITS))),
    Card("spin-0", "Spin q0", "h", ((0,),)),
    Card("tie-12-a", "Tie q1-q2", "cz", ((1, 2),)),
    Card("tie-12-b", "Tie q1-q2", "cz", ((1, 2),)),
    Card("tie-34-a", "Tie q3-q4", "cz", ((3, 4),)),
    Card("tie-34-b", "Tie q3-q4", "cz", ((3, 4),)),
)


TIE_PAIRS: tuple[tuple[int, int], ...] = tuple(
    sorted({pair for card in DECK if card.gate == "cz" for pair in card.targets})
)


def _check_draft(draft: Sequence[int]) -> None:
    cards = list(draft)
    if len(cards) > len(TURNS):
        raise ValueError(f"a draft has at most {len(TURNS)} cards, got {len(cards)}")
    for card in cards:
        if not isinstance(card, int) or isinstance(card, bool) or not 0 <= card < len(DECK):
            raise ValueError(f"cards are deck indices 0 to {len(DECK) - 1}, got {card!r}")
    if len(set(cards)) != len(cards):
        raise ValueError(f"a card can be drafted once, got {cards}")


def turn_of(draft: Sequence[int]) -> str:
    """Who plays the next card, or "spin" once the draft is complete."""
    _check_draft(draft)
    return TURNS[len(draft)] if len(draft) < len(TURNS) else SPIN_TURN


def legal_drafts() -> list[Draft]:
    return list(itertools.permutations(range(len(DECK)), len(TURNS)))


def legal_prefixes() -> list[Draft]:
    """Every stage of every legal draft, shortest first, starting with the empty one."""
    return [
        prefix
        for length in range(len(TURNS) + 1)
        for prefix in itertools.permutations(range(len(DECK)), length)
    ]


def draft_circuit(draft: Sequence[int], measure: bool = True) -> QuantumCircuit:
    """The opening spin, then each card in its own barrier block, then the spin."""
    _check_draft(draft)
    wheel = QuantumRegister(QUBITS, "wheel")
    pocket = ClassicalRegister(QUBITS, "pocket")
    circuit = QuantumCircuit(wheel, pocket, name="roulette") if measure else QuantumCircuit(wheel)
    circuit.h(wheel)
    circuit.barrier()
    for card in draft:
        DECK[card].apply(circuit)
        circuit.barrier()
    if measure:
        circuit.measure(wheel, pocket)
    return circuit


def exact_wheel(draft: Sequence[int]) -> tuple[float, ...]:
    """Each pocket's chance after the draft so far, from a Qiskit statevector."""
    probabilities = Statevector.from_instruction(draft_circuit(draft, measure=False)).probabilities()
    return tuple(round(float(p), WHEEL_DECIMALS) for p in probabilities)


def tied_pairs(draft: Sequence[int]) -> tuple[tuple[int, int], ...]:
    """The Tie pairs entangled after the draft so far, from a Qiskit statevector.

    A pair is tied when its first qubit, traced out alone, is a mixed state.
    """
    state = Statevector.from_instruction(draft_circuit(draft, measure=False))
    tied = []
    for pair in TIE_PAIRS:
        reduced = partial_trace(state, [q for q in range(QUBITS) if q != pair[0]])
        if reduced.purity().real < 1 - TOLERANCE:
            tied.append(pair)
    return tuple(tied)


def best_chance(wheel: Sequence[float]) -> float:
    """The chance of a straight-up bet on the wheel's most likely pocket."""
    return max(wheel)


def limit_pockets(wheel: Sequence[float], limit: float) -> list[int]:
    return [pocket for pocket, chance in enumerate(wheel) if chance >= limit - TOLERANCE]


@dataclass(frozen=True)
class Solution:
    """Every legal stage's wheel and minimax value, and the house's cards at its turns."""

    wheels: dict[Draft, tuple[float, ...]]
    value: dict[Draft, float]
    house_cards: dict[Draft, tuple[int, ...]]


def _remaining(draft: Draft) -> list[int]:
    return [card for card in range(len(DECK)) if card not in draft]


@functools.cache
def solve() -> Solution:
    """Minimax over every legal draft. The player bets on the best pocket after it."""
    prefixes = legal_prefixes()
    wheels = {prefix: exact_wheel(prefix) for prefix in prefixes}
    value: dict[Draft, float] = {}
    house_cards: dict[Draft, tuple[int, ...]] = {}
    for prefix in reversed(prefixes):
        turn = turn_of(prefix)
        if turn == SPIN_TURN:
            value[prefix] = best_chance(wheels[prefix])
            continue
        options = {card: value[prefix + (card,)] for card in _remaining(prefix)}
        if turn == "player":
            value[prefix] = max(options.values())
        else:
            value[prefix] = min(options.values())
            house_cards[prefix] = tuple(
                card for card, v in options.items() if v <= value[prefix] + TOLERANCE
            )
    return Solution(wheels, value, house_cards)


def reachable(solution: Solution) -> list[Draft]:
    """Every stage the game can reach: any player card, and only the house's listed cards."""
    found: list[Draft] = []

    def walk(draft: Draft) -> None:
        found.append(draft)
        turn = turn_of(draft)
        if turn == SPIN_TURN:
            return
        cards = solution.house_cards[draft] if turn == "house" else _remaining(draft)
        for card in cards:
            walk(draft + (card,))

    walk(())
    return found


def _play(
    solution: Solution,
    leaf: Callable[[Draft], float],
    player: Callable[[Draft, list[float]], float],
) -> float:
    """Expected leaf value with the house picking uniformly among its listed cards."""

    def walk(draft: Draft) -> float:
        turn = turn_of(draft)
        if turn == SPIN_TURN:
            return leaf(draft)
        if turn == "house":
            cards = solution.house_cards[draft]
            return sum(walk(draft + (card,)) for card in cards) / len(cards)
        return player(draft, [walk(draft + (card,)) for card in _remaining(draft)])

    return walk(())


def player_best(solution: Solution, leaf: Callable[[Draft], float]) -> float:
    """The most any player strategy can expect of leaf against the house's play."""
    return _play(solution, leaf, lambda _draft, values: max(values))


def player_random(solution: Solution, leaf: Callable[[Draft], float]) -> float:
    return _play(solution, leaf, lambda _draft, values: sum(values) / len(values))


def player_greedy(solution: Solution) -> float:
    """A player who always plays the card that makes the best pocket likeliest right now."""

    def greedy(draft: Draft, values: list[float]) -> float:
        now = [best_chance(solution.wheels[draft + (card,)]) for card in _remaining(draft)]
        top = max(now)
        picks = [v for v, chance in zip(values, now) if chance >= top - TOLERANCE]
        return sum(picks) / len(picks)

    return _play(solution, lambda draft: best_chance(solution.wheels[draft]), greedy)


def _card_circuit(card: int) -> QuantumCircuit:
    circuit = QuantumCircuit(QUBITS)
    DECK[card].apply(circuit)
    return circuit


def _measured(state: DensityMatrix) -> DensityMatrix:
    """Measure every qubit and forget the outcome, which removes all superposition."""
    measure = Kraus([np.diag([1.0, 0.0]), np.diag([0.0, 1.0])])
    for qubit in range(QUBITS):
        state = state.evolve(measure, qargs=[qubit])
    return state


def classical_wheel_limit() -> float:
    """The best pocket over every legal draft when every qubit is measured between cards."""
    opening = QuantumCircuit(QUBITS)
    opening.h(range(QUBITS))
    states = {(): _measured(DensityMatrix.from_label("0" * QUBITS).evolve(opening))}
    for prefix in legal_prefixes()[1:]:
        states[prefix] = _measured(states[prefix[:-1]].evolve(_card_circuit(prefix[-1])))
    return max(
        round(float(max(states[draft].probabilities())), WHEEL_DECIMALS)
        for draft in legal_drafts()
    )
