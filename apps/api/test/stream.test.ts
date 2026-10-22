import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NotificationEventsService } from '../src/stream/index.js';
import type { ApiContext, TestUser } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const runId = `st${Date.now().toString(36)}`;

let ctx: ApiContext;
let adminToken = '';

async function call(method: Method, url: string, token: string, payload?: unknown): Promise<CallResult> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: authHeader(token),
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

function errorOf(body: Record<string, unknown>): string {
  const error = body['error'] as { code?: string } | undefined;
  return error?.code ?? '';
}

function itemsOf(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(body['list']) ? (body['list'] as Array<Record<string, unknown>>) : [];
}

async function createTask(token: string, name: string): Promise<string> {
  const created = await call('POST', '/api/v1/Task', token, { name, status: 'Not Started' });
  expect(created.status).toBe(201);
  return String(created.body['id']);
}

let taskId = '';
let poster!: TestUser;
let viewer!: TestUser;
let mentioned!: TestUser;

beforeAll(async () => {
  ctx = await bootApi();
  adminToken = ctx.adminToken;
  await createTestRole(ctx, {
    id: `streamPost${runId}`,
    name: `Stream post ${runId}`,
    permissions: { Task: { read: 'all', stream: 'yes' } },
  });
  await createTestRole(ctx, {
    id: `streamView${runId}`,
    name: `Stream view ${runId}`,
    permissions: { Task: { read: 'all', stream: 'no' } },
  });
  poster = await createTestUser(ctx, { userName: `st_post_${runId}`, roleIds: [`streamPost${runId}`] });
  viewer = await createTestUser(ctx, { userName: `st_view_${runId}`, roleIds: [`streamView${runId}`] });
  mentioned = await createTestUser(ctx, { userName: `st_mention_${runId}`, roleIds: [`streamPost${runId}`] });
  taskId = await createTask(adminToken, `Stream Task ${runId}`);
});

afterAll(async () => {
  await shutdownApi();
});

describe('stream authentication', () => {
  it('rejects anonymous access to the global stream and record stream', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/Stream' });
    expect(res.statusCode).toBe(401);
    const record = await ctx.app.inject({ method: 'GET', url: `/api/v1/Task/${taskId}/stream` });
    expect(record.statusCode).toBe(401);
  });
});

describe('stream posts', () => {
  it('creates a post and returns it in the record stream', async () => {
    const created = await call('POST', '/api/v1/Note', adminToken, {
      type: 'Post',
      parentId: taskId,
      parentType: 'Task',
      post: `first note ${runId}`,
    });
    expect(created.status).toBe(201);
    expect(created.body['type']).toBe('Post');
    expect(created.body['post']).toBe(`first note ${runId}`);
    expect(String(created.body['id'] ?? '')).not.toBe('');

    const list = await call('GET', `/api/v1/Task/${taskId}/stream`, adminToken);
    expect(list.status).toBe(200);
    expect(itemsOf(list.body).some((item) => item['post'] === `first note ${runId}`)).toBe(true);
  });

  it('rejects an empty post', async () => {
    const created = await call('POST', '/api/v1/Note', adminToken, {
      type: 'Post',
      parentId: taskId,
      parentType: 'Task',
      post: '   ',
    });
    expect(created.status).toBe(422);
    expect(errorOf(created.body)).toBe('VALIDATION_FAILED');
  });

  it('refuses to generate Update items through the public endpoint', async () => {
    const created = await call('POST', '/api/v1/Note', adminToken, {
      type: 'Update',
      parentId: taskId,
      parentType: 'Task',
      post: 'spoofed',
    });
    // rejected by the request schema: only Post/Note may be created by a caller
    expect(created.status).toBe(400);
    expect(errorOf(created.body)).toBe('INVALID_QUERY');
  });

  it('requires the stream action, not just read access', async () => {
    const denied = await call('POST', '/api/v1/Note', viewer.token, {
      type: 'Post',
      parentId: taskId,
      parentType: 'Task',
      post: `should not persist ${runId}`,
    });
    expect(denied.status).toBe(403);
    expect(errorOf(denied.body)).toBe('AUTHORIZATION_DENIED');

    const allowed = await call('POST', '/api/v1/Note', poster.token, {
      type: 'Post',
      parentId: taskId,
      parentType: 'Task',
      post: `posted by user ${runId}`,
    });
    expect(allowed.status).toBe(201);

    const read = await call('GET', `/api/v1/Task/${taskId}/stream`, viewer.token);
    expect(read.status).toBe(200);
    expect(itemsOf(read.body).some((item) => item['post'] === `should not persist ${runId}`)).toBe(false);
  });

  it('lets only the author or an admin delete an item', async () => {
    const created = await call('POST', '/api/v1/Note', poster.token, {
      type: 'Post',
      parentId: taskId,
      parentType: 'Task',
      post: `to delete ${runId}`,
    });
    const id = String(created.body['id']);
    const stranger = await call('DELETE', `/api/v1/Note/${id}`, viewer.token);
    expect(stranger.status).toBe(403);
    const byAuthor = await call('DELETE', `/api/v1/Note/${id}`, poster.token);
    expect(byAuthor.status).toBe(200);
    const list = await call('GET', `/api/v1/Task/${taskId}/stream`, adminToken);
    expect(itemsOf(list.body).some((item) => item['id'] === id)).toBe(false);
  });
});

