"""Phase 6, part C: the demo accounts follow SEED_PASSWORD, which is not in the repository."""

from __future__ import annotations

import dataclasses
import os
import re
import subprocess  # noqa: S404 - runs the repository's own scripts, test-only

import pytest

from acme import seed
from acme.core import auth, db
from conftest import ROLE_EMAILS, ROOT, SEED_PASSWORD

ROTATED = "Rotated-Demo-Pass-9"
LOCAL_PASSWORD = "AcmeDemo-2026"
DEMO_EMAILS = sorted(ROLE_EMAILS.values())


def _with_password(settings, password):
    return dataclasses.replace(settings, seed_password=password)


def _demo_rows(conn) -> dict[str, dict]:
    rows = conn.execute(
        "SELECT email, password_hash, token_version, must_change_password FROM users "
        "WHERE email = ANY(%s)",
        (DEMO_EMAILS,),
    ).fetchall()
    return {row["email"]: row for row in rows}


def _login(api, email: str, password: str):
    return api.post("/auth/login", {"email": email, "password": password}, role=None)


# C2: the checksum


def test_the_checksum_covers_the_seed_password_but_never_contains_it(database) -> None:
    current = db.schema_checksum(database.SETTINGS)
    rotated = db.schema_checksum(_with_password(database.SETTINGS, ROTATED))
    unset = db.schema_checksum(_with_password(database.SETTINGS, None))
    assert len({current, rotated, unset}) == 3
    for checksum in (current, rotated, unset):
        assert re.fullmatch(r"[0-9a-f]{64}", checksum)
        assert SEED_PASSWORD not in checksum and ROTATED not in checksum
    assert db.schema_checksum(database.SETTINGS) == current


def test_the_checksum_still_covers_the_schema(database, monkeypatch, tmp_path) -> None:
    changed = tmp_path / "schema.sql"
    changed.write_text(db.SCHEMA_PATH.read_text(encoding="utf-8") + "\n-- changed\n")
    before = db.schema_checksum(database.SETTINGS)
    monkeypatch.setattr(db, "SCHEMA_PATH", changed)
    assert db.schema_checksum(database.SETTINGS) != before


# C2: a rotated password takes effect on the next cold start


def test_a_rotated_seed_password_takes_effect_on_the_next_cold_start(
    api, conn, database, monkeypatch
) -> None:
    before = _demo_rows(conn)
    assert _login(api, "viewer@acme.test", SEED_PASSWORD).status == 200

    monkeypatch.setattr(db, "_schema_ready", False)  # a new container
    db.ensure_schema(_with_password(database.SETTINGS, ROTATED))

    after = _demo_rows(conn)
    assert set(after) == set(DEMO_EMAILS)
    for email in DEMO_EMAILS:
        assert auth.verify_password(ROTATED, after[email]["password_hash"])
        assert not auth.verify_password(SEED_PASSWORD, after[email]["password_hash"])
        assert after[email]["token_version"] == before[email]["token_version"] + 1
        assert _login(api, email, ROTATED).status == 200
        assert _login(api, email, SEED_PASSWORD).status == 401
    stored = conn.execute("SELECT checksum FROM schema_meta").fetchone()["checksum"]
    assert stored == db.schema_checksum(_with_password(database.SETTINGS, ROTATED))
    # the sessions issued under the old password are revoked
    refused = api.get("/auth/me", role="viewer")
    assert refused.status == 401
    assert refused.error["code"] == "token_revoked"


def test_an_unchanged_seed_password_touches_nothing(conn, database) -> None:
    before = _demo_rows(conn)
    seed.run(conn, database.SETTINGS)
    assert _demo_rows(conn) == before


def test_a_demo_user_on_another_password_is_brought_back(api, conn, database) -> None:
    changed = api.post(
        "/auth/change-password",
        {"current_password": SEED_PASSWORD, "new_password": "Tangerine-Sky-42"}, role="viewer",
    )
    assert changed.status == 200
    conn.execute("UPDATE users SET must_change_password = true WHERE email = 'viewer@acme.test'")
    before = _demo_rows(conn)

    seed.run(conn, database.SETTINGS)

    after = _demo_rows(conn)
    viewer = after["viewer@acme.test"]
    assert auth.verify_password(SEED_PASSWORD, viewer["password_hash"])
    assert viewer["token_version"] == before["viewer@acme.test"]["token_version"] + 1
    assert viewer["must_change_password"] is False
    others = [email for email in DEMO_EMAILS if email != "viewer@acme.test"]
    assert {email: after[email] for email in others} == {email: before[email] for email in others}


def test_other_users_never_follow_the_seed_password(api, conn, database) -> None:
    created = api.post("/auth/users", {"email": "real.person@acme.test", "full_name": "Real Person",
                                       "password": "Tangerine-Sky-42", "role": "viewer"})
    assert created.status == 201
    seed.run(conn, _with_password(database.SETTINGS, ROTATED))
    assert _login(api, "real.person@acme.test", "Tangerine-Sky-42").status == 200
    assert _login(api, "real.person@acme.test", ROTATED).status == 401


