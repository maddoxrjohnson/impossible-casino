import gzip
import json
import math
import subprocess
import sys
from datetime import date
from pathlib import Path

import pytest
import qiskit
import qiskit_aer
import qiskit_ibm_runtime
from qiskit import QuantumCircuit, qasm2
from qiskit.quantum_info import Statevector, entropy, partial_trace
from qiskit_aer import AerSimulator
from qiskit_ibm_runtime.fake_provider import FakeKingston

import quantum.export_roulette
from quantum.export import simulator_provenance
from quantum.export_roulette import (
    CZ_PER_TIE,
    EXPORT_PATH,
    IDEAL_BASE_SEED,
    MEASURES_PER_QUBIT,
    NOISY_BASE_SEED,
    SHOTS,
    SX_PER_QUBIT,
    CHIP_JOBS,
    best_return,
    build_export,
    check_edge,
    clear_chance,
    compile_draft,
    draft_seed,
    layout_cost,
    limits,
    logical_circuits,
    main,
    noise_model_label,
    noise_simulator,
    nodes_and_wheels,
    payouts,
    quietest_layout,
    refresh_chip_runs,
    run_edge,
    sample_point,
    spin_drafts,
    spin_return,
)
from quantum.roulette import (
    DECK,
    POCKETS,
    TURNS,
    best_chance,
    draft_circuit,
    exact_wheel,
    limit_pockets,
    reachable,
    solve,
    tied_pairs,
    turn_of,
)

SMALL_SHOTS = 64
TODAY = date(2026, 11, 7)
CLEARING_LINE = [2, 3, 4, 0]
CURRENT_VERSIONS = {
    "qiskitVersion": qiskit.__version__,
    "aerVersion": qiskit_aer.__version__,
    "runtimeVersion": qiskit_ibm_runtime.__version__,
}
TIE_PAIRS = [(1, 2), (3, 4)]


def run_named(export, run_id):
    return next(r for r in export["runs"] if r["id"] == run_id)


def point_for(run, draft):
    return next(p for p in run["points"] if p["draft"] == list(draft))


@pytest.fixture(scope="module")
def solution():
    return solve()


@pytest.fixture(scope="module")
def device():
    return FakeKingston()


@pytest.fixture(scope="module")
def small_export():
    return build_export(shots=SMALL_SHOTS, today=TODAY)


@pytest.fixture(scope="module")
def committed():
    return json.loads(Path(EXPORT_PATH).read_text())


@pytest.fixture(params=["small_export", "committed"])
def export(request):
    return request.getfixturevalue(request.param)


# Shape and labels


def test_export_has_every_top_level_block(export):
    assert set(export) == {
        "schemaVersion",
        "experiment",
        "pocketOrder",
        "opening",
        "turns",
        "houseRule",
        "bet",
        "stakeRule",
        "spin",
        "playRun",
        "deck",
        "limits",
        "payouts",
        "clear",
        "wheels",
        "wheelsMethod",
        "nodes",
        "logicalCircuits",
        "runs",
        "edge",
    }
    assert export["schemaVersion"] == 1
    assert export["experiment"] == "roulette"
    assert export["turns"] == list(TURNS)
    assert "bit k is qubit k" in export["pocketOrder"]
    assert "H on every qubit" in export["opening"]
    assert "uniformly" in export["houseRule"]
    assert "after the draft" in export["bet"]
    assert "fixed before" in export["stakeRule"]


def test_spins_come_from_the_named_runs_counts(export):
    assert "runs[].points[].counts" in export["spin"]
    assert export["playRun"] == "ibm-noise-model"
    assert export["playRun"] in [r["id"] for r in export["runs"]]


def test_deck_lists_each_card_with_its_gates(export):
    assert [c["id"] for c in export["deck"]] == [card.id for card in DECK]
    for entry, card in zip(export["deck"], DECK):
        assert set(entry) == {"id", "name", "ops"}
        assert entry["name"] == card.name
        assert entry["ops"] == [{"gate": card.gate, "qubits": list(t)} for t in card.targets]


