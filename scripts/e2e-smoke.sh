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
# Outbound mail is held in memory: this run must never reach a mail server (AGENTS.md §5.5).
export MAIL_TRANSPORT=memory
# The scratch queue the API test suite already uses: a send job queued here can never reach the real
# `crm-jobs` queue, and no per-run queue accumulates in Redis (AGENTS.md §3.3).
export JOB_QUEUE_NAME=crm-jobs-test

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

# --- storage capabilities and file safety (PLAN §25)
check 'GET /Attachment/action/info 200' 200 "$(req GET /api/v1/Attachment/action/info "$TOKEN")"
check 'info reports the local driver' local "$(jq_get .driver)"
check 'info reports the size ceiling' true "$([ "$(jq_get .maxUploadBytes)" -gt 0 ] && echo true || echo false)"
check 'info reports the malware scanner' true "$([ -n "$(jq_get .scanProvider)" ] && echo true || echo false)"
check 'local storage has no signed download URL' 403 "$(req GET "/api/v1/Attachment/${ATT_ID}/url" "$TOKEN")"
check 'anonymous download refused' 401 "$(req GET "/api/v1/Attachment/${ATT_ID}/file")"

printf '%s\n' 'X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' >"$TMP/eicar.txt"
code=$(curl -s -m 20 -o "$TMP/body" -w '%{http_code}' -X POST "$BASE/api/v1/Attachment/upload" -H "authorization: $TOKEN" -F "file=@$TMP/eicar.txt" -F 'type=text/plain')
check 'EICAR test file rejected by the scan hook' 422 "$code"
code=$(curl -s -m 20 -o "$TMP/body" -w '%{http_code}' -X POST "$BASE/api/v1/Attachment/upload" -H "authorization: $TOKEN" -F "file=@$TMP/upload.txt;filename=payload.exe")
check 'blocked executable extension rejected' 422 "$code"

# --- chunked upload: reserve, parts out of order, assemble into one attachment
head -c 700 /dev/zero | tr '\0' 'a' >"$TMP/part0"
head -c 300 /dev/zero | tr '\0' 'b' >"$TMP/part1"
TOTAL=$(( $(wc -c <"$TMP/part0") + $(wc -c <"$TMP/part1") ))
code=$(req POST /api/v1/AttachmentUpload/init "$TOKEN" "{\"name\":\"chunked.txt\",\"mimeType\":\"text/plain\",\"totalSize\":$TOTAL}")
check 'POST /AttachmentUpload/init 200' 200 "$code"
UP_ID="$(jq_get .id)"
check 'reservation reports the chunk ceiling' true "$([ "$(jq_get .chunkMaxSize)" -gt 0 ] && echo true || echo false)"
code=$(curl -s -m 20 -o "$TMP/body" -w '%{http_code}' -X POST "$BASE/api/v1/AttachmentUpload/${UP_ID}/part" -H "authorization: $TOKEN" -F "index=1" -F "file=@$TMP/part1;type=application/octet-stream")
check 'POST part (second chunk first) 200' 200 "$code"
code=$(req POST "/api/v1/AttachmentUpload/${UP_ID}/complete" "$TOKEN")
check 'complete with a gap refused' 422 "$code"
code=$(curl -s -m 20 -o "$TMP/body" -w '%{http_code}' -X POST "$BASE/api/v1/AttachmentUpload/${UP_ID}/part" -H "authorization: $TOKEN" -F "index=0" -F "file=@$TMP/part0;type=application/octet-stream")
check 'POST part (first chunk) 200' 200 "$code"
check 'progress reports every reserved byte' "$TOTAL" "$(jq_get .received)"
code=$(req POST "/api/v1/AttachmentUpload/${UP_ID}/complete" "$TOKEN")
check 'complete assembles one attachment 201' 201 "$code"
CHUNK_ID="$(jq_get .id)"
check 'assembled size matches the parts' "$TOTAL" "$(jq_get .size)"
curl -s -m 20 -o "$TMP/chunked.txt" "$BASE/api/v1/Attachment/${CHUNK_ID}/file" -H "authorization: $TOKEN" >/dev/null
check 'assembled bytes are in chunk order' true "$([ "$(cat "$TMP/chunked.txt" | tr -d 'b' | wc -c)" -eq 700 ] && [ "$(wc -c <"$TMP/chunked.txt")" -eq "$TOTAL" ] && echo true || echo false)"
code=$(req POST "/api/v1/AttachmentUpload/${UP_ID}/complete" "$TOKEN")
check 'completing twice refused' 422 "$code"

