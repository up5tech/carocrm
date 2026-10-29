#!/usr/bin/env node
/**
 * Phase 22.23 — verify a table-directory backup before anyone trusts it.
 *
 * This is a **read-only** checker for the NDJSON-directory format the demo/reset tooling writes
 * (one `*.ndjson.gz` per table). It never connects to a database and never extracts into the
 * repository; a backup is not a restore, and this script does not pretend to be one.
 *
 * Checks:
 *  - every `.ndjson.gz` is a valid gzip stream;
 *  - the core tables a recoverable CRM backup needs are present and non-empty;
 *  - the newest file is within `--max-age-hours` (default 26 h);
 *  - files are not world-readable (mode 600/640 class; group-readable is acceptable on a
 *    single-host install, other-readable is not);
 *  - a sidecar encryption marker (`.age`, `.gpg`, `.enc`) is reported when present.
 *
 * Usage: `node scripts/verify-backup.mjs <backup-dir> [--max-age-hours=26]`
 * Exit 1 on a failed backup, 0 only when every check passes.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const directory = process.argv[2];
const maxAgeArg = process.argv.find((arg) => arg.startsWith('--max-age-hours='));
const maxAgeHours = maxAgeArg === undefined ? 26 : Number(maxAgeArg.split('=')[1]);
if (directory === undefined || !Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
  console.error('usage: node scripts/verify-backup.mjs <backup-dir> [--max-age-hours=26]');
  process.exit(2);
}

const CORE_TABLES = ['entity_records', 'users', 'roles', 'teams', 'app_settings', 'audit_log', 'stream_items', 'outbox_events', 'jobs'];
const problems = [];
const notes = [];

let entries;
try {
  entries = readdirSync(directory);
} catch {
  console.error(`backup directory is not readable: ${directory}`);
  process.exit(1);
}

const files = entries.filter((name) => name.endsWith('.ndjson.gz'));
if (files.length === 0) problems.push('no *.ndjson.gz files found');

let totalRows = 0;
let newest = 0;
let worldReadable = 0;
let encryptedMarker = false;
for (const name of entries) {
  if (/(\.age|\.gpg|\.enc)$/i.test(name)) encryptedMarker = true;
}
for (const name of files) {
  const path = join(directory, name);
  try {
    execFileSync('gzip', ['-t', path], { stdio: 'ignore' });
  } catch {
    problems.push(`${name}: not a valid gzip stream`);
    continue;
  }
  // Count in the pipeline, never in this process: capturing decompressed content would put CRM
  // records in memory and, on a buffer error, in the exception text.
  let rows;
  try {
    rows = Number(execFileSync('sh', ['-c', 'gzip -dc "$1" | wc -l', 'sh', path], { encoding: 'utf8' }).trim());
  } catch {
    problems.push(`${name}: could not be decompressed`);
    continue;
  }
  totalRows += rows;
  const stat = statSync(path);
  newest = Math.max(newest, stat.mtimeMs);
  if ((stat.mode & 0o004) !== 0) worldReadable += 1;
  const table = name.replace(/\.ndjson\.gz$/, '');
  if (CORE_TABLES.includes(table) && rows === 0) problems.push(`${name}: core table is empty`);
}

for (const table of CORE_TABLES) {
  if (!files.includes(`${table}.ndjson.gz`)) problems.push(`missing core table: ${table}`);
}
if (worldReadable > 0) problems.push(`${String(worldReadable)} file(s) are world-readable; use mode 600/640`);
if (!encryptedMarker) notes.push('no encryption marker (.age/.gpg/.enc) beside the files');
const ageHours = newest === 0 ? Number.POSITIVE_INFINITY : (Date.now() - newest) / 3_600_000;
if (ageHours > maxAgeHours) problems.push(`newest file is ${ageHours.toFixed(1)} h old; limit ${String(maxAgeHours)} h`);

console.log(`backup: ${directory}`);
console.log(`tables=${String(files.length)} rows=${String(totalRows)} ageHours=${Number.isFinite(ageHours) ? ageHours.toFixed(1) : 'unknown'}`);
for (const note of notes) console.log(`note: ${note}`);
if (problems.length === 0) {
  console.log('backup check: passed');
  process.exit(0);
}
console.error(`backup check: ${String(problems.length)} problem(s)`);
for (const problem of problems) console.error(`- ${problem}`);
process.exit(1);
