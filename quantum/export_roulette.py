"""Export the drafted wheels for the Roulette Wheel.

Run from the repo root: .venv/bin/python -m quantum.export_roulette
Add --chip-only to rewrite just the chip runs and leave the simulators as written.

The game only reaches the stages in roulette.reachable, because the house only
plays its listed cards, so only those ship. Each stage's wheel is an exact
Qiskit statevector, for the draft display and the house's play. Its tiedPairs
are the Tie pairs whose first qubit is mixed in that statevector, so entangled
with its partner. Each complete draft also has sampled spins from two runs: an
ideal Aer simulator, and Aer with a noise model built from IBM's stored
fake_kingston calibration, pinned to that snapshot's quietest qubits for the
circuit. Both are simulations, and the provenance says so. Chip runs come from
the records in CHIP_JOBS, and none is listed yet.

The noisy simulator keeps only the errors on the chosen qubits, which gives the
same counts as the full model at a fraction of the cost.

Spins sample from runs[].points[].counts, and the game plays the noise-model
run. The edge block holds each run's own numbers: the most any player strategy
gets back per chip, with the player even picking the pocket that got the most
shots; the single finished draft that returns most per chip, which bounds a
player who could change the stake after seeing the draft (the game fixes the
stake before the draft); and the chance of clearing. The exporter refuses to
write a file where any of these returns reaches 1.
"""

import argparse
import gzip
import itertools
import json
import math
from collections.abc import Sequence
from datetime import date
from pathlib import Path
from typing import Any

from qiskit import QuantumCircuit, qasm2, transpile
from qiskit.providers import BackendV2
from qiskit_aer import AerSimulator
from qiskit_aer.noise import NoiseModel
from qiskit_aer.noise.device import basic_device_gate_errors, basic_device_readout_errors
from qiskit_ibm_runtime.fake_provider import FakeKingston

from quantum.export import (
    CHIP_SOURCE,
    DATA_DIR,
    SCHEMA_VERSION,
    collected_runs,
    simulator_provenance,
    write_export,
)
from quantum.roulette import (
    DECK,
    POCKETS,
    QUBITS,
    SPIN_TURN,
    TIE_PAIRS,
    TURNS,
    Draft,
    Solution,
    best_chance,
    classical_wheel_limit,
    draft_circuit,
    legal_drafts,
    limit_pockets,
    player_best,
    player_greedy,
    player_random,
    reachable,
    solve,
    tied_pairs,
    turn_of,
)

EXPORT_PATH = DATA_DIR / f"roulette.v{SCHEMA_VERSION}.json"
SHOTS = 8192
CHIP_JOBS: tuple[str, ...] = ()

POCKET_ORDER = "pocket n is the integer whose bit k is qubit k, so counts[n] and wheel[n] are pocket n"
OPENING = "before any card the house spins the wheel fair: H on every qubit"
HOUSE_RULE = (
    "the house only plays a card that holds the player to the most they can still force; "
    "where several do, the game picks one of the listed houseCards uniformly"
)
BET = (
    "after the draft the player sees the wheel and puts one straight-up chip on any pocket; "
    "the spin lands on one pocket"
)
STAKE_RULE = (
    "the stake is fixed before the house plays its first card and can't change during the draft; "
    "the game enforces this"
)
PLAY_RUN = "ibm-noise-model"
SPIN_RULE = (
    "each spin samples one shot from runs[].points[].counts for the finished draft; "
    "the game plays the run named in playRun"
)
CLEAR_RULE = (
    "win a straight-up bet on a pocket at the house limit, one of the spin's limitPockets: "
    "it needs the best line, then a lucky spin"
)
CLEAR_BASIS = (
    "chance is the exact wheel's house limit; edge[].clearChance is each run's own figure"
)
WHEELS_METHOD = "Qiskit Statevector probabilities of the draft so far, rounded to 12 decimal places"

