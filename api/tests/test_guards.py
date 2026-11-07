import threading
from collections.abc import Iterator
from dataclasses import replace
from typing import Any

import pytest
from fastapi.testclient import TestClient

from api.guards import RateLimiter, client_key
from api.settings import Settings
from api.tests.conftest import MakeClient

SITE = "https://impossible-casino.vercel.app"
PING_BODY = {"dial": 0.5}


class StubEngine:
    def chsh(self, dial: float) -> dict[str, Any]:
        return {"dial": dial}

    def wiesner(self, length: int) -> dict[str, Any]:
        return {"length": length}


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def post(client: TestClient, **kwargs: Any) -> int:
    return client.post("/v1/chsh", json=PING_BODY, **kwargs).status_code


def test_a_client_over_its_limit_gets_429_with_a_wait(make_client: MakeClient) -> None:
    client = make_client(Settings(run_limit_per_minute=2), engine_factory=StubEngine)
    assert [post(client), post(client)] == [200, 200]
    response = client.post("/v1/chsh", json=PING_BODY)
    assert response.status_code == 429
    assert int(response.headers["retry-after"]) >= 1


def test_the_limit_is_shared_across_experiments(make_client: MakeClient) -> None:
    client = make_client(Settings(run_limit_per_minute=1), engine_factory=StubEngine)
    assert post(client) == 200
    assert client.post("/v1/wiesner", json={"length": 1}).status_code == 429


def test_refused_requests_still_count(make_client: MakeClient) -> None:
    client = make_client(Settings(run_limit_per_minute=1), engine_factory=StubEngine)
    assert client.post("/v1/chsh", json={"dial": 0.51}).status_code == 422
    assert post(client) == 429


def test_the_window_reopens(make_client: MakeClient) -> None:
    clock = Clock()
    client = make_client(Settings(run_limit_per_minute=1), engine_factory=StubEngine, clock=clock)
    assert [post(client), post(client)] == [200, 429]
    clock.now += 60
    assert post(client) == 200


def test_the_hourly_cap_holds_across_clients(make_client: MakeClient) -> None:
    clock = Clock()
    settings = Settings(run_cap_per_hour=2, trust_forwarded_for=True)
    client = make_client(settings, engine_factory=StubEngine, clock=clock)
    ips = [{"x-forwarded-for": f"203.0.113.{i}"} for i in range(3)]
    assert [post(client, headers=ip) for ip in ips] == [200, 200, 429]
    refused = client.post("/v1/wiesner", json={"length": 1})
    assert refused.status_code == 429
    assert int(refused.headers["retry-after"]) > 60
    clock.now += 3600
    assert post(client) == 200


def test_refused_requests_do_not_spend_the_hourly_cap(make_client: MakeClient) -> None:
    client = make_client(Settings(run_cap_per_hour=1), engine_factory=StubEngine)
    assert client.post("/v1/chsh", json={"dial": 0.51}).status_code == 422
    assert post(client) == 200


def test_a_custom_window_sets_the_wait() -> None:
    clock = Clock()
    limiter = RateLimiter(limit=1, max_clients=1, clock=clock, window_seconds=3600)
    assert limiter.check("all") is None
    clock.now += 600
    assert limiter.check("all") == 3000


def test_the_ping_is_not_limited(make_client: MakeClient) -> None:
    client = make_client(Settings(run_limit_per_minute=1), engine_factory=StubEngine)
    assert {client.get("/health").status_code for _ in range(5)} == {200}


def test_the_rightmost_forwarded_address_is_the_client(make_client: MakeClient) -> None:
    settings = Settings(run_limit_per_minute=1, trust_forwarded_for=True)
    client = make_client(settings, engine_factory=StubEngine)
    assert post(client, headers={"x-forwarded-for": "203.0.113.1"}) == 200
    # Forged left-hand entries change nothing: Cloud Run appended the real address.
    forged = {"x-forwarded-for": "10.0.0.1, 8.8.8.8, 203.0.113.1"}
    assert post(client, headers=forged) == 429
    assert post(client, headers={"x-forwarded-for": "203.0.113.2"}) == 200


def test_the_header_is_ignored_outside_cloud_run(make_client: MakeClient) -> None:
    client = make_client(Settings(run_limit_per_minute=1), engine_factory=StubEngine)
    assert post(client, headers={"x-forwarded-for": "203.0.113.1"}) == 200
    assert post(client, headers={"x-forwarded-for": "203.0.113.2"}) == 429


def test_an_ipv6_client_cannot_rotate_within_its_network() -> None:
    assert client_key("2001:db8:1:2::1") == client_key("2001:db8:1:2:ffff::9")
    assert client_key("2001:db8:1:2::1") != client_key("2001:db8:1:3::1")
    assert client_key("::ffff:203.0.113.5") == client_key("203.0.113.5")


def test_an_unreadable_address_shares_one_bucket() -> None:
    assert client_key("garbage") == client_key("") == client_key(None)


def test_the_limiter_cannot_grow_without_limit() -> None:
    clock = Clock()
    limiter = RateLimiter(limit=1, max_clients=100, clock=clock)
    for i in range(10_000):
        limiter.check(f"client-{i}")
    assert limiter.tracked <= 100


def test_full_limiter_drops_the_oldest_client_first() -> None:
    clock = Clock()
    limiter = RateLimiter(limit=1, max_clients=2, clock=clock)
    limiter.check("a")
    clock.now += 1
    limiter.check("b")
    clock.now += 1
    limiter.check("c")
    assert limiter.check("b") is not None
    assert limiter.check("a") is None