check 'aborted upload keeps its status' aborted "$(req POST /api/v1/AttachmentUpload/init "$TOKEN" '{"name":"aborted.txt","mimeType":"text/plain","totalSize":10}' >/dev/null; jq_get .id | { read -r uid; req POST "/api/v1/AttachmentUpload/${uid}/abort" "$TOKEN" >/dev/null; req GET "/api/v1/AttachmentUpload/${uid}" "$TOKEN" >/dev/null; jq_get .status; })"


echo '--- email (PLAN §28)'
check 'GET /Email/action/transport 200' 200 "$(req GET /api/v1/Email/action/transport "$TOKEN")"
check 'transport is the in-memory one' memory "$(jq_get .name)"
check 'transport is not delivering' disabled "$(jq_get .mode)"
check 'transport response carries no credential' true "$(! grep -qi 'password\|secret' "$TMP/body" && echo true || echo false)"
check 'anonymous transport 401' 401 "$(req GET /api/v1/Email/action/transport)"
check 'admin can verify the transport' true "$(req POST /api/v1/Email/action/verify "$TOKEN" >/dev/null; jq_get .verified)"
check 'regular user cannot verify the transport' 403 "$(req POST /api/v1/Email/action/verify "$OWN_TOKEN")"

req POST /api/v1/Email "$TOKEN" "{\"name\":\"AGENT_TEST ${RUN_ID} hello\",\"fromAddress\":\"Sales <sales@example.com>\",\"toAddressList\":\"a-${RUN_ID}@example.com, b-${RUN_ID}@example.com\",\"ccAddressList\":\"c-${RUN_ID}@example.com\",\"body\":\"Smoke body\"}" >/dev/null
EMAIL_ID="$(jq_get .id)"
check 'POST /Email stored a Draft' Draft "$(req GET "/api/v1/Email/${EMAIL_ID}" "$TOKEN" >/dev/null; jq_get .status)"

check 'POST /Email/:id/action/send 200' 200 "$(req POST "/api/v1/Email/${EMAIL_ID}/action/send" "$TOKEN")"
SEND_JOB_ID="$(jq_get .job.id)"
check 'send produced a system.sendEmail job' system.sendEmail "$(jq_get .job.name)"
check 'send wrote one ledger row per recipient' 3 "$(jq -r '.deliveries | length' "$TMP/body")"
check 'the record is now Queued' Queued "$(req GET "/api/v1/Email/${EMAIL_ID}" "$TOKEN" >/dev/null; jq_get .status)"
check 'GET /Email/:id/deliveries 200' 200 "$(req GET "/api/v1/Email/${EMAIL_ID}/deliveries" "$TOKEN")"
check 'every ledger row is pending' 3 "$(jq -r '[.[] | select(.status=="pending")] | length' "$TMP/body")"
check 'the cc recipient is remembered' 1 "$(jq -r '[.[] | select(.recipientType=="cc")] | length' "$TMP/body")"
check 'a queued email cannot be queued twice' 422 "$(req POST "/api/v1/Email/${EMAIL_ID}/action/send" "$TOKEN")"
check 'deliveries need authentication' 401 "$(req GET "/api/v1/Email/${EMAIL_ID}/deliveries")"

req POST /api/v1/Email "$TOKEN" "{\"name\":\"AGENT_TEST ${RUN_ID} no recipient\",\"body\":\"x\"}" >/dev/null
NO_TO_ID="$(jq_get .id)"
check 'an email with no recipient is refused' 422 "$(req POST "/api/v1/Email/${NO_TO_ID}/action/send" "$TOKEN")"
check 'the refused draft is still a Draft' Draft "$(req GET "/api/v1/Email/${NO_TO_ID}" "$TOKEN" >/dev/null; jq_get .status)"
check 'the refused draft wrote no ledger row' 0 "$(req GET "/api/v1/Email/${NO_TO_ID}/deliveries" "$TOKEN" >/dev/null; jq -r 'length' "$TMP/body")"