FREE_QUBITS: tuple[int, ...] = tuple(
    q for q in range(QUBITS) if all(q not in pair for pair in TIE_PAIRS)
)
# The clearing line measures each qubit once, compiles two H on each to one sx
# each, and a tied pair can take both of its twin CZ cards.
MEASURES_PER_QUBIT = 1
SX_PER_QUBIT = 2
CZ_PER_TIE = 2
QUBIT_SELECTION = (
    "best-case pick: each tied pair on a coupler, choosing the five qubits and two couplers "
    "with the lowest readout, sx and CZ error in the snapshot, weighted by the clearing line's use; "
    "qubits is a layout, so logical qubit k sits on entry k"
)
NOISE_SCOPE = (
    "gate and readout errors on the chosen qubits only, as fake_kingston's full model has them; "
    "left out: decay while a qubit waits idle for the others, crosstalk, and leakage"
)

PAYOUT_STATUS = "accepted"
STAKE = 100
HOUSE_RETURN = 0.95
PAYS_STEP = 5
PAYOUT_RULE = (
    "fair total return at the house limit times 0.95, "
    "with net profit on a 100 stake rounded down to a multiple of 5"
)
PAYOUT_BASIS = (
    "fairPays, breakEven and houseEdge use the exact wheel's house limit; "
    "edge[] has each run's own returns"
)
EDGE_METHOD = (
    "bestReturn: the most any player strategy gets back per chip against the house's play, "
    "picking the pocket with the most shots in this run. worstSpin: the finished draft whose "
    "best pocket returns most per chip, which bounds a player who could change the stake after "
    "seeing the draft. clearChance: the best chance per spin of clearing, with the pocket one of "
    "the limitPockets, averaged over them"
)

# One circuit per Aer job, so a seed is used once; the spacing only keeps runs apart.
SEED_SPACING = 1_000
IDEAL_BASE_SEED = 5_000_000
NOISY_BASE_SEED = 6_000_000


def draft_seed(base: int, index: int) -> int:
    return base + index * SEED_SPACING


def spin_drafts(solution: Solution) -> list[Draft]:
    """The complete drafts the game can reach, in reachable order."""
    return [draft for draft in reachable(solution) if turn_of(draft) == SPIN_TURN]


# Qubit choice and noise


def _qubit_cost(backend: BackendV2, qubit: int) -> float:
    read = backend.target["measure"].get((qubit,))
    gate = backend.target["sx"].get((qubit,))
    if read is None or gate is None or read.error is None or gate.error is None:
        return math.inf
    return MEASURES_PER_QUBIT * read.error + SX_PER_QUBIT * gate.error


def _coupler_cost(backend: BackendV2, a: int, b: int) -> float:
    """CZ is symmetric, so a coupler listed in either direction will do."""
    cz = backend.target["cz"].get((a, b)) or backend.target["cz"].get((b, a))
    if cz is None or cz.error is None:
        return math.inf
    return CZ_PER_TIE * cz.error


def layout_cost(backend: BackendV2, layout: Sequence[int]) -> float:
    """Logical qubit k sits on layout[k]. A broken tie or a faulty qubit costs infinity."""
    if len(set(layout)) != QUBITS:
        return math.inf
    return sum(_qubit_cost(backend, q) for q in layout) + sum(
        _coupler_cost(backend, layout[a], layout[b]) for a, b in TIE_PAIRS
    )


def quietest_layout(backend: BackendV2) -> list[int]:
    """The cheapest layout that puts each tied pair on a coupler."""
    if len(TIE_PAIRS) != 2 or len({q for pair in TIE_PAIRS for q in pair}) != 4:
        raise ValueError(f"the layout search expects two disjoint tied pairs, got {TIE_PAIRS}")
    by_cost = sorted(
        (q for q in range(backend.num_qubits) if _qubit_cost(backend, q) < math.inf),
        key=lambda q: (_qubit_cost(backend, q), q),
    )
    couplers = sorted(
        (a, b)
        for a, b in {tuple(sorted(pair)) for pair in backend.target["cz"]}
        if _coupler_cost(backend, a, b) + _qubit_cost(backend, a) + _qubit_cost(backend, b) < math.inf
    )
    best: tuple[float, list[int]] | None = None
    for first, second in ((x, y) for x in couplers for y in couplers if not set(x) & set(y)):
        taken = {*first, *second}
        free = list(itertools.islice((q for q in by_cost if q not in taken), len(FREE_QUBITS)))
        layout = [0] * QUBITS
        for (a, b), (pa, pb) in zip(TIE_PAIRS, (first, second)):
            layout[a], layout[b] = pa, pb
        for logical, physical in zip(FREE_QUBITS, free):
            layout[logical] = physical
        candidate = (layout_cost(backend, layout), layout)
        if best is None or candidate < best:
            best = candidate
    if best is None:
        raise ValueError(f"{backend.name} has no two disjoint usable couplers")
    return best[1]


