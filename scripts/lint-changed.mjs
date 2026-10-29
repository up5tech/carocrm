#!/usr/bin/env node
// Lint only files changed since HEAD (working tree) plus untracked files.
// Fast feedback during development; run `pnpm lint` for the full check.
import { execSync } from 'node:child_process';
import { ESLint } from 'eslint';

const gitList = (cmd) =>
  execSync(`git ${cmd}`, { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

let files;
try {
  files = [
    ...gitList('diff --name-only HEAD --diff-filter=ACMR'),
    ...gitList('ls-files --others --exclude-standard'),
  ];
} catch (err) {
  console.error('Failed to list changed files via git:', err.message);
  process.exit(1);
}

const targets = [...new Set(files)].filter(
  (file) => /\.(ts|tsx|js|mjs|jsx|cjs)$/.test(file) && !file.includes('node_modules'),
);

if (targets.length === 0) {
  console.log('No changed lintable files.');
  process.exit(0);
}

console.log(`Linting ${targets.length} changed file(s)...`);
// `warnIgnored: false` keeps a changed file that ESLint deliberately ignores (config files,
// generated paths) from turning the fast check red just because git named it.
const eslint = new ESLint({ cache: true, warnIgnored: false });
const results = await eslint.lintFiles(targets);
const formatter = await eslint.loadFormatter('stylish');
const output = await formatter.format(results);
if (output) console.log(output);

const errorCount = results.reduce((sum, r) => sum + r.errorCount, 0);
const warningCount = results.reduce((sum, r) => sum + r.warningCount, 0);
console.log(`${errorCount} error(s), ${warningCount} warning(s).`);
process.exit(errorCount > 0 || warningCount > 0 ? 1 : 0);
