"""Run the CHSH circuits on a real IBM chip and record exactly what came back.

From the repo root, with the owner present:
  .venv/bin/python -m quantum.chip_chsh plan --dials 0.5 --shots 4096
  .venv/bin/python -m quantum.chip_chsh submit --dials 0.5 --shots 4096 --max-seconds 30
  .venv/bin/python -m quantum.chip_chsh collect JOB_ID

`plan` reads calibration and spends no chip time. `submit` spends it, up to
--max-seconds, after which IBM cancels the job. Counts are raw: no error
mitigation, no twirling and no dynamical decoupling.

One job holds every dial, so a run has one job id and one calibration.
"""

import argparse
from collections.abc import Mapping, Sequence
from datetime import UTC, date, datetime
from typing import Any

from qiskit import QuantumCircuit
from qiskit.providers import BackendV2
from qiskit_ibm_runtime import QiskitRuntimeService

from quantum.chip import (
    CHIP_SOURCE,
    DEFAULT_BACKEND,
    NON_GATES,
    TRANSPILE_SEED,
    check_budget,
    pending_seconds,
    chip_provenance,
    sample,
)
from quantum.chsh import QUESTION_PAIRS, compile_chsh, pair_win_rate, win_rate
from quantum.export import read_record, write_record
from quantum.export_chsh import DIAL_GRID, OUTCOMES, point_from_counts, quietest_pair

EXPERIMENT = "chsh"
QUBIT_SELECTION = (
    "best-case pick: the coupler with the lowest CZ plus readout error "
    "in that day's calibration"
)

Counts = Mapping[str, int]
CountsByDial = Mapping[float, Mapping[tuple[int, int], Counts]]


def check_dials(dials: Sequence[float]) -> None:
    """Off-grid dials have no logical circuit, and repeats pay twice for one kept point."""
    if not dials or len(set(dials)) != len(dials) or not set(dials) <= set(DIAL_GRID):
        raise ValueError(f"dials must be distinct positions on the 33-point grid, got {dials}")


def compile_job(
    dials: Sequence[float], backend: BackendV2, layout: Sequence[int] | None
) -> list[QuantumCircuit]:
    """Every dial's four question pairs, ordered by dial then QUESTION_PAIRS."""
    return [
        circuit
        for dial in dials
        for circuit in compile_chsh(dial, backend, layout=layout, seed=TRANSPILE_SEED)
    ]


def check_compiled(circuit: QuantumCircuit, layout: Sequence[int]) -> None:
    """Raises unless the circuit uses only the layout, with c0 the player and c1 the partner."""
    index = {qubit: i for i, qubit in enumerate(circuit.qubits)}
    used = {
        index[qubit]
        for instruction in circuit.data
        if instruction.operation.name not in NON_GATES
        for qubit in instruction.qubits
    }
    if not used <= set(layout):
        raise ValueError(f"{circuit.name} touches qubits {sorted(used - set(layout))}")
    readout = {
        circuit.find_bit(instruction.clbits[0]).index: index[instruction.qubits[0]]
        for instruction in circuit.data
        if instruction.operation.name == "measure"
    }
    if readout != {0: layout[0], 1: layout[1]}:
        raise ValueError(f"{circuit.name} classical bits read {readout}, layout is {layout}")


def counts_from_result(
    result: Any, dials: Sequence[float], shots: int
) -> dict[float, dict[tuple[int, int], dict[str, int]]]:
    expected = len(dials) * len(QUESTION_PAIRS)
    if len(result) != expected:
        raise ValueError(f"expected {expected} results, got {len(result)}")
    keys = [(dial, pair) for dial in dials for pair in QUESTION_PAIRS]
    counts: dict[float, dict[tuple[int, int], dict[str, int]]] = {dial: {} for dial in dials}
    for (dial, pair), pub in zip(keys, result, strict=True):
        pair_counts = pub.data.c.get_counts()
        if sum(pair_counts.values()) != shots:
            raise ValueError(f"dial {dial} pair {pair} has the wrong number of shots")
        counts[dial][pair] = {key: pair_counts.get(key, 0) for key in OUTCOMES}
    return counts