def test_a_declared_body_over_the_limit_gets_413(make_client: MakeClient) -> None:
    client = make_client(Settings(max_body_bytes=32), engine_factory=StubEngine)
    response = client.post("/v1/chsh", content=b"x" * 33)
    assert response.status_code == 413


def test_a_chunked_body_over_the_limit_gets_413(make_client: MakeClient) -> None:
    def chunks() -> Iterator[bytes]:
        yield b"x" * 20
        yield b"x" * 20

    client = make_client(Settings(max_body_bytes=32), engine_factory=StubEngine)
    response = client.post("/v1/chsh", content=chunks())
    assert response.status_code == 413


def test_a_body_at_the_limit_is_fine(make_client: MakeClient) -> None:
    body = b'{"dial": 0.5}'
    client = make_client(Settings(max_body_bytes=len(body)), engine_factory=StubEngine)
    response = client.post("/v1/chsh", content=body, headers={"content-type": "application/json"})
    assert response.status_code == 200


class BlockingEngine(StubEngine):
    def __init__(self) -> None:
        self.entered = threading.Event()
        self.release = threading.Event()

    def chsh(self, dial: float) -> dict[str, Any]:
        self.entered.set()
        assert self.release.wait(10)
        return super().chsh(dial)


def test_runs_past_the_cap_are_refused_at_once(make_client: MakeClient) -> None:
    engine = BlockingEngine()
    client = make_client(Settings(max_concurrent_runs=1), engine_factory=lambda: engine)
    results: list[int] = []
    held = threading.Thread(target=lambda: results.append(post(client)))
    held.start()
    assert engine.entered.wait(10)
    try:
        response = client.post("/v1/wiesner", json={"length": 1})
        assert response.status_code == 503
        assert "retry-after" in response.headers
        assert client.get("/health").status_code == 200
    finally:
        engine.release.set()
        held.join()
    assert results == [200]
    assert client.post("/v1/wiesner", json={"length": 1}).status_code == 200


def test_a_failed_run_frees_its_slot_and_hides_the_detail(make_client: MakeClient) -> None:
    class Broken(StubEngine):
        def chsh(self, dial: float) -> dict[str, Any]:
            raise RuntimeError("private detail")

    client = make_client(
        Settings(max_concurrent_runs=1), engine_factory=Broken, raise_server_exceptions=False
    )
    response = client.post("/v1/chsh", json=PING_BODY)
    assert response.status_code == 500
    assert "private detail" not in response.text
    assert client.post("/v1/wiesner", json={"length": 1}).status_code == 200


def cors(client: TestClient, origin: str) -> str | None:
    response = client.post("/v1/chsh", json=PING_BODY, headers={"origin": origin})
    return response.headers.get("access-control-allow-origin")


@pytest.mark.parametrize(
    "origin",
    [
        SITE,
        "https://impossible-casino-a1b2c3d4e-maddoxrjohnson.vercel.app",
        "http://localhost:5173",
        "http://localhost:5181",
        "http://127.0.0.1:4173",
    ],
)
def test_cors_allows_our_sites(make_client: MakeClient, origin: str) -> None:
    assert cors(make_client(engine_factory=StubEngine), origin) == origin


@pytest.mark.parametrize(
    "origin",
    [
        "https://evil.example",
        "http://impossible-casino.vercel.app",
        "https://impossible-casino.vercel.app.evil.example",
        "https://impossible-casino-a1b2-c3d4-maddoxrjohnson.vercel.app",
        "https://impossible-casino--maddoxrjohnson.vercel.app",
        "https://impossible-casino-a1b2c3d4e-maddoxrjohnson.vercel.app.evil.example",
        "https://ximpossible-casino-a1b2c3d4e-maddoxrjohnson.vercel.app",
        "https://impossible-casino-a1b2c3d4e-someone.vercel.app",
        "https://impossible-casino-a1b2c3d4eXmaddoxrjohnson.vercel.app",
        "https://localhost:5173",
        "http://localhost.evil.example:5173",
        "http://localhost",
        "null",
    ],
)
def test_cors_refuses_everyone_else(make_client: MakeClient, origin: str) -> None:
    assert cors(make_client(engine_factory=StubEngine), origin) is None


def test_a_preflight_passes_for_a_site_and_fails_for_a_stranger(make_client: MakeClient) -> None:
    client = make_client(engine_factory=StubEngine)
    ask = {"access-control-request-method": "POST", "access-control-request-headers": "content-type"}
    allowed = client.options("/v1/chsh", headers={"origin": SITE, **ask})
    assert allowed.status_code == 200
    assert allowed.headers["access-control-allow-origin"] == SITE
    refused = client.options("/v1/chsh", headers={"origin": "https://evil.example", **ask})
    assert refused.status_code == 400
    assert "access-control-allow-origin" not in refused.headers


def test_refusals_stay_readable_by_our_site(make_client: MakeClient) -> None:
    settings = replace(Settings(), run_limit_per_minute=1, max_body_bytes=32)
    client = make_client(settings, engine_factory=StubEngine)
    headers = {"origin": SITE}
    client.post("/v1/chsh", json=PING_BODY, headers=headers)
    limited = client.post("/v1/chsh", json=PING_BODY, headers=headers)
    assert limited.status_code == 429
    assert limited.headers["access-control-allow-origin"] == SITE
    huge = client.post("/v1/chsh", content=b"x" * 33, headers=headers)
    assert huge.status_code == 413
    assert huge.headers["access-control-allow-origin"] == SITE
