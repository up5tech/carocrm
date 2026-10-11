#!/usr/bin/env bash
#
# Worker integration smoke test.
#
# Proves the worker loops against the real Postgres + Redis from .env:
#   1. outbox poller  -> fake `pending` events become `processed` (known + unknown types)
#   2. BullMQ worker  -> a producer-enqueued `system.noop` job writes a `completed` jobs row
#   3. cron scheduler -> a `scheduled_jobs` row fires once (deterministic jobId, last_run_at)
#   4. graceful shutdown -> the WORKER_RUN_MS auto-stop and a SIGTERM both drain cleanly
#
# It never starts the API, so it consumes no HTTP port (scripts/e2e-smoke.sh owns 3131; an API
# owned by this script would have to use 3132). Every row it creates is tagged with this run's
# id and deleted again on exit, so it is idempotent and safe to re-run. Nothing destructive:
# no TRUNCATE, no DROP.
#
# Run: bash scripts/worker-smoke.sh   (also: pnpm --filter @carocrm/worker test:smoke)

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

# pino-pretty is not installed: keep the shared logger on its plain JSON path.
export NODE_ENV="${NODE_ENV:-production}"
export LOG_LEVEL="${LOG_LEVEL:-info}"

RUN_ID="smoke-worker-$(date +%Y%m%d%H%M%S)-$$"
LOG_FILE="$(mktemp -t carocrm-worker-smoke)"
SEED_LOG="$(mktemp -t carocrm-worker-seed)"
SIG_LOG="$(mktemp -t carocrm-worker-sig)"
PROG_LOG="$(mktemp -t carocrm-worker-progress)"
WORKER_PID=""
FAILURES=0
CHECKS=0
WAIT_TIMEOUT="${WORKER_SMOKE_WAIT:-30}"
WORKER_RUN_MS=0

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

env_or_dotenv() { # key default -> value (real env wins, then .env, then the default)
  local key="$1" default="$2" value="${!1:-}"
  if [ -z "$value" ] && [ -f "$ROOT/.env" ]; then
    value="$(grep -E "^${key}=" "$ROOT/.env" | tail -n 1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
  fi
  [ -z "$value" ] && value="$default"
  printf '%s' "$value"
}

DATABASE_URL="$(env_or_dotenv DATABASE_URL 'postgres://postgres:postgres@127.0.0.1:5432/carocrm_dev')"
REDIS_URL="$(env_or_dotenv REDIS_URL 'redis://127.0.0.1:6379')"
export DATABASE_URL REDIS_URL

hide_credentials() { sed -e 's#://[^@/]*@#://***@#'; }

# node_pg <sql> -> JSON array of rows on stdout (pg is a root devDependency).
node_pg() {
  SMOKE_SQL="$1" node -e '
    const { Pool } = require("pg");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    pool.query(process.env.SMOKE_SQL)
      .then((res) => pool.end().then(() => res))
      .then((res) => {
        process.stdout.write(JSON.stringify(res.rows ?? []));
      })
      .catch(async (error) => {
        process.stderr.write(`pg: ${error.message}\n`);
        await pool.end().catch(() => {});
        process.exit(1);
      });
  '
}

first_value() { # reads a JSON row array on stdin -> first column of the first row
  node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => (raw += chunk));
    process.stdin.on("end", () => {
      let rows = [];
      try { rows = JSON.parse(raw || "[]"); } catch { rows = []; }
      const first = Array.isArray(rows) ? rows[0] : undefined;
      if (!first) { process.stdout.write(""); return; }
      const key = Object.keys(first)[0];
      process.stdout.write(String(first[key]));
    });
  '
}

count_where() { # count_where "<table> WHERE ..." -> integer
  local value
  value="$(node_pg "SELECT COUNT(*)::int AS n FROM $1;" | first_value)"
  printf '%s' "${value:-0}"
}

ok() { printf '  ok   %s\n' "$1"; }
bad() { printf '  FAIL %s\n' "$1"; FAILURES=$((FAILURES + 1)); }

check_equals() { # check_equals <label> <expected> <actual>
  CHECKS=$((CHECKS + 1))
  if [ "$2" = "$3" ]; then
    ok "$1"
  else
    printf '  FAIL %s (expected "%s", got "%s")\n' "$1" "$2" "$3"
    FAILURES=$((FAILURES + 1))
  fi
}

check_at_least() { # check_at_least <label> <expected> <actual>
  CHECKS=$((CHECKS + 1))
  if [ "${3:-0}" -ge "$2" ] 2>/dev/null; then
    ok "$1"
  else
    printf '  FAIL %s (expected at least %s, got %s)\n' "$1" "$2" "${3:-0}"
    FAILURES=$((FAILURES + 1))
  fi
}

