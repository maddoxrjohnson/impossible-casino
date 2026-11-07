import itertools
import math
import random

import pytest
from qiskit import QuantumCircuit
from qiskit.quantum_info import Statevector

from quantum.roulette import (
    DECK,
    POCKETS,
    QUBITS,
    TURNS,
    WHEEL_DECIMALS,
    best_chance,
    classical_wheel_limit,
    draft_circuit,
    exact_wheel,
    legal_drafts,
    legal_prefixes,
    limit_pockets,
    player_best,
    player_greedy,
    player_random,
    reachable,
    solve,
    turn_of,
)

FAIR = 1 / POCKETS
SWEEP = 0
SPIN = 1
TIE_12 = (2, 3)
TIE_34 = (4, 5)
TIES = (*TIE_12, *TIE_34)


def twin(card):
    return {2: 3, 3: 2, 4: 5, 5: 4}[card]


@pytest.fixture(scope="module")
def solution():
    return solve()


def lit(wheel):
    return [pocket for pocket, chance in enumerate(wheel) if chance > 0]


# Deck and turns


def test_the_deck_is_one_sweep_one_spin_and_two_pairs_of_twin_ties():
    assert [card.id for card in DECK] == [
        "sweep",
        "spin-0",
        "tie-12-a",
        "tie-12-b",
        "tie-34-a",
        "tie-34-b",
    ]
    assert DECK[SWEEP].gate == "h"
    assert DECK[SWEEP].targets == tuple((q,) for q in range(QUBITS))
    assert (DECK[SPIN].gate, DECK[SPIN].targets) == ("h", ((0,),))
    for card, pair in ((2, (1, 2)), (3, (1, 2)), (4, (3, 4)), (5, (3, 4))):
        assert (DECK[card].gate, DECK[card].targets) == ("cz", (pair,))
        assert DECK[card].name == DECK[twin(card)].name


def test_the_house_plays_first_and_the_player_last():
    assert TURNS == ("house", "player", "house", "player")


def test_a_wheel_is_five_qubits_and_32_pockets():
    assert (QUBITS, POCKETS) == (5, 32)


# Legal drafts


def test_every_legal_draft_uses_four_different_cards():
    drafts = legal_drafts()
    assert len(drafts) == 6 * 5 * 4 * 3 == 360
    assert len(set(drafts)) == len(drafts)
    assert set(drafts) == set(itertools.permutations(range(len(DECK)), len(TURNS)))


def test_legal_prefixes_cover_every_stage_of_every_draft():
    prefixes = legal_prefixes()
    assert len(prefixes) == 1 + 6 + 30 + 120 + 360
    assert prefixes[0] == ()
    assert set(legal_drafts()) <= set(prefixes)
    for prefix in prefixes:
        assert len(set(prefix)) == len(prefix) <= len(TURNS)


def test_turn_of_names_who_plays_next():
    assert turn_of(()) == "house"
    assert turn_of((2,)) == "player"
    assert turn_of((2, 3)) == "house"
    assert turn_of((2, 3, 4)) == "player"
    assert turn_of((2, 3, 4, 0)) == "spin"


@pytest.mark.parametrize("bad", [(0, 0), (6,), (-1,), (0, 1, 2, 3, 4), ("0",)])
def test_an_illegal_draft_is_refused(bad):
    with pytest.raises(ValueError):
        draft_circuit(bad)


# Circuits and wheels


def test_the_circuit_opens_with_a_fair_spin_and_plays_each_card_in_its_own_block():
    circuit = draft_circuit((4, 3, 2, 0))
    ops = [(i.operation.name, [circuit.find_bit(q).index for q in i.qubits]) for i in circuit.data]
    expected = [("h", [q]) for q in range(5)] + [("barrier", list(range(5)))]
    expected += [("cz", [3, 4]), ("barrier", list(range(5)))]
    expected += [("cz", [1, 2]), ("barrier", list(range(5)))]
    expected += [("cz", [1, 2]), ("barrier", list(range(5)))]
    expected += [("h", [q]) for q in range(5)] + [("barrier", list(range(5)))]
    expected += [("measure", [q]) for q in range(5)]
    assert ops == expected
    assert [r.name for r in circuit.cregs] == ["pocket"]