def test_each_run_labels_its_true_source(export, device):
    assert [r["id"] for r in export["runs"]] == ["ideal", "ibm-noise-model"]
    ideal = run_named(export, "ideal")["provenance"]
    noisy = run_named(export, "ibm-noise-model")["provenance"]
    for provenance in (ideal, noisy):
        assert provenance["source"] == "pre-run-simulator"
        assert provenance["jobId"] is None
        assert CURRENT_VERSIONS.items() <= provenance.items()
        assert date.fromisoformat(provenance["date"])
    assert ideal["backend"] == "aer_simulator"
    assert ideal["noiseModel"] is None and ideal["qubits"] is None
    assert noisy["backend"] == "aer_simulator_from(fake_kingston)"
    assert noisy["noiseModel"]["name"] == "fake_kingston"
    assert noisy["noiseModel"]["calibrated"].startswith("2026-04-15")
    assert "best-case" in noisy["noiseModel"]["qubitSelection"]
    assert "logical qubit k sits on entry k" in noisy["noiseModel"]["qubitSelection"]
    scope = noisy["noiseModel"]["scope"]
    assert "chosen qubits only" in scope
    left_out = scope.split("left out:")[1]
    for missing in ("idle", "crosstalk", "leakage"):
        assert missing in left_out
    assert noisy["qubits"] == quietest_layout(device)


def test_provenance_records_the_requested_shots_and_date(small_export, device):
    ideal, noisy = small_export["runs"]
    assert ideal["provenance"] == simulator_provenance("aer_simulator", SMALL_SHOTS, TODAY)
    assert noisy["provenance"] == simulator_provenance(
        "aer_simulator_from(fake_kingston)",
        SMALL_SHOTS,
        TODAY,
        noise_model=noise_model_label(device),
        qubits=quietest_layout(device),
    )


def test_committed_runs_use_the_full_shot_count(committed):
    for run in committed["runs"]:
        if run["provenance"]["source"] == "ibm-chip":
            continue
        assert run["provenance"]["shots"] == SHOTS


# Nodes and wheels


def test_nodes_are_exactly_the_reachable_tree(export, solution):
    assert [n["draft"] for n in export["nodes"]] == [list(d) for d in reachable(solution)]


def test_each_node_carries_its_turn_wheel_and_value(export, solution):
    wheels = export["wheels"]
    assert len({tuple(w) for w in wheels}) == len(wheels), "wheels are stored once each"
    for node in export["nodes"]:
        draft = tuple(node["draft"])
        turn = turn_of(draft)
        keys = {"draft", "turn", "wheel", "value", "tiedPairs"}
        keys |= {"houseCards"} if turn == "house" else set()
        keys |= {"limitPockets"} if turn == "spin" else set()
        assert set(node) == keys
        assert node["turn"] == turn
        assert wheels[node["wheel"]] == list(solution.wheels[draft])
        assert node["value"] == solution.value[draft]
        assert node["tiedPairs"] == [list(pair) for pair in tied_pairs(draft)]
        if turn == "house":
            assert node["houseCards"] == list(solution.house_cards[draft])
        if turn == "spin":
            limit = export["limits"]["houseLimit"]["value"]
            assert node["limitPockets"] == limit_pockets(solution.wheels[draft], limit)


@pytest.mark.parametrize("draft", [(), (2,), (2, 3), (2, 3, 4), (2, 3, 4, 0), (4, 0, 1, 2)])
def test_stored_wheels_replay_from_a_fresh_statevector(committed, draft):
    node = next(n for n in committed["nodes"] if n["draft"] == list(draft))
    assert committed["wheels"][node["wheel"]] == list(exact_wheel(draft))


def test_every_nodes_tied_pairs_match_its_statevector(committed):
    for node in committed["nodes"]:
        state = Statevector.from_instruction(draft_circuit(node["draft"], measure=False))
        expected = [
            list(pair)
            for pair in TIE_PAIRS
            if entropy(partial_trace(state, [q for q in range(5) if q != pair[0]])) > 1e-6
        ]
        assert node["tiedPairs"] == expected, node["draft"]


