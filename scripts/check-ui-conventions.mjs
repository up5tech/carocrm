#!/usr/bin/env node
/**
 * UI convention gate (PLAN_Phase_20_Settings_UX.md §20.22/§20.23/§20.20, gate formalised in §20.26).
 *
 * Five rules, each of which is a defect this repository shipped at least once:
 *
 * 1. **Every `t('…')` key exists in `i18n/en`.** A missing key is not a fallback — `t()` returns the
 *    key itself, so the operator reads `core.common.accessDenied` where a sentence belongs. Six of
 *    those were live when this script was written. A key that exists only as `_one`/`_other` is a
 *    plural form and passes: i18next resolves it from the `count` variable.
 * 2. **No `.slice(0, 19)` timestamp.** That is the ISO string cut at the `T`, which prints UTC while
 *    the rest of the page prints the user's timezone. Use `formatDateTime`.
 * 3. **No raw `<Empty>` outside `EmptyState.tsx`.** One component owns the empty state, so the four
 *    situations (nothing exists / nothing matched / filtered away / not permitted) stay distinct.
 * 4. **No `<a href="/…">`.** A full page load drops the SPA state; use `Link`.
 * 5. **No hex colour literal outside `tokens.css` (and `theme.ts` must stay literal-free).** Every
 *    colour lives in `styles/tokens.css` (generated from `theme/tokens.ts`); a literal elsewhere is a
 *    drift that breaks the single-source-of-truth rule §20.20 established. The only legal literals are
 *    in `tokens.css` and `theme/tokens.ts`.
 *
 * Run: `node scripts/check-ui-conventions.mjs` (also wired to `pnpm lint:ui`).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const srcDir = join(root, 'apps/web/src');
const i18nDir = join(root, 'i18n/en');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (path.endsWith('.ts') || path.endsWith('.tsx') || path.endsWith('.css')) out.push(path);
  }
  return out;
}

function flatten(prefix, doc, out = {}) {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    out[prefix] = doc;
    return out;
  }
  for (const [key, value] of Object.entries(doc)) flatten(`${prefix}.${key}`, value, out);
  return out;
}

const catalog = {};
for (const file of readdirSync(i18nDir)) {
  if (!file.endsWith('.json')) continue;
  const doc = JSON.parse(readFileSync(join(i18nDir, file), 'utf8'));
  Object.assign(catalog, flatten(file.slice(0, -'.json'.length), doc));
}

const KEY_RE = /\bt\(\s*'([^'{}]+)'/g;
const SLICE_RE = /\.slice\(0,\s*19\)/;
const RAW_EMPTY_RE = /<Empty[\s/>]/;
// `/api/…` is deliberately excluded: a file download must be a real navigation, not a route change.
const RAW_ANCHOR_RE = /<a\s[^>]*href=\{?["'`]\/(?!api\/)/;
// Hex colour literal. The negative lookaheads reject a value that is part of an identifier (so
// `#carocrm-content` is never matched) and one followed by more hex digits.
const HEX_RE = /(#[0-9a-fA-F]{8}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{4}|#[0-9a-fA-F]{3})(?![0-9a-fA-F])(?![a-zA-Z0-9_-])/;

const violations = [];

for (const file of walk(srcDir)) {
  const rel = relative(root, file);
  const source = readFileSync(file, 'utf8');
  const lines = source.split('\n');

  // Rule 5: hex literals may live only in tokens.css (and theme/tokens.ts, the TS source). Any other
  // .css file, and theme.ts itself, must stay literal-free.
  const hexScoped = (rel.endsWith('.css') && !rel.endsWith('styles/tokens.css')) || rel.endsWith('theme.ts');

  lines.forEach((line, index) => {
    const at = `${rel}:${index + 1}`;
    for (const match of line.matchAll(KEY_RE)) {
      const key = match[1];
      if (key in catalog) continue;
      // A plural form is called as the bare key and resolved from `count`.
      if (`${key}_one` in catalog || `${key}_other` in catalog) continue;
      violations.push(`${at}  missing i18n key: ${key}`);
    }
    if (SLICE_RE.test(line)) violations.push(`${at}  ISO slice instead of formatDateTime`);
    if (RAW_EMPTY_RE.test(line) && !rel.endsWith('components/EmptyState.tsx')) {
      violations.push(`${at}  raw <Empty> — use EmptyState`);
    }
    if (RAW_ANCHOR_RE.test(line)) violations.push(`${at}  raw <a href="/…"> — use Link`);
    if (hexScoped && HEX_RE.test(line)) violations.push(`${at}  hex colour literal — use a --carocrm-* token (tokens.css)`);
  });
}

if (violations.length === 0) {
  console.log(`ui conventions: clean (${Object.keys(catalog).length} keys checked)`);
  process.exit(0);
}

console.error(`ui conventions: ${violations.length} violation(s)\n`);
for (const violation of violations) console.error(`  ${violation}`);
console.error('\nSee docs/ux/design-principles.md and PLAN_Phase_20_Settings_UX.md §20.22–§20.26.');
process.exit(1);
