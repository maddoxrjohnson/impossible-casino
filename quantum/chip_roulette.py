"""Spin every finished Roulette draft on a real IBM chip and record exactly what came back.

From the repo root, with the owner present:
  .venv/bin/python -m quantum.chip_roulette plan --shots 512 --limit-shots 8192
  .venv/bin/python -m quantum.chip_roulette submit --shots 512 --limit-shots 8192 \
      --max-seconds 60
  .venv/bin/python -m quantum.chip_roulette collect JOB_ID

`plan` reads calibration and spends no chip time. `submit` spends it, up to
--max-seconds, after which IBM cancels the job. Counts are raw: no error
mitigation, no twirling and no dynamical decoupling.

One job holds all 108 finished drafts the game can reach, one circuit each, so
a run has one job id and one calibration. The layout is quietest_layout on that
day's calibration: each tied pair on a coupler, so the compiler adds no swaps.

The seconds estimate is a fit to what past jobs on this account billed: a fixed
cost per job, a cost per shot and a cost per circuit. The per-shot term is
mostly the chip's reset between shots, which these short circuits barely add
to. The range runs from the fit to half as much again, because this job has
three times as many distinct circuits as any job behind the fit.

The house edge is thin, and the export's guard refuses the whole run if any
one draft's best pocket is sampled past it. Sampling noise alone does that to a
pocket sitting at 1 in 4 unless it has thousands of shots, so the drafts with a
pocket at the house limit get --limit-shots and the rest, whose best pocket is
1 in 8 at most, get --shots. Each circuit carries its own shot count, and each
point keeps it. plan says how likely sampling alone is to trip the guard.
"""

import argparse
import math
import statistics
from collections.abc import Sequence
from datetime import UTC, date, datetime
from typing import Any

import numpy as np
from qiskit import QuantumCircuit
from qiskit.providers import BackendV2
from qiskit_ibm_runtime import QiskitRuntimeService
from scipy.stats import binom

from quantum.chip import (
    CHIP_SOURCE,
    DEFAULT_BACKEND,
    NON_GATES,
    TRANSPILE_SEED,
    check_budget,
    chip_provenance,
    pending_seconds,
    sample,
)
from quantum.export import read_record, write_record
from quantum.export_roulette import (
    QUBIT_SELECTION as SNAPSHOT_SELECTION,
    TIE_PAIRS,
    check_edge,
    compile_draft,
    noise_simulator,
    payouts,
    quietest_layout,
    run_edge,
    spin_drafts,
)
from quantum.roulette import POCKETS, QUBITS, Draft, Solution, limit_pockets, solve

EXPERIMENT = "roulette"
QUBIT_SELECTION = SNAPSHOT_SELECTION.replace("snapshot", "day's calibration")
DEFAULT_SHOTS = 512
DEFAULT_LIMIT_SHOTS = 8192

# (job id, circuits or bindings, shots each, seconds billed) for past jobs on this account.
BILLED_JOBS: tuple[tuple[str, int, int, int], ...] = (
    ("dbnneo0qtr0c73adbufg", 36, 4096, 41),
    ("dbnna5gqtr0c73adbo90", 4, 4096, 6),
    ("dbnp35gou4as73b4tusg", 1024, 8, 6),
    ("dbnoi58ou4as73b4tcr0", 32, 32, 3),
)
ESTIMATE_MARGIN = 1.5
FORECAST_SHOTS = 2**15
FORECAST_SEED = 7_000_000


def compile_job(
    drafts: Sequence[Draft], backend: BackendV2, layout: Sequence[int] | None
) -> list[QuantumCircuit]:
    """One circuit per finished draft, in the order given."""
    return [compile_draft(draft, backend, layout=layout, seed=TRANSPILE_SEED) for draft in drafts]


