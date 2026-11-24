"""AWS Lambda entry point for the ACME project tracker API (Function URL, payload v2)."""

from __future__ import annotations

import logging
from typing import Any

from acme.core.config import load_settings
from acme.core.http import dispatch
from acme.domains import build_router

logging.getLogger().setLevel(logging.INFO)

# Built once per container: a missing JWT_SECRET fails the cold start with a clear message
SETTINGS = load_settings()
ROUTER = build_router()


def handler(event: dict[str, Any], context: Any = None) -> dict[str, Any]:
    """Handle one HTTP request and return the Function URL response."""
    return dispatch(event, ROUTER, SETTINGS)