req POST /api/v1/Email "$TOKEN" "{\"name\":\"AGENT_TEST ${RUN_ID} forged header\",\"body\":\"x\",\"toAddressList\":\"a-${RUN_ID}@example.com\",\"headers\":\"{\\\"From\\\":\\\"victim@example.com\\\"}\"}" >/dev/null
FORGE_ID="$(jq_get .id)"
check 'a header the envelope owns is refused' 422 "$(req POST "/api/v1/Email/${FORGE_ID}/action/send" "$TOKEN")"

# Nothing this run queued may survive for a later worker to execute (§3.3): cancel, then delete by id.
check 'the queued send job can be cancelled' 200 "$(req POST "/api/v1/Job/${SEND_JOB_ID}/action/cancel" "$TOKEN")"
node -e "
const {Pool}=require('pg');
(async()=>{const p=new Pool({connectionString:process.env.DATABASE_URL,max:1});
await p.query('DELETE FROM email_deliveries WHERE email_id = ANY(\$1::text[])',[['${EMAIL_ID}','${NO_TO_ID}','${FORGE_ID}']]);
await p.query('DELETE FROM entity_records WHERE id = ANY(\$1::text[])',[['${EMAIL_ID}','${NO_TO_ID}','${FORGE_ID}']]);
await p.query('DELETE FROM job_logs WHERE job_id = \$1',['${SEND_JOB_ID}']);
await p.query('DELETE FROM jobs WHERE id = \$1',['${SEND_JOB_ID}']);
await p.end();})()" 2>/dev/null
check 'the cancelled job row is gone' 404 "$(req GET "/api/v1/Job/${SEND_JOB_ID}" "$TOKEN")"
check 'the test emails are gone too' 404 "$(req GET "/api/v1/Email/${EMAIL_ID}" "$TOKEN")"

echo '--- search, saved filters, import/export, dashboards (PLAN §30, §32, §33)'
S_NAME="E2E Search ${RUN_ID}"
code=$(req POST /api/v1/Account "$TOKEN" "{\"name\":\"$S_NAME\",\"emailAddress\":\"e2e.${RUN_ID}@example.com\"}")
check 'POST /Account (search fixture) 201' 201 "$code"
S_ID="$(jq_get .id)"
code=$(req GET "/api/v1/Search?q=${RUN_ID}&entities=Account" "$TOKEN")
check 'GET /Search 200' 200 "$code"
check 'global search finds the fixture by name' true "$(jq -r --arg id "$S_ID" '[.list[]? | select(.entityType=="Account" and .record.id==$id)] | length > 0' "$TMP/body")"
# Only emailAddress can carry this term, so it proves the trigram-indexed attrs path is searched.
code=$(req GET "/api/v1/Search/Account?q=${RUN_ID}%40example" "$TOKEN")
check 'GET /Search/:entity 200' 200 "$code"
check 'entity search matches on the indexed email key' true "$(jq -r --arg id "$S_ID" '[.list[]? | select(.id==$id)] | length > 0' "$TMP/body")"
code=$(req GET "/api/v1/Search/Account?q=${S_ID}" "$TOKEN")
check 'entity search matches an exact id' true "$(jq -r --arg id "$S_ID" '[.list[]? | select(.id==$id)] | length > 0' "$TMP/body")"
check 'empty search query 422' 422 "$(req GET '/api/v1/Search?q=%20' "$TOKEN")"
check 'unknown search entity 404' 404 "$(req GET '/api/v1/Search/Nope?q=x' "$TOKEN")"

code=$(req POST /api/v1/SavedFilter "$TOKEN" "{\"name\":\"E2E Filter ${RUN_ID}\",\"entityType\":\"Account\",\"criteria\":[{\"field\":\"name\",\"operator\":\"like\",\"value\":\"${RUN_ID}\"}],\"visibility\":\"private\"}")
check 'POST /SavedFilter 201' 201 "$code"
FILTER_ID="$(jq_get .id)"
code=$(req POST "/api/v1/SavedFilter/${FILTER_ID}/action/run" "$TOKEN" '{}')
check 'POST /SavedFilter/:id/action/run 200' 200 "$code"
check 'saved filter run returns the fixture' true "$(jq -r --arg id "$S_ID" '[.result.list[]? | select(.id==$id)] | length > 0' "$TMP/body")"
check 'GET /SavedFilter lists it' true "$(req GET "/api/v1/SavedFilter?entityType=Account" "$TOKEN" >/dev/null; jq -r --arg id "$FILTER_ID" '[.[]? | select(.id==$id)] | length > 0' "$TMP/body")"

