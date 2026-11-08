"""Export the CHSH win-rate curve for the Impossible Tables.

Run from the repo root: .venv/bin/python -m quantum.export_chsh
Add --chip-only to rewrite just the chip runs and leave the simulators as written.

The noisy run uses Aer with a noise model built from IBM's stored fake_kingston
calibration, pinned to that snapshot's quietest coupler. It is a simulation, and
the provenance says so. Chip runs come from the records in CHIP_JOBS, and cover
only the dials those jobs ran.

Every point carries stdErr, in the same units as winRate, and chshS, the CHSH
value 8 winRate minus 4. Chip points also carry sigmasAboveClassical. Every run
says in stdErrMethod how stdErr was found.
"""

import argparse
import json
import math
from collections.abc import Mapping, Sequence
from datetime import date
from itertools import product
from pathlib import Path
from typing import Any

from qiskit import qasm2
from qiskit.providers import BackendV2
from qiskit.quantum_info import Statevector
from qiskit_aer import AerSimulator
from qiskit_ibm_runtime.fake_provider import FakeKingston

from quantum.chsh import (
    OPTIMAL_DIAL,
    QUESTION_PAIRS,
    best_classical_win_rate,
    chsh_circuits,
    pair_win_rate,
    run_chsh,
    win_rate,
)
from quantum.export import (
    CHIP_SOURCE,
    DATA_DIR,
    SCHEMA_VERSION,
    collected_runs,
    simulator_provenance,
    write_export,
)

EXPORT_PATH = DATA_DIR / f"chsh.v{SCHEMA_VERSION}.json"
SHOTS = 8192
DIAL_STEPS = 32
DIAL_GRID: tuple[float, ...] = tuple(i / DIAL_STEPS for i in range(DIAL_STEPS + 1))
OUTCOMES: tuple[str, ...] = tuple("".join(bits) for bits in product("01", repeat=2))
QUBIT_SELECTION = "lowest CZ plus readout error in the snapshot"
CHIP_JOBS: tuple[str, ...] = ("dbnneo0qtr0c73adbufg",)
STD_ERR_METHOD = (
    "binomial: square root of winRate times (1 minus winRate) over the point's "
    "shots summed across its four question pairs; every shot is an independent "
    "run, and with the pairs split evenly this slightly overstates the error"
)

# Aer steps the seed by about 2,100 per circuit inside a job. This spacing keeps
# each dial's four streams in their own band, so neighbouring dials stay independent.
SEED_SPACING = 10_000
IDEAL_BASE_SEED = 1_000_000
NOISY_BASE_SEED = 2_000_000


def dial_seed(base: int, index: int) -> int:
    return base + index * SEED_SPACING


def quietest_pair(backend: BackendV2) -> tuple[int, int]:
    """The coupler with the lowest CZ error plus readout error on both qubits."""
    target = backend.target

    def cost(pair: tuple[int, int]) -> float:
        a, b = pair
        return (
            target["cz"][pair].error
            + target["measure"][(a,)].error
            + target["measure"][(b,)].error
        )

    return min(target["cz"], key=cost)


def quantum_limit() -> float:
    probabilities = {
        pair: Statevector.from_instruction(
            circuit.remove_final_measurements(inplace=False)
        ).probabilities_dict()
        for pair, circuit in chsh_circuits(OPTIMAL_DIAL).items()
    }
    return win_rate(probabilities)


def sample_point(
    dial: float,
    shots: int,
    seed: int,
    backend: BackendV2,
    layout: Sequence[int] | None = None,
) -> dict[str, Any]:
    counts = run_chsh(dial, shots=shots, backend=backend, seed=seed, layout=layout)
    return point_from_counts(dial, shots, seed, counts)


def point_from_counts(
    dial: float,
    shots: int,
    seed: int,
    counts: Mapping[tuple[int, int], Mapping[str, int]],
) -> dict[str, Any]:
    return {
        "dial": dial,
        "seed": seed,
        "winRate": win_rate(counts),
        "pairs": [
            {
                "x": x,
                "y": y,
                "shots": shots,
                "winRate": pair_win_rate(counts[(x, y)], x, y),
                "counts": {key: counts[(x, y)].get(key, 0) for key in OUTCOMES},
            }
            for x, y in QUESTION_PAIRS
        ],
    }


def binomial_std_err(rate: float, shots: int) -> float:
    """Standard error of a rate over shots independent trials."""
    if shots <= 0 or not 0 <= rate <= 1:
        raise ValueError(f"need a rate in [0, 1] over positive shots, got {rate} over {shots}")
    return math.sqrt(rate * (1 - rate) / shots)


