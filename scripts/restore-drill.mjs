#!/usr/bin/env node
/**
 * Phase 22.23 / G80 — the restore drill tool and the backup freshness check.
 *
 * The rehearsal document (`docs/quality/phase-22-backup-restore-rehearsal.md`) is blocked on two things the
 * repo does not have: an **approved isolated recovery environment** and an **approved RPO/RTO**. This tool
 * does not pretend those exist. It does the part that can be done in code — it makes a restore exercise
 * repeatable, measured and evidenced, and it refuses, loudly and by default, every way of faking one.
 *
 * What it will not do:
 *   * create, drop or alter any database (AGENTS.md §3.6) — the recovery target must already exist and must
 *     be named by an environment variable the operator sets out of band;
 *   * touch the primary. The target is refused if it is the same URL as `DATABASE_URL`, and refused again if
 *     its database name is one of the known application names, so a copy-paste of the primary URL under a
 *     different host cannot silently restore over live data;
 *   * restore without `--allow-restore`. The default run is a verification pass: archive integrity, structure
 *     (`pg_restore --list`), freshness and permissions — no database is contacted at all;
 *   * print or store a connection string. Evidence records a label, the database *name*, counts and
 *     durations. Credentials reach libpq through the environment of the child process, never as argv.
 *
 * Usage:
 *   node scripts/restore-drill.mjs --check-freshness
 *   node scripts/restore-drill.mjs --target-env=RESTORE_DATABASE_URL [--archive=DIR] [--allow-restore]
 *                                [--allow-clean] [--label=NAME] [--evidence-dir=DIR]
 *
 * Environment:
 *   DATABASE_URL              the primary; read only to prove the target is *not* it, never connected to
 *   RESTORE_DATABASE_URL      the isolated recovery target (name overridable with --target-env)
 *   BACKUP_ROOT               default `.data/backups`
 *   BACKUP_PG_CONTAINER       set to e.g. `postgres16` when the host has no pg_restore/psql
 *   BACKUP_MAX_AGE_HOURS      freshness limit for --check-freshness, default 26
 *   RESTORE_DB_ALLOWLIST      extra database names that may never be a target (comma-separated)
 *
 * Exit codes: 0 the run completed as asked; 1 refused (a guard stopped it); 2 the drill ran and failed a check.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const HELP = `usage:
  node scripts/restore-drill.mjs --check-freshness
  node scripts/restore-drill.mjs --target-env=RESTORE_DATABASE_URL [--archive=DIR] [--allow-restore] [--allow-clean] [--label=NAME] [--evidence-dir=DIR]

Refuses to create a database, and refuses the primary as a target. Without --allow-restore nothing is
written anywhere: the run verifies the archive and reports. See the header of this file for details.`;

/** Database names this installation uses for live data; a target may never be one of them. */
const PROTECTED_DATABASE_NAMES = ['carocrm_dev', 'carocrm', 'carocrm_prod', 'postgres', 'template0', 'template1'];

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((arg) => !arg.includes('=')));
const option = (name, fallback) => {
  const found = argv.find((arg) => arg.startsWith(`--${name}=`));
  return found === undefined ? fallback : found.slice(name.length + 3);
};

if (flags.has('--help') || flags.has('-h')) {
  console.log(HELP);
  process.exit(0);
}

const checkFreshnessOnly = flags.has('--check-freshness');
const allowRestore = flags.has('--allow-restore');
const allowClean = flags.has('--allow-clean');
const targetEnvName = option('target-env', 'RESTORE_DATABASE_URL');
const label = option('label', 'recovery-target');
const root = resolve(option('backup-root', process.env.BACKUP_ROOT ?? '.data/backups'));
const evidenceDir = resolve(option('evidence-dir', process.env.RESTORE_EVIDENCE_DIR ?? '.data/restore-drill'));
const maxAgeHours = Number(option('max-age-hours', process.env.BACKUP_MAX_AGE_HOURS ?? '26'));
const container = process.env.BACKUP_PG_CONTAINER ?? '';

