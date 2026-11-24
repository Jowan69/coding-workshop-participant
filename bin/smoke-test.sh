#!/usr/bin/env bash
# Purpose: smoke-test a running tracker API end to end, with curl only
# Usage:   ./bin/smoke-test.sh [BASE_URL]
#          BASE_URL defaults to http://localhost:3001 (the dev proxy); in AWS pass the CloudFront URL
# Env:     SEED_PASSWORD (defaults to the Terraform default demo password)
# Exit:    0 when every check passes, 1 otherwise

set -uo pipefail

BASE_URL="${1:-http://localhost:3001}"
API="${BASE_URL%/}/api/tracker"
PASSWORD="${SEED_PASSWORD:-AcmeDemo-2026}"
FAILURES=0
BODY_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE"' EXIT

command -v curl > /dev/null 2>&1 || { echo "ERROR: curl is required"; exit 2; }

pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s (%s)\n' "$1" "$2"; FAILURES=$((FAILURES + 1)); }

# request METHOD PATH [TOKEN] [JSON]: sets STATUS, CTYPE and BODY.
# The JSON goes through stdin so the password never shows up in the process list.
request() {
    local method="$1" path="$2" token="${3:-}" data="${4:-}" meta
    local args=(-sS --max-time 30 -o "$BODY_FILE" -w '%{http_code} %{content_type}'
                -X "$method" -H 'Accept: application/json')
    [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
    [ -n "$data" ] && args+=(-H 'Content-Type: application/json' --data-binary @-)
    meta="$(printf '%s' "$data" | curl "${args[@]}" "$API$path" 2> /dev/null)" || meta="000 "
    STATUS="${meta%% *}"
    CTYPE="${meta#* }"
    BODY="$(cat "$BODY_FILE" 2> /dev/null)"
}

# expect NAME STATUS: PASS when the last response had that status
expect() {
    if [ "$STATUS" = "$2" ]; then pass "$1"; else fail "$1" "expected $2, got $STATUS"; fi
}

# json_string KEY: the first "KEY": "value" in the last response body
json_string() {
    printf '%s' "$BODY" | sed -n "s/.*\"$1\": *\"\([^\"]*\)\".*/\1/p" | head -n 1
}

json_escape() {
    local text="${1//\\/\\\\}"
    printf '%s' "${text//\"/\\\"}"
}

echo "Smoke-testing $API"

request GET /health
expect "GET /health needs no token" 200

declare -A TOKENS
for pair in admin@acme.test:admin manager@acme.test:manager lead@acme.test:contributor \
            viewer@acme.test:viewer; do
    email="${pair%%:*}"
    role="${pair##*:}"
    request POST /auth/login "" "{\"email\": \"$email\", \"password\": \"$(json_escape "$PASSWORD")\"}"
    token="$(json_string access_token)"
    if [ "$STATUS" != 200 ] || [ -z "$token" ]; then
        fail "log in as $email" "got $STATUS"
        continue
    fi
    pass "log in as $email"
    TOKENS[$role]="$token"
    request GET /auth/me "$token"
    if [ "$STATUS" = 200 ] && [ "$(json_string role)" = "$role" ]; then
        pass "GET /auth/me as $role"
    else
        fail "GET /auth/me as $role" "got $STATUS, role '$(json_string role)'"
    fi
done

ADMIN="${TOKENS[admin]:-}"
VIEWER="${TOKENS[viewer]:-}"

for path in /projects /deliverables /resources /allocations /budgets; do
    request GET "$path" "$VIEWER"
    if [ "$STATUS" = 200 ] && [[ "$BODY" == *'"items"'* ]]; then
        pass "GET $path as viewer"
    else
        fail "GET $path as viewer" "got $STATUS"
    fi
done
request GET /auth/users "$ADMIN"
expect "GET /auth/users as admin" 200

# An empty body: the role check runs first, and nothing is created if it ever failed
request POST /projects "$VIEWER" '{}'
expect "viewer POST /projects is forbidden" 403

request GET /projects
expect "no token is unauthorized" 401

request GET /projects/999999999 "$ADMIN"
if [ "$STATUS" = 404 ] && [[ "$CTYPE" == application/json* ]] && [[ "$BODY" == *'"error"'* ]]; then
    pass "unknown project id is a JSON 404"
else
    fail "unknown project id is a JSON 404" "got $STATUS, content-type '${CTYPE:-none}'"
fi

echo
if [ "$FAILURES" -gt 0 ]; then
    echo "$FAILURES check(s) failed"
    exit 1
fi
echo "All checks passed"
