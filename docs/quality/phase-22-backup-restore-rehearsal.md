# Phase 22.23 — Backup, Restore and Migration Rehearsal

> **Date:** 2026-10-29
> **Plan:** `PLAN_Phase_22_Integration_E2E_Hardening.md` §22
> **Status: BLOCKED** on the restore exercise (tasks 3–6). The audit, artifact verification,
> recovery procedure and reconciliation policy are complete; there is **no approved isolated
> recovery environment** and **no approved RPO/RTO**, and the plan/AGENTS.md forbid creating a new
> database to work around that. The primary database was not altered.

---

## 1. Objective

Prove the system can recover from failures and evolve its schema without losing existing CRM data.

## 2. Task status

| # | Task | Status |
|---|---|---|
| 1 | Review backup policy and identify DB/file/object-storage backup processes | **Done** — audit §3. Existing policy is a manual `pg_dump` + file tar in `docs/operations/backup-restore.md`; no automation in the repo or compose. |
| 2 | Confirm backup completion, retention, encryption, access controls, monitoring | **Done as an audit** — none of the four is evidenced: no schedule/monitor, no encryption, files are 644, and the only artifact is a partial demo snapshot 179.9 h old. G81. |
| 3 | Define RPO/RTO with the project owner | **Blocked** — the owner chose not to approve values yet; do not invent them (G80). |
| 4 | Validate restore in an approved isolated recovery environment | **Blocked** — no such environment exists; only `carocrm_dev` and unrelated databases. Creating one without explicit approval would violate AGENTS.md §3.6. |
| 5 | Verify restored files/attachments align and signatures/recordings are not public | **Blocked** with task 4. Procedure documented in the runbook §5–§6; not executed. |
| 6 | Rehearse additive migrations on a disposable/recoverable non-production deployment | **Not run** — same environment blocker; no migration was applied to a rehearsal target. |
| 7 | Verify startup/health after a migration and schema/version mismatch | **Current state verified only** — the API boots, `/health/ready` is tested (22.21), and migrations are at 086. Post-restore/post-rehearsal verification remains unproven. |
| 8 | Document pausing workers/integrations during recovery | **Done** — runbook §5–§6: pause workers/integrations before restore and until provider reconciliation is complete. |
| 9 | Document reconciliation for external actions after the snapshot | **Done** — runbook §6: re-read provider state, never re-send, replay only idempotency-key-safe work, record decisions. |
| 10 | Record evidence, duration, blockers, consistency checks | **Done for what ran** — evidence §4; duration/blockers below; no restore consistency check exists because no restore ran. |

## 3. Audit (read-only)

| Item | Finding |
|---|---|
| Primary DB | `carocrm_dev`, PostgreSQL 16.13, 738 MB. Audited with `SELECT`/`pg_database_size` only. |
| Other databases | Unrelated workloads; no approved carocrm recovery target. |
| Existing backup artifact | `.data/demo/backup-2026-10-22T03-12-12-673Z/`: 40 NDJSON tables, 1.9 MB, 31 379 rows, newest file 179.9 h old. **Not a full backup**: `users`, `roles`, `teams`, `app_settings`, `audit_log`, `outbox_events`, `jobs` are absent. |
| Artifact security | Files 644 (world-readable), no `.age`/`.gpg`/`.enc` marker; directory 755. |
| WAL/PITR | `archive_mode = off`, `archive_command` disabled → no PITR. RPO would be the last dump, and there is no scheduled dump. |
| File storage | `.data/files`: 7.9 MB, 1 846 files; sampled files 644; no file backup artifact found. |
| Dump tooling | PostgreSQL 16.13 `pg_dump`/`pg_restore` available in the container. A **schema-only** dump (429 KB, 942 TOC entries) was created and listed to prove the archive format works; it was deleted. It contains no data and was never restored. |
| Backup automation | None in `docker-compose.yml` (named volumes only), none in scripts/cron; the existing document was manual. |

`pnpm verify:backup` (read-only) on the existing artifact:

```
tables=40 rows=31379 ageHours=179.9
note: no encryption marker (.age/.gpg/.enc) beside the files
backup check: 9 problem(s)
- missing core table: users, roles, teams, app_settings, audit_log, outbox_events, jobs
- 40 file(s) are world-readable; use mode 600/640
- newest file is 179.9 h old; limit 26 h
```

This is the evidence for G81; it is not a restore.

## 4. What was actually run

| Check | Result |
|---|---|
| List databases / sizes / version (read-only) | `carocrm_dev` 738 MB; PostgreSQL 16.13; no restore target. |
| Inventory/validate the demo backup | 40 valid gzip tables / 31 379 rows; 9 problems above. |
| `pg_dump --schema-only --format=custom` from the primary, `pg_restore --list` | exit 0; 429 KB; 942 TOC entries; temp file deleted. No DB write. |
| WAL settings | `archive_mode=off`, `archive_level`… no PITR. |
| File storage inventory | 7.9 MB / 1 846 files; sampled 644. |
| Application health/migrations | migrations at 086 (22.21); `/health/ready` covered by tests; not a post-restore check. |

No database was created, dropped, truncated, reset or restored; no backup was imported.

## 5. Blockers

1. **No approved isolated recovery environment** (G80). The plan accepts this as an explicit blocked
   state; it does not permit silently provisioning a database.
2. **No approved RPO/RTO** (G80). Without them the exercise cannot say whether a 24 h dump, WAL/PITR,
   or another cadence is the required design.
3. **No production-grade backup artifact** (G81): the existing one is partial, unencrypted,
   world-readable and 7.5 days old; restoring it would prove a demo snapshot, not a recoverable CRM.
4. **No automated backup schedule, retention, monitoring or off-host copy** (G81).

## 6. To unblock (owner/operations)

1. Approve RPO/RTO (for example 24 h dump vs 1 h PITR — the decision changes the infrastructure).
2. Enable a scheduled full `pg_dump` + file archive, checksum, encrypt, copy off-host, retain, and alert
   when the newest artifact is older than the RPO (the `verify:backup --max-age-hours` threshold is a
   starting point, not a policy).
3. Approve one isolated non-production recovery target and a window. Restore the latest full backup,
   restore files from the same snapshot, supply secrets from the vault, start with workers paused, run
   the post-restore checks and provider reconciliation, record duration and row counts, then tear the
   target down through its owner.
4. Re-run the migration rehearsal there (forward-only) and verify `/health/ready`, schema version and
   row counts.

## 7. Acceptance criteria (plan §22)

- **A restore exercise is documented with evidence and the primary database remains untouched.**
  The primary DB is untouched, but the restore exercise is **not** documented with evidence: it is
  blocked. This criterion is **not met**; the phase is marked blocked rather than claiming success.
- **Recovery instructions cover database, files, queues/jobs, provider reconciliation, secrets,
  post-restore validation.** Met by `docs/operations/backup-restore.md` §1–§8.
- **If an approved recovery environment is unavailable, the phase is marked blocked with an explicit
  gap.** Met: this status, G80/G81, and no silent database provisioning.

## 8. Gaps opened

- **G80** — restore drill blocked: no approved isolated environment and no approved RPO/RTO.
- **G81** — no automated/encrypted/off-host backup; the existing demo NDJSON artifact is partial,
  world-readable and stale; WAL archiving is off; file-storage backup is not evidenced.

Both are in `docs/quality/known-gaps.md` with owner/review fields.
