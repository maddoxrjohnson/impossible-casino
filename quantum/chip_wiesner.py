"""Run the Wiesner forgery on a real IBM chip and record exactly what came back.

From the repo root, with the owner present:
  .venv/bin/python -m quantum.chip_wiesner plan --lengths 4 --tickets 32 --shots-per-ticket 32
  .venv/bin/python -m quantum.chip_wiesner submit --lengths 4 --tickets 32 \
      --shots-per-ticket 32 --max-seconds 30
  .venv/bin/python -m quantum.chip_wiesner collect JOB_ID
  .venv/bin/python -m quantum.chip_wiesner backfill JOB_ID

`plan` reads calibration and spends no chip time. `submit` spends it, up to
--max-seconds, after which IBM cancels the job. Counts are raw. `collect` keeps
each ticket's own pass count, and `backfill` adds those to a record collected
before they were kept, checking them against the passes already recorded.

The simulators forge one fresh ticket per shot. A chip charges for every binding,
so a length here runs a fixed set of random tickets at several shots each. The
pass rate is still unbiased, but its spread is wider than the shot count alone
suggests, and the run records both numbers. The tickets replay from each point's
seed through random_tickets.
"""

import argparse
import random
from collections.abc import Mapping, Sequence
from datetime import UTC, date, datetime
from typing import Any

import numpy as np
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
from quantum.export import read_record, write_record
from quantum.export_wiesner import QUBIT_SELECTION, quietest_qubits
from quantum.wiesner import (
    LENGTHS,
    MAX_LENGTH,
    Ticket,
    compile_forgery,
    exact_pass_per_qubit,
    forgery_binds,
    random_tickets,
)

EXPERIMENT = "wiesner"
TICKET_BASE_SEED = 3_000_000_000
TICKET_SEED_SPACING = 10_000


def ticket_seed(length: int) -> int:
    return TICKET_BASE_SEED + length * TICKET_SEED_SPACING


def ticket_values(circuit: QuantumCircuit, tickets: Sequence[Ticket]) -> np.ndarray:
    """Binding array, one row per ticket, in the circuit's own parameter order."""
    binds = forgery_binds(tickets)
    return np.array([binds[parameter] for parameter in circuit.parameters]).T


def check_lengths(lengths: Sequence[int]) -> None:
    """Repeated lengths would pay twice for one kept point."""
    if not lengths or len(set(lengths)) != len(lengths) or not set(lengths) <= set(LENGTHS):
        raise ValueError(f"lengths must be distinct, from {LENGTHS}, got {lengths}")


def compile_job(
    lengths: Sequence[int],
    backend: BackendV2,
    layout: Sequence[int] | None,
    tickets: int,
) -> list[tuple[QuantumCircuit, np.ndarray]]:
    """One (circuit, ticket bindings) pair per length."""
    pubs = []
    for length in lengths:
        circuit = compile_forgery(length, backend, layout=layout, seed=TRANSPILE_SEED)
        drawn = random_tickets(length, tickets, random.Random(ticket_seed(length)))
        pubs.append((circuit, ticket_values(circuit, drawn)))
    return pubs


def check_compiled(circuit: QuantumCircuit, layout: Sequence[int], length: int) -> None:
    """Raises unless both registers read layout[i] at bit i, and no other qubit is used."""
    chosen = list(layout[:length])
    index = {qubit: i for i, qubit in enumerate(circuit.qubits)}
    used = {
        index[qubit]
        for instruction in circuit.data
        if instruction.operation.name not in NON_GATES
        for qubit in instruction.qubits
    }
    if not used <= set(chosen):
        raise ValueError(f"{circuit.name} touches qubits {sorted(used - set(chosen))}")
    readout = {}
    for instruction in circuit.data:
        if instruction.operation.name == "measure":
            location = circuit.find_bit(instruction.clbits[0]).registers[0]
            readout[(location[0].name, location[1])] = index[instruction.qubits[0]]
    expected = {
        (register, i): chosen[i]
        for register in ("attacker", "cashier")
        for i in range(length)
    }
    if readout != expected:
        raise ValueError(f"{circuit.name} reads {readout}, expected {expected}")


