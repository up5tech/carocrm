#!/usr/bin/env bash
# End-to-end smoke test against a real HTTP CaroCRM API (PLAN §73 CRM Kernel Alpha).
# Boots its own server on a scratch port against the CONFIGURED project database
# (AGENTS.md §3.1: no extra database is created). Test records use a unique run marker.
set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${E2E_PORT:-3133}"
RUN_ID="e2e-$(date -u +%Y%m%d%H%M%S)-$$"
BASE="http://127.0.0.1:${PORT}"
ADMIN_LOGIN="admin"
ADMIN_PASSWORD="${E2E_ADMIN_PASSWORD:-admin}"
# DATABASE_URL comes from .env — the configured primary project database (AGENTS.md §3.1).
set -a
[ -f .env ] && . ./.env
set +a
if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set; copy .env.example to .env first." >&2
  exit 1
fi
export DATABASE_URL
export APP_PORT="$PORT"
export APP_HOST=127.0.0.1
export NODE_ENV=production
export LOG_LEVEL=error
export STORAGE_ROOT=".data/e2e-${RUN_ID}"
export JWT_SECRET="e2e-se…tion"

PASS=0
FAIL=0
API_PID=""
TMP="$(mktemp -d)"

cleanup() {
  if [ -n "$API_PID" ] && kill -0 "$API_PID" 2>/dev/null; then kill "$API_PID" 2>/dev/null; fi
  wait "$API_PID" 2>/dev/null
  rm -rf "$TMP" "$STORAGE_ROOT" 2>/dev/null || true
}
trap cleanup EXIT

ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() {
  FAIL=$((FAIL + 1))
  printf '  FAIL %s\n' "$1"
  if [ -n "${2:-}" ]; then printf '        %s\n' "$2"; fi
}
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected=$2 actual=$3"; fi; }
body() { tr -d '\n' <"$TMP/body" 2>/dev/null | head -c 240; }
jq_get() { jq -r "${1} // empty" "$TMP/body" 2>/dev/null; }

req() { # method path token [data]
  local method="$1" path="$2" token="${3:-}" data="${4:-}"
  local args=(-s -m 20 -o "$TMP/body" -w '%{http_code}' -X "$method" "$BASE$path")
  if [ -n "$token" ]; then args+=(-H "authorization: $token"); fi
  if [ -n "$data" ]; then args+=(-H 'content-type: application/json' -d "$data"); fi
  curl "${args[@]}"
}

echo "e2e smoke $RUN_ID"
echo "  database ${DATABASE_URL##*/} (credentials hidden)"
echo "  api      $BASE"

echo '--- bootstrap'
if pnpm db:seed >"$TMP/seed.log" 2>&1; then
  ok 'db:seed (migrations applied, idempotent seed)'
else
  bad 'db:seed' "$(tail -3 "$TMP/seed.log" | tr '\n' ' ')"
fi
if pnpm -r build >"$TMP/build.log" 2>&1; then ok 'pnpm -r build'; else bad 'pnpm -r build' "$(tail -5 "$TMP/build.log" | tr '\n' ' ')"; fi

echo '--- api boot'
node apps/api/dist/main.js >"$TMP/api.log" 2>&1 &
API_PID=$!
ready=''
for _ in $(seq 1 60); do
  ready="$(curl -s -m 3 "$BASE/health/ready" 2>/dev/null | jq -r '.status // empty')"
  if [ "$ready" = "ok" ]; then break; fi
  sleep 1
done
check 'GET /health/ready ok' ok "$ready"
check 'health reports database up' up "$(curl -s -m 3 "$BASE/health/ready" | jq -r '.database')"
if kill -0 "$API_PID" 2>/dev/null; then
  ok 'api process stays up'
else
  bad 'api process stays up' "$(tail -8 "$TMP/api.log")"
  echo "e2e smoke aborted: $PASS ok / $FAIL fail"
  exit 1
fi

echo '--- authentication'
code=$(req POST /api/v1/Authentication '' "{\"userName\":\"$ADMIN_LOGIN\",\"password\":\"$ADMIN_PASSWORD\"}")
check 'POST /Authentication 201' 201 "$code"
TOKEN="Bearer $(jq_get .accessToken)"
REFRESH="$(jq_get .refreshToken)"
if [ -n "$TOKEN" ]; then ok 'access token issued'; else bad 'access token issued' "$(body)"; fi
check 'GET /AppUser/me 200' 200 "$(req GET /api/v1/AppUser/me "$TOKEN")"
check 'me reports admin type' admin "$(jq_get .type)"
code=$(req POST /api/v1/Authentication '' "{\"userName\":\"$ADMIN_LOGIN\",\"password\":\"wrong-password\"}")
check 'wrong password 401' 401 "$code"
check 'error envelope code' AUTHENTICATION_FAILED "$(jq_get .error.code)"
check 'unauthenticated list 401' 401 "$(req GET /api/v1/User '')"
code=$(req POST /api/v1/Refresh '' "{\"refreshToken\":\"$REFRESH\"}")
check 'POST /Refresh 201' 201 "$code"
TOKEN="Bearer $(jq_get .accessToken)"
check 'reused refresh token 401' 401 "$(req POST /api/v1/Refresh '' "{\"refreshToken\":\"$REFRESH\"}")"
REFRESH="$(jq_get .refreshToken)"

