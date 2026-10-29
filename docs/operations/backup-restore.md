# Backup and restore — operations

> Phase 22.23 audit (`PLAN_Phase_22_Integration_E2E_Hardening.md` §22) and Phase 22.25 backup
> automation. **Status: restore drill still blocked.** No approved isolated recovery environment
> exists, and the owner has not approved RPO/RTO. The primary database was not altered; see
> `docs/quality/phase-22-backup-restore-rehearsal.md`, `docs/quality/phase-22-25-release-blocker-remediation.md`,
> G80 and G81.

This document is the procedure, the current evidence and the rules. It is not a claim that a restore
has been rehearsed — it has not, and a backup that has never been restored is not a validated backup.

## 1. What must be backed up

| Asset | Location | Notes |
|---|---|---|
| PostgreSQL database (users, roles, teams, records, metadata overrides, audit, stream, outbox, jobs, module tables) | `DATABASE_URL` | A **full** `pg_dump`; the demo NDJSON artifact is not one (see §3). |
| Uploaded files (attachments, voice media, signature artifacts, e-signature snapshots) | `STORAGE_ROOT` (default `.data/files`; compose volume `apidata`) | Files and DB metadata must be restored from the **same point in time**. |
| Secrets/configuration | environment or secret manager, **never** the database | Database URL, JWT secret, encryption key, provider credentials. A DB restore is useless without the matching key material. |
| Queue/broker state | Redis | Redis is not the source of truth; durable `jobs`/`outbox_events` are in Postgres. Treat Redis as disposable and reconcile (§6). |

Not backed up by a database dump: browser state, logs (collector-owned), local `.env`.

## 2. Current state (audited 2026-10-29)

| Item | Finding |
|---|---|
| Primary database | `carocrm_dev`, PostgreSQL 16.13, 738 MB; read-only audit only. |
| Backup automation | Phase 22.25 adds `scripts/backup.mjs` (`pnpm backup`): pg_dump/files/checksums, gpg encryption required unless explicitly waived for local tooling, 700/600 permissions and opt-in retention. No deployment cron/off-host copy/alert is configured yet (G81 partial). |
| Existing artifact | `.data/demo/backup-2026-10-22T03-12-12-673Z/` — 40 NDJSON tables, 1.9 MB, 31 379 rows, newest file **179.9 h** old. It is a demo-reset snapshot, **not a full backup**: it has no `users`, `roles`, `teams`, `app_settings`, `audit_log`, `outbox_events` or `jobs`. |
| Artifact permissions | Secured in 22.25: directory 700, files 600 (was world-readable 644). No `.age`/`.gpg`/`.enc` marker; the artifact remains a partial demo snapshot. |
| WAL / PITR | `archive_mode = off`, `archive_command` disabled → **no point-in-time recovery**; the only RPO is the last dump (which is not scheduled). |
| Dump tooling | `pg_dump`/`pg_restore` 16.13 are available in the Postgres container. A **schema-only** dump was created and listed (`429 KB`, 942 TOC entries) as a read-only tooling check; it was deleted. |
| File storage | `.data/files` 7.9 MB / 1 846 files; sampled files are **world-readable (644)**; no file backup artifact was found. |
| Approved recovery environment | **None.** Only `carocrm_dev` plus unrelated databases exist; no restore target. Creating one without approval is forbidden by AGENTS.md §3. |
| RPO / RTO | **Not approved.** No business values exist; do not infer them from the dump cadence. |

## 3. Taking a backup

### 3.0 The automated job (preferred)

```bash
# Configure once in a root-owned environment file (mode 600), not in the repository:
#   BACKUP_ROOT=/var/backups/carocrm
#   BACKUP_PG_CONTAINER=postgres16   # or install pg_dump on the host
#   BACKUP_PG_USER=postgres
#   BACKUP_PG_DB=carocrm_dev
#   STORAGE_ROOT=/srv/carocrm/.data/files
#   BACKUP_GPG_RECIPIENT=ops@example.invalid

pnpm backup                      # full dump + files.tgz + SHA256SUMS + manifest.json
pnpm backup --schema-only        # tooling check: no table data written
pnpm backup --prune --keep-days=7
```

