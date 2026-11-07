"""Real chip runs behind the gate: one CHSH press at the middle dial, then polling.

Nothing is kept between requests. IBM holds the state: our jobs carry TAG, so
any instance can find them, count them and serve them back.
"""

import hmac
import logging
import re
import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from fastapi import HTTPException
from qiskit.providers import BackendV2
from qiskit_ibm_runtime import QiskitRuntimeService
from qiskit_ibm_runtime.exceptions import RuntimeJobNotFound

from api.settings import Settings
from quantum.chip import CHIP_SOURCE, DEFAULT_BACKEND, check_budget, sample
from quantum.chip_chsh import check_compiled, compile_job, counts_from_result, run_from_counts
from quantum.chsh import OPTIMAL_DIAL
from quantum.export_chsh import DIAL_GRID, quietest_pair

TAG = "impossible-casino-live"
LIVE_DIAL = OPTIMAL_DIAL
# Per question pair, so four times this per press.
LIVE_SHOTS = 1024
CHANNEL = "ibm_quantum_platform"
DAY = timedelta(hours=24)
JOB_ID = re.compile(r"[a-z0-9]{16,40}")
QUBITS_TAG = re.compile(r"qubits-([0-9]{1,4})-([0-9]{1,4})")
DIAL_TAG = re.compile(r"dial-([01](?:\.[0-9]{1,5})?)")
# Jobs looked at for one in flight. Past this many pending, a press is refused anyway.
PENDING_LOOKUP = 20
STATUSES = {
    "INITIALIZING": "queued",
    "QUEUED": "queued",
    "RUNNING": "running",
    "DONE": "done",
    "CANCELLED": "cancelled",
    "ERROR": "error",
}
FINAL = {"done", "cancelled", "error"}
# A waiting job's status is reused this long, so many open tabs cost IBM one call.
STATUS_CACHE_SECONDS = 5
FINISHED_CACHE_JOBS = 64
# After the service fails to build, presses and polls are refused this long before trying again.
SERVICE_RETRY_SECONDS = 60
# A second press waits this long for the first to finish submitting.
PRESS_WAIT_SECONDS = 5

log = logging.getLogger(__name__)


class ChipService(Protocol):
    """The part of QiskitRuntimeService a press uses."""

    def usage(self) -> Mapping[str, Any]: ...

    def jobs(self, **filters: Any) -> Sequence[Any]: ...

    def job(self, job_id: str) -> Any: ...

    def backend(self, name: str) -> BackendV2: ...


ServiceFactory = Callable[[Settings], ChipService]
Submit = Callable[..., Any]


def runtime_service(settings: Settings) -> ChipService:
    """The only place the service reaches IBM from. Built on the first press or poll."""
    return QiskitRuntimeService(
        channel=CHANNEL, token=settings.ibm_token, instance=settings.ibm_instance
    )


def check_gate(settings: Settings, passphrase: str | None) -> None:
    """Raises unless the mode lets this caller through. Never repeats what was sent."""
    if settings.chip_mode == "off":
        raise HTTPException(403, "Chip runs are off.")
    if settings.chip_mode == "public":
        return
    secret = settings.chip_passphrase
    if secret is None or not hmac.compare_digest((passphrase or "").encode(), secret.encode()):
        raise HTTPException(403, "Not allowed.")


def presses_left(created_today: int, per_day: int) -> bool:
    return created_today < per_day


def budget_allows(remaining_seconds: float, max_seconds: int, reserve_seconds: int) -> bool:
    """True if a job using its whole cap still leaves the reserve."""
    try:
        check_budget(remaining_seconds - reserve_seconds, max_seconds)
    except ValueError:
        return False
    return True


def qubits_tag(layout: Sequence[int]) -> str:
    player, partner = layout
    return f"qubits-{player}-{partner}"


def dial_tag(dial: float) -> str:
    return f"dial-{dial:g}"


def one_tag(tags: Sequence[str], pattern: re.Pattern[str]) -> re.Match[str]:
    found = [match for tag in tags if (match := pattern.fullmatch(tag))]
    if len(found) != 1:
        raise ValueError(f"a live job carries exactly one tag like {pattern.pattern}")
    return found[0]


def qubits_from_tags(tags: Sequence[str]) -> list[int]:
    match = one_tag(tags, QUBITS_TAG)
    return [int(match[1]), int(match[2])]


def dial_from_tags(tags: Sequence[str]) -> float:
    dial = float(one_tag(tags, DIAL_TAG)[1])
    if dial not in DIAL_GRID:
        raise ValueError(f"dial {dial} is not on the exported grid")
    return dial


class ChipInFlight(Exception):
    """A press found our own job still waiting. The caller is handed its id to follow."""

    def __init__(self, job_id: str) -> None:
        super().__init__(job_id)
        self.job_id = job_id


@contextmanager
def ibm_call() -> Iterator[None]:
    """IBM's errors can quote a request, so only their type is logged or answered."""
    try:
        yield
    except (HTTPException, ChipInFlight):
        raise
    except RuntimeJobNotFound:
        raise HTTPException(404, "No such chip run.") from None
    except Exception as error:
        log.warning("IBM call failed: %s", type(error).__name__)
        raise HTTPException(502, "IBM did not answer. Try again shortly.") from None