def draft_shots(
    solution: Solution, drafts: Sequence[Draft], shots: int, limit_shots: int
) -> list[int]:
    """limit_shots for a draft whose exact wheel has a pocket at the house limit, else shots."""
    at_limit = set(limit_drafts(solution, drafts))
    return [limit_shots if draft in at_limit else shots for draft in drafts]


def job_pubs(circuits: Sequence[QuantumCircuit], shots: Sequence[int]) -> list[tuple[Any, ...]]:
    """Sampler pubs that each carry their own shot count."""
    return [(circuit, None, n) for circuit, n in zip(circuits, shots, strict=True)]


def check_compiled(circuit: QuantumCircuit, layout: Sequence[int]) -> None:
    """Raises unless the circuit uses only the layout and pocket bit k reads layout[k]."""
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
    if readout != dict(enumerate(layout)):
        raise ValueError(f"{circuit.name} reads {readout}, layout is {list(layout)}")


def counts_from_result(
    result: Any, drafts: Sequence[Draft], shots: Sequence[int]
) -> list[list[int]]:
    """Each draft's counts in pocket order. Qiskit keys put clbit 0 last, so int(key, 2) is the pocket."""
    if len(result) != len(drafts) or len(shots) != len(drafts):
        raise ValueError(f"expected {len(drafts)} results, got {len(result)}")
    counts = []
    for draft, expected, pub in zip(drafts, shots, result, strict=True):
        keyed = pub.data.pocket.get_counts()
        if sum(keyed.values()) != expected:
            raise ValueError(
                f"draft {list(draft)} has {sum(keyed.values())} shots, expected {expected}"
            )
        pockets = [0] * POCKETS
        for key, n in keyed.items():
            pockets[int(key, 2)] += n
        counts.append(pockets)
    return counts


def run_from_counts(
    run_id: str,
    backend: str,
    qubits: Sequence[int],
    shots: Sequence[int],
    today: date,
    job_id: str,
    drafts: Sequence[Draft],
    counts: Sequence[Sequence[int]],
) -> dict[str, Any]:
    """A run in the export's shape. A chip takes no seed, so each point's seed is null.

    Shots differ by draft, so each point's shots is its own and the provenance
    holds the most any draft had.
    """
    return {
        "id": run_id,
        "provenance": chip_provenance(
            backend, qubits, QUBIT_SELECTION, max(shots), today, job_id
        ),
        "points": [
            {"draft": list(draft), "seed": None, "shots": n, "counts": list(pockets)}
            for draft, n, pockets in zip(drafts, shots, counts, strict=True)
        ],
    }


def layout_errors(backend: BackendV2, layout: Sequence[int]) -> dict[str, Any]:
    target = backend.target

    def cz(a: int, b: int) -> float:
        return (target["cz"].get((a, b)) or target["cz"][(b, a)]).error

    return {
        "qubits": [
            {
                "qubit": qubit,
                "readout": target["measure"][(qubit,)].error,
                "sx": target["sx"][(qubit,)].error,
            }
            for qubit in layout
        ],
        "ties": [
            {"pair": [layout[a], layout[b]], "cz": cz(layout[a], layout[b])} for a, b in TIE_PAIRS
        ],
    }


# Planning arithmetic


def _fit(billed: Sequence[float]) -> np.ndarray:
    rows = [[1.0, circuits * shots, circuits] for _, circuits, shots, _ in BILLED_JOBS]
    return np.linalg.lstsq(np.array(rows), np.array(billed, dtype=float), rcond=None)[0]


def estimate_seconds(circuits: int, total_shots: int) -> tuple[float, float]:
    """Chip seconds from a fixed, per-shot and per-circuit fit to past billing, then a margin."""
    fixed, per_shot, per_circuit = _fit([seconds for *_, seconds in BILLED_JOBS])
    low = fixed + per_shot * total_shots + per_circuit * circuits
    return low, low * ESTIMATE_MARGIN


def edge_bar(shots: int, pays: int, stake: int) -> int:
    """The fewest hits on one pocket that check_edge refuses."""
    return math.ceil(shots * stake / (stake + pays))