wait_until_equals() { # wait_until_equals <expected> <probe-function-name>
  local expected="$1" probe="$2" waited=0 actual=""
  while [ "$waited" -lt "$WAIT_TIMEOUT" ]; do
    actual="$("$probe")"
    [ "$actual" = "$expected" ] && return 0
    sleep 1
    waited=$((waited + 1))
  done
  printf '  (timed out after %ss waiting for %s to reach %s; last value "%s")\n' \
    "$WAIT_TIMEOUT" "$probe" "$expected" "$actual"
  return 1
}

alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }

kill_tree() { # kill_tree <pid> [signal] — descendants first, restricted to our own process tree
  local pid="$1" sig="${2:-TERM}" child
  [ -z "$pid" ] && return 0
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    kill_tree "$child" "$sig"
  done
  kill "-${sig}" "$pid" 2>/dev/null || true
}

wait_gone() { # wait_gone <pid> <timeoutSeconds>
  local pid="$1" timeout="$2" waited=0
  while alive "$pid"; do
    [ "$waited" -ge "$timeout" ] && return 1
    sleep 1
    waited=$((waited + 1))
  done
  return 0
}

purge_like() { # purge_like <id-prefix> — delete this run's rows (also used for stale runs)
  node_pg "
    DELETE FROM outbox_events WHERE id LIKE '$1%';
    DELETE FROM scheduled_jobs WHERE id LIKE '$1%';
    DELETE FROM jobs WHERE target->>'smokeRunId' LIKE '$1%';  -- job_logs rows cascade through the FK
  " >/dev/null 2>&1 || true
}

cleanup() {
  if alive "$WORKER_PID"; then
    kill_tree "$WORKER_PID" TERM
    wait_gone "$WORKER_PID" 12 || kill_tree "$WORKER_PID" KILL
  fi
  if alive "${SIG_PID:-}"; then
    kill_tree "$SIG_PID" TERM
    wait_gone "$SIG_PID" 12 || kill_tree "$SIG_PID" KILL
  fi
  purge_like "$RUN_ID"
  rm -f "$LOG_FILE" "$SEED_LOG" "$SIG_LOG" "$PROG_LOG"
}
trap cleanup EXIT

worker_run() { # worker_run <script.ts> [args...] — bounded by WORKER_RUN_MS
  local script="$1"
  shift
  env DATABASE_URL="$DATABASE_URL" REDIS_URL="$REDIS_URL" LOG_LEVEL="$LOG_LEVEL" NODE_ENV="$NODE_ENV" \
    WORKER_OUTBOX_POLL_INTERVAL_MS=700 WORKER_SCHEDULER_INTERVAL_MS=1000 WORKER_JOB_CONCURRENCY=2 \
    WORKER_RUN_MS="$WORKER_RUN_MS" \
    "$ROOT/apps/worker/node_modules/.bin/tsx" "$script" "$@"
}

# ---------------------------------------------------------------------------
# 0. schema + seed, plus a sweep of rows left behind by an aborted run
# ---------------------------------------------------------------------------
printf 'worker smoke %s\n' "$RUN_ID"
printf '  database %s\n' "$(printf '%s' "$DATABASE_URL" | hide_credentials)"
printf '  redis    %s\n' "$(printf '%s' "$REDIS_URL" | hide_credentials)"

CHECKS=$((CHECKS + 1))
if pnpm db:seed >"$SEED_LOG" 2>&1; then
  ok 'pnpm db:seed (migrations + admin seed, idempotent)'
else
  bad 'pnpm db:seed (migrations + admin seed, idempotent)'
  tail -n 20 "$SEED_LOG"
  exit 1
fi

purge_like 'smoke-worker-'

# ---------------------------------------------------------------------------
# 1. fixtures: pending outbox events + one per-minute cron schedule
# ---------------------------------------------------------------------------
node_pg "
  INSERT INTO outbox_events (id, event_type, payload, status, attempts, available_at)
  VALUES
    ('${RUN_ID}-noop', 'system.noop', '{\"smokeRunId\":\"${RUN_ID}\"}'::jsonb, 'pending', 0, now()),
    ('${RUN_ID}-log', 'system.log', '{\"smokeRunId\":\"${RUN_ID}\",\"note\":\"worker smoke\"}'::jsonb, 'pending', 0, now()),
    ('${RUN_ID}-unknown', 'smoke.thisTypeHasNoHandler', '{\"smokeRunId\":\"${RUN_ID}\"}'::jsonb, 'pending', 0, now());

  INSERT INTO scheduled_jobs (id, job, scheduling, target, enabled, last_run_at)
  VALUES ('${RUN_ID}-sched', 'system.noop', '* * * * *', '{\"smokeRunId\":\"${RUN_ID}\"}'::jsonb, TRUE, NULL);

  -- The poller claims the oldest pending rows first, so this run's fixtures jump that queue
  -- instead of waiting behind events left by earlier development runs.
  UPDATE outbox_events SET available_at = now() - interval '1 hour' WHERE id LIKE '${RUN_ID}%';
