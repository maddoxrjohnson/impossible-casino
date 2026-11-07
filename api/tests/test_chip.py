import hmac
import json
import logging
import os
import re
import threading
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from qiskit_ibm_runtime.exceptions import RuntimeJobNotFound
from qiskit_ibm_runtime.fake_provider import FakeKingston

import api.chip
from api.chip import TAG, ChipInFlight, LiveChip, budget_allows, presses_left, live_result
from api.settings import Settings
from api.tests.conftest import MakeClient
from quantum.chsh import QUESTION_PAIRS

SECRET = "correct-horse-battery"
TOKEN = "ibm-token-that-must-never-show"
OWNER = Settings(chip_mode="owner", chip_passphrase=SECRET, ibm_token=TOKEN)
PATH = "/v1/chip/run"
JOB = "d0fakejob0000000000a"
NOW = datetime(2026, 11, 7, 12, 0, tzinfo=UTC)
SHOTS = 1024
# Made-up counts for a fake job. Each pair sums to SHOTS.
PAIR_COUNTS = {"00": 430, "01": 70, "10": 84, "11": 440}
CHIP_NAME = re.compile(r"^ibm_[a-z0-9_]+$")
LIVE_TAGS = [TAG, "qubits-61-62", "dial-0.5"]
# Read by web/src/game/press.test.ts, so both sides parse the same response.
FIXTURE = Path(__file__).parent / "fixtures" / "chip-press-done.json"


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


class StubEngine:
    def chsh(self, dial: float) -> dict[str, Any]:
        raise AssertionError

    def wiesner(self, length: int) -> dict[str, Any]:
        raise AssertionError


class FakeCounts:
    def __init__(self, counts: dict[str, int]) -> None:
        self._counts = counts
        self.num_shots = sum(counts.values())

    def get_counts(self) -> dict[str, int]:
        return dict(self._counts)


def fake_result(counts: dict[str, int] = PAIR_COUNTS) -> list[Any]:
    return [SimpleNamespace(data=SimpleNamespace(c=FakeCounts(counts))) for _ in QUESTION_PAIRS]


class FakeJob:
    def __init__(
        self,
        job_id: str = JOB,
        status: str = "QUEUED",
        tags: list[str] | None = None,
        created: datetime = NOW,
        backend: str = "ibm_kingston",
        result: list[Any] | None = None,
    ) -> None:
        self._id = job_id
        self._status = status
        self.tags = list(LIVE_TAGS) if tags is None else tags
        self.creation_date = created
        self._backend = backend
        self._result = result if result is not None else fake_result()

    def job_id(self) -> str:
        return self._id

    def status(self) -> str:
        return self._status

    def backend(self) -> Any:
        return SimpleNamespace(name=self._backend)

    def result(self) -> list[Any]:
        return self._result


@pytest.fixture(scope="module")
def device() -> FakeKingston:
    return FakeKingston()


class FakeService:
    def __init__(self, device: FakeKingston, remaining: float | None = 600) -> None:
        self.device = device
        self.remaining = remaining
        self.history: list[FakeJob] = []
        self.calls: list[str] = []
        self.fail: Exception | None = None

    def _call(self, name: str) -> None:
        self.calls.append(name)
        if self.fail is not None:
            raise self.fail

    def usage(self) -> dict[str, Any]:
        self._call("usage")
        return {} if self.remaining is None else {"usage_remaining_seconds": self.remaining}

    def jobs(
        self,
        limit: int | None = 10,
        pending: bool | None = None,
        job_tags: list[str] | None = None,
        created_after: datetime | None = None,
    ) -> list[FakeJob]:
        self._call("jobs")
        found = [
            job
            for job in self.history
            if set(job_tags or []) <= set(job.tags)
            and (pending is None or (job.status() in ("QUEUED", "RUNNING")) == pending)
            and (created_after is None or job.creation_date >= created_after)
        ]
        return found if limit is None else found[:limit]

    def job(self, job_id: str) -> FakeJob:
        self._call("job")
        for job in self.history:
            if job.job_id() == job_id:
                return job
        raise RuntimeJobNotFound(f"Job not found: {job_id}")

    def backend(self, name: str) -> FakeKingston:
        self._call("backend")
        return self.device