def passes_from_result(result: Any, lengths: Sequence[int], shots: int) -> dict[int, int]:
    """Passes per length, where shots is tickets times shots per ticket."""
    if len(result) != len(lengths):
        raise ValueError(f"expected {len(lengths)} results, got {len(result)}")
    passes = {}
    for length, pub in zip(lengths, result, strict=True):
        counts = pub.data.cashier.get_int_counts()
        if sum(counts.values()) != shots:
            raise ValueError(f"length {length} has the wrong number of shots")
        passes[length] = counts.get(0, 0)
    return passes


def ticket_passes_from_result(
    result: Any, lengths: Sequence[int], tickets: int, shots_per_ticket: int
) -> dict[int, list[int]]:
    """Passes of each ticket, in ticket order, per length."""
    if len(result) != len(lengths):
        raise ValueError(f"expected {len(lengths)} results, got {len(result)}")
    split = {}
    for length, pub in zip(lengths, result, strict=True):
        bits = pub.data.cashier
        if bits.shape != (tickets,):
            raise ValueError(f"length {length} has {bits.shape} tickets, expected {tickets}")
        if bits.num_shots != shots_per_ticket:
            raise ValueError(f"length {length} has the wrong number of shots per ticket")
        split[length] = [bits[i].get_int_counts().get(0, 0) for i in range(tickets)]
    return split


def check_ticket_passes(
    length: int, split: Sequence[int], passes: int, tickets: int, shots_per_ticket: int
) -> None:
    """Raises unless the per-ticket passes are the ones behind the recorded passes."""
    if len(split) != tickets:
        raise ValueError(f"length {length} has {len(split)} tickets, expected {tickets}")
    if not all(0 <= n <= shots_per_ticket for n in split):
        raise ValueError(f"length {length} has a ticket with impossible passes")
    if sum(split) != passes:
        raise ValueError(f"length {length} per-ticket passes add to {sum(split)}, not {passes}")


def run_from_passes(
    run_id: str,
    backend: str,
    qubits: Sequence[int],
    qubit_selection: str,
    tickets: int,
    shots_per_ticket: int,
    today: date,
    job_id: str,
    passes: Mapping[int, int],
    ticket_passes: Mapping[int, Sequence[int]] | None = None,
) -> dict[str, Any]:
    shots = tickets * shots_per_ticket
    run = {
        "id": run_id,
        "provenance": chip_provenance(backend, qubits, qubit_selection, shots, today, job_id),
        "ticketsPerPoint": tickets,
        "shotsPerTicket": shots_per_ticket,
        "points": [
            {
                "length": length,
                "seed": ticket_seed(length),
                "shots": shots,
                "qubits": list(qubits[:length]),
                "passes": count,
                "passRate": count / shots,
            }
            for length, count in passes.items()
        ],
    }
    return run if ticket_passes is None else add_ticket_passes(run, ticket_passes)


def add_ticket_passes(
    run: dict[str, Any], ticket_passes: Mapping[int, Sequence[int]]
) -> dict[str, Any]:
    """A copy of the run with each point's per-ticket passes, checked against its passes."""
    lengths = [point["length"] for point in run["points"]]
    if sorted(ticket_passes) != sorted(lengths):
        raise ValueError(f"per-ticket passes cover lengths {sorted(ticket_passes)}, not {lengths}")
    points = []
    for point in run["points"]:
        split = list(ticket_passes[point["length"]])
        check_ticket_passes(
            point["length"], split, point["passes"], run["ticketsPerPoint"], run["shotsPerTicket"]
        )
        points.append({**point, "ticketPasses": split})
    return {**run, "points": points}


def qubit_errors(backend: BackendV2, qubits: Sequence[int]) -> list[dict[str, float]]:
    target = backend.target
    return [
        {
            "qubit": qubit,
            "readout": target["measure"][(qubit,)].error,
            "sx": target["sx"][(qubit,)].error,
        }
        for qubit in qubits
    ]


