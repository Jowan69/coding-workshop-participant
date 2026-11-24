#!/usr/bin/env bash
# Purpose: wake the tracker API before a demo. Aurora Serverless v2 pauses at zero capacity and
#          takes a while to resume, so the first requests can fail or time out. This polls
#          GET /health until the database answers, then signs in and lists one page of
#          projects, printing how long each step took.
# Usage:   ./bin/warm-up.sh [BASE_URL]
#          BASE_URL defaults to http://localhost:3001 (the dev proxy); in AWS pass the CloudFront URL
# Env:     SEED_PASSWORD (defaults to the Terraform default demo password)
#          WARMUP_EMAIL (default viewer@acme.test), ATTEMPTS (default 12), DELAY seconds (default 5)
# Exit:    0 when the API answered an authenticated list, 1 otherwise, 2 without curl

set -uo pipefail

BASE_URL="${1:-http://localhost:3001}"
API="${BASE_URL%/}/api/tracker"
PASSWORD="${SEED_PASSWORD:-AcmeDemo-2026}"
EMAIL="${WARMUP_EMAIL:-viewer@acme.test}"
ATTEMPTS="${ATTEMPTS:-12}"
DELAY="${DELAY:-5}"
BODY_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE"' EXIT

command -v curl > /dev/null 2>&1 || { echo "ERROR: curl is required"; exit 2; }

# request METHOD PATH [TOKEN] [JSON]: sets STATUS, SECS (curl time_total) and BODY.
# The JSON goes through stdin so the password never shows up in the process list.
request() {
    local method="$1" path="$2" token="${3:-}" data="${4:-}" meta
    local args=(-sS --max-time 35 -o "$BODY_FILE" -w '%{http_code} %{time_total}'
                -X "$method" -H 'Accept: application/json')
    [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
    [ -n "$data" ] && args+=(-H 'Content-Type: application/json' --data-binary @-)
    meta="$(printf '%s' "$data" | curl "${args[@]}" "$API$path" 2> /dev/null)" || true
    STATUS="${meta%% *}"
    SECS="${meta#* }"
    [ -n "$STATUS" ] || STATUS=000
    [ "$SECS" != "$meta" ] || SECS="?"
    BODY="$(cat "$BODY_FILE" 2> /dev/null)"
}

json_value() {
    printf '%s' "$BODY" | sed -n "s/.*\"$1\": *\"\{0,1\}\([^\",}]*\).*/\1/p" | head -n 1
}

json_escape() {
    local text="${1//\\/\\\\}"
    printf '%s' "${text//\"/\\\"}"
}

echo "Warming up $API (up to $ATTEMPTS health checks, ${DELAY}s apart)"
STARTED=$SECONDS

for attempt in $(seq 1 "$ATTEMPTS"); do
    request GET /health
    printf 'health  attempt %2d/%d: HTTP %s in %ss\n' "$attempt" "$ATTEMPTS" "$STATUS" "$SECS"
    [ "$STATUS" = 200 ] && break
    if [ "$attempt" -eq "$ATTEMPTS" ]; then
        echo "FAIL  the API did not report a healthy database after $((SECONDS - STARTED))s"
        echo "      last response: ${BODY:0:200}"
        exit 1
    fi
    sleep "$DELAY"
done

request POST /auth/login "" "{\"email\": \"$EMAIL\", \"password\": \"$(json_escape "$PASSWORD")\"}"
TOKEN="$(json_value access_token)"
printf 'login   %s: HTTP %s in %ss\n' "$EMAIL" "$STATUS" "$SECS"
if [ "$STATUS" != 200 ] || [ -z "$TOKEN" ]; then
    echo "FAIL  could not sign in as $EMAIL (set SEED_PASSWORD if the demo password was changed)"
    exit 1
fi

request GET "/projects?limit=1" "$TOKEN"
printf 'list    GET /projects?limit=1: HTTP %s in %ss (total %s)\n' "$STATUS" "$SECS" "$(json_value total)"
if [ "$STATUS" != 200 ]; then
    echo "FAIL  the authenticated list did not answer"
    exit 1
fi

echo "Warm after $((SECONDS - STARTED))s"
