import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import * as context from './index.js';

/**
 * Phase 24.1 — single-tenant boundary regression.
 *
 * `tenantId` / `getTenantId()` used to sit on RequestContext and AclContext with no caller at all.
 * They were removed rather than left as a misleading "future" hook (see
 * `docs/reference/product-charter.md` §3 and §6). Provider-account labels (`tenantRef` in
 * `apps/api/src/advanced-integrations/*`) are a different concept and are deliberately untouched.
 */
const ROOT = new URL('../../../../', import.meta.url);
const DEAD_SURFACE = [
  'packages/core/src/context/index.ts',
  'packages/core/src/logger/index.ts',
  'packages/acl/src/types/index.ts',
];

describe('single-tenant request context (24.1)', () => {
  it('exports no tenant identifier accessor', () => {
    expect(Object.keys(context)).not.toContain('getTenantId');
  });

  it('carries no tenant field on a running context', () => {
    const created = context.createRequestContext({ userId: 'agent-test-user' });
    expect(Object.keys(created)).not.toContain('tenantId');
    context.runWithRequestContext(created, () => {
      const current = context.getRequestContext();
      expect(current?.userId).toBe('agent-test-user');
      expect(Object.keys(current ?? {})).not.toContain('tenantId');
    });
  });

  it('keeps the removed field out of the context, ACL and logger sources', () => {
    for (const file of DEAD_SURFACE) {
      const source = readFileSync(new URL(file, ROOT), 'utf8');
      expect(source, `${file} still declares a tenant identifier`).not.toMatch(/\btenantId\b/);
      expect(source, `${file} still calls getTenantId()`).not.toMatch(/\bgetTenantId\b/);
    }
  });
});
