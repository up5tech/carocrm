# Backup & Restore (operations)

Kernel Alpha targets a single self-hosted PostgreSQL + Redis install (PLAN §65).

## What must be backed up

| Item | Location | Tool |
|---|---|---|
| Application data (users, roles, teams, records, metadata overrides, audit) | PostgreSQL database (`DATABASE_URL`) | `pg_dump` / filestream |
| Uploaded files | `STORAGE_ROOT` (default `.data/files`) | rsync / object-store sync |
| Secrets | environment / secret manager, **not** the DB | your own vault |

## Full backup

```bash
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
pg_dump "$DATABASE_URL" --format=custom --file="backup-$TIMESTAMP.dump"
tar czf "files-$TIMESTAMP.tgz" -C "$(dirname "$STORAGE_ROOT")" "$(basename "$STORAGE_ROOT")"
```

Keep at least one dump per day and encrypt before shipping off-host (`age`, `gpg`, or the
storage provider's encryption).

## Restore into an empty database

```bash
createdb carocrm_restore
pg_restore --no-owner --exit --dbname "postgres://.../carocrm_restore" backup-<ts>.dump
tar xzf files-<ts>.tgz -C /target
```

Start the API against a **non-production** copy first and run the smoke test
(`pnpm test:e2e`) before promoting the restored database.

> A backup that has never been restored is not a validated backup: schedule a restore drill
> (into a scratch database) at least quarterly and record the result.

## Point-in-time recovery

Requires WAL archiving on the PostgreSQL server (continuous archiving to disk or object
storage) plus a base backup. Enable it before the dataset is large enough that a nightly
`pg_dump` loses a day of CRM data.

## Migrations

Schema changes are forward-only SQL files in `database/migrations`, applied by
`pnpm db:migrate` (or automatically by the API at boot). Rollback = restore from backup
plus a corrective forward migration; destructive automated rollback is not supported.
