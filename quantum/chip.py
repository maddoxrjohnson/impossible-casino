"""What every real-chip run shares: the spending cap and the label."""

import json
import re
from collections.abc import Sequence
from datetime import date
from pathlib import Path
from typing import Any

import qiskit
import qiskit_aer
import qiskit_ibm_runtime
from qiskit.providers import BackendV2
from qiskit_ibm_runtime import SamplerV2

from quantum.export import CHIP_SOURCE, RUNS_DIR

DEFAULT_BACKEND = "ibm_kingston"
CHIP_NAME = re.compile(r"ibm_[a-z0-9_]+")
TRANSPILE_SEED = 20_261_107
NON_GATES = {"barrier", "delay"}


def check_cap(max_seconds: int) -> None:
    """A cap of zero is dropped from IBM's request, which would leave the job uncapped."""
    if max_seconds < 1:
        raise ValueError(f"a chip job needs a cap of at least 1 s, got {max_seconds}")


def check_budget(remaining_seconds: float, max_seconds: int) -> None:
    check_cap(max_seconds)
    if remaining_seconds < max_seconds:
        raise ValueError(f"{remaining_seconds} s left, job could use {max_seconds} s")


def pending_seconds(runs_dir: Path = RUNS_DIR) -> int:
    """Caps of submitted jobs with no results yet, which IBM's usage figure may not include."""
    records = (json.loads(path.read_text()) for path in sorted(runs_dir.glob("*.json")))
    return sum(record["maxSeconds"] for record in records if "run" not in record)


def sample(
    pubs: Sequence[Any],
    backend: BackendV2,
    shots: int,
    max_seconds: int,
    tags: Sequence[str] = (),
) -> Any:
    """Submit raw sampling, which IBM cancels past max_seconds of chip time."""
    check_cap(max_seconds)
    sampler = SamplerV2(mode=backend)
    sampler.options.default_shots = shots
    sampler.options.max_execution_time = max_seconds
    if tags:
        sampler.options.environment.job_tags = list(tags)
    return sampler.run(list(pubs))


def chip_provenance(
    backend: str,
    qubits: Sequence[int],
    qubit_selection: str,
    shots: int,
    today: date,
    job_id: str,
) -> dict[str, Any]:
    """Only a real chip name with a job id can carry the chip label."""
    if not CHIP_NAME.fullmatch(backend):
        raise ValueError(f"{backend} is not an IBM chip name")
    if not job_id.strip():
        raise ValueError("a chip run needs a job id")
    if not qubit_selection.strip():
        raise ValueError("a chip run says how its qubits were picked")
    return {
        "source": CHIP_SOURCE,
        "backend": backend,
        "noiseModel": None,
        "qubits": list(qubits),
        "qubitSelection": qubit_selection,
        "shots": shots,
        "qiskitVersion": qiskit.__version__,
        "aerVersion": qiskit_aer.__version__,
        "runtimeVersion": qiskit_ibm_runtime.__version__,
        "date": today.isoformat(),
        "jobId": job_id,
    }