" >/dev/null

check_equals 'fixtures: 3 pending outbox events' '3' "$(count_where "outbox_events WHERE id LIKE '${RUN_ID}%' AND status = 'pending'")"
check_equals 'fixtures: 1 enabled schedule' '1' "$(count_where "scheduled_jobs WHERE id = '${RUN_ID}-sched' AND enabled = TRUE")"

# ---------------------------------------------------------------------------
# 2. run the worker bounded: it stops itself through the graceful shutdown path
# ---------------------------------------------------------------------------
WORKER_RUN_MS=20000
worker_run apps/worker/src/main.ts >"$LOG_FILE" 2>&1 &
WORKER_PID=$!
printf '  worker started (pid %s, outbox poll 700ms, scheduler 1s, auto-stop 20s)\n' "$WORKER_PID"

# Producer: enqueue through the real BullMQ queue while the worker is consuming.
sleep 2
CHECKS=$((CHECKS + 1))
if worker_run apps/worker/src/tools/enqueue-cli.ts system.noop "{\"smokeRunId\":\"${RUN_ID}\",\"source\":\"producer\"}" >>"$LOG_FILE" 2>&1; then
  ok 'producer enqueued system.noop on crm-jobs'
else
  bad 'producer enqueued system.noop on crm-jobs'
fi

processed_events() { count_where "outbox_events WHERE id LIKE '${RUN_ID}%' AND status = 'processed' AND processed_at IS NOT NULL"; }
producer_jobs() { count_where "jobs WHERE target->>'smokeRunId' = '${RUN_ID}' AND target->>'source' = 'producer' AND status = 'completed' AND started_at IS NOT NULL AND finished_at IS NOT NULL"; }
cron_jobs() { count_where "jobs WHERE target->>'smokeRunId' = '${RUN_ID}' AND scheduling_type = 'cron' AND status = 'completed'"; }
schedule_ran() { count_where "scheduled_jobs WHERE id = '${RUN_ID}-sched' AND last_run_at IS NOT NULL"; }
leftover_events() { count_where "outbox_events WHERE id LIKE '${RUN_ID}%' AND status IN ('pending', 'running')"; }
completed_jobs() { count_where "jobs WHERE target->>'smokeRunId' = '${RUN_ID}' AND status = 'completed'"; }

wait_until_equals 3 processed_events || true
wait_until_equals 1 producer_jobs || true
wait_until_equals 1 cron_jobs || true
wait_until_equals 1 schedule_ran || true
worker_run apps/worker/src/tools/enqueue-cli.ts --stats >>"$LOG_FILE" 2>&1 || true

check_equals 'outbox: known + unknown events processed' '3' "$(processed_events)"
check_equals 'outbox: nothing left pending or running' '0' "$(leftover_events)"
check_equals 'queue: producer job recorded completed' '1' "$(producer_jobs)"
check_equals 'scheduler: cron job completed with scheduling_type = cron' '1' "$(cron_jobs)"
check_equals 'scheduler: scheduled_jobs.last_run_at advanced' '1' "$(schedule_ran)"
check_at_least 'jobs: at least 2 completed rows for this run' 2 "$(completed_jobs)"

CHECKS=$((CHECKS + 1))
if wait_gone "$WORKER_PID" 45; then
  ok 'worker stopped itself on the WORKER_RUN_MS deadline'
else
  bad 'worker stopped itself on the WORKER_RUN_MS deadline'
  kill_tree "$WORKER_PID" KILL
fi
WORKER_PID=""
check_equals 'shutdown: graceful drain logged' 'yes' "$(grep -q '"msg":"worker stopped"' "$LOG_FILE" && echo yes || echo no)"

# ---------------------------------------------------------------------------
# 3. SIGTERM path: the same drain sequence, driven by a signal instead of a timer
# ---------------------------------------------------------------------------
WORKER_RUN_MS=0
worker_run apps/worker/src/main.ts >"$SIG_LOG" 2>&1 &
SIG_PID=$!
sleep 3
kill_tree "$SIG_PID" TERM
CHECKS=$((CHECKS + 1))
if wait_gone "$SIG_PID" 20; then
  ok 'SIGTERM drained the worker'