@pytest.mark.parametrize(
    "draft, pairs",
    [([2, 0, 1, 4], [[1, 2]]), ([3, 0, 1, 5], [[1, 2]]), ([4, 0, 1, 2], [[3, 4]]), ([2, 3, 4, 0], [[3, 4]])],
)
def test_a_tie_after_the_sweep_is_not_exported_as_tied(committed, draft, pairs):
    node = next(n for n in committed["nodes"] if n["draft"] == draft)
    assert node["tiedPairs"] == pairs


def test_wheels_are_probability_vectors(export):
    for wheel in export["wheels"]:
        assert len(wheel) == POCKETS
        assert min(wheel) >= 0
        assert math.isclose(sum(wheel), 1, abs_tol=1e-9)


def test_the_clearing_line_is_marked_at_the_limit(export):
    node = next(n for n in export["nodes"] if n["draft"] == CLEARING_LINE)
    assert node["limitPockets"] == [0, 8, 16, 24]
    assert export["clear"]["chance"] == export["limits"]["houseLimit"]["value"] == 0.25
    assert "limit" in export["clear"]["rule"]
    assert export["clear"]["basis"].startswith("chance is the exact wheel's")


# Limits


def test_limits_hold_the_walls_and_the_house_limit(export):
    lim = export["limits"]
    assert lim["fairWheel"]["value"] == 1 / 32
    assert lim["classicalWheel"]["value"] == pytest.approx(1 / 32, abs=1e-12)
    assert lim["houseLimit"]["value"] == 0.25
    assert "statevector" in lim["fairWheel"]["method"].lower()
    assert "measur" in lim["classicalWheel"]["method"]
    assert "minimax" in lim["houseLimit"]["method"]
    assert lim["legalDrafts"] == 360
    assert lim["reachableDrafts"] == 108
    styles = {s["style"]: s for s in lim["playStyles"]}
    assert set(styles) == {"perfect", "greedy", "random"}
    assert styles["perfect"]["value"] == 0.25
    assert styles["greedy"]["value"] == pytest.approx(0.125, abs=1e-12)
    assert styles["random"]["value"] < styles["greedy"]["value"]
    for style in styles.values():
        assert style["rule"]


def test_committed_shared_blocks_match_the_current_code(committed, solution):
    assert committed["limits"] == limits(solution)
    assert committed["payouts"] == payouts(committed["limits"]["houseLimit"]["value"])
    assert committed["logicalCircuits"] == logical_circuits(solution)
    nodes, wheels = nodes_and_wheels(solution)
    assert committed["nodes"] == nodes
    assert committed["wheels"] == wheels


# Payouts and the house edge


def test_payouts_pay_the_expected_table(export):
    pay = export["payouts"]
    assert pay["status"] == "accepted"
    assert pay["stake"] == 100
    assert pay["rule"]
    assert "houseEdge use the exact wheel" in pay["basis"]
    assert pay["table"] == [
        {
            "bet": "straight",
            "pockets": 1,
            "pays": 280,
            "fairPays": 300.0,
            "breakEven": 100 / 380,
            "houseEdge": pytest.approx(0.05, abs=1e-12),
        }
    ]


def test_payouts_use_the_limit_they_are_given():
    row = payouts(0.5)["table"][0]
    assert row["pays"] == 90
    assert row["houseEdge"] == pytest.approx(1 - 1.9 * 0.5, abs=1e-12)


def test_payout_is_below_fair_and_keeps_a_house_edge(export):
    row = export["payouts"]["table"][0]
    assert row["pays"] < row["fairPays"]
    assert 0.04 < row["houseEdge"] < 0.08


def test_edge_entries_carry_each_runs_own_numbers(export):
    assert [e["run"] for e in export["edge"]] == ["ideal", "ibm-noise-model"]
    for entry in export["edge"]:
        assert set(entry) == {"run", "method", "bestReturn", "worstSpin", "clearChance"}
        assert set(entry["worstSpin"]) == {"draft", "return"}
        for field in ("bestReturn", "worstSpin", "clearChance"):
            assert field in entry["method"]


def test_committed_edge_holds_against_every_player_strategy_in_every_run(committed, solution):
    pays = committed["payouts"]["table"][0]["pays"]
    stake = committed["payouts"]["stake"]
    for entry, run in zip(committed["edge"], committed["runs"]):
        recomputed = best_return(solution, run, pays, stake)
        assert entry["bestReturn"] == recomputed
        assert recomputed < 1
    check_edge(committed)


