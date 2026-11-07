"""Export the Wiesner chip forgery for the Cashier's Cage.

Run from the repo root: .venv/bin/python -m quantum.export_wiesner

The noisy run uses Aer with a noise model built from IBM's stored fake_kingston
calibration, pinned to that snapshot's eight quietest qubits. It is a simulation,
and the provenance says so.

Every shot is its own circuit binding, and the full noise model costs about
50 ms per binding. The noisy simulator keeps only the errors on the chosen
qubits, which gives the same counts at about 3 ms per binding.
"""

import math
import random
from collections.abc import Sequence
from datetime import date
from typing import Any

from qiskit import qasm2
from qiskit.providers import BackendV2
from qiskit_aer import AerSimulator
from qiskit_aer.noise import NoiseModel
from qiskit_aer.noise.device import basic_device_gate_errors, basic_device_readout_errors
from qiskit_ibm_runtime.fake_provider import FakeKingston

from quantum.export import DATA_DIR, SCHEMA_VERSION, simulator_provenance, write_export
from quantum.wiesner import (
    LENGTHS,
    MAX_LENGTH,
    exact_pass_per_qubit,
    forgery_circuit,
    random_tickets,
    run_forgery,
)

EXPORT_PATH = DATA_DIR / f"wiesner.v{SCHEMA_VERSION}.json"
SHOTS = 8192
TICKETS_PER_SHOT = 1
ATTACK = "measure each qubit in a guessed basis, then resend it as a re-made chip"
PASS_RULE = (
    "one re-made chip goes to the cashier and every qubit must agree; "
    "this does not model both of two copies passing"
)
QUBIT_SELECTION = (
    "best-case pick: the qubits with the lowest readout plus single-qubit gate error "
    "in the snapshot, ranked best first; length n uses the first n"
)
NOISE_SCOPE = (
    "gate and readout errors on the chosen qubits only; "
    "no decay during the mid-circuit measurement"
)

LOGICAL_CIRCUITS_NOTE = (
    "each circuit is one example ticket, the first of the ideal run's stream; "
    "every shot used a fresh ticket"
)
BY_LENGTH_METHOD = (
    "perQubit to the power of length, because the qubits are independent "
    "with no entangling gates"
)

# Each qubit is measured twice and each of its four RY gates compiles to two sx.
MEASURES_PER_QUBIT = 2
SX_PER_QUBIT = 8

PAYOUT_STATUS = "accepted"
STAKE = 100
HOUSE_RETURN = 0.95
PAYS_STEP = 5
PAYOUT_RULE = (
    "fair total return times 0.95, with net profit on a 100 stake rounded down to a multiple of 5"
)

# Aer steps the seed by 2,113 per binding inside a job, so a full job spans about
# 17.3M. This spacing keeps each length in its own band. The same integer seeds
# the ticket stream, the transpiler and Aer.
SEED_SPACING = 20_000_000
IDEAL_BASE_SEED = 100_000_000
NOISY_BASE_SEED = 1_000_000_000


def length_seed(base: int, length: int) -> int:
    return base + length * SEED_SPACING


def quietest_qubits(backend: BackendV2, count: int) -> list[int]:
    """The qubits with the lowest error over one chip's measures and sx gates."""
    target = backend.target

    def cost(qubit: int) -> float:
        return (
            MEASURES_PER_QUBIT * target["measure"][(qubit,)].error
            + SX_PER_QUBIT * target["sx"][(qubit,)].error
        )

    return sorted(range(backend.num_qubits), key=cost)[:count]


def noise_model_label(device: BackendV2) -> dict[str, str]:
    return {
        "name": device.name,
        "calibrated": device.properties().last_update_date.isoformat(),
        "qubitSelection": QUBIT_SELECTION,
        "scope": NOISE_SCOPE,
    }


