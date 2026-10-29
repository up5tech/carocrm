#!/usr/bin/env node
/**
 * Phase 22.22 — the CI-safe migration check (plan §21 Layer 2: "migration/static checks that do not
 * create or reset a database").
 *
 * It never connects to Postgres. It reads `database/migrations/*.sql` in order and checks:
 *
 *  1. the numeric prefix is unique and increasing (a duplicate makes the applied order ambiguous);
 *  2. no file contains a destructive statement that would erase data if it ever ran:
 *     `DROP DATABASE`, `DROP SCHEMA`, `TRUNCATE`, or an unqualified `DELETE FROM` without a WHERE.
 *     A reviewed exception can be written as `-- migration-safety: allow-destructive` in the file;
 *  3. a migration is not empty.
 *
 * Additive index/column work is not restricted. The check is a guard against an accidental reset in
 * a future commit, not a substitute for reviewing a migration.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIRECTORY = 'database/migrations';
const ALLOW = '-- migration-safety: allow-destructive';
const DESTRUCTIVE = [
  { name: 'drop-database', re: /\bDROP\s+DATABASE\b/i },
  { name: 'drop-schema', re: /\bDROP\s+SCHEMA\b/i },
  { name: 'truncate', re: /\bTRUNCATE\b/i },
  { name: 'unqualified-delete', re: /^\s*DELETE\s+FROM\b(?![^;]*\bWHERE\b)[^;]*;/gim },
];

const files = readdirSync(DIRECTORY)
  .filter((name) => name.endsWith('.sql'))
  .sort();

const problems = [];
const seen = new Map();
for (const [index, name] of files.entries()) {
  const match = /^(\d{3})_/.exec(name);
  if (!match) {
    problems.push(`${name}: expected a three-digit numeric prefix`);
    continue;
  }
  const number = Number(match[1]);
  if (seen.has(number)) problems.push(`${name}: duplicate migration number ${match[1]} (also ${seen.get(number)})`);
  seen.set(number, name);
  if (index > 0) {
    const previous = Number(/^(\d{3})_/.exec(files[index - 1])?.[1] ?? 'NaN');
    if (Number.isFinite(previous) && number <= previous) problems.push(`${name}: number ${match[1]} is not after ${files[index - 1]}`);
  }

  const content = readFileSync(join(DIRECTORY, name), 'utf8');
  if (content.trim() === '') problems.push(`${name}: empty migration`);
  if (content.includes(ALLOW)) continue;
  for (const rule of DESTRUCTIVE) {
    rule.re.lastIndex = 0;
    if (rule.re.test(content)) problems.push(`${name}: contains ${rule.name}; add "${ALLOW}" only after review`);
  }
}

if (problems.length === 0) {
  console.log(`migration check: clean (${String(files.length)} files, highest ${files.at(-1) ?? 'none'})`);
  process.exit(0);
}
console.error(`migration check: ${String(problems.length)} problem(s)`);
for (const problem of problems) console.error(`- ${problem}`);
process.exit(1);