def test_every_finished_draft_keeps_the_edge_in_every_run(committed):
    """Even a player who could set the stake after seeing the draft never gets an edge."""
    pays = committed["payouts"]["table"][0]["pays"]
    stake = committed["payouts"]["stake"]
    for entry, run in zip(committed["edge"], committed["runs"]):
        returns = {tuple(p["draft"]): spin_return(p, pays, stake) for p in run["points"]}
        for point in run["points"]:
            assert max(point["counts"]) / point["shots"] * (stake + pays) / stake < 1
        worst = entry["worstSpin"]
        assert worst["return"] == max(returns.values())
        assert returns[tuple(worst["draft"])] == worst["return"]


def test_committed_clear_chance_is_each_runs_own(committed, solution):
    for entry, run in zip(committed["edge"], committed["runs"]):
        assert entry["clearChance"] == clear_chance(solution, run)
    ideal, noisy = (e["clearChance"] for e in committed["edge"])
    assert ideal == pytest.approx(0.25, abs=5 * math.sqrt(0.25 * 0.75 / SHOTS))
    assert 0.2 < noisy < 0.26


def test_clear_chance_counts_only_limit_pockets(solution):
    """Every shot on pocket 1, which is never at the limit, means no spin can clear."""
    fake = {
        "points": [{"draft": list(d), "counts": [0, 10] + [0] * 30} for d in spin_drafts(solution)]
    }
    assert clear_chance(solution, fake) == 0.0


def test_best_return_picks_the_best_pocket_of_each_spin(solution):
    """A made-up run that puts every shot on pocket 5 lets any line win every spin."""
    finals = spin_drafts(solution)
    fake = {"points": [{"draft": list(d), "counts": [0] * 5 + [10] + [0] * 26} for d in finals]}
    assert best_return(solution, fake, 280, 100) == pytest.approx(3.8)


def test_check_edge_refuses_an_export_the_player_can_beat(committed):
    beaten = {**committed, "edge": [{"run": "ideal", "bestReturn": 1.0}]}
    with pytest.raises(ValueError, match="edge"):
        check_edge(beaten)


def test_check_edge_refuses_one_finished_draft_the_player_can_beat(committed):
    ideal, noisy = committed["runs"]
    point = ideal["points"][0]
    third = point["shots"] // 3
    spike = {**point, "counts": [third] + [0] * 30 + [point["shots"] - third]}
    assert spin_return(spike, 280, 100) == pytest.approx(3.8 * 2 / 3, abs=1e-3)
    runs = [{**ideal, "points": [spike, *ideal["points"][1:]]}, noisy]
    with pytest.raises(ValueError, match="edge fails on run ideal at draft"):
        check_edge({**committed, "runs": runs})


def test_main_refuses_to_write_an_export_the_player_can_beat(monkeypatch, tmp_path, committed):
    beaten = {**committed, "edge": [{"run": "ideal", "bestReturn": 1.01}]}
    target = tmp_path / "roulette.json"
    monkeypatch.setattr(quantum.export_roulette, "build_export", lambda: beaten)
    monkeypatch.setattr(quantum.export_roulette, "EXPORT_PATH", target)
    with pytest.raises(ValueError):
        main([])
    assert not target.exists()


# Runs


def test_runs_cover_every_reachable_spin_once(export, solution):
    finals = [list(d) for d in spin_drafts(solution)]
    for run in export["runs"]:
        assert set(run) == {"id", "provenance", "points"}
        assert [p["draft"] for p in run["points"]] == finals


def test_points_are_consistent(export):
    for run in export["runs"]:
        shots = run["provenance"]["shots"]
        on_chip = run["provenance"]["source"] == "ibm-chip"
        for point in run["points"]:
            assert set(point) == {"draft", "seed", "shots", "counts"}
            assert point["shots"] <= shots if on_chip else point["shots"] == shots
            assert len(point["counts"]) == POCKETS
            assert all(isinstance(n, int) and n >= 0 for n in point["counts"])
            assert sum(point["counts"]) == point["shots"]


