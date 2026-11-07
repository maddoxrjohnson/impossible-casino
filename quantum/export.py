"""Shared shape of every exported result file in web/public/data/, and the chip records behind them.

The live service imports the exporters, so nothing here may load chip submission.
"""

import json
from collections.abc import Sequence
from datetime import date
from pathlib import Path
from typing import Any

import qiskit
import qiskit_aer
import qiskit_ibm_runtime

SCHEMA_VERSION = 1
DATA_DIR = Path(__file__).resolve().parent.parent / "web" / "public" / "data"
RUNS_DIR = Path(__file__).resolve().parent / "chip_runs"
PRE_RUN_SIMULATOR = "pre-run-simulator"
LIVE_SIMULATOR = "live-simulator"
CHIP_SOURCE = "ibm-chip"


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


def record_path(experiment: str, job_id: str) -> Path:
    return RUNS_DIR / f"{experiment}-{job_id}.json"


def read_record(experiment: str, job_id: str) -> dict[str, Any]:
    return json.loads(record_path(experiment, job_id).read_text())


def write_record(record: dict[str, Any]) -> Path:
    RUNS_DIR.mkdir(exist_ok=True)
    path = record_path(record["experiment"], record["jobId"])
    path.write_text(json.dumps(record, indent=1) + "\n")
    return path


def collected_runs(experiment: str, job_ids: Sequence[str]) -> list[dict[str, Any]]:
    """The run of each listed chip job, skipping a job not collected yet."""
    records = [read_record(experiment, job_id) for job_id in job_ids]
    runs = [record["run"] for record in records if "run" in record]
    ids = [run["id"] for run in runs]
    if len(set(ids)) != len(ids):
        raise ValueError(f"chip run ids repeat, which the game refuses to load: {ids}")
    return runs
