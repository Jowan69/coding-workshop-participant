#!/usr/bin/env bash
# Purpose: lint, security-scan and test the tracker backend (ruff, bandit, pytest + coverage)
# Usage:   ./bin/test-backend.sh [extra pytest args]
# Env:     PYTHON (default python3.10), PGPASSWORD (default postgres123, local Postgres on :5432)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VENV="$ROOT/.venv"
PYTHON="${PYTHON:-python3.10}"
command -v "$PYTHON" > /dev/null 2>&1 || PYTHON=python3

if [ ! -x "$VENV/bin/python" ]; then
    echo "INFO: creating $VENV with $PYTHON"
    if ! "$PYTHON" -m venv "$VENV" > /dev/null 2>&1; then
        # Ubuntu's python3.10 ships without ensurepip: borrow the system pip instead
        rm -rf "$VENV"
        "$PYTHON" -m venv --without-pip --system-site-packages "$VENV"
    fi
fi

# Reinstall dev requirements only when they change
STAMP="$VENV/.requirements.sha256"
HASH="$(cat requirements-dev.txt backend/tracker/requirements.txt | sha256sum | cut -d' ' -f1)"
if [ "$(cat "$STAMP" 2> /dev/null || true)" != "$HASH" ]; then
    echo "INFO: installing requirements-dev.txt"
    "$VENV/bin/python" -m pip install --quiet --disable-pip-version-check -r requirements-dev.txt
    echo "$HASH" > "$STAMP"
fi

echo "== ruff"
"$VENV/bin/python" -m ruff check backend/tracker tests/backend

echo "== bandit"
# Same scope as CI (bandit -r ./backend), minus git-ignored paths such as the packages
# start-dev.sh pip-installs into backend/tracker/ (CI never sees those)
IGNORED="$(git ls-files --others --ignored --exclude-standard --directory -- backend | paste -sd, -)"
"$VENV/bin/python" -m bandit -r backend -q ${IGNORED:+-x "$IGNORED"}
echo "bandit: no issues"

echo "== pytest"
"$VENV/bin/python" -m pytest --cov --cov-report=term-missing "$@"