def test_without_a_seed_password_the_demo_users_are_left_alone(conn, database) -> None:
    before = _demo_rows(conn)
    seed.run(conn, _with_password(database.SETTINGS, None))
    assert _demo_rows(conn) == before


# C1: Terraform


def _terraform(name: str) -> str:
    return (ROOT / "infra" / name).read_text(encoding="utf-8")


def test_terraform_has_no_default_demo_password() -> None:
    variable = re.search(r'variable "demo_password" \{(.*?)\n\}', _terraform("variable.tf"), re.S)
    assert variable is not None
    assert re.search(r"default\s*=\s*null", variable.group(1))
    assert re.search(r"sensitive\s*=\s*true", variable.group(1))
    assert LOCAL_PASSWORD not in _terraform("variable.tf")


def test_terraform_uses_the_fixed_password_on_localstack_only() -> None:
    local = re.search(r"demo_password = (.*?)\n  \)", _terraform("locals.tf"), re.S)
    assert local is not None
    expression = " ".join(local.group(1).split())
    assert "var.demo_password" in expression
    assert f'== "000000000000" ? "{LOCAL_PASSWORD}" : random_password.demo.result' in expression
    assert "SEED_PASSWORD = local.demo_password" in _terraform("locals.tf")
    pattern = r'resource "random_password" "demo" \{(.*?)\n\}'
    generated = re.search(pattern, _terraform("main.tf"), re.S)
    assert generated is not None
    assert re.search(r"length\s*=\s*20", generated.group(1))
    assert re.search(r"special\s*=\s*false", generated.group(1))


def test_terraform_outputs_the_demo_password_as_sensitive() -> None:
    output = re.search(r'output "demo_password" \{(.*?)\n\}', _terraform("output.tf"), re.S)
    assert output is not None
    assert "local.demo_password" in output.group(1)
    assert re.search(r"sensitive\s*=\s*true", output.group(1))


# C3: documents and scripts


def test_the_cloud_password_is_gone_from_the_api_document() -> None:
    assert "AcmeDemo" not in (ROOT / "API.md").read_text(encoding="utf-8")


def test_the_readme_says_how_to_set_and_read_the_cloud_password() -> None:
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    assert "TF_VAR_demo_password" in readme
    assert "terraform -chdir=infra output -raw demo_password" in readme
    assert readme.count(LOCAL_PASSWORD) == 1
    assert re.search(r"Locally[^\n]*" + re.escape(LOCAL_PASSWORD), readme)


def _run(script: str, *args: str, password: str | None = None) -> subprocess.CompletedProcess:
    env = {key: value for key, value in os.environ.items() if key != "SEED_PASSWORD"}
    env["ATTEMPTS"] = "1"
    if password is not None:
        env["SEED_PASSWORD"] = password
    return subprocess.run(  # noqa: S603 - the repository's own script, fixed arguments
        [str(ROOT / "bin" / script), *args], capture_output=True, text=True, env=env, timeout=120,
    )


@pytest.mark.parametrize("script", ["smoke-test.sh", "warm-up.sh"])
@pytest.mark.parametrize(
    "url", ["https://d111111abcdef8.cloudfront.net", "http://example.test:3001",
            "https://localhost.example.test", "http://localhostile.test"],
)
def test_scripts_refuse_a_remote_url_without_seed_password(script: str, url: str) -> None:
    result = _run(script, url)
    assert result.returncode == 2
    assert "SEED_PASSWORD is not set" in result.stdout
    assert "terraform -chdir=infra output -raw demo_password" in result.stdout
    assert "TF_VAR_demo_password" in result.stdout
    assert LOCAL_PASSWORD not in result.stdout + result.stderr
    assert "Smoke-testing" not in result.stdout and "Warming up" not in result.stdout


@pytest.mark.parametrize("script", ["smoke-test.sh", "warm-up.sh"])
@pytest.mark.parametrize("url", ["http://localhost:9", "http://127.0.0.1:9/"])
def test_scripts_fall_back_to_the_local_password_for_localhost(script: str, url: str) -> None:
    result = _run(script, url)  # port 9 is closed: the run gets past the password and fails fast
    assert result.returncode == 1
    assert "SEED_PASSWORD is not set" not in result.stdout
    assert ("Smoke-testing" in result.stdout) or ("Warming up" in result.stdout)


@pytest.mark.parametrize("script", ["smoke-test.sh", "warm-up.sh"])
def test_scripts_accept_seed_password_for_a_remote_url(script: str) -> None:
    # Not "localhost", so it needs the password, but refused at once (no waiting on a network)
    result = _run(script, "http://[::1]:9", password="Given-Pass-123")
    assert "SEED_PASSWORD is not set" not in result.stdout
    assert result.returncode == 1