def test_seeds_follow_the_spaced_scheme(export):
    for run_id, base in (("ideal", IDEAL_BASE_SEED), ("ibm-noise-model", NOISY_BASE_SEED)):
        seeds = [p["seed"] for p in run_named(export, run_id)["points"]]
        assert seeds == [draft_seed(base, i) for i in range(len(seeds))]
    every = [p["seed"] for r in export["runs"] for p in r["points"] if p["seed"] is not None]
    assert len(set(every)) == len(every)
    assert max(every) < 2**31


def test_committed_ideal_counts_only_land_on_lit_pockets(committed, solution):
    for point in run_named(committed, "ideal")["points"]:
        wheel = solution.wheels[tuple(point["draft"])]
        for pocket, n in enumerate(point["counts"]):
            if wheel[pocket] == 0:
                assert n == 0


def test_committed_ideal_counts_match_the_wheel_within_shot_noise(committed, solution):
    for point in run_named(committed, "ideal")["points"]:
        wheel = solution.wheels[tuple(point["draft"])]
        for pocket, chance in enumerate(wheel):
            rate = point["counts"][pocket] / point["shots"]
            assert rate == pytest.approx(chance, abs=5 * math.sqrt(chance * (1 - chance) / SHOTS) + 1e-12)


def test_committed_noisy_counts_keep_the_clearing_line_gathered(committed):
    """Noise leaks shots out of the four lit pockets, but most stay."""
    point = point_for(run_named(committed, "ibm-noise-model"), CLEARING_LINE)
    on_limit = sum(point["counts"][p] for p in (0, 8, 16, 24)) / point["shots"]
    assert 0.6 < on_limit < 1


@pytest.mark.parametrize("draft", [CLEARING_LINE, [2, 0, 1, 3], [5, 2, 0, 1]])
def test_committed_ideal_points_replay_exactly(committed, draft):
    stored = point_for(run_named(committed, "ideal"), draft)
    assert sample_point(tuple(draft), stored["shots"], stored["seed"], AerSimulator()) == stored


@pytest.fixture(scope="module")
def committed_noise(committed, device):
    qubits = run_named(committed, "ibm-noise-model")["provenance"]["qubits"]
    assert qubits == quietest_layout(device)
    return noise_simulator(device, qubits), qubits


@pytest.mark.parametrize("draft", [CLEARING_LINE, [2, 0, 1, 3], [5, 2, 0, 1]])
def test_committed_noisy_points_replay_exactly(committed, committed_noise, draft):
    stored = point_for(run_named(committed, "ibm-noise-model"), draft)
    backend, qubits = committed_noise
    assert sample_point(tuple(draft), stored["shots"], stored["seed"], backend, qubits) == stored


def test_replay_notices_a_changed_layout(committed, committed_noise):
    stored = point_for(run_named(committed, "ibm-noise-model"), CLEARING_LINE)
    backend, qubits = committed_noise
    moved = [qubits[0], qubits[2], qubits[1], *qubits[3:]]
    args = (tuple(CLEARING_LINE), stored["shots"], stored["seed"], backend)
    assert sample_point(*args, moved)["counts"] != stored["counts"]


# Circuits


def test_shipped_circuits_are_rebuilt_exactly_from_their_drafts(export, solution):
    entries = export["logicalCircuits"]
    assert [e["draft"] for e in entries] == [list(d) for d in spin_drafts(solution)]
    for entry in entries:
        assert set(entry) == {"draft", "qasm"}
        assert entry["qasm"] == qasm2.dumps(draft_circuit(tuple(entry["draft"])))


def test_shipped_qasm_loads_with_the_pocket_register(committed):
    for entry in committed["logicalCircuits"][:5]:
        circuit = QuantumCircuit.from_qasm_str(entry["qasm"])
        assert circuit.num_qubits == 5
        assert [r.name for r in circuit.cregs] == ["pocket"]
        assert circuit.count_ops()["measure"] == 5


# Qubit choice and noise


def test_quietest_layout_puts_each_tie_on_a_coupler(device):
    layout = quietest_layout(device)
    assert len(set(layout)) == 5
    for a, b in TIE_PAIRS:
        assert (layout[a], layout[b]) in device.target["cz"]