def prepare(service: QiskitRuntimeService, args: argparse.Namespace) -> dict[str, Any]:
    check_lengths(args.lengths)
    backend = service.backend(args.backend)
    layout = quietest_qubits(backend, MAX_LENGTH)
    pubs = compile_job(args.lengths, backend, layout, args.tickets)
    for length, (circuit, _) in zip(args.lengths, pubs, strict=True):
        check_compiled(circuit, layout, length)
    print(f"backend {backend.name}, {backend.status().pending_jobs} jobs pending")
    print(f"calibrated {backend.properties().last_update_date}")
    print(f"qubits {layout}")
    print(f"errors {qubit_errors(backend, layout)}")
    for length, (circuit, values) in zip(args.lengths, pubs, strict=True):
        print(f"length {length}: depth {circuit.depth()}, {values.shape[0]} tickets")
    print(f"{len(pubs) * args.tickets * args.shots_per_ticket} shots in total")
    return {"backend": backend, "layout": layout, "pubs": pubs}


def plan(args: argparse.Namespace) -> None:
    prepare(QiskitRuntimeService(), args)


def submit(args: argparse.Namespace) -> None:
    service = QiskitRuntimeService()
    remaining = service.usage()["usage_remaining_seconds"] - pending_seconds()
    check_budget(remaining, args.max_seconds)
    ready = prepare(service, args)
    job = sample(ready["pubs"], ready["backend"], args.shots_per_ticket, args.max_seconds)
    path = write_record(
        {
            "jobId": job.job_id(),
            "experiment": EXPERIMENT,
            "backend": args.backend,
            "qubits": list(ready["layout"]),
            "qubitSelection": QUBIT_SELECTION.replace("snapshot", "day's calibration"),
            "errors": qubit_errors(ready["backend"], ready["layout"]),
            "calibrated": ready["backend"].properties().last_update_date.isoformat(),
            "lengths": args.lengths,
            "tickets": args.tickets,
            "shotsPerTicket": args.shots_per_ticket,
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
    shots = record["tickets"] * record["shotsPerTicket"]
    result = job.result()
    passes = passes_from_result(result, record["lengths"], shots)
    split = ticket_passes_from_result(
        result, record["lengths"], record["tickets"], record["shotsPerTicket"]
    )
    record["usageSeconds"] = job.usage()
    record["run"] = run_from_passes(
        args.run_id,
        record["backend"],
        record["qubits"],
        record["qubitSelection"],
        record["tickets"],
        record["shotsPerTicket"],
        job.creation_date.date(),
        args.job_id,
        passes,
        split,
    )
    write_record(record)
    print(f"chip seconds used {record['usageSeconds']}")
    per_qubit = exact_pass_per_qubit()
    for length, count in passes.items():
        print(f"length {length}: {count / shots:.4f}, exact {per_qubit**length:.4f}")


def backfill(args: argparse.Namespace) -> None:
    """Add per-ticket passes to a collected record, changing nothing else in it."""
    record = read_record(EXPERIMENT, args.job_id)
    if "run" not in record:
        raise ValueError(f"{args.job_id} has not been collected")
    job = QiskitRuntimeService().job(args.job_id)
    print(f"status {job.status()}")
    if job.status() != "DONE":
        return
    split = ticket_passes_from_result(
        job.result(), record["lengths"], record["tickets"], record["shotsPerTicket"]
    )
    record["run"] = add_ticket_passes(record["run"], split)
    write_record(record)
    for point in record["run"]["points"]:
        tickets = len(point["ticketPasses"])
        print(f"length {point['length']}: {tickets} tickets, {point['passes']} passes")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(required=True)
    for name, handler in (("plan", plan), ("submit", submit)):
        command = commands.add_parser(name)
        command.add_argument("--backend", default=DEFAULT_BACKEND)
        command.add_argument("--lengths", type=int, nargs="+", required=True)
        command.add_argument("--tickets", type=int, required=True)
        command.add_argument("--shots-per-ticket", type=int, required=True)
        command.set_defaults(handler=handler)
        if name == "submit":
            command.add_argument("--max-seconds", type=int, required=True)
    command = commands.add_parser("collect")
    command.add_argument("job_id")
    command.add_argument("--run-id", default=CHIP_SOURCE)
    command.set_defaults(handler=collect)
    command = commands.add_parser("backfill")
    command.add_argument("job_id")
    command.set_defaults(handler=backfill)
    args = parser.parse_args()
    args.handler(args)


if __name__ == "__main__":
    main()
