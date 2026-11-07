"""The Impossible Casino API. Run with: uvicorn --factory api.main:create_app"""

import asyncio
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Annotated, Any, Protocol

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import AfterValidator, BaseModel, ConfigDict, Field

from api.chip import ChipNotEnabled, ChipRunner, check_gate, not_enabled
from api.engine import Engine
from api.guards import BodySizeLimit, RateLimiter, RunSlots, client_address, client_key
from api.settings import Settings
from quantum.export_chsh import DIAL_GRID
from quantum.wiesner import MAX_LENGTH

MAX_PASSPHRASE_CHARS = 256
PREFLIGHT_CACHE_SECONDS = 600
HOUR_SECONDS = 3600
SERVICE_WIDE = "all"


class Simulations(Protocol):
    def chsh(self, dial: float) -> dict[str, Any]: ...

    def wiesner(self, length: int) -> dict[str, Any]: ...


def on_grid(dial: float) -> float:
    if dial not in DIAL_GRID:
        raise ValueError("dial is not on the exported grid")
    return dial


class ChshRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    dial: Annotated[float, AfterValidator(on_grid)]


class WiesnerRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    length: int = Field(ge=1, le=MAX_LENGTH)


class ChipRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    passphrase: str | None = Field(default=None, max_length=MAX_PASSPHRASE_CHARS)


def create_app(
    settings: Settings | None = None,
    engine_factory: Callable[[], Simulations] = Engine,
    chip_runner: ChipRunner = not_enabled,
    clock: Callable[[], float] = time.monotonic,
) -> FastAPI:
    config = Settings.from_env() if settings is None else settings
    slots = RunSlots(config.max_concurrent_runs)
    run_limit = RateLimiter(config.run_limit_per_minute, config.max_clients, clock)
    chip_limit = RateLimiter(config.chip_limit_per_minute, config.max_clients, clock)
    hourly_cap = RateLimiter(config.run_cap_per_hour, 1, clock, HOUR_SECONDS)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # Uvicorn binds the port after this, so a successful ping means runs are ready.
        app.state.engine = await asyncio.to_thread(engine_factory)
        yield
        slots.close()

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.add_middleware(BodySizeLimit, max_bytes=config.max_body_bytes)
    # Outermost, so a refusal is still readable by the site.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=config.cors_origins,
        allow_origin_regex=config.cors_origin_regex,
        allow_methods=["GET", "POST"],
        allow_headers=["content-type"],
        max_age=PREFLIGHT_CACHE_SECONDS,
    )

    def limited_by(limiter: RateLimiter) -> Callable[[Request], None]:
        def check(request: Request) -> None:
            address = client_address(request, config.trust_forwarded_for)
            wait = limiter.check(client_key(address))
            if wait is not None:
                raise HTTPException(429, "Too many requests.", {"Retry-After": str(wait)})

        return check

    run_guard = Depends(limited_by(run_limit))
    chip_guard = Depends(limited_by(chip_limit))

    async def simulate(work: Callable[[], dict[str, Any]]) -> dict[str, Any]:
        wait = hourly_cap.check(SERVICE_WIDE)
        if wait is not None:
            raise HTTPException(429, "Too many requests.", {"Retry-After": str(wait)})
        return await slots.run(work)

    @app.exception_handler(RequestValidationError)
    async def refuse_quietly(_: Request, __: RequestValidationError) -> JSONResponse:
        # The default handler echoes the input, which could be a passphrase.
        return JSONResponse({"detail": "Invalid request."}, status_code=422)

    @app.exception_handler(ChipNotEnabled)
    async def chip_not_enabled(_: Request, __: ChipNotEnabled) -> JSONResponse:
        return JSONResponse(
            {"status": "not-enabled", "detail": "Chip runs are not enabled on this service."},
            status_code=501,
        )

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/v1/chsh", dependencies=[run_guard])
    async def chsh(body: ChshRequest, request: Request) -> dict[str, Any]:
        engine: Simulations = request.app.state.engine
        return await simulate(lambda: engine.chsh(body.dial))

    @app.post("/v1/wiesner", dependencies=[run_guard])
    async def wiesner(body: WiesnerRequest, request: Request) -> dict[str, Any]:
        engine: Simulations = request.app.state.engine
        return await simulate(lambda: engine.wiesner(body.length))

    @app.post("/v1/chip/run", dependencies=[chip_guard])
    async def chip_run(body: ChipRequest) -> dict[str, Any]:
        check_gate(config, body.passphrase)
        return chip_runner()

    return app