def noise_model_label(device: BackendV2) -> dict[str, str]:
    return {
        "name": device.name,
        "calibrated": device.properties().last_update_date.isoformat(),
        "qubitSelection": QUBIT_SELECTION,
        "scope": NOISE_SCOPE,
    }


def noise_simulator(device: BackendV2, qubits: Sequence[int]) -> AerSimulator:
    """A density-matrix simulator of device with errors on the given qubits only.

    Settings match NoiseModel.from_backend. Its delay relaxation is left out
    because compiled drafts have no delays.
    """
    chosen = set(qubits)
    target = device.target
    noise_model = NoiseModel(basis_gates=device.operation_names)
    for error_qubits, error in basic_device_readout_errors(target=target):
        if chosen.issuperset(error_qubits):
            noise_model.add_readout_error(error, error_qubits)
    for name, error_qubits, error in basic_device_gate_errors(target=target):
        if chosen.issuperset(error_qubits):
            noise_model.add_quantum_error(error, name, error_qubits)
    return AerSimulator.from_backend(device, noise_model=noise_model, method="density_matrix")


# Runs


def compile_draft(
    draft: Draft,
    backend: BackendV2,
    layout: Sequence[int] | None = None,
    seed: int | None = None,
) -> QuantumCircuit:
    return transpile(
        draft_circuit(draft),
        backend,
        initial_layout=None if layout is None else list(layout),
        seed_transpiler=seed,
    )


def sample_point(
    draft: Draft,
    shots: int,
    seed: int,
    backend: BackendV2,
    layout: Sequence[int] | None = None,
) -> dict[str, Any]:
    """Spin one draft. With no layout the ideal simulator runs the circuit as designed,
    since it takes every gate in it; with a layout the draft is compiled onto those qubits.
    """
    if layout is None:
        circuit = draft_circuit(draft)
    else:
        circuit = compile_draft(draft, backend, layout=layout, seed=seed)
    result = backend.run(circuit, shots=shots, seed_simulator=seed).result()
    counts = [0] * POCKETS
    for key, n in result.get_counts().items():
        counts[int(key, 2)] += n
    return {"draft": list(draft), "seed": seed, "shots": shots, "counts": counts}


def ideal_run(drafts: Sequence[Draft], shots: int, today: date) -> dict[str, Any]:
    backend = AerSimulator()
    return {
        "id": "ideal",
        "provenance": simulator_provenance(backend.name, shots, today),
        "points": [
            sample_point(draft, shots, draft_seed(IDEAL_BASE_SEED, i), backend)
            for i, draft in enumerate(drafts)
        ],
    }


def noisy_run(drafts: Sequence[Draft], shots: int, today: date) -> dict[str, Any]:
    device = FakeKingston()
    qubits = quietest_layout(device)
    backend = noise_simulator(device, qubits)
    return {
        "id": "ibm-noise-model",
        "provenance": simulator_provenance(
            backend.name, shots, today, noise_model=noise_model_label(device), qubits=qubits
        ),
        "points": [
            sample_point(draft, shots, draft_seed(NOISY_BASE_SEED, i), backend, qubits)
            for i, draft in enumerate(drafts)
        ],
    }


def chip_runs() -> list[dict[str, Any]]:
    return collected_runs("roulette", CHIP_JOBS)


# Shared blocks


def deck() -> list[dict[str, Any]]:
    return [
        {
            "id": card.id,
            "name": card.name,
            "ops": [{"gate": card.gate, "qubits": list(qubits)} for qubits in card.targets],
        }
        for card in DECK
    ]