def test_no_single_swap_for_an_unused_qubit_lowers_the_cost(device):
    """A swap that breaks a tie's coupler or uses a faulty qubit costs infinity."""
    layout = quietest_layout(device)
    best = layout_cost(device, layout)
    usable = [q for q in range(device.num_qubits) if q not in layout]
    for slot in range(5):
        for q in usable:
            trial = [*layout]
            trial[slot] = q
            assert layout_cost(device, trial) >= best


def test_cost_weights_match_the_clearing_line(device):
    compiled = compile_draft(tuple(CLEARING_LINE), device, layout=quietest_layout(device), seed=1)
    ops = compiled.count_ops()
    assert ops["measure"] == MEASURES_PER_QUBIT * 5
    assert ops["sx"] == SX_PER_QUBIT * 5
    assert ops["cz"] <= CZ_PER_TIE * len(TIE_PAIRS)


def test_noisy_run_compiles_onto_the_qubits_it_names(device):
    layout = quietest_layout(device)
    compiled = compile_draft(tuple(CLEARING_LINE), device, layout=layout, seed=1)
    used = {
        compiled.find_bit(q).index
        for instruction in compiled.data
        if instruction.operation.name != "barrier"
        for q in instruction.qubits
    }
    assert used == set(layout)
    measured = {
        compiled.find_bit(i.clbits[0]).index: compiled.find_bit(i.qubits[0]).index
        for i in compiled.data
        if i.operation.name == "measure"
    }
    assert measured == dict(enumerate(layout))


def test_restricted_noise_gives_the_same_counts_as_the_full_model(device, committed_noise):
    restricted, layout = committed_noise
    compiled = compile_draft(tuple(CLEARING_LINE), device, layout=layout, seed=3)
    full = AerSimulator.from_backend(device, method="density_matrix")

    def counts(backend):
        return backend.run(compiled, shots=512, seed_simulator=3).result().get_counts()

    assert counts(restricted) == counts(full)


def test_restricted_noise_only_covers_the_chosen_qubits(committed_noise):
    restricted, layout = committed_noise
    assert set(restricted.options.noise_model.noise_qubits) == set(layout)


# Size and isolation


def test_committed_export_is_compact():
    raw = Path(EXPORT_PATH).read_bytes()
    assert len(raw) < 300_000
    assert len(gzip.compress(raw)) < 60_000


def test_the_exporter_does_not_load_the_chip_module():
    """The live service may import this file, and must stay clear of chip submission."""
    code = "import sys, quantum.export_roulette; sys.exit('quantum.chip' in sys.modules)"
    root = Path(__file__).resolve().parents[2]
    assert subprocess.run([sys.executable, "-c", code], cwd=root, check=False).returncode == 0


def test_spin_drafts_are_the_reachable_finals(solution):
    finals = spin_drafts(solution)
    assert finals == [d for d in reachable(solution) if turn_of(d) == "spin"]
    assert all(best_chance(solution.wheels[d]) <= 0.25 for d in finals)


# Chip runs


def chip_run(source_run, shots=None):
    """A stand-in chip run reusing a simulator run's counts, labelled the way a collected run is."""
    return {
        "id": "ibm-chip",
        "provenance": {
            **source_run["provenance"],
            "source": "ibm-chip",
            "backend": "ibm_kingston",
            "noiseModel": None,
            "jobId": "job123",
        },
        "points": [{**p, "seed": None} for p in source_run["points"]],
    }


@pytest.fixture
def from_committed(monkeypatch, committed):
    """build_export with the simulators replaced by the committed runs, so it is fast."""
    ideal, noisy = committed["runs"]
    monkeypatch.setattr(quantum.export_roulette, "ideal_run", lambda *_: ideal)
    monkeypatch.setattr(quantum.export_roulette, "noisy_run", lambda *_: noisy)


def test_no_chip_jobs_are_listed_yet():
    assert CHIP_JOBS == ()
    assert quantum.export_roulette.chip_runs() == []


def test_with_no_chip_jobs_the_runs_and_edge_are_unchanged(from_committed, committed):
    export = build_export(today=TODAY)
    for block in ("runs", "edge"):
        assert json.dumps(export[block], indent=1) == json.dumps(committed[block], indent=1)