else
  bad 'SIGTERM drained the worker'
  kill_tree "$SIG_PID" KILL
fi
check_equals 'SIGTERM: graceful drain logged' 'yes' "$(grep -q '"msg":"worker stopped"' "$SIG_LOG" && echo yes || echo no)"

# ---------------------------------------------------------------------------
# 4. job progress, logs and cancellation (PLAN §24)
# ---------------------------------------------------------------------------
# Two `pending` rows are created first, then one is cancelled before any worker
# claims it: the adoption rule (status = 'pending' AND cancel_requested = FALSE)
# decides the outcome, so there is no race to lose.
node_pg "
  INSERT INTO jobs (id, job, status, scheduling_type, created_at, target, progress, attempt, max_attempts, cancel_requested)
  VALUES
    ('${RUN_ID}-adopt', 'system.cleanupOutbox', 'pending', NULL, now(),
     '{\"smokeRunId\":\"${RUN_ID}\",\"source\":\"adopt\",\"retentionDays\":3650}'::jsonb, 0, 1, 1, FALSE),
    ('${RUN_ID}-cancelled', 'system.noop', 'pending', NULL, now(),
     '{\"smokeRunId\":\"${RUN_ID}\",\"source\":\"cancelled\"}'::jsonb, 0, 1, 1, FALSE);
  UPDATE jobs SET status = 'cancelled', finished_at = now(), cancel_requested = TRUE, message = 'Cancelled before it started.'
   WHERE id = '${RUN_ID}-cancelled';
" >/dev/null

adopt_status() { node_pg "SELECT status FROM jobs WHERE id = '${RUN_ID}-adopt';" | first_value; }
adopt_progress() { node_pg "SELECT COALESCE(progress, -1)::int AS p FROM jobs WHERE id = '${RUN_ID}-adopt';" | first_value; }
adopt_logs() { count_where "job_logs WHERE job_id = '${RUN_ID}-adopt'"; }
adopt_rows() { count_where "jobs WHERE id = '${RUN_ID}-adopt'"; }
cancelled_started() { node_pg "SELECT COALESCE(started_at::text, 'null') AS s FROM jobs WHERE id = '${RUN_ID}-cancelled';" | first_value; }

WORKER_RUN_MS=15000
worker_run apps/worker/src/main.ts >"$PROG_LOG" 2>&1 &
WORKER_PID=$!
sleep 2
CHECKS=$((CHECKS + 1))
if worker_run apps/worker/src/tools/enqueue-cli.ts --row "${RUN_ID}-adopt" system.cleanupOutbox "{\"smokeRunId\":\"${RUN_ID}\",\"source\":\"adopt\",\"retentionDays\":3650}" >>"$PROG_LOG" 2>&1; then
  ok 'producer enqueued onto the pending row'
else
  bad 'producer enqueued onto the pending row'
fi
worker_run apps/worker/src/tools/enqueue-cli.ts --row "${RUN_ID}-cancelled" system.noop "{\"smokeRunId\":\"${RUN_ID}\",\"source\":\"cancelled\"}" >>"$PROG_LOG" 2>&1 || true

wait_until_equals 'completed' adopt_status || true
check_equals 'jobs: the API pending row was adopted, not duplicated' '1' "$(adopt_rows)"
check_equals 'jobs: adopted row finished as completed' 'completed' "$(adopt_status)"
check_at_least 'jobs: progress was written by context.progress()' 20 "$(adopt_progress)"
check_at_least 'jobs: log lines were written by context.log()' 1 "$(adopt_logs)"
check_equals 'jobs: a cancelled job never starts' 'null' "$(cancelled_started)"
check_equals 'jobs: cancelled job stayed cancelled' 'cancelled' "$(node_pg "SELECT status FROM jobs WHERE id = '${RUN_ID}-cancelled';" | first_value)"

CHECKS=$((CHECKS + 1))
if wait_gone "$WORKER_PID" 40; then
  ok 'worker finished the progress run and stopped itself'
else
  bad 'worker finished the progress run and stopped itself'
  kill_tree "$WORKER_PID" KILL
fi
WORKER_PID=""

# ---------------------------------------------------------------------------
# summary
# ---------------------------------------------------------------------------
printf 'worker smoke: %d checks, %d failure(s)\n' "$CHECKS" "$FAILURES"
if [ "$FAILURES" -gt 0 ]; then
  printf 'WORKER SMOKE FAIL\n'
  printf -- '--- last 40 worker log lines ---\n'
  tail -n 40 "$LOG_FILE"
  exit 1
fi
printf 'WORKER SMOKE PASS\n'
exit 0