def limits(solution: Solution) -> dict[str, Any]:
    def chance(draft: Draft) -> float:
        return best_chance(solution.wheels[draft])

    return {
        "fairWheel": {
            "value": best_chance(solution.wheels[()]),
            "method": "Qiskit statevector of the opening spin, before any card",
        },
        "classicalWheel": {
            "value": classical_wheel_limit(),
            "method": (
                "Qiskit DensityMatrix with every qubit measured after the opening and after "
                "each card, so no superposition carries between cards; best pocket over every legal draft"
            ),
        },
        "houseLimit": {
            "value": solution.value[()],
            "method": (
                "minimax over every legal draft, each wheel a Qiskit statevector: the house plays "
                "to keep the best pocket unlikely, the player to make it likely"
            ),
        },
        "playStyles": [
            {
                "style": "perfect",
                "value": player_best(solution, chance),
                "rule": "the best line against the house's play",
            },
            {
                "style": "greedy",
                "value": player_greedy(solution),
                "rule": "always plays the card that makes the best pocket likeliest right now",
            },
            {
                "style": "random",
                "value": player_random(solution, chance),
                "rule": "plays any card left, at random",
            },
        ],
        "legalDrafts": len(legal_drafts()),
        "reachableDrafts": len(spin_drafts(solution)),
    }


def payouts(limit: float) -> dict[str, Any]:
    """The straight-up price, set from the house limit. pays is net profit on the stake."""
    fair_total = STAKE / limit
    pays = math.floor((fair_total * HOUSE_RETURN - STAKE) / PAYS_STEP) * PAYS_STEP
    return {
        "status": PAYOUT_STATUS,
        "stake": STAKE,
        "rule": PAYOUT_RULE,
        "basis": PAYOUT_BASIS,
        "table": [
            {
                "bet": "straight",
                "pockets": 1,
                "pays": pays,
                "fairPays": fair_total - STAKE,
                "breakEven": STAKE / (STAKE + pays),
                "houseEdge": 1 - (STAKE + pays) / STAKE * limit,
            }
        ],
    }


def nodes_and_wheels(solution: Solution) -> tuple[list[dict[str, Any]], list[list[float]]]:
    """Every reachable stage, pointing into a table that holds each distinct wheel once."""
    wheels: list[list[float]] = []
    index: dict[tuple[float, ...], int] = {}
    nodes = []
    for draft in reachable(solution):
        wheel = solution.wheels[draft]
        if wheel not in index:
            index[wheel] = len(wheels)
            wheels.append(list(wheel))
        turn = turn_of(draft)
        node: dict[str, Any] = {
            "draft": list(draft),
            "turn": turn,
            "wheel": index[wheel],
            "value": solution.value[draft],
            "tiedPairs": [list(pair) for pair in tied_pairs(draft)],
        }
        if turn == "house":
            node["houseCards"] = list(solution.house_cards[draft])
        if turn == SPIN_TURN:
            node["limitPockets"] = limit_pockets(wheel, solution.value[()])
        nodes.append(node)
    return nodes, wheels


def logical_circuits(solution: Solution) -> list[dict[str, Any]]:
    """Each reachable draft's circuit as designed, before transpiling."""
    return [
        {"draft": list(draft), "qasm": qasm2.dumps(draft_circuit(draft))}
        for draft in spin_drafts(solution)
    ]


# The house edge


def best_return(solution: Solution, run: dict[str, Any], pays: int, stake: int) -> float:
    """The most any player strategy gets back per chip staked, against the house's play.

    The player picks the pocket with the most shots in this run, which is the
    best a player could do even knowing the run's counts.
    """
    counts = {tuple(point["draft"]): point["counts"] for point in run["points"]}

    def leaf(draft: Draft) -> float:
        shots = counts[draft]
        return max(shots) / sum(shots)

    return player_best(solution, leaf) * (stake + pays) / stake


def spin_return(point: dict[str, Any], pays: int, stake: int) -> float:
    """What one finished draft returns per chip on its most-hit pocket in a run."""
    return max(point["counts"]) / point["shots"] * (stake + pays) / stake


def worst_spin(run: dict[str, Any], pays: int, stake: int) -> dict[str, Any]:
    """The finished draft a player who could pick the stake after the draft would bet big on."""
    worst = max(run["points"], key=lambda point: spin_return(point, pays, stake))
    return {"draft": worst["draft"], "return": spin_return(worst, pays, stake)}


