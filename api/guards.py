"""Abuse and cost controls: client identity, rate limit, body size and run slots."""

import asyncio
import math
import threading
from collections import OrderedDict
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from ipaddress import IPv6Address, IPv6Network, ip_address
from typing import TypeVar

from fastapi import HTTPException, Request
from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

MINUTE_SECONDS = 60
IPV6_NETWORK_BITS = 64
BUSY_RETRY_SECONDS = 1

T = TypeVar("T")


def client_key(address: str | None) -> str:
    """One bucket per address, and per /64 on IPv6, where a client owns the whole block."""
    try:
        ip = ip_address(address or "")
    except ValueError:
        return "unknown"
    if isinstance(ip, IPv6Address):
        if ip.ipv4_mapped:
            return str(ip.ipv4_mapped)
        return str(IPv6Network((ip, IPV6_NETWORK_BITS), strict=False).network_address)
    return str(ip)


def client_address(request: Request, trust_forwarded_for: bool) -> str | None:
    """The caller's address.

    Cloud Run appends the address it saw to X-Forwarded-For, so only the last
    entry is real. Everything to its left is whatever the caller chose to send.
    """
    if trust_forwarded_for:
        forwarded = ",".join(request.headers.getlist("x-forwarded-for"))
        last = forwarded.rsplit(",", 1)[-1].strip()
        if last:
            return last
    return request.client.host if request.client else None


class RateLimiter:
    """Fixed-window counts per client, in memory, for one instance.

    Holds at most max_clients windows. When full it forgets the oldest window,
    which at worst gives that client a fresh count.
    """

    def __init__(
        self,
        limit: int,
        max_clients: int,
        clock: Callable[[], float],
        window_seconds: int = MINUTE_SECONDS,
    ) -> None:
        self._limit = limit
        self._window_seconds = window_seconds
        self._max_clients = max_clients
        self._clock = clock
        # client -> (window start, requests), oldest window first.
        self._windows: OrderedDict[str, tuple[float, int]] = OrderedDict()

    @property
    def tracked(self) -> int:
        return len(self._windows)

    def check(self, client: str) -> int | None:
        """Count one request. Returns the seconds to wait if it is over the limit."""
        now = self._clock()
        started, count = self._windows.get(client, (now, 0))
        if now - started >= self._window_seconds:
            started, count = now, 0
            self._windows.pop(client, None)
        if count >= self._limit:
            return max(1, math.ceil(started + self._window_seconds - now))
        self._windows[client] = (started, count + 1)
        if len(self._windows) > self._max_clients:
            self._windows.popitem(last=False)
        return None


class BodySizeLimit:
    """Refuses a large body whether it declares its size or streams past the limit."""

    def __init__(self, app: ASGIApp, max_bytes: int) -> None:
        self._app = app
        self._max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self._app(scope, receive, send)
            return
        declared = Headers(scope=scope).get("content-length")
        if declared is not None and (not declared.isdigit() or int(declared) > self._max_bytes):
            refusal = JSONResponse({"detail": "Request body too large."}, status_code=413)
            await refusal(scope, receive, send)
            return
        seen = 0

        async def counted() -> Message:
            nonlocal seen
            message = await receive()
            if message["type"] == "http.request":
                seen += len(message.get("body", b""))
                if seen > self._max_bytes:
                    # The router turns other exceptions from a body read into a 400.
                    raise HTTPException(413, "Request body too large.")
            return message

        await self._app(scope, counted, send)


class RunSlots:
    """Worker threads for simulations, with no queue: a run takes a free slot or is refused."""

    def __init__(self, slots: int) -> None:
        self._free = threading.BoundedSemaphore(slots)
        self._pool = ThreadPoolExecutor(slots, thread_name_prefix="run")

    async def run(self, work: Callable[[], T]) -> T:
        if not self._free.acquire(blocking=False):
            raise HTTPException(
                503, "Busy. Try again shortly.", {"Retry-After": str(BUSY_RETRY_SECONDS)}
            )
        future = self._pool.submit(work)
        # Tied to the thread, not the request: a dropped caller keeps its slot until the work ends.
        future.add_done_callback(lambda _: self._free.release())
        return await asyncio.wrap_future(future)

    def close(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)