The script refuses to create a plaintext backup unless `--allow-plaintext` is passed, and refuses
that flag when `NODE_ENV=production`. It writes a `phase22-*` directory with 700/600 permissions,
checksums every file and verifies the dump archive with `pg_restore --list` before reporting success.
`--prune` is opt-in and only removes `phase22-*` directories older than the retention window.

Schedule example (deployment-owned; not installed by this repository):

```cron
# /etc/cron.d/carocrm-backup, environment file mode 600
17 2 * * * root set -a; . /etc/carocrm/backup.env; set +a; cd /srv/carocrm && pnpm backup --prune
```

The schedule must also copy the encrypted artifact **off-host**, alert when the newest artifact is
older than the approved RPO, and test the recipient key separately. None of that exists yet.

### 3.1 Manual fallback

Run from the deployment host; the environment variables are already set for the API.

```bash
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "backups/$TIMESTAMP"

# 1. Database — custom format, owned by the restoring role, compressed.
pg_dump "$DATABASE_URL" --format=custom --compress=9 --file="backups/$TIMESTAMP/database.dump"

# 2. Files — the exact STORAGE_ROOT (default .data/files) and nothing else.
tar czf "backups/$TIMESTAMP/files.tgz" -C "$(dirname "$STORAGE_ROOT")" "$(basename "$STORAGE_ROOT")"

# 3. Checksums before encryption/shipping.
(cd "backups/$TIMESTAMP" && shasum -a 256 database.dump files.tgz > SHA256SUMS)

# 4. Restrict access; a CRM backup is personal data.
chmod -R 600 "backups/$TIMESTAMP"

# 5. Encrypt before it leaves the host (age/gpg or provider-side encryption).
age -r "$BACKUP_RECIPIENT" -o "backups/$TIMESTAMP/database.dump.age" "backups/$TIMESTAMP/database.dump"
```

**Verification without a restore:**

```bash
# Full pg_dump archive: readable table of contents (the backup job already does this).
pg_restore --list backups/<ts>/database.dump | head

# NDJSON-directory format (the demo-reset artifact): integrity, core tables, age, permissions.
pnpm verify:backup .data/demo/backup-<timestamp>
# 2026-10-29 after the 22.25 chmod: 8 problems remain (missing core tables + stale), no permission
# problem; it is still not a recovery backup.
```

`pnpm verify:backup` is a read-only checker: valid gzip, core tables present and non-empty, newest file
within `--max-age-hours` (default 26), and no world-readable file. It never connects to a database and
never prints row content. On 2026-10-29 it reported **9 problems** for the existing demo artifact
(missing core tables, 644 files, 179.9 h old) — which is why that artifact is not a recovery backup.

**Schedule (proposed, not enabled):** daily full dump + file archive, retained 7 daily / 4 weekly /
3 monthly, checksummed, encrypted, off-host, with an alert if the newest artifact is older than 26 h.
The 26 h threshold is the default of `verify:backup`, not an approved RPO.

## 4. RPO / RTO — blocker

| Value | Status |
|---|---|
| RPO | **Not approved.** A nightly dump implies up to 24 h loss; WAL archiving is off, so PITR is not available. The owner must choose (24 h dump vs 1 h PITR) before this is a promise. |
| RTO | **Not approved.** It depends on restore environment, dump size, file size and file/DB consistency; measure in a drill. |

Do not publish an RPO/RTO from this document until the owner approves it. The phase is marked blocked
on this point (G80).

## 5. Restore procedure — approved isolated environment only

**Preconditions (all required):**

1. The owner has approved a **non-production, isolated** recovery target (host/database/storage) and
   the exercise window. Do not use the configured primary database; do not create a routine test DB
   to avoid asking (AGENTS.md §3.6).
2. Workers and integrations are paused/stopped against the target so a restored event or job cannot
   call a provider or send a message. The API may run in a read-only/queue-disabled mode for checks.
3. The backup's checksums match `SHA256SUMS` and the encrypted artifact is decrypted with the correct
   key. Never copy a key into the repository.

