#!/usr/bin/env bash
# Targeted post-install/upgrade smoke. Uses only the explicitly configured installation and creates
# one identifiable AGENT_TEST record plus one system.noop job; never seeds, migrates, or provisions DBs.
set -euo pipefail

: "${SMOKE_BASE_URL:?Set SMOKE_BASE_URL to the deployed HTTPS URL}"
: "${SMOKE_ADMIN_LOGIN:?Set SMOKE_ADMIN_LOGIN for the dedicated smoke-test administrator}"
: "${SMOKE_ADMIN_PASSWORD:?Set SMOKE_ADMIN_PASSWORD for the dedicated smoke-test administrator}"

case "$SMOKE_BASE_URL" in
  https://*) ;;
  *) echo 'Refusing: production smoke must use HTTPS so proxy cookies and edge headers are tested.' >&2; exit 2 ;;
esac
if ! command -v curl >/dev/null || ! command -v jq >/dev/null; then
  echo 'curl and jq are required.' >&2
  exit 2
fi

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
MARKER="AGENT_TEST_install-smoke-${RUN_ID}"
BASE="${SMOKE_BASE_URL%/}"
TMP="$(mktemp -d)"
ACCOUNT_ID=""
JOB_ID=""
TOKEN=""
PASS=0
FAIL=0

cleanup() {
  if [[ -n "$TOKEN" && -n "$ACCOUNT_ID" ]]; then
    curl -fsS -o /dev/null -X DELETE "$BASE/api/v1/Account/$ACCOUNT_ID" -H "Authorization: Bearer $TOKEN" || true
  fi
  if [[ -n "$TOKEN" && -n "$JOB_ID" ]]; then
    curl -fsS -o /dev/null -X POST "$BASE/api/v1/Job/$JOB_ID/action/discard" -H "Authorization: Bearer $TOKEN" || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

ok() { PASS=$((PASS + 1)); printf 'ok   %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL %s\n' "$1" >&2; }
request() {
  curl -sS --max-time 20 -o "$TMP/body" -w '%{http_code}' "$@"
}

printf 'Production smoke %s\n' "$RUN_ID"

code="$(request "$BASE/health/ready")"
if [[ "$code" == 200 ]] && [[ "$(jq -r '.status // empty' "$TMP/body")" == ok ]]; then ok 'API readiness and database'; else fail "readiness (HTTP $code)"; fi

code="$(curl -sS --max-time 20 -D "$TMP/headers" -o "$TMP/body" -w '%{http_code}' \
  -H 'content-type: application/json' -X POST "$BASE/api/v1/Authentication" \
  --data "$(jq -cn --arg user "$SMOKE_ADMIN_LOGIN" --arg password "$SMOKE_ADMIN_PASSWORD" '{userName:$user,password:$password}')")"
TOKEN="$(jq -r '.accessToken // empty' "$TMP/body")"
if [[ "$code" == 201 && -n "$TOKEN" ]]; then ok 'administrator authentication'; else fail "authentication (HTTP $code)"; fi
if grep -qi '^set-cookie:.*; Secure' "$TMP/headers"; then ok 'secure session cookie behind TLS proxy'; else fail 'secure session cookie'; fi

code="$(request -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/Metadata")"
if [[ "$code" == 200 ]]; then ok 'metadata endpoint'; else fail "metadata (HTTP $code)"; fi

code="$(request -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -X POST \
  "$BASE/api/v1/Account" --data "$(jq -cn --arg name "$MARKER" '{name:$name}')")"
ACCOUNT_ID="$(jq -r '.id // empty' "$TMP/body")"
if [[ "$code" == 201 && -n "$ACCOUNT_ID" ]]; then ok 'representative create'; else fail "create record (HTTP $code)"; fi

if [[ -n "$ACCOUNT_ID" ]]; then
  code="$(request -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/Account/$ACCOUNT_ID")"
  if [[ "$code" == 200 && "$(jq -r '.name // empty' "$TMP/body")" == "$MARKER" ]]; then ok 'representative read'; else fail "read record (HTTP $code)"; fi
  version="$(jq -r '.version // empty' "$TMP/body")"
  code="$(request -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -X PATCH \
    "$BASE/api/v1/Account/$ACCOUNT_ID" --data "$(jq -cn --arg name "$MARKER updated" --argjson version "$version" '{name:$name,version:$version}')")"
  if [[ "$code" == 200 && "$(jq -r '.name // empty' "$TMP/body")" == "$MARKER updated" ]]; then ok 'representative update'; else fail "update record (HTTP $code)"; fi
  code="$(request -H "Authorization: Bearer $TOKEN" -X DELETE "$BASE/api/v1/Account/$ACCOUNT_ID")"
  if [[ "$code" == 200 ]]; then
    ok 'representative soft delete'
    ACCOUNT_ID=""
  else
    fail "soft delete (HTTP $code)"
  fi
fi

code="$(request -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -X POST \
  "$BASE/api/v1/Job" --data '{"jobName":"system.noop","data":{}}')"
JOB_ID="$(jq -r '.id // empty' "$TMP/body")"
if [[ "$code" == 201 && -n "$JOB_ID" ]]; then ok 'worker job enqueued'; else fail "enqueue worker job (HTTP $code)"; fi

if [[ -n "$JOB_ID" ]]; then
  completed=''
  for _ in $(seq 1 60); do
    code="$(request -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/Job/$JOB_ID")"
    if [[ "$code" == 200 ]]; then
      status="$(jq -r '.status // empty' "$TMP/body")"
      if [[ "$status" == completed ]]; then completed=yes; break; fi
      if [[ "$status" == failed || "$status" == cancelled ]]; then break; fi
    fi
    sleep 2
  done
  if [[ "$completed" == yes ]]; then ok 'worker completed system.noop'; else fail 'worker job did not complete within 120 seconds'; fi
  code="$(request -H "Authorization: Bearer $TOKEN" -X POST "$BASE/api/v1/Job/$JOB_ID/action/discard")"
  if [[ "$code" == 200 ]]; then
    ok 'smoke job removed by exact id'
    JOB_ID=""
  else
    fail "discard smoke job (HTTP $code)"
  fi
fi

printf '\nProduction smoke: %s passed, %s failed\n' "$PASS" "$FAIL"
if [[ "$FAIL" -ne 0 ]]; then exit 1; fi
