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
    // The field is an allowlisted identifier, so the only acceptable answer is a validation refusal.
    expect(res.statusCode, res.body).toBe(400);
    expect(res.body).toContain('INVALID_QUERY');
  });

  it('rejects a filter with a SQL-injection payload in the operator without executing arbitrary SQL', async () => {
    const malicious = JSON.stringify([{ field: 'name', operator: "like' OR '1'='1", value: 'x' }]);
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/Account?where=${encodeURIComponent(malicious)}`,
      headers: authHeader(ctx.adminToken),
    });
    expect(res.statusCode, res.body).toBe(400);
  });

  it('rejects a SQL-injection payload in a sort key and a selected field', async () => {
    for (const url of [
      `/api/v1/Account?orderBy=${encodeURIComponent("name; DROP TABLE accounts;--")}`,
      `/api/v1/Account?select=${encodeURIComponent("name; DROP TABLE accounts;--")}`,
      `/api/v1/Account?order=asc;DELETE`,
    ]) {
      const res = await ctx.app.inject({ method: 'GET', url, headers: authHeader(ctx.adminToken) });
      expect(res.statusCode, `${url} ${res.body}`).toBe(400);
    }
  });

  it('treats a SQL-looking value as data and returns no injected rows', async () => {
    const where = JSON.stringify([{ field: 'name', operator: 'equals', value: "x' OR '1'='1" }]);
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/Account?where=${encodeURIComponent(where)}`,
      headers: authHeader(ctx.adminToken),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { list?: unknown[] }).list).toEqual([]);
  });

  it('refuses an injection-shaped entity name without a server error', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/${encodeURIComponent("Account; DROP TABLE accounts;--")}`,
      headers: authHeader(ctx.adminToken),
    });
    expect([400, 404]).toContain(res.statusCode);
    expect(res.statusCode).not.toBe(500);
  });

  it('rejects a malformed provider webhook body before it reaches an adapter', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/MarketingAutomation/webhook/agent-test',
      headers: { 'content-type': 'application/json' },
      payload: '{"eventId":',
    });
    expect(res.statusCode).toBe(400);
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
    // And the response is JSON, not a document the browser would parse as HTML.
    expect(String(read.headers['content-type'])).toContain('application/json');
  });

  it('serves a CSP that forbids inline script and plugin content', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/health' });
    const csp = String(res.headers['content-security-policy'] ?? '');
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
  });

  it('publishes a route-level OpenAPI document with declared authentication schemes', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/OpenApi' });
    expect(res.statusCode).toBe(200);
    const spec = res.json() as {
      openapi: string;
      paths: Record<string, Record<string, unknown>>;
      components?: { securitySchemes?: Record<string, unknown> };
    };
    expect(spec.openapi).toMatch(/^3\./);
    // Representative entity and command routes are present with their verbs. This is the contract
    // test G1 asks for; DTO-derived bodies remain the documented deviation.
    // The generic record API publishes one parametric path, not one per entity.
    expect(Object.keys(spec.paths['/api/v1/{entity}'] ?? {})).toEqual(expect.arrayContaining(['get', 'post']));
    expect(Object.keys(spec.paths['/api/v1/{entity}/{id}'] ?? {})).toEqual(
      expect.arrayContaining(['get', 'patch', 'delete']),
    );
    expect(Object.keys(spec.paths['/api/v1/Authentication'] ?? {})).toContain('post');
    expect(spec.components?.securitySchemes?.['cookieAuth']).toBeDefined();
    expect(spec.components?.securitySchemes?.['bearerAuth']).toBeDefined();
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