describe('record updates in the stream', () => {
  it('writes an Update item when an audited field changes', async () => {
    const fresh = await call('GET', `/api/v1/Task/${taskId}`, adminToken);
    const updated = await call('PATCH', `/api/v1/Task/${taskId}`, adminToken, {
      status: 'Started',
      version: fresh.body['version'],
    });
    expect(updated.status).toBe(200);

    const after = await call('GET', `/api/v1/Task/${taskId}/stream?maxSize=50`, adminToken);
    const updateItem = itemsOf(after.body).find((item) => item['type'] === 'Update');
    expect(updateItem).toBeDefined();
    const data = updateItem?.['data'] as { attributes?: Array<{ name: string; value: unknown }> };
    expect(data.attributes?.some((attribute) => attribute.name === 'status' && attribute.value === 'Started')).toBe(true);
  });

  it('does not write an Update item when no audited field changes', async () => {
    const fresh = await call('GET', `/api/v1/Task/${taskId}`, adminToken);
    const before = await call('GET', `/api/v1/Task/${taskId}/stream?maxSize=100`, adminToken);
    const updated = await call('PATCH', `/api/v1/Task/${taskId}`, adminToken, {
      description: `plain change ${runId}`,
      version: fresh.body['version'],
    });
    expect(updated.status).toBe(200);
    const after = await call('GET', `/api/v1/Task/${taskId}/stream?maxSize=100`, adminToken);
    expect(itemsOf(after.body).length).toBe(itemsOf(before.body).length);
  });
});

describe('follow and global stream', () => {
  it('follows, lists, and unfollows a record', async () => {
    const post = await call('POST', '/api/v1/Note', adminToken, {
      type: 'Post',
      parentId: taskId,
      parentType: 'Task',
      post: `follow me ${runId}`,
    });
    const itemId = String(post.body['id']);

    expect((await call('GET', `/api/v1/Task/${taskId}/subscription`, poster.token)).body).toEqual({ followed: false });
    expect((await call('PUT', `/api/v1/Task/${taskId}/subscription`, poster.token)).status).toBe(200);
    expect((await call('GET', `/api/v1/Task/${taskId}/subscription`, poster.token)).body).toEqual({ followed: true });

    const mine = await call('GET', '/api/v1/Stream?view=followed&maxSize=50', poster.token);
    expect(itemsOf(mine.body).some((item) => item['id'] === itemId)).toBe(true);

    // idempotent follow
    expect((await call('PUT', `/api/v1/Task/${taskId}/subscription`, poster.token)).status).toBe(200);

    expect((await call('DELETE', `/api/v1/Task/${taskId}/subscription`, poster.token)).status).toBe(200);
    const after = await call('GET', '/api/v1/Stream?view=followed&maxSize=50', poster.token);
    expect(itemsOf(after.body).some((item) => item['id'] === itemId)).toBe(false);
  });

  it('returns only the caller-scoped views of the global stream', async () => {
    const own = await call('GET', '/api/v1/Stream?view=own&maxSize=50', poster.token);
    expect(own.status).toBe(200);
    for (const item of itemsOf(own.body)) {
      expect(item['createdById']).toBe(poster.id);
    }
  });

  it('hides items whose parent record the caller cannot read', async () => {
    await createTestRole(ctx, {
      id: `streamBlind${runId}`,
      name: `Stream blind ${runId}`,
      permissions: { Task: { read: 'own', stream: 'yes' } },
    });
    const blind = await createTestUser(ctx, { userName: `st_blind_${runId}`, roleIds: [`streamBlind${runId}`] });
    const post = await call('POST', '/api/v1/Note', adminToken, {
      type: 'Post',
      parentId: taskId,
      parentType: 'Task',
      post: `hidden from blind ${runId}`,
    });
    const itemId = String(post.body['id']);
    // Following is allowed (the stream action is granted), but the parent record is not
    // readable, so the item must never surface in the global stream.
    await call('PUT', `/api/v1/Task/${taskId}/subscription`, blind.token);
    const list = await call('GET', '/api/v1/Stream?view=followed&maxSize=100', blind.token);
    expect(itemsOf(list.body).some((item) => item['id'] === itemId)).toBe(false);
    const direct = await call('GET', `/api/v1/Task/${taskId}/stream`, blind.token);
    expect(direct.status).toBe(403);
  });
});