class Submitter:
    def __init__(self, service: FakeService) -> None:
        self.service = service
        self.calls: list[dict[str, Any]] = []

    def __call__(
        self,
        pubs: Sequence[Any],
        backend: Any,
        shots: int,
        max_seconds: int,
        tags: Sequence[str] = (),
    ) -> FakeJob:
        self.calls.append(
            {"pubs": list(pubs), "shots": shots, "max_seconds": max_seconds, "tags": list(tags)}
        )
        job = FakeJob(job_id=f"d0press{len(self.calls):014d}", tags=list(tags))
        self.service.history.append(job)
        return job


@pytest.fixture
def ibm(device: FakeKingston) -> FakeService:
    return FakeService(device)


@pytest.fixture
def submitter(ibm: FakeService) -> Submitter:
    return Submitter(ibm)


def client_for(
    make_client: MakeClient,
    settings: Settings,
    ibm: FakeService | None = None,
    submitter: Submitter | None = None,
    **options: Any,
) -> TestClient:
    def service(_: Settings) -> Any:
        if ibm is None:
            raise AssertionError("the gate let a refused caller reach IBM")
        return ibm

    def submit(*args: Any, **kwargs: Any) -> Any:
        if submitter is None:
            raise AssertionError("nothing should be submitted")
        return submitter(*args, **kwargs)

    options.setdefault("clock", FakeClock())
    return make_client(
        settings,
        engine_factory=StubEngine,
        chip_service=service,
        chip_submit=submit,
        chip_now=lambda: NOW,
        **options,
    )


# The gate


def test_off_refuses_even_the_right_passphrase(make_client: MakeClient) -> None:
    settings = Settings(chip_mode="off", chip_passphrase=SECRET)
    response = client_for(make_client, settings).post(PATH, json={"passphrase": SECRET})
    assert response.status_code == 403


@pytest.mark.parametrize("body", [{}, {"passphrase": ""}, {"passphrase": "guess"}, {"passphrase": None}])
def test_owner_refuses_a_wrong_or_missing_passphrase(
    make_client: MakeClient, body: dict[str, Any]
) -> None:
    assert client_for(make_client, OWNER).post(PATH, json=body).status_code == 403


def test_a_non_ascii_passphrase_is_a_refusal_not_a_crash(make_client: MakeClient) -> None:
    response = client_for(make_client, OWNER).post(PATH, json={"passphrase": "pässwörd"})
    assert response.status_code == 403


def test_public_needs_no_passphrase(
    make_client: MakeClient, ibm: FakeService, submitter: Submitter
) -> None:
    client = client_for(make_client, Settings(chip_mode="public", ibm_token=TOKEN), ibm, submitter)
    assert client.post(PATH, json={}).status_code == 200


def test_the_check_is_constant_time(make_client: MakeClient, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[bytes, bytes]] = []
    compare = hmac.compare_digest

    def spy(given: bytes, secret: bytes) -> bool:
        calls.append((given, secret))
        return compare(given, secret)

    monkeypatch.setattr(api.chip.hmac, "compare_digest", spy)
    client_for(make_client, OWNER).post(PATH, json={"passphrase": "guess"})
    assert calls == [(b"guess", SECRET.encode())]


def test_guesses_hit_the_rate_limit_before_the_check(make_client: MakeClient) -> None:
    settings = Settings(
        chip_mode="owner", chip_passphrase=SECRET, ibm_token=TOKEN, chip_limit_per_minute=2
    )
    client = client_for(make_client, settings)
    assert client.post(PATH, json={"passphrase": "a"}).status_code == 403
    assert client.post(PATH, json={"passphrase": "b"}).status_code == 403
    assert client.post(PATH, json={"passphrase": SECRET}).status_code == 429


def test_chip_guesses_have_their_own_limit(make_client: MakeClient) -> None:
    settings = Settings(chip_mode="off", chip_limit_per_minute=1)
    client = client_for(make_client, settings)
    assert client.post(PATH, json={}).status_code == 403
    assert client.post(PATH, json={}).status_code == 429
    assert client.get("/health").status_code == 200


