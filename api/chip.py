"""The gate in front of real chip runs. Submission itself is not built yet."""

import hmac
from collections.abc import Callable
from typing import Any

from fastapi import HTTPException

from api.settings import Settings

ChipRunner = Callable[[], dict[str, Any]]


class ChipNotEnabled(Exception):
    """This service has no chip submission behind the gate."""


def not_enabled() -> dict[str, Any]:
    """The seam for chip submission. Nothing here contacts IBM."""
    raise ChipNotEnabled


def check_gate(settings: Settings, passphrase: str | None) -> None:
    """Raises unless the mode lets this caller through. Never repeats what was sent."""
    if settings.chip_mode == "off":
        raise HTTPException(403, "Chip runs are off.")
    if settings.chip_mode == "public":
        return
    secret = settings.chip_passphrase
    if secret is None or not hmac.compare_digest((passphrase or "").encode(), secret.encode()):
        raise HTTPException(403, "Not allowed.")