describe('mentions and notifications', () => {
  it('resolves @mentions, records them and notifies the mentioned user', async () => {
    const created = await call('POST', '/api/v1/Note', poster.token, {
      type: 'Post',
      parentId: taskId,
      parentType: 'Task',
      post: `ping @${mentioned.userName} please`,
    });
    expect(created.status).toBe(201);
    const mentions = created.body['mentions'] as Array<Record<string, unknown>>;
    expect(mentions.map((mention) => mention['userId'])).toContain(mentioned.id);

    const inbox = await call('GET', '/api/v1/Notification?unreadOnly=true', mentioned.token);
    expect(inbox.status).toBe(200);
    const list = Array.isArray(inbox.body['list']) ? (inbox.body['list'] as Array<Record<string, unknown>>) : [];
    const notification = list.find((row) => row['type'] === 'Mention');
    expect(notification).toBeDefined();
    const data = notification?.['data'] as Record<string, unknown>;
    expect(data['entityId']).toBe(taskId);
    expect(data['createdById']).toBe(poster.id);

    const read = await call('POST', `/api/v1/Notification/${String(notification?.['id'])}/Read`, mentioned.token);
    expect(read.status).toBe(201);
    const still = await call('GET', '/api/v1/Notification?unreadOnly=true', mentioned.token);
    const remaining = Array.isArray(still.body['list']) ? (still.body['list'] as Array<unknown>) : [];
    expect(remaining.some((row) => (row as Record<string, unknown>)['id'] === notification?.['id'])).toBe(false);
  });

  it('does not notify the author about their own mention', async () => {
    const before = await call('GET', '/api/v1/Notification?unreadOnly=true', poster.token);
    const beforeCount = Number(before.body['total'] ?? 0);
    await call('POST', '/api/v1/Note', poster.token, {
      type: 'Post',
      parentId: taskId,
      parentType: 'Task',
      post: `self ping @${poster.userName}`,
    });
    const after = await call('GET', '/api/v1/Notification?unreadOnly=true', poster.token);
    expect(Number(after.body['total'] ?? 0)).toBe(beforeCount);
  });

  it('accepts an explicit idList of mention targets', async () => {
    const created = await call('POST', '/api/v1/Note', poster.token, {
      type: 'Post',
      parentId: taskId,
      parentType: 'Task',
      post: 'explicit list',
      idList: [mentioned.id],
    });
    const mentions = created.body['mentions'] as Array<Record<string, unknown>>;
    expect(mentions.map((mention) => mention['userId'])).toContain(mentioned.id);
  });

  it('pushes a notification insert to the recipient event channel', async () => {
    const events = ctx.app.get(NotificationEventsService);
    await events.whenReady();
    const id = `agent-test-realtime-${runId}`;
    const received = new Promise<string>((resolve) => {
      const unsubscribe = events.subscribe(mentioned.id, (event) => {
        unsubscribe();
        resolve(event.id);
      });
    });
    try {
      await ctx.database.db
        .insertInto('notifications')
        .values({
          id,
          type: 'AgentTestRealtime',
          user_id: mentioned.id,
          data: JSON.stringify({ title: 'AGENT_TEST realtime push' }),
          is_read: false,
          created_at: new Date(),
        })
        .execute();
      await expect(received).resolves.toBe(id);
    } finally {
      await ctx.database.db.deleteFrom('notifications').where('id', '=', id).execute();
    }
  });

  it('reports the unread total and marks every notification read at once', async () => {
    await call('POST', '/api/v1/Note', poster.token, {
      type: 'Post',
      parentId: taskId,
      parentType: 'Task',
      post: `batch read @${mentioned.userName}`,
    });
    // `maxSize=1` is what the header badge asks for: the count must not shrink to the page size.
    const unread = await call('GET', '/api/v1/Notification?unreadOnly=true&maxSize=1', mentioned.token);
    expect(unread.status).toBe(200);
    expect(Number(unread.body['total'] ?? 0)).toBeGreaterThan(0);

    const cleared = await call('POST', '/api/v1/Notification/Read-all', mentioned.token);
    expect(cleared.status).toBe(201);
    expect(Number(cleared.body['updated'] ?? 0)).toBeGreaterThan(0);

    const after = await call('GET', '/api/v1/Notification?unreadOnly=true&maxSize=1', mentioned.token);
    expect(Number(after.body['total'] ?? 0)).toBe(0);
  });
});