def noise_simulator(device: BackendV2, qubits: Sequence[int]) -> AerSimulator:
    """A simulator of device with errors on the given qubits only.

    Settings match NoiseModel.from_backend. Its delay relaxation is left out
    because compiled forgeries have no delays.
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
    return AerSimulator.from_backend(device, noise_model=noise_model)


def sample_point(
    length: int,
    shots: int,
    seed: int,
    backend: BackendV2,
    layout: Sequence[int] | None = None,
) -> dict[str, Any]:
    passes = run_forgery(length, shots, backend=backend, seed=seed, layout=layout)
    return {
        "length": length,
        "seed": seed,
        "shots": shots,
        "qubits": None if layout is None else list(layout[:length]),
        "passes": passes,
        "passRate": passes / shots,
    }


def ideal_run(lengths: Sequence[int], shots: int, today: date) -> dict[str, Any]:
    backend = AerSimulator()
    return {
        "id": "ideal",
        "provenance": simulator_provenance(backend.name, shots, today),
        "points": [
            sample_point(length, shots, length_seed(IDEAL_BASE_SEED, length), backend)
            for length in lengths
        ],
    }


def noisy_run(lengths: Sequence[int], shots: int, today: date) -> dict[str, Any]:
    device = FakeKingston()
    qubits = quietest_qubits(device, MAX_LENGTH)
    backend = noise_simulator(device, qubits)
    return {
        "id": "ibm-noise-model",
        "provenance": simulator_provenance(
            backend.name, shots, today, noise_model=noise_model_label(device), qubits=qubits
        ),
        "points": [
            sample_point(length, shots, length_seed(NOISY_BASE_SEED, length), backend, qubits)
            for length in lengths
        ],
    }


def limits(lengths: Sequence[int]) -> dict[str, Any]:
    per_qubit = exact_pass_per_qubit()
    return {
        "perQubit": {
            "value": per_qubit,
            "method": "Qiskit statevector over every bank state and attacker basis",
        },
        "byLength": [{"length": n, "value": per_qubit**n} for n in lengths],
        "byLengthMethod": BY_LENGTH_METHOD,
    }


def payouts(by_length: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """The pay table, set from the limits. pays is net profit on the stake."""
    table = []
    for entry in by_length:
        limit = entry["value"]
        fair_total = STAKE / limit
        pays = math.floor((fair_total * HOUSE_RETURN - STAKE) / PAYS_STEP) * PAYS_STEP
        table.append(
            {
                "length": entry["length"],
                "pays": pays,
                "fairPays": fair_total - STAKE,
                "breakEven": STAKE / (STAKE + pays),
                "houseEdge": 1 - (STAKE + pays) / STAKE * limit,
            }
        )
    return {"status": PAYOUT_STATUS, "stake": STAKE, "rule": PAYOUT_RULE, "table": table}


def logical_circuits(lengths: Sequence[int]) -> list[dict[str, Any]]:
    """One bound example per length: the first ticket of the ideal run's stream."""
    entries = []
    for length in lengths:
        rng = random.Random(length_seed(IDEAL_BASE_SEED, length))
        ticket = random_tickets(length, 1, rng)[0]
        entries.append(
            {
                "length": length,
                "ticket": {
                    "bits": list(ticket.bits),
                    "bases": list(ticket.bases),
                    "attackerBases": list(ticket.attacker_bases),
                },
                "qasm": qasm2.dumps(forgery_circuit(ticket)),
            }
        )
    return entries


def build_export(
    lengths: Sequence[int] = LENGTHS,
    shots: int = SHOTS,
    today: date | None = None,
) -> dict[str, Any]:
    today = today or date.today()
    pass_limits = limits(lengths)
    return {
        "schemaVersion": SCHEMA_VERSION,
        "experiment": "wiesner",
        "attack": ATTACK,
        "passRule": PASS_RULE,
        "ticketsPerShot": TICKETS_PER_SHOT,
        "limits": pass_limits,
        "payouts": payouts(pass_limits["byLength"]),
        "logicalCircuits": logical_circuits(lengths),
        "logicalCircuitsNote": LOGICAL_CIRCUITS_NOTE,
        "runs": [ideal_run(lengths, shots, today), noisy_run(lengths, shots, today)],
    }


if __name__ == "__main__":
    write_export(EXPORT_PATH, build_export())
    print(f"wrote {EXPORT_PATH}")