class LiveChip:
    """Presses and polls. Safe to call from worker threads."""

    def __init__(
        self,
        settings: Settings,
        service_factory: ServiceFactory = runtime_service,
        submit: Submit = sample,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._settings = settings
        self._factory = service_factory
        self._submit = submit
        self._now = now
        self._clock = clock
        self._service: ChipService | None = None
        self._failed_at: float | None = None
        self._building = threading.Lock()
        # Held from the first check to the submit, so two presses here cannot both pass.
        self._pressing = threading.Lock()
        self._caching = threading.Lock()
        self._finished: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self._waiting: dict[str, tuple[float, dict[str, Any]]] = {}

    def _ibm(self) -> ChipService:
        with self._building:
            if self._service is not None:
                return self._service
            if self._failed_at is not None and self._clock() - self._failed_at < SERVICE_RETRY_SECONDS:
                raise HTTPException(502, "IBM did not answer. Try again shortly.")
            try:
                self._service = self._factory(self._settings)
            except Exception:
                self._failed_at = self._clock()
                raise
            self._failed_at = None
            return self._service

    def press(self) -> dict[str, Any]:
        """Call only past the gate. Refuses unless every spending limit holds, then submits."""
        if not self._pressing.acquire(timeout=PRESS_WAIT_SECONDS):
            raise HTTPException(409, "A press is still being sent. Try again shortly.")
        try:
            with ibm_call():
                return self._press(self._ibm())
        finally:
            self._pressing.release()

    def _press(self, service: ChipService) -> dict[str, Any]:
        settings = self._settings
        # Any job on the account counts: IBM's usage figure leaves out queued and running jobs.
        pending = service.jobs(limit=PENDING_LOOKUP, pending=True)
        ours = [job for job in pending if TAG in (job.tags or [])]
        if ours:
            raise ChipInFlight(ours[0].job_id())
        if pending:
            raise HTTPException(409, "Another chip job is running on this account. Try again later.")
        recent = service.jobs(
            limit=settings.chip_presses_per_day,
            job_tags=[TAG],
            created_after=self._now() - DAY,
        )
        if not presses_left(len(recent), settings.chip_presses_per_day):
            raise HTTPException(429, "Today's chip presses are used up. Try again tomorrow.")
        remaining = service.usage().get("usage_remaining_seconds")
        if not isinstance(remaining, int | float) or not budget_allows(
            remaining, settings.chip_max_seconds, settings.chip_reserve_seconds
        ):
            raise HTTPException(409, "Not enough chip time left this month.")
        backend = service.backend(DEFAULT_BACKEND)
        layout = quietest_pair(backend)
        circuits = compile_job([LIVE_DIAL], backend, layout)
        for circuit in circuits:
            check_compiled(circuit, layout)
        job = self._submit(
            circuits,
            backend,
            LIVE_SHOTS,
            settings.chip_max_seconds,
            tags=[TAG, qubits_tag(layout), dial_tag(LIVE_DIAL)],
        )
        return {"status": "queued", "jobId": job.job_id(), "backend": backend.name}

    def poll(self, job_id: str) -> dict[str, Any]:
        """Any caller may poll, but only our own tagged jobs are served."""
        if self._settings.chip_mode == "off":
            raise HTTPException(403, "Chip runs are off.")
        if not JOB_ID.fullmatch(job_id):
            raise HTTPException(404, "No such chip run.")
        cached = self._cached(job_id)
        if cached is not None:
            return cached
        answer = self._fetch(job_id)
        self._keep(job_id, answer)
        return answer

    def _cached(self, job_id: str) -> dict[str, Any] | None:
        with self._caching:
            if job_id in self._finished:
                return self._finished[job_id]
            held = self._waiting.get(job_id)
            if held is not None and self._clock() - held[0] < STATUS_CACHE_SECONDS:
                return held[1]
            return None

    def _keep(self, job_id: str, answer: dict[str, Any]) -> None:
        with self._caching:
            if answer["status"] in FINAL:
                self._waiting.pop(job_id, None)
                self._finished[job_id] = answer
                while len(self._finished) > FINISHED_CACHE_JOBS:
                    self._finished.popitem(last=False)
                return
            now = self._clock()
            for stale in [key for key, (at, _) in self._waiting.items() if now - at >= STATUS_CACHE_SECONDS]:
                del self._waiting[stale]
            self._waiting[job_id] = (now, answer)

    def _fetch(self, job_id: str) -> dict[str, Any]:
        with ibm_call():
            # service.job() and status() each read the job once. Nothing public reads both together.
            job = self._ibm().job(job_id)
            tags = list(job.tags or [])
            if TAG not in tags:
                raise HTTPException(404, "No such chip run.")
            status = STATUSES.get(job.status(), "error")
            if status != "done":
                return {"status": status, "jobId": job_id}
            backend = job.backend().name
            result = job.result()
        try:
            return {"status": "done", "jobId": job_id, "result": live_result(job, backend, result, tags)}
        except (ValueError, KeyError, IndexError, AttributeError) as error:
            log.warning("chip job %s came back unreadable: %s", job_id, type(error).__name__)
            return {"status": "error", "jobId": job_id}


def live_result(job: Any, backend: str, result: Any, tags: Sequence[str]) -> dict[str, Any]:
    """A done job in the shape of a live CHSH result, labelled with its own chip, job and date."""
    dial = dial_from_tags(tags)
    shots = result[0].data.c.num_shots
    counts = counts_from_result(result, [dial], shots)
    run = run_from_counts(
        CHIP_SOURCE,
        backend,
        qubits_from_tags(tags),
        shots,
        job.creation_date.date(),
        job.job_id(),
        counts,
    )
    [point] = run["points"]
    return {
        "experiment": "chsh",
        "runId": run["id"],
        "outcomeOrder": "ba",
        **point,
        "provenance": run["provenance"],
    }