def test_build_export_folds_a_chip_run_in_and_checks_its_edge(monkeypatch, from_committed, committed, solution):
    chip = chip_run(committed["runs"][1])
    monkeypatch.setattr(quantum.export_roulette, "chip_runs", lambda: [chip])
    export = build_export(today=TODAY)
    assert [r["id"] for r in export["runs"]] == ["ideal", "ibm-noise-model", "ibm-chip"]
    assert [e["run"] for e in export["edge"]] == ["ideal", "ibm-noise-model", "ibm-chip"]
    pays, stake = export["payouts"]["table"][0]["pays"], export["payouts"]["stake"]
    assert export["edge"][2] == run_edge(solution, chip, pays, stake)
    assert export["playRun"] == "ibm-noise-model"
    check_edge(export)


def test_a_chip_run_with_shots_per_draft_folds_in_with_each_points_own_shots(
    monkeypatch, from_committed, committed, solution
):
    """Drafts below the limit keep a sixteenth of the shots, as a mixed chip job would."""
    chip = chip_run(committed["runs"][1])
    limit = solution.value[()]
    for i, point in enumerate(chip["points"]):
        if max(solution.wheels[tuple(point["draft"])]) < limit - 1e-9:
            counts = [n // 16 for n in point["counts"]]
            chip["points"][i] = {**point, "counts": counts, "shots": sum(counts)}
    assert len({p["shots"] for p in chip["points"]}) > 1
    monkeypatch.setattr(quantum.export_roulette, "chip_runs", lambda: [chip])
    export = build_export(today=TODAY)
    test_points_are_consistent(export)
    pays, stake = export["payouts"]["table"][0]["pays"], export["payouts"]["stake"]
    assert export["edge"][2] == run_edge(solution, chip, pays, stake)
    check_edge(export)


def test_check_edge_refuses_a_chip_run_with_one_beaten_draft(monkeypatch, from_committed, committed):
    chip = chip_run(committed["runs"][1])
    point = chip["points"][0]
    third = point["shots"] // 3
    chip["points"][0] = {**point, "counts": [third] + [0] * 30 + [point["shots"] - third]}
    monkeypatch.setattr(quantum.export_roulette, "chip_runs", lambda: [chip])
    with pytest.raises(ValueError, match="edge fails on run ibm-chip"):
        check_edge(build_export(today=TODAY))


def test_chip_only_refresh_adds_the_chip_run_and_keeps_the_simulators(monkeypatch, tmp_path, committed, solution):
    target = tmp_path / "roulette.json"
    target.write_text(Path(EXPORT_PATH).read_text())
    chip = chip_run(committed["runs"][1])
    monkeypatch.setattr(quantum.export_roulette, "chip_runs", lambda: [chip])
    monkeypatch.setattr(quantum.export_roulette, "EXPORT_PATH", target)
    main(["--chip-only"])
    refreshed = json.loads(target.read_text())
    assert refreshed["runs"][:2] == committed["runs"]
    assert refreshed["edge"][:2] == committed["edge"]
    assert refreshed["runs"][2] == chip
    pays, stake = committed["payouts"]["table"][0]["pays"], committed["payouts"]["stake"]
    assert refreshed["edge"][2] == run_edge(solution, chip, pays, stake)
    assert {k: v for k, v in refreshed.items() if k not in ("runs", "edge")} == {
        k: v for k, v in committed.items() if k not in ("runs", "edge")
    }

    monkeypatch.setattr(quantum.export_roulette, "chip_runs", lambda: [])
    refresh_chip_runs(target)
    assert target.read_text() == Path(EXPORT_PATH).read_text()


def test_chip_only_refresh_refuses_to_write_a_beaten_chip_run(monkeypatch, tmp_path, committed):
    target = tmp_path / "roulette.json"
    original = Path(EXPORT_PATH).read_text()
    target.write_text(original)
    chip = chip_run(committed["runs"][1])
    chip["points"][0] = {**chip["points"][0], "counts": [0] * 31 + [chip["points"][0]["shots"]]}
    monkeypatch.setattr(quantum.export_roulette, "chip_runs", lambda: [chip])
    with pytest.raises(ValueError, match="ibm-chip"):
        refresh_chip_runs(target)
    assert target.read_text() == original