def edge_risk(chance: float, pockets: int, shots: int, pays: int, stake: int) -> float:
    """Chance that one of this many pockets, each landing with this chance, reaches the bar."""
    return mix_risk([(chance, shots)] * pockets, pays, stake)


def mix_risk(pockets: Sequence[tuple[float, int]], pays: int, stake: int) -> float:
    """Chance that any (chance, shots) pocket reaches the bar for its shots.

    Treating the pockets as independent slightly overstates it, since pockets on
    one wheel share their shots.
    """
    log_below = sum(
        math.log1p(-float(binom.sf(edge_bar(shots, pays, stake) - 1, shots, chance)))
        for chance, shots in pockets
    )
    return -math.expm1(log_below)


def risk_pockets(
    solution: Solution,
    drafts: Sequence[Draft],
    shots: Sequence[int],
    limit_chance: float | None = None,
) -> list[tuple[float, int]]:
    """Every lit pocket as (chance, shots) from the exact wheel; a limit_chance replaces
    the chance of each pocket at the house limit."""
    limit = solution.value[()]
    pockets = []
    for draft, n in zip(drafts, shots, strict=True):
        at_limit = set(limit_pockets(solution.wheels[draft], limit))
        for pocket, chance in enumerate(solution.wheels[draft]):
            if chance > 0:
                swap = limit_chance is not None and pocket in at_limit
                pockets.append((limit_chance if swap else chance, n))
    return pockets


def limit_drafts(solution: Solution, drafts: Sequence[Draft]) -> list[Draft]:
    limit = solution.value[()]
    return [d for d in drafts if limit_pockets(solution.wheels[d], limit)]


def forecast_limit_chance(
    backend: BackendV2, layout: Sequence[int], solution: Solution, drafts: Sequence[Draft]
) -> float:
    """The mean limit-pocket chance in Aer with a noise model of the day's calibration."""
    simulator = noise_simulator(backend, layout)
    limit = solution.value[()]
    chances = []
    for i, draft in enumerate(drafts):
        circuit = compile_draft(draft, backend, layout=layout, seed=TRANSPILE_SEED)
        keyed = (
            simulator.run(circuit, shots=FORECAST_SHOTS, seed_simulator=FORECAST_SEED + i)
            .result()
            .get_counts()
        )
        for pocket in limit_pockets(solution.wheels[draft], limit):
            chances.append(keyed.get(format(pocket, f"0{QUBITS}b"), 0) / FORECAST_SHOTS)
    return statistics.fmean(chances)


def _spread(values: Sequence[int]) -> str:
    return f"min {min(values)}, median {statistics.median(values):g}, max {max(values)}"


def prepare(service: QiskitRuntimeService, args: argparse.Namespace) -> dict[str, Any]:
    backend = service.backend(args.backend)
    solution = solve()
    drafts = spin_drafts(solution)
    layout = quietest_layout(backend)
    circuits = compile_job(drafts, backend, layout)
    for circuit in circuits:
        check_compiled(circuit, layout)
    shots = draft_shots(solution, drafts, args.shots, args.limit_shots)
    print(f"backend {backend.name}, {backend.status().pending_jobs} jobs pending")
    print(f"calibrated {backend.properties().last_update_date}")
    print(f"qubits {layout} (logical qubit k on entry k)")
    print(f"errors {layout_errors(backend, layout)}")
    print(f"{len(circuits)} circuits, one per finished draft")
    print(f"depth {_spread([c.depth() for c in circuits])}")
    print(f"cz per draft {_spread([c.count_ops().get('cz', 0) for c in circuits])}")
    total = sum(shots)
    low, high = estimate_seconds(len(circuits), total)
    at_limit = len(limit_drafts(solution, drafts))
    print(
        f"{at_limit} drafts at the house limit get {args.limit_shots} shots, "
        f"{len(shots) - at_limit} others get {args.shots}; {total} shots in total"
    )
    print(f"estimated chip time {low:.0f} to {high:.0f} s")
    return {
        "backend": backend,
        "layout": layout,
        "drafts": drafts,
        "circuits": circuits,
        "shots": shots,
        "pubs": job_pubs(circuits, shots),
    }