def with_statistics(point: dict[str, Any]) -> dict[str, Any]:
    """A point with its standard error and CHSH value, leaving sample_point as is."""
    shots = sum(pair["shots"] for pair in point["pairs"])
    return {
        **point,
        "stdErr": binomial_std_err(point["winRate"], shots),
        "chshS": 8 * point["winRate"] - 4,
    }


def chip_run_with_statistics(run: dict[str, Any]) -> dict[str, Any]:
    """A chip run whose points also say how many standard errors they clear 75% by."""
    classical = float(best_classical_win_rate())
    points = []
    for point in run["points"]:
        stats = with_statistics(point)
        sigmas = (point["winRate"] - classical) / stats["stdErr"]
        points.append({**stats, "sigmasAboveClassical": sigmas})
    return {**run, "points": points, "stdErrMethod": STD_ERR_METHOD}


def ideal_run(dials: Sequence[float], shots: int, today: date) -> dict[str, Any]:
    backend = AerSimulator()
    return {
        "id": "ideal",
        "provenance": simulator_provenance(backend.name, shots, today),
        "points": [
            with_statistics(sample_point(dial, shots, dial_seed(IDEAL_BASE_SEED, i), backend))
            for i, dial in enumerate(dials)
        ],
        "stdErrMethod": STD_ERR_METHOD,
    }


def noisy_run(dials: Sequence[float], shots: int, today: date) -> dict[str, Any]:
    device = FakeKingston()
    backend = AerSimulator.from_backend(device)
    layout = quietest_pair(device)
    noise_model = {
        "name": device.name,
        "calibrated": device.properties().last_update_date.isoformat(),
        "qubitSelection": QUBIT_SELECTION,
    }
    return {
        "id": "ibm-noise-model",
        "provenance": simulator_provenance(
            backend.name, shots, today, noise_model=noise_model, qubits=list(layout)
        ),
        "points": [
            with_statistics(
                sample_point(dial, shots, dial_seed(NOISY_BASE_SEED, i), backend, layout)
            )
            for i, dial in enumerate(dials)
        ],
        "stdErrMethod": STD_ERR_METHOD,
    }


def chip_runs() -> list[dict[str, Any]]:
    return [chip_run_with_statistics(run) for run in collected_runs("chsh", CHIP_JOBS)]


def limits() -> dict[str, dict[str, Any]]:
    """Each limit as a win rate, and as the CHSH value S = 8 winRate - 4 it equals."""
    classical = float(best_classical_win_rate())
    quantum = quantum_limit()
    return {
        "classical": {
            "value": classical,
            "method": "brute force over every deterministic strategy",
            "chshS": 8 * classical - 4,
        },
        "quantum": {
            "value": quantum,
            "method": "Qiskit statevector at dial 0.5",
            "chshS": 8 * quantum - 4,
        },
    }


def logical_circuits(dials: Sequence[float]) -> list[dict[str, Any]]:
    """The circuits as designed, before transpiling to a backend's gates and qubits."""
    return [
        {
            "dial": dial,
            "pairs": [
                {"x": x, "y": y, "qasm": qasm2.dumps(circuit)}
                for (x, y), circuit in chsh_circuits(dial).items()
            ],
        }
        for dial in dials
    ]


def build_export(
    dials: Sequence[float] = DIAL_GRID,
    shots: int = SHOTS,
    today: date | None = None,
) -> dict[str, Any]:
    today = today or date.today()
    return {
        "schemaVersion": SCHEMA_VERSION,
        "experiment": "chsh",
        "outcomeOrder": "ba",
        "limits": limits(),
        "logicalCircuits": logical_circuits(dials),
        "runs": [
            ideal_run(dials, shots, today),
            noisy_run(dials, shots, today),
            *chip_runs(),
        ],
    }


def refresh_chip_runs(path: Path) -> None:
    export = json.loads(path.read_text())
    simulators = [r for r in export["runs"] if r["provenance"]["source"] != CHIP_SOURCE]
    write_export(path, {**export, "runs": [*simulators, *chip_runs()]})


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chip-only", action="store_true")
    if parser.parse_args(argv).chip_only:
        refresh_chip_runs(EXPORT_PATH)
    else:
        write_export(EXPORT_PATH, build_export())
    print(f"wrote {EXPORT_PATH}")


if __name__ == "__main__":
    main()
