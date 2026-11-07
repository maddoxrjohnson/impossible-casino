import math
from fractions import Fraction

import pytest
from qiskit.quantum_info import Statevector
from qiskit_aer import AerSimulator
from qiskit_aer.noise import NoiseModel, depolarizing_error
from qiskit_ibm_runtime.fake_provider import FakeKingston

from quantum.chsh import (
    compile_chsh,
    QUESTION_PAIRS,
    best_classical_win_rate,
    chsh_circuit,
    chsh_circuits,
    classical_strategies,
    classical_win_rate,
    is_win,
    measurement_angles,
    pair_win_rate,
    run_chsh,
    split_outcome,
    win_rate,
)

QUANTUM_LIMIT = math.cos(math.pi / 8) ** 2


def exact_probabilities(dial):
    """Noise-free outcome probabilities per question pair, from the statevector."""
    return {
        pair: Statevector.from_instruction(
            circuit.remove_final_measurements(inplace=False)
        ).probabilities_dict()
        for pair, circuit in chsh_circuits(dial).items()
    }


def expected_pair_rates(dial):
    delta = (dial - 0.5) * math.pi
    return {
        (0, 0): (1 + math.cos(delta - math.pi / 4)) / 2,
        (0, 1): (1 + math.cos(delta + math.pi / 4)) / 2,
        (1, 0): (1 + math.cos(delta + math.pi / 4)) / 2,
        (1, 1): (1 - math.cos(delta + 3 * math.pi / 4)) / 2,
    }


def shot_noise_tolerance(rate, shots_per_pair, sigmas=4):
    return sigmas * math.sqrt(rate * (1 - rate) / (4 * shots_per_pair))


# Classical limit


def test_there_are_sixteen_deterministic_strategies():
    assert len(set(classical_strategies())) == 16


def test_brute_force_classical_best_is_exactly_three_quarters():
    assert best_classical_win_rate() == Fraction(3, 4)


def test_always_answering_zero_wins_three_of_four_pairs():
    assert classical_win_rate((0, 0), (0, 0)) == Fraction(3, 4)


def test_no_deterministic_strategy_wins_every_pair():
    rates = [classical_win_rate(a, b) for a, b in classical_strategies()]
    assert set(rates) == {Fraction(1, 4), Fraction(3, 4)}


# Game rule


@pytest.mark.parametrize(
    "x, y, a, b, expected",
    [
        (0, 0, 0, 0, True),
        (0, 0, 1, 1, True),
        (0, 0, 0, 1, False),
        (0, 1, 1, 0, False),
        (1, 0, 0, 0, True),
        (1, 1, 0, 0, False),
        (1, 1, 1, 1, False),
        (1, 1, 0, 1, True),
        (1, 1, 1, 0, True),
    ],
)
def test_win_means_xor_of_answers_equals_and_of_questions(x, y, a, b, expected):
    assert is_win(x, y, a, b) is expected


# Circuits, checked exactly


def test_every_question_pair_gets_a_two_qubit_measured_circuit():
    circuits = chsh_circuits(0.5)
    assert set(circuits) == set(QUESTION_PAIRS) == {(0, 0), (0, 1), (1, 0), (1, 1)}
    for circuit in circuits.values():
        assert circuit.num_qubits == 2
        assert circuit.count_ops()["measure"] == 2
        assert circuit.count_ops()["cx"] == 1


def test_ideal_best_is_exactly_the_quantum_limit():
    assert win_rate(exact_probabilities(0.5)) == pytest.approx(QUANTUM_LIMIT, abs=1e-12)


@pytest.mark.parametrize("dial", [0.25, 0.75])
def test_quarter_turns_sit_on_the_classical_limit(dial):
    assert win_rate(exact_probabilities(dial)) == pytest.approx(0.75, abs=1e-12)


@pytest.mark.parametrize("dial", [0.0, 1.0])
def test_dial_ends_fall_to_a_coin_flip(dial):
    assert win_rate(exact_probabilities(dial)) == pytest.approx(0.5, abs=1e-12)


def test_no_dial_position_beats_the_optimum():
    rates = {dial / 64: win_rate(exact_probabilities(dial / 64)) for dial in range(65)}
    assert max(rates, key=rates.get) == 0.5
    assert max(rates.values()) == pytest.approx(QUANTUM_LIMIT, abs=1e-12)


@pytest.mark.parametrize("dial", [0.0, 0.14, 0.3, 0.5, 0.8, 1.0])
def test_each_pair_wins_with_the_expected_probability(dial):
    probabilities = exact_probabilities(dial)
    for (x, y), chance in expected_pair_rates(dial).items():
        assert pair_win_rate(probabilities[(x, y)], x, y) == pytest.approx(chance, abs=1e-12)


@pytest.mark.parametrize("step", range(33))
def test_win_rate_follows_the_game_curve_across_the_dial(step):
    dial = step / 32
    curve = 0.5 + (math.sqrt(2) / 4) * math.cos((dial - 0.5) * math.pi)
    assert win_rate(exact_probabilities(dial)) == pytest.approx(curve, abs=1e-12)


