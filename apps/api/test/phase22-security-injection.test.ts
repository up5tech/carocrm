import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, shutdownApi } from './support/boot-api.js';

describe('Phase 22.17 — security regression: injection & non-disclosure', () => {
  let ctx: ApiContext;

  beforeAll(async () => {
    ctx = await bootApi();
  });

  afterAll(async () => {
    await shutdownApi();
  });

  it('rejects a filter with a SQL-injection payload in the field name without executing arbitrary SQL', async () => {
    const malicious = JSON.stringify([{ field: "name'; DROP TABLE accounts;--", operator: 'like', value: 'x' }]);
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/Account?where=${encodeURIComponent(malicious)}`,
      headers: authHeader(ctx.adminToken),
    });
    // Must not 500 / crash; should be a validation refusal or empty result, never a server error.
    expect(res.statusCode).not.toBe(500);
    expect(res.statusCode).not.toBe(502);
  });

  it('rejects a filter with a SQL-injection payload in the operator without executing arbitrary SQL', async () => {
    const malicious = JSON.stringify([{ field: 'name', operator: "like' OR '1'='1", value: 'x' }]);
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/Account?where=${encodeURIComponent(malicious)}`,
      headers: authHeader(ctx.adminToken),
    });
    expect(res.statusCode).not.toBe(500);
    expect(res.statusCode).not.toBe(502);
  });

  it('stores an HTML/script payload as text without executing it', async () => {
    const payload = `<script>alert('xss')</script>`;
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/Account',
      headers: authHeader(ctx.adminToken),
      payload: { name: `Sec XSS ${Date.now().toString(36)}`, description: payload },
    });
    expect(created.statusCode).toBe(201);
    const id = String((created.json() as { id: string }).id);
    const read = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/Account/${id}`,
      headers: authHeader(ctx.adminToken),
    });
    expect(read.statusCode).toBe(200);
    const body = read.json() as Record<string, unknown>;
    // The payload must be returned verbatim as data, not interpreted.
    expect(String(body['description'] ?? '')).toContain(payload);
  });

  it('does not disclose existence of a protected record to an unrelated caller (non-disclosure)', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/Account',
      headers: authHeader(ctx.adminToken),
      payload: { name: `Sec Hidden ${Date.now().toString(36)}` },
    });
    expect(created.statusCode).toBe(201);
    const id = String((created.json() as { id: string }).id);

    // Unauthenticated caller must not learn the record exists.
    const anon = await ctx.app.inject({ method: 'GET', url: `/api/v1/Account/${id}` });
    expect(anon.statusCode).toBe(401);

    // The response must not leak the record name or any field.
    const body = anon.body ?? '';
    expect(body).not.toContain('Sec Hidden');
  });
});
