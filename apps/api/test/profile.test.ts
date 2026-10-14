import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestUser, loginAs, shutdownApi } from './support/boot-api.js';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const runId = Date.now().toString(36);
const PASSWORD = 'AGENT_TEST_pw123';
const NEW_PASSWORD = 'AGENT_TEST_pw456';

let ctx: ApiContext;
let user: { id: string; userName: string; token: string };

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
  return { status: res.statusCode, body };
}

/** A stored file the profile may point at; only the owner column matters for these assertions. */
async function insertAttachment(id: string, ownerId: string): Promise<void> {
  await ctx.database.db
    .insertInto('attachments')
    .values({
      id,
      name: `${id}.png`,
      type: 'Attachment',
      size: BigInt(8),
      mime_type: 'image/png',
      storage_key: `test/${id}.png`,
      checksum: null,
      parent_id: null,
      parent_type: null,
      field: 'avatar',
      role: 'avatar',
      created_by_id: ownerId,
      created_at: new Date(),
    })
    .execute();
}

beforeAll(async () => {
  ctx = await bootApi();
  user = await createTestUser(ctx, { userName: `AGENT_TEST prof${runId}`, password: PASSWORD });
});

afterAll(async () => {
  await ctx.database.db.deleteFrom('attachments').where('name', 'like', `AGENT_TEST-att-${runId}%`).execute();
  await ctx.database.db.deleteFrom('users').where('id', '=', user.id).execute();
  await shutdownApi();
});

describe('profile page API', () => {
  it('serves the signed-in user their own profile fields', async () => {
    const me = await call('GET', '/api/v1/AppUser/me', user.token);
    expect(me.status).toBe(200);
    expect(me.body['id']).toBe(user.id);
    expect(me.body['avatarId']).toBeNull();
    expect(String(me.body['emailAddress'])).toContain('@example.com');
  });

  it('lets a non-admin edit their own name, contact details and title', async () => {
    const patched = await call('PATCH', '/api/v1/AppUser/me', user.token, {
      firstName: 'Ada',
      lastName: 'Lovelace',
      emailAddress: 'ada@example.com',
      phoneNumber: '+84 900 000 001',
      title: 'Engineer',
    });
    expect(patched.status).toBe(200);
    expect(patched.body['name']).toBe('Ada Lovelace');

    const read = await call('GET', '/api/v1/AppUser/me', user.token);
    expect(read.body['firstName']).toBe('Ada');
    expect(read.body['emailAddress']).toBe('ada@example.com');
    expect(read.body['phoneNumber']).toBe('+84 900 000 001');
    expect(read.body['title']).toBe('Engineer');
  });

  it('refuses an invalid email and an empty patch', async () => {
    const badEmail = await call('PATCH', '/api/v1/AppUser/me', user.token, { emailAddress: 'not-an-email' });
    expect(badEmail.status).toBe(422);

    const empty = await call('PATCH', '/api/v1/AppUser/me', user.token, {});
    expect(empty.status).toBe(422);
  });

  it('accepts an avatar the user uploaded and refuses one they did not', async () => {
    const admin = await ctx.database.db.selectFrom('users').select('id').where('user_name', '=', 'admin').executeTakeFirstOrThrow();
    const foreign = `AGENT_TEST-att-${runId}-foreign`;
    const own = `AGENT_TEST-att-${runId}-own`;
    await insertAttachment(foreign, admin.id);
    await insertAttachment(own, user.id);

    const denied = await call('PATCH', '/api/v1/AppUser/me', user.token, { avatarId: foreign });
    expect(denied.status).toBe(422);

    const accepted = await call('PATCH', '/api/v1/AppUser/me', user.token, { avatarId: own });
    expect(accepted.status).toBe(200);
    expect(accepted.body['avatarId']).toBe(own);

    const cleared = await call('PATCH', '/api/v1/AppUser/me', user.token, { avatarId: null });
    expect(cleared.body['avatarId']).toBeNull();
  });

  it('changes the password only with the current one, and revokes the sessions', async () => {
    const wrong = await call('POST', '/api/v1/AppUser/me/password', user.token, {
      currentPassword: 'not-the-password',
      newPassword: NEW_PASSWORD,
    });
    expect(wrong.status).toBe(401);

    const short = await call('POST', '/api/v1/AppUser/me/password', user.token, {
      currentPassword: PASSWORD,
      newPassword: 'short',
    });
    expect(short.status).toBe(422);

    const changed = await call('POST', '/api/v1/AppUser/me/password', user.token, {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(changed.status).toBe(200);

    // `changePassword` revokes every session of this user, so the token in hand is dead.
    const after = await call('GET', '/api/v1/AppUser/me', user.token);
    expect(after.status, JSON.stringify(after.body)).toBe(401);

    const again = await loginAs(ctx, user.userName, NEW_PASSWORD);
    expect(typeof again).toBe('string');
    user.token = again;
  });
});