/** A refusal is not a failure of the drill; it is the drill working. Exit 1 so a pipeline stops. */
function refuse(reason, remedy) {
  console.log(`restore drill refused: ${reason}`);
  if (remedy !== undefined) console.log(`  how to proceed: ${remedy}`);
  process.exit(1);
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function newestArchive() {
  if (!existsSync(root)) return undefined;
  const dirs = readdirSync(root)
    .map((name) => join(root, name))
    .filter((path) => statSync(path).isDirectory() && existsSync(join(path, 'manifest.json')));
  if (dirs.length === 0) return undefined;
  return dirs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

function ageHours(path) {
  return (Date.now() - statSync(path).mtimeMs) / 3_600_000;
}

/** The files inside an archive, with the mode each one carries. World-writable or world-readable is a finding. */
function inventory(dir) {
  return readdirSync(dir).map((name) => {
    const path = join(dir, name);
    const stat = statSync(path);
    return {
      name,
      sizeBytes: stat.size,
      mode: `0${(stat.mode & 0o777).toString(8)}`,
      ageHours: Math.round(ageHours(path) * 10) / 10,
    };
  });
}

/**
 * Check `SHA256SUMS` against the bytes actually present. A backup nobody can prove is intact is not a
 * recovery point, and this is the check that catches a truncated or edited archive.
 */
function verifyChecksums(dir) {
  const sumsPath = join(dir, 'SHA256SUMS');
  if (!existsSync(sumsPath)) return { ok: false, detail: 'no SHA256SUMS beside the archive' };
  const lines = readFileSync(sumsPath, 'utf8').split('\n').map((line) => line.trim()).filter((line) => line !== '');
  const problems = [];
  for (const line of lines) {
    const [digest, name] = [line.slice(0, 64), line.slice(66).replace(/^\*?/, '').trim()];
    const path = join(dir, name);
    if (!existsSync(path)) {
      problems.push(`listed but missing: ${name}`);
      continue;
    }
    if (sha256(path) !== digest) problems.push(`checksum mismatch: ${name}`);
  }
  const present = readdirSync(dir).filter((name) => name !== 'SHA256SUMS' && name !== 'manifest.json');
  for (const name of present) {
    if (!lines.some((line) => line.includes(name))) problems.push(`not covered by SHA256SUMS: ${name}`);
  }
  return problems.length === 0 ? { ok: true, detail: `${String(lines.length)} file(s) verified` } : { ok: false, detail: problems.join('; ') };
}

/** Parse a URL into the libpq environment, so no credential is ever an argv element. */
function connectionEnv(url) {
  const parsed = new URL(url);
  const env = { PGCONNECT_TIMEOUT: '10' };
  if (parsed.hostname !== '') env.PGHOST = decodeURIComponent(parsed.hostname);
  if (parsed.port !== '') env.PGPORT = parsed.port;
  if (parsed.username !== '') env.PGUSER = decodeURIComponent(parsed.username);
  if (parsed.password !== '') env.PGPASSWORD = decodeURIComponent(parsed.password);
  const dbname = parsed.pathname.replace(/^\//, '');
  if (dbname !== '') env.PGDATABASE = dbname;
  const ssl = parsed.searchParams.get('sslmode');
  if (ssl !== null && ssl !== '') env.PGSSLMODE = ssl;
  return env;
}

/**
 * Run a postgres client either on the host or inside the configured container.
 *
 * Credentials go to libpq as `PG*` environment variables, never as argv: an argv element is visible to every
 * process on the host, an environment belongs to the child. In container mode the archive has to be readable
 * from inside the container, which is why `--container-archive-dir` exists — the operator says which mounted
 * path corresponds to `--archive`, and nothing here guesses a volume.
 */
function runPg(binary, args, env) {
  const pgEnv = Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('PG')));
  if (container === '') {
    return spawnSync(binary, args, { encoding: 'utf8', env: { ...process.env, ...pgEnv } });
  }
  const inner = [
    ...Object.entries(pgEnv).map(([key, value]) => `${key}=${shellQuote(String(value))}`),
    binary,
    ...args.map((arg) => shellQuote(String(arg))),
  ].join(' ');
  return spawnSync('docker', ['exec', container, 'sh', '-c', inner], { encoding: 'utf8' });
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The path of an archive file as the child process will see it. */
function archivePath(dir, name) {
  const containerDir = option('container-archive-dir', undefined);
  if (container === '' || containerDir === undefined) return join(dir, name);
  return join(containerDir, name);
}

function report(lines) {
  for (const line of lines) console.log(line);
}

// ---------------------------------------------------------------------------
// Mode 1 — freshness only. No database is involved; this is what a cron alert calls.
// ---------------------------------------------------------------------------
if (checkFreshnessOnly) {
  const dir = option('archive', undefined) === undefined ? newestArchive() : resolve(option('archive', ''));
  if (dir === undefined || !existsSync(dir)) {
    console.log(`backup freshness: no archive found under ${root}`);
    console.log('  how to proceed: run `pnpm backup` (see scripts/backup.mjs) on the schedule in scripts/backup.cron.example');
    process.exit(1);
  }
  const files = inventory(dir);
  const newest = Math.min(...files.map((file) => file.ageHours));
  const worldReadable = files.filter((file) => file.mode.endsWith('4') || file.mode.endsWith('6') || file.mode.endsWith('7'));
  const checksums = verifyChecksums(dir);
  report([
    `backup freshness: archive=${dir.split('/').pop()}`,
    `  newest file age = ${String(Math.round(newest * 10) / 10)} h (limit ${String(maxAgeHours)} h)`,
    `  checksums: ${checksums.ok ? 'verified' : checksums.detail}`,
    `  files: ${String(files.length)}; world-readable: ${String(worldReadable.length)}`,
    `  encrypted: ${files.some((file) => file.name.endsWith('.gpg') || file.name.endsWith('.age') || file.name.endsWith('.enc')) ? 'yes' : 'NO MARKER'}`,
  ]);
  if (newest > maxAgeHours) {
    console.log('backup freshness: STALE — the newest artifact is outside the window');
    process.exit(1);
  }
  if (!checksums.ok) {
    console.log('backup freshness: archive integrity check failed');
    process.exit(1);
  }
  console.log('backup freshness: within the window');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Mode 2 — the drill. Verification always; restore only when explicitly allowed.
// ---------------------------------------------------------------------------
const dir = option('archive', undefined) === undefined ? newestArchive() : resolve(option('archive', ''));
if (dir === undefined || !existsSync(dir)) {
  refuse('no backup archive to drill against', `run \`pnpm backup\` first, or pass --archive=DIR (looked in ${root})`);
}

const targetUrl = process.env[targetEnvName];
if (targetUrl === undefined || targetUrl === '') {
  refuse(
    `the recovery target is not provided (set $${targetEnvName})`,
    'provision an isolated recovery database out of band and point this at it. This tool never creates one (AGENTS.md §3.6), and there is no approved recovery environment yet — see G80.',
  );
}

const primary = process.env.DATABASE_URL;
if (primary !== undefined && primary !== '' && primary === targetUrl) {
  refuse('the target is the primary database', `point --target-env at a separate, disposable recovery database`);
}

let env;
try {
  env = connectionEnv(targetUrl);
} catch {
  refuse('the target URL cannot be parsed', 'pass a libpq URL such as postgresql://user:pass@host:port/dbname');
}

const denylist = [...PROTECTED_DATABASE_NAMES, ...(process.env.RESTORE_DB_ALLOWLIST ?? '').split(',').map((name) => name.trim()).filter((name) => name !== '')];
if (denylist.includes(env.PGDATABASE ?? '')) {
  refuse(
    `the target database name "${env.PGDATABASE ?? ''}" is an application database`,
    'a target may not be named after live data even behind another host; use a dedicated recovery database name',
  );
}

const findings = [];
const started = Date.now();
const checksums = verifyChecksums(dir);
findings.push(`archive checksums: ${checksums.ok ? 'verified' : `FAILED — ${checksums.detail}`}`);
if (!checksums.ok) {
  writeEvidence({ dir, label, findings, elapsedSeconds: Math.round((Date.now() - started) / 1000), restored: false });
  console.log(`restore drill: the archive is not provably intact — ${checksums.detail}`);
  process.exit(2);
}

const dumpName = ['database.dump', 'database.dump.gpg'].find((name) => existsSync(join(dir, name)));
if (dumpName === undefined) {
  writeEvidence({ dir, label, findings, elapsedSeconds: Math.round((Date.now() - started) / 1000), restored: false });
  console.log('restore drill: the archive holds no database.dump; nothing to restore');
  process.exit(2);
}

const listed = runPg('pg_restore', ['--list', archivePath(dir, dumpName)], {});
if (listed.status !== 0) {
  findings.push(`pg_restore --list: FAILED — ${(listed.stderr ?? listed.error?.message ?? 'unknown').toString().trim().slice(0, 200)}`);
  report(findings);
  refuse(
    'the archive structure could not be listed',
    container === '' ? 'install the PostgreSQL 16 client tools or set BACKUP_PG_CONTAINER to run them in the database container' : 'check that the container is running and holds pg_restore',
  );
}
const tocEntries = listed.stdout.split('\n').filter((line) => /^\s*\d+;\s/.test(line)).length;
findings.push(`pg_restore --list: ${String(tocEntries)} TOC entries`);

const filesArchive = existsSync(join(dir, 'files.tgz')) || existsSync(join(dir, 'files.tgz.gpg'));
findings.push(`file storage archive: ${filesArchive ? 'present' : 'ABSENT — attachments cannot be realigned'}`);

if (!allowRestore) {
  findings.push('restore: not attempted (this run was a verification pass; pass --allow-restore to restore)');
  report(findings);
  writeEvidence({ dir, label, findings, elapsedSeconds: Math.round((Date.now() - started) / 1000), restored: false, tocEntries });
  console.log('restore drill: verification complete, no database was contacted');
  process.exit(0);
}

// From here the target is written to. Everything above proved the artifact; this part measures recovery.
const restoreArgs = ['--no-owner', '--no-privileges', '--exit-on-error', archivePath(dir, dumpName)];
if (allowClean) restoreArgs.unshift('--clean', '--if-exists');
if (!allowClean) {
  const probe = runPg('psql', ['-tAc', 'select count(*) from pg_catalog.pg_tables where schemaname = \'public\''], env);
  if (probe.status === 0 && Number((probe.stdout ?? '0').trim()) > 0) {
    refuse(
      'the target already holds tables and --allow-clean was not passed',
      'a drill should start from an empty recovery database; if the target is disposable, add --allow-clean',
    );
  }
}

const restoreStarted = Date.now();
// The connection comes from the `PG*` environment, so no `-d` and no URL in argv.
const restored = runPg('pg_restore', restoreArgs, env);
if (restored.status !== 0) {
  findings.push(`pg_restore: FAILED — ${(restored.stderr ?? '').toString().trim().slice(0, 300)}`);
  report(findings);
  writeEvidence({ dir, label, findings, elapsedSeconds: Math.round((Date.now() - restoreStarted) / 1000), restored: false, tocEntries });
  console.log('restore drill: the restore failed; see the evidence file');
  process.exit(2);
}

// RTO is measured to the moment the recovered database answers a real query, not to the moment the
// restore command returns. There is no approved RTO target, so this is a measurement, not a pass/fail.
const ready = runPg('psql', ['-tAc', 'select count(*)::int from schema_migrations'], env);
const rtoSeconds = Math.round((Date.now() - restoreStarted) / 1000);
if (ready.status !== 0) {
  findings.push('post-restore probe: FAILED — the recovered database did not answer a query');
  report(findings);
  writeEvidence({ dir, label, findings, elapsedSeconds: rtoSeconds, restored: true, tocEntries });
  process.exit(2);
}

const migrationsApplied = Number((ready.stdout ?? '0').trim());
const migrationsOnDisk = readdirSync(resolve('database/migrations')).filter((name) => name.endsWith('.sql')).length;
const tables = runPg('psql', ['-tAc', "select count(*)::int from pg_catalog.pg_tables where schemaname = 'public'"], env);
const coreCounts = runPg(
  'psql',
  ['-tAc', "select 'entity_records='||(select count(*) from entity_records)||' users='||(select count(*) from users)"],
  env,
);

findings.push(`restore: completed into the target named "${env.PGDATABASE ?? ''}"`);
findings.push(`measured time to a queryable database = ${String(rtoSeconds)} s (no approved RTO exists; this is a measurement)`);
findings.push(`schema_migrations applied = ${String(migrationsApplied)}; repository migrations = ${String(migrationsOnDisk)}${migrationsApplied === migrationsOnDisk ? ' (aligned)' : ' (MISMATCH — the dump and the code disagree)'}`);
findings.push(`public tables = ${String((tables.stdout ?? '?').trim())}`);
findings.push(`row counts after restore: ${(coreCounts.stdout ?? '?').trim()}`);
findings.push(`RPO: not approved by the owner — the recoverable point is this archive's newest file, ${String(Math.round(Math.min(...inventory(dir).map((file) => file.ageHours)) * 10) / 10)} h old`);

report(findings);
writeEvidence({
  dir,
  label,
  findings,
  elapsedSeconds: rtoSeconds,
  restored: true,
  tocEntries,
  migrationsApplied,
  migrationsOnDisk,
});
console.log(`restore drill: done. Evidence written under ${evidenceDir}`);
console.log('  this is a measurement, not an approval: G80 stays open until the owner approves an RPO/RTO and signs the evidence.');

function writeEvidence(data) {
  if (!existsSync(evidenceDir)) mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const payload = {
    ranAt: new Date().toISOString(),
    archive: data.dir,
    archiveFiles: inventory(data.dir),
    targetLabel: data.label,
    // Deliberately no host, no user, no password, no URL: the evidence file is committed-adjacent output.
    targetDatabaseName: process.env[targetEnvName] === undefined ? null : safeDatabaseName(process.env[targetEnvName]),
    restored: data.restored,
    elapsedSeconds: data.elapsedSeconds,
    tocEntries: data.tocEntries ?? null,
    migrationsApplied: data.migrationsApplied ?? null,
    migrationsOnDisk: data.migrationsOnDisk ?? null,
    findings: data.findings,
    rpoApproved: false,
    rtoApproved: false,
  };
  const jsonPath = join(evidenceDir, `restore-drill-${stamp}.json`);
  writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  const markdown = [
    `# Restore drill evidence — ${payload.ranAt}`,
    '',
    `- Archive: \`${data.dir}\``,
    `- Target: ${data.label} (database name \`${payload.targetDatabaseName ?? 'unknown'}\`)`,
    `- Restored: ${String(data.restored)}; elapsed ${String(data.elapsedSeconds)} s`,
    '',
    '## Findings',
    '',
    ...data.findings.map((line) => `- ${line}`),
    '',
    '## Status of the approval',
    '',
    'RPO and RTO remain **unapproved by the owner** (G80). The duration above is a measurement for that',
    'decision, not a pass against an agreed target. See `docs/quality/phase-22-backup-restore-rehearsal.md`.',
    '',
  ].join('\n');
  writeFileSync(join(evidenceDir, `restore-drill-${stamp}.md`), markdown, { mode: 0o600 });
  console.log(`  evidence: ${dirname(jsonPath)}/${stamp}`);
}

function safeDatabaseName(url) {
  try {
    return new URL(url).pathname.replace(/^\//, '');
  } catch {
    return null;
  }
}