def test_a_refused_caller_never_reaches_ibm(make_client: MakeClient, ibm: FakeService) -> None:
    client = client_for(make_client, OWNER, ibm)
    assert client.post(PATH, json={"passphrase": "guess"}).status_code == 403
    assert ibm.calls == []


def test_nothing_reaches_ibm_at_startup(make_client: MakeClient) -> None:
    built: list[int] = []

    def service(_: Settings) -> Any:
        built.append(1)
        raise AssertionError

    client = make_client(OWNER, engine_factory=StubEngine, chip_service=service)
    assert client.get("/health").status_code == 200
    assert built == []


# A press


def test_a_press_submits_one_tagged_capped_job_at_the_middle_dial(
    make_client: MakeClient, ibm: FakeService, submitter: Submitter
) -> None:
    response = client_for(make_client, OWNER, ibm, submitter).post(
        PATH, json={"passphrase": SECRET}
    )
    assert response.status_code == 200
    [call] = submitter.calls
    job_id = ibm.history[-1].job_id()
    assert response.json() == {"status": "queued", "jobId": job_id, "backend": ibm.device.name}
    assert call["shots"] == SHOTS
    assert call["max_seconds"] == OWNER.chip_max_seconds
    assert len(call["pubs"]) == len(QUESTION_PAIRS)
    assert TAG in call["tags"]
    assert any(re.fullmatch(r"qubits-\d+-\d+", tag) for tag in call["tags"])
    assert "dial-0.5" in call["tags"]


def test_the_checks_run_in_order_before_submitting(
    make_client: MakeClient, ibm: FakeService, submitter: Submitter
) -> None:
    client_for(make_client, OWNER, ibm, submitter).post(PATH, json={"passphrase": SECRET})
    assert ibm.calls[:3] == ["jobs", "jobs", "usage"]


def test_one_in_flight_hands_back_the_job_to_follow(
    make_client: MakeClient, ibm: FakeService, submitter: Submitter
) -> None:
    ibm.history.append(FakeJob(job_id="d0other0000000000000", status="RUNNING"))
    response = client_for(make_client, OWNER, ibm, submitter).post(
        PATH, json={"passphrase": SECRET}
    )
    assert response.status_code == 409
    assert response.json() == {
        "detail": "A chip run is already in flight.",
        "jobId": "d0other0000000000000",
    }
    assert submitter.calls == []
    assert "usage" not in ibm.calls


def test_a_refused_caller_is_not_handed_a_job(make_client: MakeClient, ibm: FakeService) -> None:
    ibm.history.append(FakeJob(job_id="d0other0000000000000", status="RUNNING"))
    response = client_for(make_client, OWNER, ibm).post(PATH, json={"passphrase": "guess"})
    assert response.status_code == 403
    assert "d0other" not in response.text


def test_any_job_in_flight_on_the_account_blocks_a_press(
    make_client: MakeClient, ibm: FakeService, submitter: Submitter
) -> None:
    ibm.history.append(FakeJob(job_id="d0cage00000000000000", status="QUEUED", tags=[]))
    response = client_for(make_client, OWNER, ibm, submitter).post(
        PATH, json={"passphrase": SECRET}
    )
    assert response.status_code == 409
    assert "Another chip job" in response.json()["detail"]
    assert "jobId" not in response.json()
    assert "d0cage" not in response.text
    assert submitter.calls == []


def test_two_presses_at_once_submit_one_job(ibm: FakeService) -> None:
    started, release = threading.Event(), threading.Event()
    submitted: list[int] = []

    def slow_submit(*_: Any, tags: Sequence[str] = ()) -> FakeJob:
        started.set()
        release.wait(5)
        submitted.append(1)
        job = FakeJob(tags=list(tags))
        ibm.history.append(job)
        return job

    chip = LiveChip(OWNER, lambda _: ibm, slow_submit, lambda: NOW)
    outcomes: list[Any] = []

    def press() -> None:
        try:
            outcomes.append(chip.press())
        except ChipInFlight as error:
            outcomes.append(error)

    first = threading.Thread(target=press)
    first.start()
    assert started.wait(30)
    second = threading.Thread(target=press)
    second.start()
    second.join(0.2)
    assert second.is_alive()
    release.set()
    first.join(5)
    second.join(5)
    assert submitted == [1]
    [accepted] = [o for o in outcomes if isinstance(o, dict)]
    [refused] = [o for o in outcomes if isinstance(o, ChipInFlight)]
    assert accepted["jobId"] == JOB
    assert refused.job_id == JOB


