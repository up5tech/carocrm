#!/usr/bin/env node
/**
 * Single-tenant boundary check (Phase 24.1 decision, asserted again in Phase 24.11).
 *
 * CaroCRM is single-tenant by owner decision (`docs/reference/product-charter.md` §6,
 * `docs/security/tenancy-decision.md`). Phase 24.1 removed the unused `tenantId`/`getTenantId`
 * surface; this script fails if a caller depends on CRM tenancy again — a `getTenantId` helper, a
 * `tenantId` field on requests/queries/records, or a `tenant_id` predicate outside the two places
 * the word legitimately means something else:
 *
 *  - `apps/api/src/email/inbound-connections.service.ts` and `packages/mail/src/inbound/graph.ts` —
 *    the Microsoft Graph/Entra `tenantId` is the customer's Azure AD tenant, not CaroCRM tenancy.
 *  - `apps/api/src/database/database.service.ts` — the row type that carries that column.
 *
 * Test files are exempt: fixtures may name the field while asserting its absence.
 *
 * Run: `node scripts/check-single-tenant.mjs` (wired into `pnpm lint`).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const SCAN_DIRS = ['apps/api/src', 'apps/web/src', 'packages'];
const ALLOWLIST = new Set([
  'apps/api/src/email/inbound-connections.service.ts',
  'apps/api/src/database/database.service.ts',
  'packages/mail/src/inbound/graph.ts',
]);
// `tenantId`/`tenant_id`/`getTenantId` as a whole word; `tenantId` inside a longer identifier
// (e.g. `graphTenantId`) is still caught only when it stands alone — the Entra usages above are
// allowlisted by file, not by pattern, so no pattern exception is needed here.
const FORBIDDEN = /\b(?:getTenantId|tenantId|tenant_id)\b/;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      walk(path, out);
    } else if (/\.(ts|tsx|mts|cts)$/.test(entry) && !/\.(test|spec|d)\.(ts|tsx)$/.test(entry) && !entry.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

const violations = [];
for (const dir of SCAN_DIRS) {
  const full = join(root, dir);
  try {
    statSync(full);
  } catch {
    continue;
  }
  for (const file of walk(full)) {
    const rel = relative(root, file).split('\\').join('/');
    if (ALLOWLIST.has(rel)) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (FORBIDDEN.test(line)) violations.push(`${rel}:${index + 1}  ${line.trim().slice(0, 120)}`);
    });
  }
}

if (violations.length > 0) {
  console.error(`single-tenant check: ${violations.length} violation(s) — CaroCRM is single-tenant by decision`);
  console.error('(docs/reference/product-charter.md §6); remove the tenant dependency or record a reviewed exception.\n');
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}
console.log('single-tenant check: clean (no CRM tenantId/getTenantId/tenant_id callers)');