echo '--- api keys'
code=$(req POST /api/v1/ApiUser "$TOKEN" "{\"userName\":\"api-${RUN_ID}\",\"assignedRoleIds\":[\"sysAdmin\"]}")
check 'POST /ApiUser 201' 201 "$code"
KEY_ID="$(jq_get .keyId)"
APIAUTH="ApiKey ${KEY_ID}:$(jq_get .secret)"
check 'ApiKey authentication 200' 200 "$(req GET /api/v1/AppUser/me "$APIAUTH")"
check 'DELETE /ApiKey 200' 200 "$(req DELETE "/api/v1/ApiKey/${KEY_ID}" "$TOKEN")"
check 'revoked ApiKey 401' 401 "$(req GET /api/v1/AppUser/me "$APIAUTH")"

echo '--- roles, teams, users'
code=$(req POST /api/v1/Role "$TOKEN" "{\"name\":\"role-${RUN_ID}\",\"permissions\":{\"Account\":{\"read\":\"own\",\"create\":\"yes\",\"edit\":\"own\",\"delete\":\"no\"}}}")
check 'POST /Role 201' 201 "$code"
ROLE_ID="$(jq_get .id)"
code=$(req POST /api/v1/Team "$TOKEN" "{\"name\":\"team-${RUN_ID}\"}")
check 'POST /Team 201' 201 "$code"
code=$(req POST /api/v1/User "$TOKEN" "{\"userName\":\"own-${RUN_ID}\",\"password\":\"ownpass123\",\"assignedRoleIds\":[\"$ROLE_ID\"]}")
check 'POST /User 201' 201 "$code"
code=$(req POST /api/v1/Authentication '' "{\"userName\":\"own-${RUN_ID}\",\"password\":\"ownpass123\"}")
check 'scoped user logs in 201' 201 "$code"
OWN_TOKEN="Bearer $(jq_get .accessToken)"
check 'scoped user denied admin list 403' 403 "$(req GET /api/v1/User "$OWN_TOKEN")"

echo '--- metadata'
code=$(req GET /api/v1/Metadata "$TOKEN")
check 'GET /Metadata 200' 200 "$code"
check 'metadata contains Account' Account "$(jq_get '.entities.Account.name // .Account.name')"
FIELD="e2eField${RUN_ID//-/}"
code=$(req POST "/api/v1/Metadata/Account" "$TOKEN" "{\"fields\":{\"$FIELD\":{\"type\":\"varchar\",\"maxLength\":64,\"inList\":true}}}")
if [ "$code" = 200 ] || [ "$code" = 201 ]; then ok 'POST /Metadata/Account (custom field)'; else bad 'POST /Metadata/Account (custom field)' "code=$code $(body)"; fi
req GET /api/v1/Metadata "$TOKEN" >/dev/null
check 'custom field visible in metadata' varchar "$(jq_get ".Account.fields.${FIELD}.type")"

echo '--- generic entity CRUD'
code=$(req POST /api/v1/Account "$TOKEN" "{\"name\":\"E2E Account ${RUN_ID}\",\"website\":\"https://example.com\",\"$FIELD\":\"dynamic-value\"}")
check 'POST /Account 201' 201 "$code"
ACCOUNT_ID="$(jq_get .id)"
check 'dynamic custom field stored' dynamic-value "$(jq_get ".$FIELD")"
check 'GET /Account/:id 200' 200 "$(req GET "/api/v1/Account/${ACCOUNT_ID}" "$TOKEN")"
code=$(req PATCH "/api/v1/Account/${ACCOUNT_ID}" "$TOKEN" "{\"industry\":\"Software\",\"version\":$(jq_get .version)}")
check 'PATCH /Account/:id 200' 200 "$code"
check 'updated field persisted' Software "$(jq_get .industry)"
req GET "/api/v1/Account?maxSize=25" "$TOKEN" >/dev/null
check 'list envelope has list/total/count' true "$([ -n "$(jq_get .total)" ] && [ "$(jq_get '.list | length')" -ge 1 ] && echo true || echo false)"
WHERE_ENC=$(jq -rn --arg id "$ACCOUNT_ID" '[{field:"id",operator:"equals",value:$id}] | @uri')
req GET "/api/v1/Account?where=${WHERE_ENC}&maxSize=10" "$TOKEN" >/dev/null
check 'query grammar: equals filter matches' 1 "$(jq_get '.list | length')"
code=$(req POST /api/v1/Contact "$TOKEN" "{\"name\":\"E2E Contact\",\"lastName\":\"Contact\",\"accountId\":\"$ACCOUNT_ID\"}")
check 'POST /Contact 201' 201 "$code"
CONTACT_ID="$(jq_get .id)"
req GET "/api/v1/Account/${ACCOUNT_ID}/contacts" "$TOKEN" >/dev/null
found="$(jq -r --arg cid "$CONTACT_ID" '.list | map(.id) | index($cid) // "__missing__"' "$TMP/body")"
check 'GET /Account/:id/contacts contains child' true "$([ "$found" != "__missing__" ] && echo true || echo false)"

