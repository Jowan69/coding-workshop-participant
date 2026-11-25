#!/usr/bin/env bash
# Purpose: smoke-test a running tracker API end to end, with curl only
# Usage:   ./bin/smoke-test.sh [BASE_URL]
#          BASE_URL defaults to http://localhost:3001 (the dev proxy); in AWS pass the CloudFront URL
#          For an https:// URL (CloudFront) it also checks the edge: the security headers, that
#          the main script is served compressed, and that /projects returns the app's HTML.
#          SPA_REWRITE=0 skips that last check (deployments with enable_spa_rewrite = false).
# Env:     SEED_PASSWORD, the demo users' password. Required unless BASE_URL is localhost,
#          where it falls back to the local stack's value. For AWS:
#            export SEED_PASSWORD="$(terraform -chdir=infra output -raw demo_password)"
# Exit:    0 when every check passes, 1 otherwise, 2 without curl or without the password

set -uo pipefail

BASE_URL="${1:-http://localhost:3001}"
API="${BASE_URL%/}/api/tracker"
FAILURES=0

# The demo password comes from $SEED_PASSWORD. Only a local stack has a known default (the
# LocalStack value in infra/locals.tf); for a deployed API it must be given.
case "${BASE_URL%/}" in
    http://localhost | http://localhost:* | http://127.0.0.1 | http://127.0.0.1:*) IS_LOCAL=1 ;;
    *) IS_LOCAL=0 ;;
esac
if [ -n "${SEED_PASSWORD:-}" ]; then
    PASSWORD="$SEED_PASSWORD"
elif [ "$IS_LOCAL" = 1 ]; then
    PASSWORD="AcmeDemo-2026"
else
    echo "ERROR: SEED_PASSWORD is not set, and $BASE_URL is not a local stack."
    echo "       Export the demo password of that deployment first, for example:"
    echo "         export SEED_PASSWORD=\"\$(terraform -chdir=infra output -raw demo_password)\""
    echo "       (or the value you deployed with TF_VAR_demo_password)."
    exit 2
fi
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

# json_number KEY: the first "KEY": 123 in the last response body
json_number() {
    printf '%s' "$BODY" | sed -n "s/.*\"$1\": *\([0-9][0-9]*\).*/\1/p" | head -n 1
}

json_escape() {
    local text="${1//\\/\\\\}"
    printf '%s' "${text//\"/\\\"}"
}

echo "Smoke-testing $API"

request GET /health
expect "GET /health needs no token" 200

# Every API response must forbid caching
CACHE_CONTROL="$(curl -sS --max-time 30 -o /dev/null -D - "$API/health" 2> /dev/null \
    | tr -d '\r' | sed -n 's/^[Cc]ache-[Cc]ontrol: *//p' | head -n 1)"
if [ "$CACHE_CONTROL" = "no-store" ]; then
    pass "API responses say Cache-Control: no-store"
else
    fail "API responses say Cache-Control: no-store" "got '${CACHE_CONTROL:-nothing}'"
fi

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

# Insights: each dashboard question answers a viewer; "path:key" names a key the body must have
for pair in project-status:items at-risk:items allocation:resources deliverables:items \
            over-allocated:items budget:items summary:active_projects; do
    path="/insights/${pair%%:*}"
    key="${pair##*:}"
    request GET "$path" "$VIEWER"
    if [ "$STATUS" = 200 ] && [[ "$BODY" == *"\"$key\""* ]]; then
        pass "GET $path as viewer"
    else
        fail "GET $path as viewer" "got $STATUS"
    fi
done

request GET "/projects?limit=1" "$VIEWER"
PROJECT_ID="$(json_number id)"
if [ -n "$PROJECT_ID" ]; then
    request GET "/insights/dependencies?project_id=$PROJECT_ID" "$VIEWER"
    if [ "$STATUS" = 200 ] && [[ "$BODY" == *'"longest_chain"'* ]]; then
        pass "GET /insights/dependencies as viewer"
    else
        fail "GET /insights/dependencies as viewer" "got $STATUS"
    fi
else
    fail "GET /insights/dependencies as viewer" "no project to ask about"
fi
request GET /insights/dependencies "$VIEWER"
expect "GET /insights/dependencies without project_id is a 400" 400

# The edge, for a deployed (https) site only: CloudFront adds these, the local stack does not
case "$BASE_URL" in
    https://*)
        SITE="${BASE_URL%/}"
        PAGE_HEADERS="$(curl -sS --max-time 30 -o /dev/null -D - "$SITE/" 2> /dev/null | tr -d '\r')"
        for header in strict-transport-security x-content-type-options x-frame-options \
                      referrer-policy; do
            if printf '%s\n' "$PAGE_HEADERS" | grep -qi "^$header:"; then
                pass "security header $header on the page"
            else
                fail "security header $header on the page" "missing"
            fi
        done
        API_HEADERS="$(curl -sS --max-time 30 -o /dev/null -D - "$API/health" 2> /dev/null | tr -d '\r')"
        if printf '%s\n' "$API_HEADERS" | grep -qi '^strict-transport-security:' \
            && printf '%s\n' "$API_HEADERS" | grep -qi '^x-content-type-options:'; then
            pass "security headers on the API"
        else
            fail "security headers on the API" "missing"
        fi

        PAGE="$(curl -sS --max-time 30 "$SITE/" 2> /dev/null)"
        if [[ "$PAGE" == *'http-equiv="Content-Security-Policy"'* ]]; then
            pass "index.html carries the Content-Security-Policy"
        else
            fail "index.html carries the Content-Security-Policy" "no meta tag"
        fi
        SCRIPT="$(printf '%s' "$PAGE" | sed -n 's/.*src="\(\/assets\/[^"]*\.js\)".*/\1/p' | head -n 1)"
        if [ -z "$SCRIPT" ]; then
            fail "the main script is served compressed" "no /assets/*.js script in index.html"
        else
            ENCODING="$(curl -sS --max-time 30 -o /dev/null -D - -H 'Accept-Encoding: gzip, br' \
                "$SITE$SCRIPT" 2> /dev/null | tr -d '\r' \
                | sed -n 's/^[Cc]ontent-[Ee]ncoding: *//p' | head -n 1)"
            case "$ENCODING" in
                gzip | br) pass "the main script is served compressed ($ENCODING)" ;;
                *) fail "the main script is served compressed" "content-encoding '${ENCODING:-none}'" ;;
            esac
        fi

        if [ "${SPA_REWRITE:-1}" = "0" ]; then
            echo "SKIP  /projects returns the app's HTML (SPA_REWRITE=0)"
        else
            DEEP="$(curl -sS --max-time 30 -o "$BODY_FILE" -w '%{http_code} %{content_type}' \
                "$SITE/projects" 2> /dev/null)" || DEEP="000 "
            if [ "${DEEP%% *}" = 200 ] && [[ "${DEEP#* }" == text/html* ]] \
                && grep -q '<div id="root">' "$BODY_FILE"; then
                pass "/projects returns the app's HTML"
            else
                fail "/projects returns the app's HTML" "got $DEEP"
            fi
        fi
        ;;
esac

echo
if [ "$FAILURES" -gt 0 ]; then
    echo "$FAILURES check(s) failed"
    exit 1
fi
echo "All checks passed"
