"""Export the CHSH win-rate curve for the Impossible Tables.

Run from the repo root: .venv/bin/python -m quantum.export_chsh

The noisy run uses Aer with a noise model built from IBM's stored fake_kingston
calibration, pinned to that snapshot's quietest coupler. It is a simulation, and
the provenance says so.
"""

from collections.abc import Sequence
from datetime import date
from itertools import product
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
from quantum.export import DATA_DIR, SCHEMA_VERSION, simulator_provenance, write_export

EXPORT_PATH = DATA_DIR / f"chsh.v{SCHEMA_VERSION}.json"
SHOTS = 8192
DIAL_STEPS = 32
DIAL_GRID: tuple[float, ...] = tuple(i / DIAL_STEPS for i in range(DIAL_STEPS + 1))
OUTCOMES: tuple[str, ...] = tuple("".join(bits) for bits in product("01", repeat=2))
QUBIT_SELECTION = "lowest CZ plus readout error in the snapshot"

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


def ideal_run(dials: Sequence[float], shots: int, today: date) -> dict[str, Any]:
    backend = AerSimulator()
    return {
        "id": "ideal",
        "provenance": simulator_provenance(backend.name, shots, today),
        "points": [
            sample_point(dial, shots, dial_seed(IDEAL_BASE_SEED, i), backend)
            for i, dial in enumerate(dials)
        ],
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
            sample_point(dial, shots, dial_seed(NOISY_BASE_SEED, i), backend, layout)
            for i, dial in enumerate(dials)
        ],
    }


def limits() -> dict[str, dict[str, Any]]:
    return {
        "classical": {
            "value": float(best_classical_win_rate()),
            "method": "brute force over every deterministic strategy",
        },
        "quantum": {"value": quantum_limit(), "method": "Qiskit statevector at dial 0.5"},
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
        "runs": [ideal_run(dials, shots, today), noisy_run(dials, shots, today)],
    }


if __name__ == "__main__":
    write_export(EXPORT_PATH, build_export())
    print(f"wrote {EXPORT_PATH}")
