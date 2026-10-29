#!/usr/bin/env node
/**
 * Phase 22.25 — the backup job (G81 remediation).
 *
 * It writes a timestamped directory containing:
 *   database.dump  — `pg_dump --format=custom` (or `--schema-only` for a tooling check)
 *   files.tgz      — the configured STORAGE_ROOT archive (full mode)
 *   SHA256SUMS     — checksums of what was written
 *   manifest.json  — mode/time and a safe summary, never a connection string
 *
 * Defaults are safe:
 *   * encryption is **required** unless `--allow-plaintext` is passed, and plaintext is refused when
 *     NODE_ENV=production;
 *   * a generated directory is 700 and its files are 600;
 *   * `--prune` is opt-in and only removes `phase22-*` directories older than `--keep-days` under the
 *     configured root; no broad delete;
 *   * a connection URL is never printed, and `pg_dump` runs either from a host binary or inside the
 *     configured container (local trust; no password argument).
 *
 * Usage:
 *   node scripts/backup.mjs [--schema-only] [--allow-plaintext] [--prune] [--keep-days=7] [--help]
 *
 * Environment:
 *   BACKUP_ROOT             default `.data/backups`
 *   BACKUP_PG_CONTAINER     e.g. `postgres16`; use `docker exec` instead of a host `pg_dump`
 *   BACKUP_PG_USER          default `postgres` (container mode)
 *   BACKUP_PG_DB            default `carocrm_dev` (container mode)
 *   DATABASE_URL            used by a host `pg_dump`; never printed
 *   STORAGE_ROOT            default `.data/files`
 *   BACKUP_GPG_RECIPIENT    gpg recipient fingerprint/email; required unless `--allow-plaintext`
 *   BACKUP_KEEP_DAYS        default 7, only read with `--prune`
 *
 * It does not restore anything and does not touch the database. `--schema-only` is the safe way to
 * prove the dump pipeline without writing customer data to a local file.
 */
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, openSync, readdirSync, rmSync, statSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const HELP = `usage: node scripts/backup.mjs [--schema-only] [--allow-plaintext] [--prune] [--keep-days=7]

Environment: BACKUP_ROOT, BACKUP_PG_CONTAINER, BACKUP_PG_USER, BACKUP_PG_DB, DATABASE_URL,
STORAGE_ROOT, BACKUP_GPG_RECIPIENT, BACKUP_KEEP_DAYS. See the header of this file for details.`;

const args = new Set(process.argv.slice(2));
if (args.has('--help') || args.has('-h')) {
  console.log(HELP);
  process.exit(0);
}

const schemaOnly = args.has('--schema-only');
const allowPlaintext = args.has('--allow-plaintext');
const prune = args.has('--prune');
const keepArg = [...args].find((arg) => arg.startsWith('--keep-days='));
const keepDays = keepArg === undefined ? Number(process.env.BACKUP_KEEP_DAYS ?? '7') : Number(keepArg.split('=')[1]);
const root = resolve(process.env.BACKUP_ROOT ?? '.data/backups');
const storageRoot = resolve(process.env.STORAGE_ROOT ?? '.data/files');
const container = process.env.BACKUP_PG_CONTAINER ?? '';
const pgUser = process.env.BACKUP_PG_USER ?? 'postgres';
const pgDb = process.env.BACKUP_PG_DB ?? 'carocrm_dev';
const recipient = process.env.BACKUP_GPG_RECIPIENT ?? '';
const plaintextRefused = !allowPlaintext && recipient === '';
const production = (process.env.NODE_ENV ?? '').toLowerCase() === 'production';

