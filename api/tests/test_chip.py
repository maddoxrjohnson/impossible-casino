import hmac
import logging
from typing import Any

import pytest
from fastapi.testclient import TestClient

import api.chip
from api.settings import Settings
from api.tests.conftest import MakeClient

SECRET = "correct-horse-battery"
OWNER = Settings(chip_mode="owner", chip_passphrase=SECRET)
PATH = "/v1/chip/run"


class StubEngine:
    def chsh(self, dial: float) -> dict[str, Any]:
        raise AssertionError

    def wiesner(self, length: int) -> dict[str, Any]:
        raise AssertionError


def client_for(make_client: MakeClient, settings: Settings, **options: Any) -> TestClient:
    return make_client(settings, engine_factory=StubEngine, **options)


def test_off_refuses_even_the_right_passphrase(make_client: MakeClient) -> None:
    settings = Settings(chip_mode="off", chip_passphrase=SECRET)
    response = client_for(make_client, settings).post(PATH, json={"passphrase": SECRET})
    assert response.status_code == 403


@pytest.mark.parametrize("body", [{}, {"passphrase": ""}, {"passphrase": "guess"}, {"passphrase": None}])
def test_owner_refuses_a_wrong_or_missing_passphrase(
    make_client: MakeClient, body: dict[str, Any]
) -> None:
    assert client_for(make_client, OWNER).post(PATH, json=body).status_code == 403


def test_owner_with_the_passphrase_reaches_the_not_enabled_seam(make_client: MakeClient) -> None:
    response = client_for(make_client, OWNER).post(PATH, json={"passphrase": SECRET})
    assert response.status_code == 501
    assert response.json()["status"] == "not-enabled"


def test_a_non_ascii_passphrase_is_a_refusal_not_a_crash(make_client: MakeClient) -> None:
    response = client_for(make_client, OWNER).post(PATH, json={"passphrase": "pässwörd"})
    assert response.status_code == 403


def test_public_needs_no_passphrase(make_client: MakeClient) -> None:
    client = client_for(make_client, Settings(chip_mode="public"))
    assert client.post(PATH, json={}).status_code == 501


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
    settings = Settings(chip_mode="owner", chip_passphrase=SECRET, chip_limit_per_minute=2)
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


def test_the_runner_only_runs_behind_the_gate(make_client: MakeClient) -> None:
    calls: list[int] = []

    def runner() -> dict[str, Any]:
        calls.append(1)
        return {"status": "queued"}

    client = client_for(make_client, OWNER, chip_runner=runner)
    assert client.post(PATH, json={"passphrase": "guess"}).status_code == 403
    assert calls == []
    accepted = client.post(PATH, json={"passphrase": SECRET})
    assert accepted.status_code == 200
    assert accepted.json() == {"status": "queued"}
    assert calls == [1]


@pytest.mark.parametrize(
    "body",
    [
        {"passphrase": SECRET},
        {"passphrase": 12345, "note": SECRET},
        {"passphrase": SECRET, "extra": True},
        {"passphrase": SECRET + "x" * 1000},
    ],
)
def test_no_response_or_log_repeats_a_passphrase(
    make_client: MakeClient, caplog: pytest.LogCaptureFixture, body: dict[str, Any]
) -> None:
    caplog.set_level(logging.DEBUG)
    settings = Settings(chip_mode="owner", chip_passphrase=SECRET, max_body_bytes=4096)
    response = client_for(make_client, settings).post(PATH, json=body)
    assert SECRET not in response.text
    assert SECRET not in str(dict(response.headers))
    assert SECRET not in caplog.text


def test_validation_errors_never_echo_input(make_client: MakeClient) -> None:
    response = client_for(make_client, Settings()).post("/v1/chsh", json={"dial": "secret-looking"})
    assert response.status_code == 422
    assert "secret-looking" not in response.text