def test_the_press_cap_counts_tagged_jobs_from_the_last_day(
    make_client: MakeClient, ibm: FakeService, submitter: Submitter
) -> None:
    settings = Settings(
        chip_mode="owner", chip_passphrase=SECRET, ibm_token=TOKEN, chip_presses_per_day=2
    )
    ibm.history += [
        FakeJob(job_id="d0old000000000000000", status="DONE", created=NOW - timedelta(hours=25)),
        FakeJob(job_id="d0new000000000000000", status="DONE", created=NOW - timedelta(hours=2)),
    ]
    client = client_for(make_client, settings, ibm, submitter)
    assert client.post(PATH, json={"passphrase": SECRET}).status_code == 200
    ibm.history[-1]._status = "DONE"
    refused = client.post(PATH, json={"passphrase": SECRET})
    assert refused.status_code == 429
    assert "today" in refused.json()["detail"].lower()
    assert len(submitter.calls) == 1


@pytest.mark.parametrize("remaining", [309, 0, None])
def test_the_budget_floor_refuses_a_press_that_would_dip_into_the_reserve(
    make_client: MakeClient, ibm: FakeService, submitter: Submitter, remaining: float | None
) -> None:
    ibm.remaining = remaining
    response = client_for(make_client, OWNER, ibm, submitter).post(
        PATH, json={"passphrase": SECRET}
    )
    assert response.status_code == 409
    assert "chip time" in response.json()["detail"]
    assert submitter.calls == []


def test_the_budget_floor_allows_exactly_the_reserve(
    make_client: MakeClient, ibm: FakeService, submitter: Submitter
) -> None:
    ibm.remaining = 310
    response = client_for(make_client, OWNER, ibm, submitter).post(
        PATH, json={"passphrase": SECRET}
    )
    assert response.status_code == 200


@pytest.mark.parametrize(
    ("created", "per_day", "allowed"), [(0, 12, True), (11, 12, True), (12, 12, False), (13, 12, False)]
)
def test_presses_left(created: int, per_day: int, allowed: bool) -> None:
    assert presses_left(created, per_day) is allowed


@pytest.mark.parametrize(
    ("remaining", "allowed"), [(310, True), (310.5, True), (309.9, False), (0, False), (-5, False)]
)
def test_budget_allows(remaining: float, allowed: bool) -> None:
    assert budget_allows(remaining, max_seconds=10, reserve_seconds=300) is allowed


# Polling


def poll(client: TestClient, job_id: str = JOB) -> Any:
    return client.get(f"{PATH}/{job_id}")


@pytest.mark.parametrize(
    ("ibm_status", "status"),
    [
        ("INITIALIZING", "queued"),
        ("QUEUED", "queued"),
        ("RUNNING", "running"),
        ("CANCELLED", "cancelled"),
        ("ERROR", "error"),
    ],
)
def test_poll_maps_ibm_status_with_no_numbers(
    make_client: MakeClient, ibm: FakeService, ibm_status: str, status: str
) -> None:
    ibm.history.append(FakeJob(status=ibm_status))
    response = poll(client_for(make_client, OWNER, ibm))
    assert response.status_code == 200
    assert response.json() == {"status": status, "jobId": JOB}


def test_poll_needs_no_passphrase(make_client: MakeClient, ibm: FakeService) -> None:
    ibm.history.append(FakeJob(status="QUEUED"))
    assert poll(client_for(make_client, OWNER, ibm)).status_code == 200


def test_poll_is_refused_when_chip_runs_are_off(make_client: MakeClient, ibm: FakeService) -> None:
    assert poll(client_for(make_client, Settings(), ibm)).status_code == 403
    assert ibm.calls == []


