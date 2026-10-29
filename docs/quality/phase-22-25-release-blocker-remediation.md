# Phase 22.25 — Release-blocker remediation (G80/G81)

> **Date:** 2026-10-29
> **Scope:** owner-selected follow-up to the Phase 22.24 NO-GO: reduce the backup/restore blockers.
> **Status:** G81 **partially fixed** (automation + secure defaults + existing artifact secured);
> G80 remains **blocked** (no approved isolated recovery environment, no approved RPO/RTO). The
> release decision stays **NO-GO** until a deployment schedule/off-host copy and a restore drill exist.

---

## 1. Why this phase

The 22.24 review blocked a production release on:

- **G80** — no restore drill, no approved RPO/RTO.
- **G81** — no automated/encrypted/off-host backup; the only artifact was a partial, world-readable,
  stale demo snapshot.

A restore cannot be rehearsed without an approved environment, but the **backup side** can be made
safe and repeatable now. This phase does that and records exactly what remains.

## 2. What changed

### 2.1 `scripts/backup.mjs` (`pnpm backup`)

A deployable backup job that:

- dumps the database with `pg_dump --format=custom` (host binary or `docker exec` into
  `BACKUP_PG_CONTAINER`), and archives `STORAGE_ROOT` with `tar czf` in full mode;
- writes `database.dump`, `files.tgz`, `SHA256SUMS` and a `manifest.json` (mode/time/TOC count; no
  connection string or record content);
- **requires gpg encryption** via `BACKUP_GPG_RECIPIENT` unless `--allow-plaintext` is passed for a
  local tooling check; plaintext is refused when `NODE_ENV=production`;
- creates the directory 700 and files 600, verifies the dump archive with `pg_restore --list`, and
  removes a half-written directory on failure;
- supports `--schema-only` (no table data) as the safe pipeline test;
- supports opt-in `--prune --keep-days=N`, deleting only `phase22-*` directories older than the
  window; no broad delete;
- never prints `DATABASE_URL`, a password or a record.

### 2.2 Existing artifact secured

`.data/demo/backup-2026-10-22T03-12-12-673Z` was world-readable (644). It is now directory 700,
files 600. `pnpm verify:backup` dropped from **9** to **8** problems: the permission finding is gone;
the missing core tables and 187 h staleness remain, so it is still not a recovery backup.

### 2.3 Runbook and scripts

- `docs/operations/backup-restore.md` now documents the automated job, the encryption/retention
  policy, a deployment cron example, the manual fallback, and the exact remaining gaps.
- `package.json` adds `backup`; `verify:backup` remains the read-only artifact checker.
- The existing checksum/permission logic is unchanged; the runbook's RPO/RTO section still says
  **not approved** and must not be read as a promise.

## 3. Evidence

All commands were read-only against the primary database and wrote only to `/tmp`; no database was
created or restored.

| Check | Result |
|---|---|
| `node --check scripts/backup.mjs` | syntax OK |
| `BACKUP_ROOT=/tmp/... BACKUP_PG_CONTAINER=postgres16 node scripts/backup.mjs --schema-only --allow-plaintext` | exit 0; `database.dump` 439 021 bytes; `tocEntries=927`; directory 700 / files 600; `shasum -a 256 -c SHA256SUMS` → **OK** |
| Refusal without recipient / without `--allow-plaintext` | exit 2, no backup directory created |
| `NODE_ENV=production` + `--allow-plaintext` | exit 2, refused |
| Existing demo artifact `chmod 700/600` + `pnpm verify:backup` | **8** problems (no permission finding); missing core tables + age remain |
| Temp backup files | deleted after the check |

A **full data backup was not run** in this phase: it would write customer/demo data to a local file,
and the environment has no approved off-host destination or encryption recipient. The script's full
path is the manual/production procedure; `--schema-only` proves the dump/checksum/perm/gpg-guard
pipeline without that data.

## 4. What remains (why the release is still NO-GO)

1. **G80 — no approved restore environment or RPO/RTO.** No restore was run; no database was created.
   The runbook and reconciliation policy are ready, but the evidence is absent.
2. **G81 — deployment configuration still missing:** a cron/systemd schedule, an off-host destination,
   a provisioned gpg recipient/key, and a freshness alert. The repository now has the job and the
   policy; the deployment must enable them. Until then the backup is not automated in practice.
3. **Real data:** do not load customer data until the above is in place and a restore has been
   rehearsed.

**Next owner actions:** provision the backup environment (schedule, recipient key, off-host storage,
alert), approve RPO/RTO, run the restore drill in the approved isolated target, then re-run
`docs/quality/phase-22-release-readiness.md`.

## 5. Gaps after 22.25

- **G80** — unchanged: restore drill blocked.
- **G81** — **partially fixed**: script/secure defaults/artifact permissions done; schedule/off-host/
  key provisioning and monitoring remain (deployment-owned).