@pytest.mark.parametrize("pair", QUESTION_PAIRS)
def test_player_owns_qubit_and_bit_zero_and_partner_owns_one(pair):
    circuit = chsh_circuits(0.3)[pair]
    player, partner = measurement_angles(0.3, *pair)
    rotations = {
        circuit.find_bit(item.qubits[0]).index: item.operation.params[0]
        for item in circuit.data
        if item.operation.name == "ry"
    }
    assert rotations == pytest.approx({0: -player, 1: -partner})
    measured = {
        circuit.find_bit(item.qubits[0]).index: circuit.find_bit(item.clbits[0]).index
        for item in circuit.data
        if item.operation.name == "measure"
    }
    assert measured == {0: 0, 1: 1}


# Sampling


def test_sampled_best_matches_the_limit_within_shot_noise():
    shots = 20_000
    rate = win_rate(run_chsh(0.5, shots=shots, seed=11))
    assert rate == pytest.approx(QUANTUM_LIMIT, abs=shot_noise_tolerance(QUANTUM_LIMIT, shots))
    assert rate > 0.75


@pytest.mark.parametrize("dial, seed", [(0.0, 21), (0.14, 22), (0.3, 23), (0.8, 24)])
def test_sampled_pairs_match_their_own_rates_away_from_the_peak(dial, seed):
    shots = 20_000
    counts = run_chsh(dial, shots=shots, seed=seed)
    for (x, y), chance in expected_pair_rates(dial).items():
        tolerance = 4 * math.sqrt(chance * (1 - chance) / shots)
        assert pair_win_rate(counts[(x, y)], x, y) == pytest.approx(chance, abs=tolerance)


def test_sampling_returns_requested_shots_for_every_pair():
    counts = run_chsh(0.5, shots=128, seed=3)
    assert set(counts) == set(QUESTION_PAIRS)
    assert all(sum(pair_counts.values()) == 128 for pair_counts in counts.values())


def test_same_seed_gives_same_counts():
    assert run_chsh(0.3, shots=256, seed=5) == run_chsh(0.3, shots=256, seed=5)


def test_a_noisy_backend_pulls_the_rate_toward_a_coin_flip():
    noise = NoiseModel()
    noise.add_all_qubit_quantum_error(depolarizing_error(0.15, 2), ["cx"])
    shots = 20_000
    rate = win_rate(run_chsh(0.5, shots=shots, backend=AerSimulator(noise_model=noise), seed=7))
    assert 0.5 < rate < QUANTUM_LIMIT - shot_noise_tolerance(QUANTUM_LIMIT, shots)


# win_rate and input checks


def test_win_rate_weights_question_pairs_equally_whatever_their_shots():
    counts = {
        (0, 0): {"00": 1000},
        (0, 1): {"00": 1},
        (1, 0): {"01": 1},
        (1, 1): {"00": 1},
    }
    assert win_rate(counts) == pytest.approx(0.5)


def test_win_rate_rejects_a_missing_pair():
    with pytest.raises(ValueError, match="question pair"):
        win_rate({(0, 0): {"00": 1}})


def test_win_rate_rejects_a_pair_with_no_shots():
    counts = {pair: {"00": 1} for pair in QUESTION_PAIRS}
    counts[(1, 0)] = {}
    with pytest.raises(ValueError, match="no shots"):
        win_rate(counts)


@pytest.mark.parametrize("outcome", ["000", "0", "23", "ab"])
def test_win_rate_rejects_outcomes_that_are_not_two_bits(outcome):
    counts = {pair: {"00": 1} for pair in QUESTION_PAIRS}
    counts[(0, 1)] = {outcome: 1}
    with pytest.raises(ValueError, match="two bits"):
        win_rate(counts)


def test_outcome_strings_read_partner_then_player():
    assert split_outcome("01") == (1, 0)
    assert split_outcome("10") == (0, 1)


@pytest.mark.parametrize("dial", [-0.01, 1.01, math.nan])
def test_dial_must_be_between_zero_and_one(dial):
    with pytest.raises(ValueError, match="dial"):
        chsh_circuit(dial, 0, 0)


@pytest.mark.parametrize("x, y", [(2, 0), (0, -1), (1.0, 0)])
def test_questions_must_be_bits(x, y):
    with pytest.raises(ValueError, match="question"):
        chsh_circuit(0.5, x, y)
    with pytest.raises(ValueError, match="question"):
        pair_win_rate({"00": 1}, x, y)


@pytest.mark.parametrize("shots", [0, -1, 1.5, None])
def test_shots_must_be_a_positive_integer(shots):
    with pytest.raises(ValueError, match="shots"):
        run_chsh(0.5, shots=shots)


def test_pinned_layout_puts_every_circuit_on_the_named_qubits():
    backend = FakeKingston()
    compiled = compile_chsh(0.5, backend, layout=(147, 148), seed=3)
    assert len(compiled) == len(QUESTION_PAIRS)
    for circuit in compiled:
        used = {
            circuit.find_bit(qubit).index
            for instruction in circuit.data
            for qubit in instruction.qubits
        }
        assert used == {147, 148}


def test_pinned_layout_keeps_the_player_on_the_first_named_qubit():
    compiled = compile_chsh(0.5, FakeKingston(), layout=(148, 147), seed=3)
    for circuit in compiled:
        measured = {
            circuit.find_bit(instruction.clbits[0]).index: circuit.find_bit(instruction.qubits[0]).index
            for instruction in circuit.data
            if instruction.operation.name == "measure"
        }
        assert measured == {0: 148, 1: 147}