def run_from_counts(
    run_id: str,
    backend: str,
    qubits: Sequence[int],
    shots: int,
    today: date,
    job_id: str,
    counts: CountsByDial,
) -> dict[str, Any]:
    """A run in the export's shape. A point's seed is the transpiler's: chips take no seed."""
    return {
        "id": run_id,
        "provenance": chip_provenance(backend, qubits, QUBIT_SELECTION, shots, today, job_id),
        "points": [
            point_from_counts(dial, shots, TRANSPILE_SEED, counts[dial]) for dial in counts
        ],
    }


def pair_errors(backend: BackendV2, pair: tuple[int, int]) -> dict[str, float]:
    target = backend.target
    return {
        "cz": target["cz"][pair].error,
        "readoutPlayer": target["measure"][(pair[0],)].error,
        "readoutPartner": target["measure"][(pair[1],)].error,
    }


def prepare(service: QiskitRuntimeService, args: argparse.Namespace) -> dict[str, Any]:
    check_dials(args.dials)
    backend = service.backend(args.backend)
    layout = quietest_pair(backend)
    circuits = compile_job(args.dials, backend, layout)
    for circuit in circuits:
        check_compiled(circuit, layout)
    status = backend.status()
    print(f"backend {backend.name}, {status.pending_jobs} jobs pending")
    print(f"calibrated {backend.properties().last_update_date}")
    print(f"qubits {layout}, errors {pair_errors(backend, layout)}")
    print(f"{len(circuits)} circuits, depth {circuits[0].depth()}, {circuits[0].count_ops()}")
    print(f"{len(circuits) * args.shots} shots in total")
    return {"backend": backend, "layout": layout, "circuits": circuits}


def plan(args: argparse.Namespace) -> None:
    prepare(QiskitRuntimeService(), args)


def submit(args: argparse.Namespace) -> None:
    service = QiskitRuntimeService()
    remaining = service.usage()["usage_remaining_seconds"] - pending_seconds()
    check_budget(remaining, args.max_seconds)
    ready = prepare(service, args)
    job = sample(ready["circuits"], ready["backend"], args.shots, args.max_seconds)
    path = write_record(
        {
            "jobId": job.job_id(),
            "experiment": EXPERIMENT,
            "backend": args.backend,
            "qubits": list(ready["layout"]),
            "qubitSelection": QUBIT_SELECTION,
            "errors": pair_errors(ready["backend"], ready["layout"]),
            "calibrated": ready["backend"].properties().last_update_date.isoformat(),
            "dials": args.dials,
            "shots": args.shots,
            "maxSeconds": args.max_seconds,
            "submitted": datetime.now(UTC).isoformat(),
        }
    )
    print(f"submitted {job.job_id()}, recorded in {path}")


def collect(args: argparse.Namespace) -> None:
    record = read_record(EXPERIMENT, args.job_id)
    job = QiskitRuntimeService().job(args.job_id)
    print(f"status {job.status()}")
    if job.status() != "DONE":
        return
    counts = counts_from_result(job.result(), record["dials"], record["shots"])
    created = job.creation_date.date()
    run = run_from_counts(
        args.run_id,
        record["backend"],
        record["qubits"],
        record["shots"],
        created,
        args.job_id,
        counts,
    )
    record["usageSeconds"] = job.usage()
    record["run"] = run
    write_record(record)
    print(f"chip seconds used {record['usageSeconds']}")
    for dial, by_pair in counts.items():
        pairs = [round(pair_win_rate(by_pair[pair], *pair), 4) for pair in QUESTION_PAIRS]
        print(f"dial {dial}: win rate {win_rate(by_pair):.4f}, by pair {pairs}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(required=True)
    for name, handler in (("plan", plan), ("submit", submit)):
        command = commands.add_parser(name)
        command.add_argument("--backend", default=DEFAULT_BACKEND)
        command.add_argument("--dials", type=float, nargs="+", required=True)
        command.add_argument("--shots", type=int, required=True)
        command.set_defaults(handler=handler)
        if name == "submit":
            command.add_argument("--max-seconds", type=int, required=True)
    command = commands.add_parser("collect")
    command.add_argument("job_id")
    command.add_argument("--run-id", default=CHIP_SOURCE)
    command.set_defaults(handler=collect)
    args = parser.parse_args()
    args.handler(args)


if __name__ == "__main__":
    main()