def test_an_untagged_job_is_not_served(make_client: MakeClient, ibm: FakeService) -> None:
    ibm.history.append(FakeJob(status="DONE", tags=["someone-else"]))
    response = poll(client_for(make_client, OWNER, ibm))
    assert response.status_code == 404
    assert "counts" not in response.text


def test_an_unknown_job_is_not_found(make_client: MakeClient, ibm: FakeService) -> None:
    assert poll(client_for(make_client, OWNER, ibm), "d0missing00000000000").status_code == 404


@pytest.mark.parametrize("job_id", ["x", "UPPERCASE0000000000", "a" * 65, "abc-def-ghi-jkl", "%2e%2e"])
def test_a_bad_job_id_never_reaches_ibm(
    make_client: MakeClient, ibm: FakeService, job_id: str
) -> None:
    response = poll(client_for(make_client, OWNER, ibm), job_id)
    assert response.status_code == 404
    assert ibm.calls == []


def test_polls_are_rate_limited(make_client: MakeClient, ibm: FakeService) -> None:
    ibm.history.append(FakeJob(status="QUEUED"))
    settings = Settings(
        chip_mode="owner", chip_passphrase=SECRET, ibm_token=TOKEN, chip_poll_limit_per_minute=2
    )
    client = client_for(make_client, settings, ibm)
    assert [poll(client).status_code for _ in range(3)] == [200, 200, 429]


def test_polls_have_a_service_wide_cap(make_client: MakeClient, ibm: FakeService) -> None:
    ibm.history.append(FakeJob(status="QUEUED"))
    settings = Settings(
        chip_mode="owner", chip_passphrase=SECRET, ibm_token=TOKEN, chip_poll_cap_per_minute=2
    )
    client = client_for(make_client, settings, ibm)
    other = TestClient(client.app, client=("203.0.113.9", 50000))
    assert poll(client).status_code == 200
    assert poll(other).status_code == 200
    assert poll(client).status_code == 429
    assert poll(other).status_code == 429


def test_a_waiting_status_is_reused_briefly(make_client: MakeClient, ibm: FakeService) -> None:
    job = FakeJob(status="QUEUED")
    ibm.history.append(job)
    clock = FakeClock()
    client = client_for(make_client, OWNER, ibm, clock=clock)
    assert poll(client).json()["status"] == "queued"
    job._status = "RUNNING"
    clock.now = 4.9
    assert poll(client).json()["status"] == "queued"
    assert ibm.calls.count("job") == 1
    clock.now = 5.0
    assert poll(client).json()["status"] == "running"
    assert ibm.calls.count("job") == 2


@pytest.mark.parametrize("end", ["DONE", "CANCELLED", "ERROR"])
def test_a_finished_job_is_read_from_ibm_once(
    make_client: MakeClient, ibm: FakeService, end: str
) -> None:
    ibm.history.append(FakeJob(status=end))
    clock = FakeClock()
    client = client_for(make_client, OWNER, ibm, clock=clock)
    first = poll(client).json()
    clock.now = 3600
    assert poll(client).json() == first
    assert ibm.calls.count("job") == 1


def test_a_service_that_fails_to_build_is_not_rebuilt_on_every_poll(
    make_client: MakeClient, ibm: FakeService
) -> None:
    built: list[int] = []
    clock = FakeClock()

    def service(_: Settings) -> Any:
        built.append(1)
        if len(built) == 1:
            raise RuntimeError("401")
        return ibm

    ibm.history.append(FakeJob(status="QUEUED"))
    client = make_client(
        OWNER, engine_factory=StubEngine, chip_service=service, clock=clock
    )
    assert poll(client).status_code == 502
    clock.now = 30
    assert poll(client).status_code == 502
    assert built == [1]
    clock.now = 61
    assert poll(client).status_code == 200
    assert built == [1, 1]


