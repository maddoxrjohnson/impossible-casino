"""Shared shape of every exported result file in web/public/data/."""

import json
from datetime import date
from pathlib import Path
from typing import Any

import qiskit
import qiskit_aer
import qiskit_ibm_runtime

SCHEMA_VERSION = 1
DATA_DIR = Path(__file__).resolve().parent.parent / "web" / "public" / "data"
PRE_RUN_SIMULATOR = "pre-run-simulator"
LIVE_SIMULATOR = "live-simulator"


def simulator_provenance(
    backend: str,
    shots: int,
    today: date,
    noise_model: dict[str, str] | None = None,
    qubits: list[int] | None = None,
    source: str = PRE_RUN_SIMULATOR,
) -> dict[str, Any]:
    """Label a simulator run. jobId is only ever set by a run on a real chip."""
    return {
        "source": source,
        "backend": backend,
        "noiseModel": noise_model,
        "qubits": qubits,
        "shots": shots,
        "qiskitVersion": qiskit.__version__,
        "aerVersion": qiskit_aer.__version__,
        "runtimeVersion": qiskit_ibm_runtime.__version__,
        "date": today.isoformat(),
        "jobId": None,
    }


def write_export(path: Path, export: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(export, indent=1) + "\n")
