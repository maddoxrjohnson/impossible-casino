"""Shared fixtures. The noisy simulators take seconds to build, so tests share one engine."""

from collections.abc import Callable, Iterator
from typing import Any

import pytest
import qiskit_ibm_runtime
from fastapi.testclient import TestClient

from api.engine import Engine
from api.main import create_app
from api.settings import Settings


class RuntimeServiceTouched(BaseException):
    """Not an Exception, so the service's own catch-alls cannot turn it into a 502."""


def _no_runtime_service(*_args: Any, **_kwargs: Any) -> None:
    raise RuntimeServiceTouched("tests must never construct QiskitRuntimeService")


@pytest.fixture(scope="session", autouse=True)
def runtime_service_trap() -> Iterator[None]:
    """Every test, and the engine build, fails if anything touches IBM's service."""
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(qiskit_ibm_runtime.QiskitRuntimeService, "__init__", _no_runtime_service)
        yield


@pytest.fixture(scope="session")
def engine(runtime_service_trap: None) -> Engine:
    return Engine()


MakeClient = Callable[..., TestClient]


@pytest.fixture
def make_client(engine: Engine) -> Iterator[MakeClient]:
    opened: list[TestClient] = []

    def make(
        settings: Settings | None = None,
        client: tuple[str, int] = ("198.51.100.7", 50000),
        raise_server_exceptions: bool = True,
        **app_options: Any,
    ) -> TestClient:
        app_options.setdefault("engine_factory", lambda: engine)
        app = create_app(settings or Settings(), **app_options)
        test_client = TestClient(
            app, client=client, raise_server_exceptions=raise_server_exceptions
        )
        test_client.__enter__()
        opened.append(test_client)
        return test_client

    yield make
    for test_client in opened:
        test_client.__exit__(None, None, None)