def test_the_fair_wheel_gives_every_pocket_one_in_32():
    wheel = exact_wheel(())
    assert wheel == (FAIR,) * POCKETS
    assert best_chance(wheel) == FAIR


def test_wheels_are_qiskit_statevector_probabilities():
    rng = random.Random(5)
    for prefix in rng.sample(legal_prefixes(), 12):
        circuit = draft_circuit(prefix, measure=False)
        probabilities = Statevector.from_instruction(circuit).probabilities()
        assert exact_wheel(prefix) == tuple(round(float(p), WHEEL_DECIMALS) for p in probabilities)
        assert math.isclose(sum(exact_wheel(prefix)), 1, abs_tol=1e-9)


def test_pocket_n_has_qubit_k_as_bit_k():
    """A Spin on q0 settles that qubit to 0, which lights the even pockets."""
    assert lit(exact_wheel((SPIN,))) == list(range(0, 32, 2))


def test_a_sweep_on_the_fair_wheel_lands_on_pocket_0_every_time():
    assert lit(exact_wheel((SWEEP,))) == [0]


def test_a_tie_moves_nothing_and_its_twin_unties_it():
    assert exact_wheel((2,)) == exact_wheel(())
    assert exact_wheel((2, 3, SWEEP)) == exact_wheel((SWEEP,))


def test_a_sweep_cannot_settle_tied_qubits():
    wheel = exact_wheel((4, SWEEP))
    assert lit(wheel) == [0, 8, 16, 24]
    assert set(wheel[p] for p in lit(wheel)) == {0.25}


def test_a_spin_on_one_tied_qubit_leaves_the_pair_always_agreeing():
    """q1 and q2 tied, then q1 spun: only pockets where bits 1 and 2 agree stay lit."""
    assert len(lit(exact_wheel((2,)))) == 32
    spin_q1 = QuantumCircuit(5)
    spin_q1.h(1)
    tied = draft_circuit((2,), measure=False)
    probabilities = Statevector.from_instruction(tied.compose(spin_q1)).probabilities()
    for pocket, chance in enumerate(probabilities):
        agree = ((pocket >> 1) & 1) == ((pocket >> 2) & 1)
        assert (chance > 1e-12) == agree


# The house's play


def brute_value(prefix, wheels):
    """Minimax written out again: the player picks the best pocket after the draft."""
    if len(prefix) == len(TURNS):
        return max(wheels[prefix])
    values = [
        brute_value(prefix + (card,), wheels)
        for card in range(len(DECK))
        if card not in prefix
    ]
    return max(values) if TURNS[len(prefix)] == "player" else min(values)


def test_the_house_limit_is_one_in_four(solution):
    assert solution.value[()] == 0.25
    assert brute_value((), solution.wheels) == 0.25


def test_every_node_value_matches_an_independent_minimax(solution):
    for prefix in legal_prefixes():
        assert solution.value[prefix] == brute_value(prefix, solution.wheels)


def test_house_cards_are_exactly_the_cards_that_hold_the_limit(solution):
    for prefix, cards in solution.house_cards.items():
        assert turn_of(prefix) == "house"
        options = {c: solution.value[prefix + (c,)] for c in range(len(DECK)) if c not in prefix}
        best = min(options.values())
        assert set(cards) == {c for c, v in options.items() if v == best}
        assert list(cards) == sorted(cards)


def test_the_house_opens_with_a_tie(solution):
    assert solution.house_cards[()] == TIES


def test_untie_first_and_sweep_last_reaches_the_limit(solution):
    for opening in TIES:
        reply = twin(opening)
        assert solution.value[(opening, reply)] == 0.25
        for answer in solution.house_cards[(opening, reply)]:
            assert answer in TIES and answer not in (opening, reply)
            assert best_chance(solution.wheels[(opening, reply, answer, SWEEP)]) == 0.25


def test_sweeping_at_once_is_the_trap(solution):
    for opening in TIES:
        assert solution.value[(opening, SWEEP)] == 0.125
        assert solution.house_cards[(opening, SWEEP)] == (SPIN,)


