"""Runtime configuration, read once from the Lambda environment."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass


class ConfigError(RuntimeError):
    """Raised when the environment is missing a required setting."""


@dataclass(frozen=True)
class Settings:
    """Settings the tracker needs: database connection, JWT key and demo seed password."""

    db_host: str
    db_port: int
    db_name: str
    db_user: str
    db_pass: str
    is_local: bool
    jwt_secret: str
    seed_password: str | None


def load_settings(environ: Mapping[str, str] | None = None) -> Settings:
    """Build Settings from the environment, failing fast when JWT_SECRET is missing.

    Args:
        environ: Mapping to read instead of ``os.environ`` (used by tests).

    Returns:
        The validated settings.

    Raises:
        ConfigError: If JWT_SECRET is empty or POSTGRES_PORT is not a number.
    """
    env = os.environ if environ is None else environ
    jwt_secret = env.get("JWT_SECRET", "").strip()
    if not jwt_secret:
        raise ConfigError(
            "JWT_SECRET is not set: the tracker API cannot sign or verify tokens. "
            "Set it in the Lambda environment (Terraform local.env_vars)."
        )
    port_text = env.get("POSTGRES_PORT", "").strip() or "5432"
    try:
        port = int(port_text)
    except ValueError as exc:
        raise ConfigError(f"POSTGRES_PORT must be a number, got {port_text!r}") from exc
    return Settings(
        db_host=env.get("POSTGRES_HOST", "").strip() or "localhost",
        db_port=port,
        db_name=env.get("POSTGRES_NAME", "").strip() or "postgres",
        db_user=env.get("POSTGRES_USER", "").strip() or "postgres",
        db_pass=env.get("POSTGRES_PASS", ""),
        is_local=env.get("IS_LOCAL", "false").strip().lower() == "true",
        jwt_secret=jwt_secret,
        seed_password=env.get("SEED_PASSWORD") or None,
    )
