import type { FileStorage } from '@carocrm/files';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FILE_STORAGE_TOKEN } from '../src/attachment/index.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestUser, shutdownApi } from './support/boot-api.js';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers: Record<string, string | string[] | undefined>;
}

const runId = Date.now().toString(36);
const LOGO_KEY = `test/AGENT_TEST-set-${runId}-logo.png`;
const LOGO = `AGENT_TEST-set-${runId}-logo`;
/** A 1x1 transparent PNG — real bytes, because the logo route streams from the storage driver. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let ctx: ApiContext;
let storage: FileStorage;
let regularToken = '';

async function call(method: Method, url: string, token?: string, payload?: unknown): Promise<CallResult> {
  const res = await ctx.app.inject({
    method,
    url,
    ...(token === undefined ? {} : { headers: authHeader(token) }),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  let body: Record<string, unknown> = {};
  try {
    body = res.json() as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body, headers: res.headers as Record<string, string | string[] | undefined> };
}

function errorOf(body: Record<string, unknown>): string {
  const error = body['error'] as { code?: string } | undefined;
  return error?.code ?? '';
}

async function currentSettings(): Promise<Record<string, unknown>> {
  return (await call('GET', '/api/v1/Settings')).body;
}

async function insertAttachment(id: string, mimeType: string, storageKey: string): Promise<void> {
  const admin = await ctx.database.db.selectFrom('users').select('id').where('user_name', '=', 'admin').executeTakeFirstOrThrow();
  await ctx.database.db
    .insertInto('attachments')
    .values({
      id,
      name: `${id}.bin`,
      type: 'Attachment',
      size: BigInt(PNG.byteLength),
      mime_type: mimeType,
      storage_key: storageKey,
      checksum: null,
      parent_id: null,
      parent_type: null,
      field: 'logo',
      role: 'logo',
      created_by_id: admin.id,
      created_at: new Date(),
    })
    .execute();
}

beforeAll(async () => {
  ctx = await bootApi();
  storage = ctx.app.get(FILE_STORAGE_TOKEN);
  regularToken = (await createTestUser(ctx, { userName: `AGENT_TEST set${runId}` })).token;
  await storage.put({ key: LOGO_KEY, body: PNG, contentType: 'image/png' });
  await insertAttachment(LOGO, 'image/png', LOGO_KEY);
});

afterAll(async () => {
  await call('POST', '/api/v1/Settings', ctx.adminToken, { pageTitle: null, footerText: null, logoAttachmentId: null });
  await ctx.database.db.deleteFrom('attachments').where('id', 'like', `AGENT_TEST-set-${runId}%`).execute();
  await storage.delete(LOGO_KEY);
  await ctx.database.db.deleteFrom('app_settings').where('name', '=', 'brand').execute();
  await shutdownApi();
});

describe('instance settings API', () => {
  it('is readable without a session so the sign-in page can paint the brand', async () => {
    const res = await call('GET', '/api/v1/Settings');
    expect(res.status).toBe(200);
    expect(res.body['pageTitle']).toBeNull();
    expect(res.body['logoUrl']).toBeNull();
    expect(res.body['enabledLocales']).toBeInstanceOf(Array);
  });

  it('refuses a write from a non-administrator', async () => {
    const denied = await call('POST', '/api/v1/Settings', regularToken, { pageTitle: 'Hijacked' });
    expect(denied.status).toBe(403);
    expect(errorOf(denied.body)).toBe('AUTHORIZATION_DENIED');
  });

  it('stores the brand text and serves it back publicly', async () => {
    const saved = await call('POST', '/api/v1/Settings', ctx.adminToken, {
      pageTitle: `AGENT_TEST Brand ${runId}`,
      footerText: `AGENT_TEST footer ${runId}`,
    });
    expect(saved.status).toBe(200);
    expect(saved.body['pageTitle']).toBe(`AGENT_TEST Brand ${runId}`);

    expect((await currentSettings())['footerText']).toBe(`AGENT_TEST footer ${runId}`);

    const cleared = await call('POST', '/api/v1/Settings', ctx.adminToken, { pageTitle: null, footerText: null });
    expect(cleared.body['pageTitle']).toBeNull();
    expect(cleared.body['footerText']).toBeNull();
  });

  it('serves the configured logo to anonymous callers and 404s once it is removed', async () => {
    const saved = await call('POST', '/api/v1/Settings', ctx.adminToken, { logoAttachmentId: LOGO });
    expect(saved.status).toBe(200);
    expect(saved.body['logoUrl']).toBe('/api/v1/Settings/logo');

    const logo = await call('GET', '/api/v1/Settings/logo');
    expect(logo.status).toBe(200);
    expect(String(logo.headers['content-type'])).toContain('image/png');

    const cleared = await call('POST', '/api/v1/Settings', ctx.adminToken, { logoAttachmentId: null });
    expect(cleared.body['logoUrl']).toBeNull();
    expect((await call('GET', '/api/v1/Settings/logo')).status).toBe(404);
  });

  it('refuses a logo that is not an image', async () => {
    const notImage = `AGENT_TEST-set-${runId}-text`;
    await insertAttachment(notImage, 'text/plain', `test/${notImage}.bin`);
    const res = await call('POST', '/api/v1/Settings', ctx.adminToken, { logoAttachmentId: notImage });
    expect(res.status).toBe(422);
  });

  it('validates the language and time zone defaults', async () => {
    const current = await currentSettings();
    const enabled = current['enabledLocales'] as string[];
    const timezone = String(current['defaultTimezone']);

    expect((await call('POST', '/api/v1/Settings', ctx.adminToken, { defaultLocale: 'zz' })).status).toBe(422);
    expect(
      (await call('POST', '/api/v1/Settings', ctx.adminToken, { enabledLocales: [enabled[0] ?? 'en'], defaultLocale: 'vi' })).status,
    ).toBe(422);
    expect((await call('POST', '/api/v1/Settings', ctx.adminToken, { defaultTimezone: 'Mars/Phobos' })).status).toBe(422);

    // Writing the values back unchanged proves the accepted path without leaving a new default behind.
    const ok = await call('POST', '/api/v1/Settings', ctx.adminToken, {
      defaultLocale: String(current['defaultLocale']),
      enabledLocales: enabled,
      defaultTimezone: timezone,
    });
    expect(ok.status).toBe(200);
    expect(ok.body['defaultTimezone']).toBe(timezone);
  });
});