def test_polls_do_not_use_up_presses(
    make_client: MakeClient, ibm: FakeService, submitter: Submitter
) -> None:
    settings = Settings(
        chip_mode="owner", chip_passphrase=SECRET, ibm_token=TOKEN, chip_limit_per_minute=1
    )
    ibm.history.append(FakeJob(job_id="d0done00000000000000", status="DONE"))
    client = client_for(make_client, settings, ibm, submitter)
    for _ in range(3):
        poll(client, "d0done00000000000000")
    assert client.post(PATH, json={"passphrase": SECRET}).status_code == 200


def done_body(make_client: MakeClient, ibm: FakeService) -> dict[str, Any]:
    ibm.history.append(FakeJob(status="DONE"))
    response = poll(client_for(make_client, OWNER, ibm))
    assert response.status_code == 200
    return response.json()


def test_a_done_job_carries_its_chip_result_and_label(
    make_client: MakeClient, ibm: FakeService
) -> None:
    body = done_body(make_client, ibm)
    assert body["status"] == "done"
    assert body["jobId"] == JOB
    result = body["result"]
    assert result["experiment"] == "chsh"
    assert result["dial"] == 0.5
    assert result["outcomeOrder"] == "ba"
    provenance = result["provenance"]
    assert provenance["source"] == "ibm-chip"
    assert provenance["backend"] == "ibm_kingston"
    assert provenance["jobId"] == JOB
    assert provenance["qubits"] == [61, 62]
    assert provenance["date"] == NOW.date().isoformat()
    assert provenance["shots"] == SHOTS


def test_a_done_result_passes_the_web_parser_rules(
    make_client: MakeClient, ibm: FakeService
) -> None:
    """Mirrors parseLiveChipChsh and parseProvenance in web/src/game/results.ts."""
    result = done_body(make_client, ibm)["result"]
    assert isinstance(result["runId"], str) and result["runId"]
    assert 0 <= result["winRate"] <= 1
    pairs = result["pairs"]
    assert sorted((p["x"], p["y"]) for p in pairs) == sorted(QUESTION_PAIRS)
    for pair in pairs:
        assert set(pair["counts"]) == {"00", "01", "10", "11"}
        assert sum(pair["counts"].values()) == pair["shots"] == SHOTS
        assert 0 <= pair["winRate"] <= 1
    provenance = result["provenance"]
    assert provenance["shots"] == pairs[0]["shots"]
    assert provenance["noiseModel"] is None
    assert CHIP_NAME.match(provenance["backend"])
    assert provenance["jobId"].strip()
    assert provenance["qubitSelection"].strip()
    assert all(isinstance(q, int) and q >= 0 for q in provenance["qubits"])
    for key in ("qiskitVersion", "aerVersion", "runtimeVersion", "date"):
        assert isinstance(provenance[key], str) and provenance[key]


def test_a_done_job_on_a_non_chip_backend_is_an_error(
    make_client: MakeClient, ibm: FakeService
) -> None:
    ibm.history.append(FakeJob(status="DONE", backend="fake_kingston"))
    body = poll(client_for(make_client, OWNER, ibm)).json()
    assert body == {"status": "error", "jobId": JOB}


@pytest.mark.parametrize(
    "tags",
    [
        [TAG, "dial-0.5"],
        [TAG, "qubits-61-62"],
        [TAG, "qubits-61-62", "dial-0.3"],
        [TAG, "qubits-61-62", "dial-0.5", "dial-0.25"],
    ],
)
def test_a_done_job_without_its_qubit_or_dial_tag_is_an_error(
    make_client: MakeClient, ibm: FakeService, tags: list[str]
) -> None:
    ibm.history.append(FakeJob(status="DONE", tags=tags))
    assert poll(client_for(make_client, OWNER, ibm)).json() == {"status": "error", "jobId": JOB}


def test_the_dial_comes_from_the_job(make_client: MakeClient, ibm: FakeService) -> None:
    ibm.history.append(FakeJob(status="DONE", tags=[TAG, "qubits-61-62", "dial-0.25"]))
    assert poll(client_for(make_client, OWNER, ibm)).json()["result"]["dial"] == 0.25