**Steps:**

```bash
# 1. Restore the database into the approved empty target.
pg_restore --no-owner --exit-on-error --dbname "$RECOVERY_DATABASE_URL" database.dump

# 2. Restore files into the matching STORAGE_ROOT of the target.
tar xzf files.tgz -C "$RECOVERY_STORAGE_PARENT"

# 3. Supply configuration/secrets from the vault (DB URL, JWT secret, ENCRYPTION_KEY,
#    provider credentials). The dump does not contain them.

# 4. Start the API/worker against the target with workers disabled; run migrations forward only.
pnpm db:migrate

# 5. Validate.
curl -fsS "$RECOVERY_API/health/ready"       # database up
pnpm test:e2e                                # only with the approved target, never primary
```

**Post-restore validation:**

- `schema_migrations` is at the expected highest version; no failed/partial migration.
- The app boots and `/health/ready` is `ok`; the operations snapshot (`AdminInternal/action/operations`)
  shows no unexpected backlog.
- Spot-check: a user can sign in (identity rows restored), a record and its attachment share the same
  point in time, the stream/audit rows exist for it, and a signature artifact opens only through the
  authenticated route (not a public URL).
- `outbox_events`/`jobs` rows are either replayed deliberately or left as evidence; Redis starts empty
  and is not treated as restored state.
- Count comparison: `entity_records`, `users`, `roles`, `teams`, `app_settings`, `audit_log`,
  `stream_items`, `outbox_events`, `jobs` against the source snapshot.

## 6. Provider reconciliation after a restore

A restored database is **older than the provider**. Between the snapshot and the restore, a provider
may have delivered a webhook, a payment may have settled, a signature may have completed, or a message
may have been sent. The restored platform must not blindly replay from its old cursor.

1. Pause inbound/outbound integrations and workers before the restore; keep them paused until the
   reconciliation below is complete.
2. For each provider/connection: compare its live status with the restored rows (payment request,
   e-signature envelope, voice message/call, connector sync checkpoint, marketing send).
3. Re-read the authoritative provider state (reconcile / status sync) for anything the snapshot cannot
   prove; do not re-send a signature, payment, campaign or message to "catch up".
4. Replay only deliveries/events whose idempotency keys are present and whose provider confirms they
   were not applied; the unique keys (payment event, inbox dedup, outbox correlation) make a replay safe.
5. Record each reconciliation decision (provider id, record id, action) in the incident log.

## 7. Migration rehearsal (not performed)

The plan asks for an additive migration rehearsal **only** in an approved disposable/recoverable
non-production deployment. No such environment exists, so it was not run; creating one without approval
is out of scope. When it is available: restore the latest backup, run `pnpm db:migrate` forward only,
verify `/health/ready` and the operations snapshot, compare row counts, and never roll back by dropping
data — restore + a corrective forward migration is the rollback.

## 8. Files, queues and secrets

- **Files** must come from the same snapshot as the DB. An attachment row whose object is missing is a
  broken record; an object with no row is an orphan to inventory, not to delete blindly.
- **Redis** is a broker, not durable state. After a restore, start it empty; the durable `jobs`/
  `outbox_events` rows decide what may be replayed. Do not restore a Redis RDB from a different point
  in time and assume its queue matches the database.
- **Secrets** are never in the dump. Restoring without the original `ENCRYPTION_KEY` makes encrypted
  provider credentials unreadable; rotating the key is a separate, reviewed operation.
- **Signature/recording artifacts** must be reachable only through the authenticated application route;
  after restore, verify no storage bucket/path became public.

## 9. Evidence and limitations

- Read-only audit and `verify:backup` result: `docs/quality/phase-22-backup-restore-rehearsal.md`.
- Schema-only dump + `pg_restore -l` (429 KB, 942 entries) proves tooling, not a data restore.
- No restore was performed; no database was created or dropped; the primary database was untouched.
- G80 (no approved recovery environment / RPO-RTO) and G81 (no automated, encrypted, off-host backup;
  the existing artifact is partial and world-readable) track the gaps.