echo '--- optimistic concurrency'
req GET "/api/v1/Account/${ACCOUNT_ID}" "$TOKEN" >/dev/null
STALE="$(jq_get .version)"
req PATCH "/api/v1/Account/${ACCOUNT_ID}" "$TOKEN" "{\"name\":\"bumped\",\"version\":$STALE}" >/dev/null
code=$(req PATCH "/api/v1/Account/${ACCOUNT_ID}" "$TOKEN" "{\"name\":\"conflict\",\"version\":$STALE}")
check 'stale version rejected 409' 409 "$code"
check 'conflict error code' CONCURRENCY_CONFLICT "$(jq_get .error.code)"

echo '--- soft delete'
check 'DELETE /Account/:id 200' 200 "$(req DELETE "/api/v1/Account/${ACCOUNT_ID}" "$TOKEN")"
check 'deleted record hidden from GET 404' 404 "$(req GET "/api/v1/Account/${ACCOUNT_ID}" "$TOKEN")"

echo '--- attachments'
printf 'e2e attachment payload\n' >"$TMP/upload.txt"
code=$(curl -s -m 20 -o "$TMP/body" -w '%{http_code}' -X POST "$BASE/api/v1/Attachment/upload" -H "authorization: $TOKEN" -F "file=@$TMP/upload.txt" -F "parentId=$CONTACT_ID" -F "parentType=Contact")
check 'POST /Attachment/upload 201' 201 "$code"
ATT_ID="$(jq_get .id)"
ATTACH_TOKEN="$TOKEN"
check 'attachment checksum returned' true "$([ -n "$(jq_get .checksum)" ] && echo true || echo false)"
curl -s -m 20 -o "$TMP/download.txt" -w '%{http_code}' "$BASE/api/v1/Attachment/${ATT_ID}/file" -H "authorization: $ATTACH_TOKEN" >/dev/null
check 'attachment downloads byte-identical' 'e2e attachment payload' "$(cat "$TMP/download.txt")"

echo '--- audit'
audit_code=$(req GET "/api/v1/AuditLog?entityType=Contact&maxSize=50" "$TOKEN")
check 'GET /AuditLog 200 for admin' 200 "$audit_code"
check 'audit rows recorded for entity changes' true "$(jq -r '[.list[]? | select(.entityType=="Contact" or .entityType=="Account")] | length > 0' "$TMP/body" 2>/dev/null)"
check 'non-admin cannot browse full audit log' 403 "$(req GET /api/v1/AuditLog "$OWN_TOKEN")"

echo '--- openapi'
code=$(curl -s -m 20 -o "$TMP/openapi.json" -w '%{http_code}' "$BASE/api/v1/OpenApi")
check 'GET /api/v1/OpenApi 200' 200 "$code"
check 'openapi documents auth endpoint' true "$(jq -r 'has("paths") and (.paths | has("/api/v1/Authentication"))' "$TMP/openapi.json")"

echo '--- outbox'
PENDING=$(node -e "
const {Pool}=require('pg');
(async()=>{const p=new Pool({connectionString:process.env.DATABASE_URL});
const r=await p.query(\"select count(*)::int as n from outbox_events where event_type like 'entity.%'\");
process.stdout.write(String(r.rows[0].n));await p.end();})()" 2>/dev/null)
check 'entity events written to outbox' true "$([ "${PENDING:-0}" -ge 1 ] && echo true || echo false)"

printf '\ne2e smoke: %d ok / %d fail\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "--- api log tail ---"
  tail -15 "$TMP/api.log"
  exit 1
fi
echo 'E2E SMOKE PASS'