def plan(args: argparse.Namespace) -> None:
    ready = prepare(QiskitRuntimeService(), args)
    solution = solve()
    pay = payouts(solution.value[()])
    pays, stake = pay["table"][0]["pays"], pay["stake"]
    drafts, shots = ready["drafts"], ready["shots"]
    at_limit = limit_drafts(solution, drafts)
    chance = forecast_limit_chance(ready["backend"], ready["layout"], solution, at_limit)
    for n in sorted(set(shots)):
        print(f"edge guard: refuses a draft with {edge_bar(n, pays, stake)} of {n} shots on a pocket")
    print(f"day's-calibration noise model puts a limit pocket at {chance:.4f}")
    others = [(d, n) for d, n in zip(drafts, shots) if d not in at_limit]
    rest = mix_risk(risk_pockets(solution, *zip(*others)), pays, stake) if others else 0.0
    forecast = mix_risk(risk_pockets(solution, drafts, shots, chance), pays, stake)
    perfect = mix_risk(risk_pockets(solution, drafts, shots), pays, stake)
    print(
        f"chance sampling breaks the guard: {forecast:.4f} at the forecast, "
        f"{perfect:.4f} on a perfect wheel; the other drafts' share is {rest:.1e}"
    )


def submit(args: argparse.Namespace) -> None:
    service = QiskitRuntimeService()
    remaining = service.usage()["usage_remaining_seconds"] - pending_seconds()
    check_budget(remaining, args.max_seconds)
    ready = prepare(service, args)
    job = sample(ready["pubs"], ready["backend"], args.shots, args.max_seconds)
    path = write_record(
        {
            "jobId": job.job_id(),
            "experiment": EXPERIMENT,
            "backend": args.backend,
            "qubits": list(ready["layout"]),
            "qubitSelection": QUBIT_SELECTION,
            "errors": layout_errors(ready["backend"], ready["layout"]),
            "calibrated": ready["backend"].properties().last_update_date.isoformat(),
            "drafts": [list(draft) for draft in ready["drafts"]],
            "shots": ready["shots"],
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
    drafts = [tuple(draft) for draft in record["drafts"]]
    counts = counts_from_result(job.result(), drafts, record["shots"])
    run = run_from_counts(
        args.run_id,
        record["backend"],
        record["qubits"],
        record["shots"],
        job.creation_date.date(),
        args.job_id,
        drafts,
        counts,
    )
    record["usageSeconds"] = job.usage()
    record["run"] = run
    write_record(record)
    print(f"chip seconds used {record['usageSeconds']}")
    solution = solve()
    pay = payouts(solution.value[()])
    pays, stake = pay["table"][0]["pays"], pay["stake"]
    if [list(d) for d in drafts] != [list(d) for d in spin_drafts(solution)]:
        print("the drafts no longer match the game's finished drafts; the export will not load them")
        return
    edge = run_edge(solution, run, pays, stake)
    print(
        f"best return {edge['bestReturn']:.4f}, worst draft {edge['worstSpin']}, "
        f"clear chance {edge['clearChance']:.4f}"
    )
    try:
        check_edge({"payouts": pay, "edge": [edge], "runs": [run]})
    except ValueError as refused:
        print(f"the export will refuse this run: {refused}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(required=True)
    for name, handler in (("plan", plan), ("submit", submit)):
        command = commands.add_parser(name)
        command.add_argument("--backend", default=DEFAULT_BACKEND)
        command.add_argument("--shots", type=int, default=DEFAULT_SHOTS)
        command.add_argument("--limit-shots", type=int, default=DEFAULT_LIMIT_SHOTS)
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