def test_the_shared_fixture_is_what_the_service_answers() -> None:
    """Regenerate with WRITE_CHIP_FIXTURE=1 after a deliberate change to the response."""
    job = FakeJob(status="DONE")
    body = {
        "status": "done",
        "jobId": JOB,
        "result": live_result(job, "ibm_kingston", job.result(), job.tags),
    }
    if os.environ.get("WRITE_CHIP_FIXTURE"):
        FIXTURE.parent.mkdir(exist_ok=True)
        FIXTURE.write_text(json.dumps(body, indent=1) + "\n")
    assert json.loads(FIXTURE.read_text()) == body


def test_a_done_job_with_short_counts_is_an_error(
    make_client: MakeClient, ibm: FakeService
) -> None:
    ibm.history.append(FakeJob(status="DONE", result=fake_result()[:3]))
    assert poll(client_for(make_client, OWNER, ibm)).json() == {"status": "error", "jobId": JOB}


# Secrets


def test_ibm_failures_hide_their_text(
    make_client: MakeClient,
    ibm: FakeService,
    submitter: Submitter,
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG)
    ibm.fail = RuntimeError(f"401 for token {TOKEN} and {SECRET}")
    client = client_for(make_client, OWNER, ibm, submitter)
    responses = [client.post(PATH, json={"passphrase": SECRET}), poll(client)]
    for response in responses:
        assert response.status_code == 502
        assert TOKEN not in response.text
        assert SECRET not in response.text
    assert TOKEN not in caplog.text
    assert SECRET not in caplog.text


def test_a_service_that_cannot_be_built_hides_its_text(
    make_client: MakeClient, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)

    def service(_: Settings) -> Any:
        raise ValueError(f"bad token {TOKEN}")

    client = make_client(OWNER, engine_factory=StubEngine, chip_service=service)
    response = client.post(PATH, json={"passphrase": SECRET})
    assert response.status_code == 502
    assert TOKEN not in response.text
    assert TOKEN not in caplog.text


def test_the_service_gets_the_token_and_instance(
    make_client: MakeClient, ibm: FakeService, submitter: Submitter
) -> None:
    seen: list[Settings] = []

    def service(settings: Settings) -> Any:
        seen.append(settings)
        return ibm

    client = make_client(
        OWNER, engine_factory=StubEngine, chip_service=service, chip_submit=submitter
    )
    client.post(PATH, json={"passphrase": SECRET})
    poll(client)
    assert [s.ibm_token for s in seen] == [TOKEN]


@pytest.mark.parametrize(
    "body",
    [
        {"passphrase": SECRET},
        {"passphrase": 12345, "note": SECRET},
        {"passphrase": SECRET, "extra": True},
        {"passphrase": SECRET + "x" * 1000},
    ],
)
def test_no_response_or_log_repeats_a_secret(
    make_client: MakeClient,
    ibm: FakeService,
    submitter: Submitter,
    caplog: pytest.LogCaptureFixture,
    body: dict[str, Any],
) -> None:
    caplog.set_level(logging.DEBUG)
    settings = Settings(
        chip_mode="owner", chip_passphrase=SECRET, ibm_token=TOKEN, max_body_bytes=4096
    )
    response = client_for(make_client, settings, ibm, submitter).post(PATH, json=body)
    for secret in (SECRET, TOKEN):
        assert secret not in response.text
        assert secret not in str(dict(response.headers))
        assert secret not in caplog.text


def test_the_runtime_factory_asks_for_the_platform_channel(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: dict[str, Any] = {}

    def fake(**kwargs: Any) -> str:
        seen.update(kwargs)
        return "service"

    monkeypatch.setattr(api.chip, "QiskitRuntimeService", fake)
    assert api.chip.runtime_service(OWNER) == "service"
    assert seen == {"channel": "ibm_quantum_platform", "token": TOKEN, "instance": "open-instance"}


def test_validation_errors_never_echo_input(make_client: MakeClient) -> None:
    response = client_for(make_client, Settings()).post("/v1/chsh", json={"dial": "secret-looking"})
    assert response.status_code == 422
    assert "secret-looking" not in response.text


def test_the_trap_on_ibm_gets_past_the_catch_alls() -> None:
    from api.tests.conftest import RuntimeServiceTouched

    with pytest.raises(RuntimeServiceTouched):
        LiveChip(OWNER).poll(JOB)
