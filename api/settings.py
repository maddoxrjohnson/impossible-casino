"""Service settings, read once at startup. A bad value stops the service from starting."""

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Literal, cast, get_args

ChipMode = Literal["owner", "public", "off"]

SITE_ORIGINS: tuple[str, ...] = ("https://impossible-casino.vercel.app",)
# Vercel previews of this project and local dev servers. A preview hash holds no hyphens.
PREVIEW_AND_DEV_ORIGINS = (
    r"\A(?:https://impossible-casino-[a-z0-9]+-maddoxrjohnson\.vercel\.app"
    r"|http://(?:localhost|127\.0\.0\.1):[0-9]{1,5})\Z"
)
ORIGIN = re.compile(r"https?://[a-z0-9.-]+(?::[0-9]{1,5})?")
POSITIVE_INTEGER = re.compile(r"[1-9][0-9]*")


class ConfigError(ValueError):
    """A setting that the service will not start with. Never quotes a secret."""


def _chip_mode(raw: str) -> ChipMode:
    if raw not in get_args(ChipMode):
        raise ConfigError(f"LIVE_CHIP_MODE must be one of {get_args(ChipMode)}")
    return cast(ChipMode, raw)


def _cors_origins(raw: str) -> tuple[str, ...]:
    origins = tuple(origin.strip() for origin in raw.split(","))
    if not all(ORIGIN.fullmatch(origin) for origin in origins):
        raise ConfigError("CORS_ORIGINS must be a comma-separated list of full origins")
    return origins


@dataclass(frozen=True)
class Settings:
    chip_mode: ChipMode = "off"
    chip_passphrase: str | None = field(default=None, repr=False)
    cors_origins: tuple[str, ...] = SITE_ORIGINS
    cors_origin_regex: str = PREVIEW_AND_DEV_ORIGINS
    # Only Cloud Run's own proxy makes X-Forwarded-For worth reading.
    trust_forwarded_for: bool = False
    run_limit_per_minute: int = 20
    # Per instance, across all clients. Binds CHSH runs; Wiesner runs are too slow to reach it.
    run_cap_per_hour: int = 12_000
    chip_limit_per_minute: int = 5
    max_clients: int = 10_000
    max_body_bytes: int = 1024
    max_concurrent_runs: int = 1

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Settings":
        env = os.environ if env is None else env

        def number(name: str, default: int) -> int:
            raw = env.get(name)
            if raw is None:
                return default
            if not POSITIVE_INTEGER.fullmatch(raw):
                raise ConfigError(f"{name} must be a positive integer")
            return int(raw)

        chip_mode = _chip_mode(env.get("LIVE_CHIP_MODE", "off"))
        chip_passphrase = env.get("CHIP_PASSPHRASE") or None
        if chip_mode == "owner" and chip_passphrase is None:
            raise ConfigError("LIVE_CHIP_MODE=owner needs CHIP_PASSPHRASE")
        cors_origins = env.get("CORS_ORIGINS")
        return cls(
            chip_mode=chip_mode,
            chip_passphrase=chip_passphrase,
            cors_origins=SITE_ORIGINS if cors_origins is None else _cors_origins(cors_origins),
            trust_forwarded_for="K_SERVICE" in env,
            run_limit_per_minute=number("RUN_LIMIT_PER_MINUTE", cls.run_limit_per_minute),
            run_cap_per_hour=number("RUN_CAP_PER_HOUR", cls.run_cap_per_hour),
            chip_limit_per_minute=number("CHIP_LIMIT_PER_MINUTE", cls.chip_limit_per_minute),
            max_clients=number("MAX_CLIENTS", cls.max_clients),
            max_body_bytes=number("MAX_BODY_BYTES", cls.max_body_bytes),
            max_concurrent_runs=number("MAX_CONCURRENT_RUNS", cls.max_concurrent_runs),
        )