I_NAME="E2E Import ${RUN_ID}"
code=$(req POST /api/v1/Account/action/import "$TOKEN" "{\"csv\":\"name,type\\n\\\"$I_NAME\\\",\\\"=HYPERLINK(\\\"\\\"http://evil.example\\\"\\\")\\\"\\n\"}")
check 'POST /:entity/action/import 200' 200 "$code"
check 'import created a row' true "$([ "$(jq_get .created)" -ge 1 ] && echo true || echo false)"
check 'unknown import column 422' 422 "$(req POST /api/v1/Account/action/import "$TOKEN" '{"csv":"nope\nx\n"}')"
check 'GET /:entity/action/exportColumns 200' 200 "$(req GET /api/v1/Account/action/exportColumns "$TOKEN")"
export_ct="$(curl -s -m 20 -o "$TMP/export.csv" -D "$TMP/export.hdr" -w '%{http_code}' -X POST "$BASE/api/v1/Account/action/export" \
  -H "authorization: $TOKEN" -H 'content-type: application/json' \
  -d "{\"where\":[{\"field\":\"name\",\"operator\":\"like\",\"value\":\"$I_NAME\"}]}")"
check 'POST /:entity/action/export 200' 200 "$export_ct"
check 'export is served as text/csv' true "$(grep -qi 'content-type: text/csv' "$TMP/export.hdr" && echo true || echo false)"
check 'export carries the imported row' true "$(grep -q "$I_NAME" "$TMP/export.csv" && echo true || echo false)"
check 'export neutralises a stored formula' true "$(grep -q "'=HYPERLINK" "$TMP/export.csv" && echo true || echo false)"

code=$(req POST /api/v1/Dashboard "$TOKEN" "{\"name\":\"E2E Dashboard ${RUN_ID}\",\"layout\":[],\"config\":{}}")
check 'POST /Dashboard 201' 201 "$code"
DASH_ID="$(jq_get .id)"
code=$(req POST "/api/v1/Dashboard/${DASH_ID}/dashlets" "$TOKEN" "{\"name\":\"E2E KPI ${RUN_ID}\",\"kind\":\"kpi\",\"position\":0,\"config\":{\"entity\":\"Account\",\"where\":[{\"field\":\"name\",\"operator\":\"like\",\"value\":\"${RUN_ID}\"}]}}")
check 'POST /Dashboard/:id/dashlets 201' 201 "$code"
DASHLET_ID="$(jq_get .id)"
code=$(req GET "/api/v1/Dashboard/${DASH_ID}/dashlets/${DASHLET_ID}/action/run" "$TOKEN")
check 'GET dashlet action/run 200' 200 "$code"
check 'kpi dashlet counts through the query engine' true "$([ "$(jq_get .count)" -ge 2 ] && echo true || echo false)"
check 'dashlet config rejects an unknown entity' 404 "$(req POST "/api/v1/Dashboard/${DASH_ID}/dashlets" "$TOKEN" '{"name":"E2E bad","kind":"list","position":1,"config":{"entity":"Nope"}}')"
check 'DELETE /Dashboard/:id 200' 200 "$(req DELETE "/api/v1/Dashboard/${DASH_ID}" "$TOKEN")"
check 'dashboard gone 404' 404 "$(req GET "/api/v1/Dashboard/${DASH_ID}" "$TOKEN")"
check 'DELETE /SavedFilter/:id 200' 200 "$(req DELETE "/api/v1/SavedFilter/${FILTER_ID}" "$TOKEN")"
node -e "
const {Pool}=require('pg');
(async()=>{const p=new Pool({connectionString:process.env.DATABASE_URL,max:1});
await p.query('DELETE FROM entity_records WHERE id = ANY(\$1::text[])',[['${S_ID}']]);
await p.query(\"DELETE FROM entity_records WHERE entity_type='Account' AND name = \$1\",['${I_NAME}']);
await p.end();})()" 2>/dev/null
check 'search fixture removed' 404 "$(req GET "/api/v1/Account/${S_ID}" "$TOKEN")"

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
