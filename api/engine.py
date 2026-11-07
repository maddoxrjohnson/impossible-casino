"""Live Qiskit runs for the tables, one fresh seed per request.

The noise setup is the same stored fake_kingston calibration and best-case qubit
pick as the ibm-noise-model exports, so the table keeps its character when live.
Each simulator keeps only the errors on its experiment's qubits. For CHSH that
gives the same counts as the full model for a seed, at 50 ms instead of 1.5 s.
"""

import secrets
from datetime import UTC, datetime
from typing import Any

from qiskit_aer import AerSimulator
from qiskit_ibm_runtime.fake_provider import FakeKingston

from quantum import export_chsh, export_wiesner
from quantum.export import LIVE_SIMULATOR, simulator_provenance
from quantum.wiesner import MAX_LENGTH

# A CHSH run costs the same at any shot count here, so it matches the export.
CHSH_SHOTS = export_chsh.SHOTS
# Every Wiesner shot is its own binding, about 1.2 ms each at length 8 on one core.
WIESNER_SHOTS = 512
CHSH_NOISE_SCOPE = "gate and readout errors on the chosen qubits only"
SEED_BOUND = 2**31


def _noise_simulator(device: FakeKingston, qubits: list[int]) -> AerSimulator:
    backend = export_wiesner.noise_simulator(device, qubits)
    # The service runs on one vCPU, and Aer sizes its pool from the host's cores.
    backend.set_options(max_parallel_threads=1)
    return backend


class Engine:
    """Built once at startup. Safe to call from the run workers."""

    def __init__(self) -> None:
        device = FakeKingston()
        self._pair = list(export_chsh.quietest_pair(device))
        self._qubits = export_wiesner.quietest_qubits(device, MAX_LENGTH)
        self._chsh_backend = _noise_simulator(device, self._pair)
        self._wiesner_backend = _noise_simulator(device, self._qubits)
        self._wiesner_noise = export_wiesner.noise_model_label(device)
        self._chsh_noise = {
            **self._wiesner_noise,
            "qubitSelection": export_chsh.QUBIT_SELECTION,
            "scope": CHSH_NOISE_SCOPE,
        }

    def chsh(self, dial: float) -> dict[str, Any]:
        seed = secrets.randbelow(SEED_BOUND)
        point = export_chsh.sample_point(dial, CHSH_SHOTS, seed, self._chsh_backend, self._pair)
        return {
            "experiment": "chsh",
            "runId": f"live-{seed}",
            "outcomeOrder": "ba",
            **point,
            "provenance": self._provenance(
                self._chsh_backend, CHSH_SHOTS, self._chsh_noise, self._pair
            ),
        }

    def wiesner(self, length: int) -> dict[str, Any]:
        seed = secrets.randbelow(SEED_BOUND)
        point = export_wiesner.sample_point(
            length, WIESNER_SHOTS, seed, self._wiesner_backend, self._qubits
        )
        return {
            "experiment": "wiesner",
            "runId": f"live-{seed}",
            **point,
            "provenance": self._provenance(
                self._wiesner_backend, WIESNER_SHOTS, self._wiesner_noise, point["qubits"]
            ),
        }

    @staticmethod
    def _provenance(
        backend: AerSimulator, shots: int, noise_model: dict[str, str], qubits: list[int]
    ) -> dict[str, Any]:
        return simulator_provenance(
            backend.name,
            shots,
            datetime.now(UTC).date(),
            noise_model=noise_model,
            qubits=qubits,
            source=LIVE_SIMULATOR,
        )