def test_every_other_first_reply_is_worse_than_untying(solution):
    for opening in TIES:
        for reply in range(len(DECK)):
            if reply not in (opening, twin(opening)):
                assert solution.value[(opening, reply)] < 0.25


# Reachable drafts


def test_reachable_holds_every_player_card_and_only_listed_house_cards(solution):
    nodes = reachable(solution)
    assert nodes[0] == ()
    assert len(nodes) == len(set(nodes))
    node_set = set(nodes)
    for node in nodes:
        if node:
            parent, card = node[:-1], node[-1]
            assert parent in node_set
            if turn_of(parent) == "house":
                assert card in solution.house_cards[parent]
        if turn_of(node) == "player":
            for card in range(len(DECK)):
                if card not in node:
                    assert node + (card,) in node_set


def test_reachable_drafts_are_few_enough_to_ship(solution):
    finals = [n for n in reachable(solution) if turn_of(n) == "spin"]
    assert len(finals) == 108
    assert len(reachable(solution)) == 169


# Every player strategy


def test_no_player_strategy_beats_the_house_limit(solution):
    best = player_best(solution, lambda draft: best_chance(solution.wheels[draft]))
    assert best == pytest.approx(0.25, abs=1e-12)


def plan_chance(solution, plan, pocket):
    """A plan's exact chance of hitting pocket, the house picking uniformly among its cards.

    turn_of refuses a draft that repeats a card, so an illegal plan fails here.
    """

    def walk(draft):
        turn = turn_of(draft)
        if turn == "spin":
            return solution.wheels[draft][pocket]
        if turn == "house":
            cards = solution.house_cards[draft]
            return sum(walk(draft + (card,)) for card in cards) / len(cards)
        return walk(draft + (plan(draft),))

    return walk(())


def untie_then_sweep(draft):
    return twin(draft[0]) if len(draft) == 1 else SWEEP


def sweep_at_once(draft):
    return SWEEP if len(draft) == 1 else next(card for card in TIES if card not in draft)


def test_untie_then_sweep_hits_pocket_0_one_time_in_four(solution):
    assert plan_chance(solution, untie_then_sweep, 0) == 0.25
    assert plan_chance(solution, untie_then_sweep, 1) == 0.0
    assert plan_chance(solution, untie_then_sweep, 0) * 380 / 100 == pytest.approx(0.95)


def test_sweeping_at_once_hits_pocket_0_one_time_in_eight(solution):
    assert plan_chance(solution, sweep_at_once, 0) == 0.125


def test_imperfect_play_does_much_worse(solution):
    chance = lambda draft: best_chance(solution.wheels[draft])  # noqa: E731
    assert player_greedy(solution) == pytest.approx(0.125, abs=1e-12)
    assert player_random(solution, chance) == pytest.approx(0.0791666667, abs=1e-9)


def test_player_best_follows_the_leaf_it_is_given(solution):
    assert player_best(solution, lambda draft: 1.0) == 1.0
    assert player_best(solution, lambda draft: float(draft[-1] == SWEEP)) == 1.0
    assert player_best(solution, lambda draft: float(draft[-1] == SPIN)) == 1.0
    assert player_best(solution, lambda draft: float(SWEEP in draft[:2])) == 1.0


# Limits and clearing


def test_a_classical_wheel_never_gathers():
    assert classical_wheel_limit() == pytest.approx(FAIR, abs=1e-12)


def test_limit_pockets_are_the_pockets_at_the_limit():
    wheel = exact_wheel((4, 5, 2, SWEEP))
    assert limit_pockets(wheel, 0.25) == [0, 2, 4, 6]
    assert limit_pockets(exact_wheel((2, SWEEP, SPIN, 3)), 0.25) == []


def test_the_clearing_line_is_reachable(solution):
    nodes = set(reachable(solution))
    line = (2, 3, 4, SWEEP)
    assert line in nodes
    assert limit_pockets(solution.wheels[line], solution.value[()]) == [0, 8, 16, 24]
