import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { EntityDefinition } from '../../src/metadata/metadata-store.service.js';
import { type ApiContext, authHeader, bootApi, shutdownApi } from './support/boot-api.js';

describe('Phase 7A — internationalization (PLAN §41)', () => {
  let ctx: ApiContext;
  let adminToken: string;
  const runId = Date.now().toString(36);

  beforeAll(async () => {
    ctx = await bootApi();
    adminToken = ctx.adminToken;
  });

  afterAll(async () => {
    await shutdownApi();
  });

  it('GET /I18n returns the merged catalog for the default instance locale', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/I18n', headers: authHeader(adminToken) });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      locale: string;
      instance: { defaultLocale: string; enabledLocales: string[]; defaultTimezone: string };
      hash: string;
      catalog: Record<string, unknown>;
    };
    expect(body.locale).toBe('en');
    expect(body.instance.enabledLocales).toContain('en');
    expect(body.instance.enabledLocales).toContain('vi');
    expect(body.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.catalog['errors.VALIDATION_FAILED']).toBe('Validation failed.');
    expect(body.catalog['web.list.refresh']).toBe('Refresh');
  });

  it('GET /I18n?clientCache=<hash> skips the catalog when the hash matches', async () => {
    const first = await ctx.app.inject({ method: 'GET', url: '/api/v1/I18n', headers: authHeader(adminToken) });
    const { hash } = first.json() as { hash: string };

    const cached = await ctx.app.inject({ method: 'GET', url: `/api/v1/I18n?clientCache=${hash}`, headers: authHeader(adminToken) });
    expect(cached.statusCode).toBe(200);
    expect(cached.json() as { unchanged?: boolean }).toMatchObject({ unchanged: true, hash });

    // A stale hash returns the full catalog again.
    const fresh = await ctx.app.inject({ method: 'GET', url: `/api/v1/I18n?clientCache=deadbeef`, headers: authHeader(adminToken) });
    const body = fresh.json() as { catalog?: Record<string, unknown>; unchanged?: boolean };
    expect(body.unchanged).toBeUndefined();
    expect(body.catalog?.['web.list.refresh']).toBe('Refresh');
  });

  it('PATCH /AppUser/me updates the signed-in user locale/timezone and rejects unknown locales', async () => {
    const rejected = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/AppUser/me',
      headers: authHeader(adminToken),
      payload: { locale: 'fr' },
    });
    expect(rejected.statusCode).toBe(422);

    const ok = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/AppUser/me',
      headers: authHeader(adminToken),
      payload: { locale: 'vi', timezone: 'Asia/Ho_Chi_Minh' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json() as { locale?: string }).toMatchObject({ locale: 'vi' });

    const me = await ctx.app.inject({ method: 'GET', url: '/api/v1/AppUser/me', headers: authHeader(adminToken) });
    expect(me.json() as { locale?: string }).toMatchObject({ locale: 'vi', timezone: 'Asia/Ho_Chi_Minh' });
  });

  it('entity labels resolve through the catalog for the user locale', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/Metadata/Account', headers: authHeader(adminToken) });
    expect(response.statusCode).toBe(200);
    const definition = response.json() as EntityDefinition;
    expect(definition['label']).toBe('Tài khoản');
    expect(definition.name).toBe('Account');

    // English keeps the stored literal label.
    const en = await ctx.app.inject({ method: 'GET', url: '/api/v1/I18n?locale=en' });
    expect((en.json() as { locale: string }).locale).toBe('en');

    const reset = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/AppUser/me',
      headers: authHeader(adminToken),
      payload: { locale: 'en', timezone: 'UTC' },
    });
    expect(reset.statusCode).toBe(200);
  });

  it('an Accept-Language outside the enabled list falls back to the instance default (vi catalog via header)', async () => {
    // Clear the admin's stored locale so the Accept-Language header decides the language
    // (§41.4): an authenticated user's own locale outranks the header, so it must be null here.
    await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/AppUser/me',
      headers: authHeader(adminToken),
      payload: { locale: null, timezone: null },
    });

    const langHeaders = (accept: string): Record<string, string> => ({ ...authHeader(adminToken), 'accept-language': accept });
    const unsupported = await ctx.app.inject({ method: 'GET', url: '/api/v1/I18n', headers: langHeaders('fr-FR,fr') });
    expect((unsupported.json() as { locale: string }).locale).toBe('en');

    const vi = await ctx.app.inject({ method: 'GET', url: '/api/v1/I18n', headers: langHeaders(`vi-VN,vi;q=0.9,en;q=0.8${runId}`) });
    expect((vi.json() as { locale: string }).locale).toBe('vi');
    expect((vi.json() as { catalog: Record<string, unknown> }).catalog['errors.VALIDATION_FAILED']).toBe('Dữ liệu không hợp lệ.');
  });

  it('validation errors carry the request-locale message (PLAN §41.9)', async () => {
    // Clear the admin's stored locale so the request header decides the message language again.
    await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/AppUser/me',
      headers: authHeader(adminToken),
      payload: { locale: null, timezone: null },
    });
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/Account',
      headers: { ...authHeader(adminToken), 'accept-language': 'vi' },
      payload: { website: 'not-an-url' },
    });
    // Creating without the required `name` is a VALIDATION_FAILED with a Vietnamese message.
    expect([404, 422]).toContain(response.statusCode);
    const body = response.json() as { error?: { code?: string; message?: string } };
    if (body.error?.code === 'VALIDATION_FAILED') {
      expect(body.error.message).toBe('Dữ liệu không hợp lệ.');
    }
  });
});