def clear_chance(solution: Solution, run: dict[str, Any]) -> float:
    """The best chance per spin of clearing in this run, betting on a limit pocket."""
    counts = {tuple(point["draft"]): point["counts"] for point in run["points"]}
    limit = solution.value[()]

    def leaf(draft: Draft) -> float:
        pockets = limit_pockets(solution.wheels[draft], limit)
        if not pockets:
            return 0.0
        shots = counts[draft]
        return sum(shots[p] for p in pockets) / len(pockets) / sum(shots)

    return player_best(solution, leaf)


def run_edge(solution: Solution, run: dict[str, Any], pays: int, stake: int) -> dict[str, Any]:
    return {
        "run": run["id"],
        "method": EDGE_METHOD,
        "bestReturn": best_return(solution, run, pays, stake),
        "worstSpin": worst_spin(run, pays, stake),
        "clearChance": clear_chance(solution, run),
    }


def check_edge(export: dict[str, Any]) -> None:
    """Refuse an export where any strategy, or any single finished draft, returns 1 or more."""
    pays = export["payouts"]["table"][0]["pays"]
    stake = export["payouts"]["stake"]
    for entry in export["edge"]:
        if entry["bestReturn"] >= 1:
            raise ValueError(
                f"the house edge fails on run {entry['run']}: best return {entry['bestReturn']}"
            )
    for run in export["runs"]:
        for point in run["points"]:
            if spin_return(point, pays, stake) >= 1:
                raise ValueError(
                    f"the house edge fails on run {run['id']} at draft {point['draft']}: "
                    f"return {spin_return(point, pays, stake)}"
                )


def build_export(shots: int = SHOTS, today: date | None = None) -> dict[str, Any]:
    today = today or date.today()
    solution = solve()
    drafts = spin_drafts(solution)
    wheel_limits = limits(solution)
    pay = payouts(wheel_limits["houseLimit"]["value"])
    nodes, wheels = nodes_and_wheels(solution)
    runs = [ideal_run(drafts, shots, today), noisy_run(drafts, shots, today), *chip_runs()]
    pays = pay["table"][0]["pays"]
    return {
        "schemaVersion": SCHEMA_VERSION,
        "experiment": "roulette",
        "pocketOrder": POCKET_ORDER,
        "opening": OPENING,
        "turns": list(TURNS),
        "houseRule": HOUSE_RULE,
        "bet": BET,
        "stakeRule": STAKE_RULE,
        "spin": SPIN_RULE,
        "playRun": PLAY_RUN,
        "deck": deck(),
        "limits": wheel_limits,
        "payouts": pay,
        "clear": {"rule": CLEAR_RULE, "basis": CLEAR_BASIS, "chance": solution.value[()]},
        "wheelsMethod": WHEELS_METHOD,
        "wheels": wheels,
        "nodes": nodes,
        "logicalCircuits": logical_circuits(solution),
        "runs": runs,
        "edge": [run_edge(solution, run, pays, pay["stake"]) for run in runs],
    }


def refresh_chip_runs(path: Path) -> None:
    """Swap in the current chip runs and their edge entries, keeping the simulators' as written."""
    export = json.loads(path.read_text())
    simulators = [r for r in export["runs"] if r["provenance"]["source"] != CHIP_SOURCE]
    kept = {r["id"] for r in simulators}
    solution = solve()
    pays = export["payouts"]["table"][0]["pays"]
    stake = export["payouts"]["stake"]
    chips = chip_runs()
    refreshed = {
        **export,
        "runs": [*simulators, *chips],
        "edge": [
            *(entry for entry in export["edge"] if entry["run"] in kept),
            *(run_edge(solution, run, pays, stake) for run in chips),
        ],
    }
    check_edge(refreshed)
    write_export(path, refreshed)


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chip-only", action="store_true")
    if parser.parse_args(argv).chip_only:
        refresh_chip_runs(EXPORT_PATH)
        print(f"wrote {EXPORT_PATH}")
        return
    export = build_export()
    check_edge(export)
    write_export(EXPORT_PATH, export)
    raw = EXPORT_PATH.read_bytes()
    print(f"wrote {EXPORT_PATH}: {len(raw)} bytes, {len(gzip.compress(raw))} gzipped")


if __name__ == "__main__":
    main()
