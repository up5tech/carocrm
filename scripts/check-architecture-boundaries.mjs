// Phase 22.2 — architecture boundary guard.
//
// Enforces the modular-monolith layering rule: the SHARED/PLATFORM core must not import
// BUSINESS domain modules. (PLAN_Phase_22 §7 task 9 — "the shared core does not import
// business-specific modules".) The only sanctioned cross-module coupling is the composition
// root (app.module.ts / bootstrap.ts) and the intended `advanced-integrations/contracts/*`
// adapter layer.
//
// This script FAILS only on NEW violations. The two currently-known violations are listed in
// `KNOWN_VIOLATIONS` as reviewed exceptions pending the 22.2 refactor (see
// docs/architecture/module-contracts.md). Any shared-core file importing a business domain that
// is NOT in the allowlist aborts the run with the offending import paths.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] ?? 'apps/api/src');
const SHARED = new Set([
  'entity', 'metadata', 'acl', 'jobs', 'events', 'audit', 'stream', 'search', 'reports',
  'attachment', 'email', 'common', 'database', 'auth', 'i18n', 'logic', 'calendar',
  'extensions', 'document', 'admin-panel', 'settings', 'hooks', 'preferences', 'health',
  'setup-checklist',
]);
const DOMAINS = new Set([
  'sales', 'projects', 'customer-success', 'service-desk', 'marketing-automation', 'ai-agents',
  'crm-chat', 'voice-communications', 'advanced-integrations', 'esignature', 'lead-score',
  'omnichannel', 'portal', 'processes', 'workflows',
]);

// Review exceptions: shared-core files that currently reach into a domain. Remove an entry only
// when the matching refactor lands. See docs/architecture/module-contracts.md §5.
const KNOWN_VIOLATIONS = new Set([
  join(ROOT, 'acl/acl-api.service.ts'),
  join(ROOT, 'search/dashboard.service.ts'),
]);

const importRe = /from\s+['"](\.\.?\/[^'"]+)['"]/g;
const violations = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === 'test') continue;
      walk(full);
    } else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
      checkFile(full);
    }
  }
}

function checkFile(file) {
  const rel = file.slice(ROOT.length + 1);
  if (!KNOWN_VIOLATIONS.has(file)) {
    // Only scan shared-core directories; composition root (api/src/*.ts) is out of scope.
    const top = rel.split('/')[0];
    if (!SHARED.has(top)) return;
  }
  const src = readFileSync(file, 'utf8');
  let m;
  while ((m = importRe.exec(src)) !== null) {
    const spec = m[1];
    const seg = spec.split('/').filter((s) => s !== '.' && s !== '..')[0];
    if (DOMAINS.has(seg) && !KNOWN_VIOLATIONS.has(file)) {
      violations.push(`${rel} -> ${spec}`);
    }
  }
}

walk(ROOT);

if (violations.length > 0) {
  console.error('ARCHITECTURE BOUNDARY VIOLATION: shared core imports a business domain module.');
  for (const v of violations) console.error('  ' + v);
  console.error('\nIf this is an intentional, reviewed exception, add the importing file to KNOWN_VIOLATIONS');
  console.error('in scripts/check-architecture-boundaries.mjs and document it in docs/architecture/module-contracts.md.');
  process.exit(1);
}
console.log('OK: no new shared-core -> business-domain imports (known exceptions=' + KNOWN_VIOLATIONS.size + ').');