if (allowPlaintext && production) {
  console.error('backup refused: plaintext backups are not allowed when NODE_ENV=production.');
  process.exit(2);
}
if (plaintextRefused) {
  console.error('backup refused: set BACKUP_GPG_RECIPIENT (recommended) or pass --allow-plaintext for a local tooling check.');
  process.exit(2);
}
if (!Number.isFinite(keepDays) || keepDays < 1) {
  console.error('backup refused: --keep-days must be a positive number.');
  process.exit(2);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = join(root, `phase22-${timestamp}`);
await mkdir(target, { recursive: true, mode: 0o700 });

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { stdio: options.stdio ?? 'inherit', ...options.spawn });
  if (result.error !== undefined) throw new Error(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} exited with ${String(result.status)}`);
  return result;
}

function dumpToFile(path, extraArgs) {
  const fd = openSync(path, 'w', 0o600);
  try {
    if (container !== '') {
      run(
        'docker',
        ['exec', container, 'pg_dump', '-U', pgUser, '-d', pgDb, '--format=custom', '--compress=9', ...extraArgs],
        { stdio: ['ignore', fd, 'inherit'] },
      );
    } else {
      if (process.env.DATABASE_URL === undefined) throw new Error('DATABASE_URL is required for a host pg_dump');
      run('pg_dump', [process.env.DATABASE_URL, '--format=custom', '--compress=9', ...extraArgs], {
        stdio: ['ignore', fd, 'inherit'],
      });
    }
  } finally {
    closeSync(fd);
  }
}

function listArchive(path) {
  const fd = openSync(path, 'r');
  try {
    if (container !== '') {
      return run('docker', ['exec', '-i', container, 'pg_restore', '--list'], { stdio: [fd, 'pipe', 'inherit'] }).stdout?.toString() ?? '';
    }
    return run('pg_restore', ['--list', path], { stdio: ['ignore', 'pipe', 'inherit'] }).stdout?.toString() ?? '';
  } finally {
    closeSync(fd);
  }
}

async function sha256(path) {
  const hash = createHash('sha256');
  // Stream: a backup can be large and must not be loaded whole.
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

try {
  const dumpPath = join(target, 'database.dump');
  dumpToFile(dumpPath, schemaOnly ? ['--schema-only'] : []);
  const toc = listArchive(dumpPath);
  const tocEntries = toc.split('\n').filter((line) => line.trim() !== '' && !line.startsWith(';')).length;
  const files = ['database.dump'];

  if (!schemaOnly) {
    const parent = dirname(storageRoot);
    const base = storageRoot.slice(parent.length).replace(/^\//, '');
    if (statSync(storageRoot, { throwIfNoEntry: false })?.isDirectory() !== true) {
      throw new Error(`STORAGE_ROOT is not a directory: ${storageRoot}`);
    }
    run('tar', ['czf', join(target, 'files.tgz'), '-C', parent, base]);
    files.push('files.tgz');
  }

  let outputFiles = [...files];
  if (recipient !== '') {
    outputFiles = [];
    for (const name of files) {
      run('gpg', ['--batch', '--yes', '--encrypt', '--recipient', recipient, '--output', join(target, `${name}.gpg`), join(target, name)]);
      rmSync(join(target, name));
      outputFiles.push(`${name}.gpg`);
    }
    console.log('encrypted: gpg recipient configured');
  } else {
    console.log('warning: plaintext backup (--allow-plaintext); keep it local and mode 600');
  }

  const sums = [];
  for (const name of outputFiles) {
    sums.push(`${await sha256(join(target, name))}  ${name}`);
    await chmod(join(target, name), 0o600);
  }
  await writeFile(join(target, 'SHA256SUMS'), `${sums.join('\n')}\n`, { mode: 0o600 });
  await writeFile(
    join(target, 'manifest.json'),
    `${JSON.stringify({
      createdAt: new Date().toISOString(),
      mode: schemaOnly ? 'schema-only' : 'full',
      encrypted: recipient !== '',
      containerized: container !== '',
      tocEntries,
      files: outputFiles,
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(`backup: ${target}`);
  console.log(`mode=${schemaOnly ? 'schema-only' : 'full'} files=${String(outputFiles.length)} tocEntries=${String(tocEntries)}`);

  if (prune) {
    const cutoff = Date.now() - keepDays * 86_400_000;
    let removed = 0;
    for (const name of readdirSync(root)) {
      if (!name.startsWith('phase22-')) continue;
      const candidate = join(root, name);
      const info = statSync(candidate, { throwIfNoEntry: false });
      if (info === undefined || !info.isDirectory() || info.mtimeMs >= cutoff) continue;
      rmSync(candidate, { recursive: true, force: true });
      removed += 1;
    }
    console.log(`pruned: ${String(removed)} backup(s) older than ${String(keepDays)} day(s)`);
  }
} catch (error) {
  // Do not leave a half-written backup that looks valid.
  rmSync(target, { recursive: true, force: true });
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
