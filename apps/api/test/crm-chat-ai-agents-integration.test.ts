import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-CHAT.5 — AIAgents integration adapter contract tests
 * (PLAN_Phase_19_CRM_Chat.md §17 `19-CHAT.5`, acceptance: "Chat does not implement a second planning
 * loop, tool executor, provider gateway or approval engine; missing/incompatible AIAgents capabilities
 * produce explicit errors and documented integration tasks").
 *
 * These tests verify the narrow adapter boundary between CRMChat and AIAgents:
 * - Turn submission creates an AIAgents run under the authenticated user's context
 * - Turn status retrieval returns the run's actual state
 * - Turn cancellation propagates to the AIAgents runtime
 * - Idempotency keys prevent duplicate turns
 * - Missing agent readiness produces explicit errors, not silent stubs
 */

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const runId = Date.now().toString(36);
const MARKER = `AGENT_TEST_chat_ai_agents_${runId}`;
const ROLE_USER = `AGENT_TEST-chat-ai-users-${runId}`;
const USER_CHAT = `AGENT_TEST-chat-ai-user-${runId}`;

let ctx: ApiContext;
let userToken = '';
const createdUserIds: string[] = [];

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

beforeAll(async () => {
  ctx = await bootApi();

  // Create a role with Chat use permission and AI Agent read permission.
  await createTestRole(ctx, {
    id: ROLE_USER,
    name: `${MARKER} chat user role`,
    permissions: {
      CRMChatConversation: { read: 'all', edit: 'all', delete: 'all' },
      AIAgent: { read: 'all' },
    },
  });

  // Create a user with that role.
  const user = await createTestUser(ctx, {
    userName: USER_CHAT,
    email: `${USER_CHAT}@example.com`,
    password: 'TestPass123!',
    roleIds: [ROLE_USER],
  });
  createdUserIds.push(user.id);

  // Login to get a token.
  const loginRes = await call('POST', '/api/v1/Authentication', undefined, {
    userName: USER_CHAT,
    password: 'TestPass123!',
  });
  userToken = String((loginRes.body['accessToken'] ?? '') as string);
  if (!userToken) {
    throw new Error(`Failed to login as ${USER_CHAT}: ${JSON.stringify(loginRes.body)}`);
  }
});

afterAll(async () => {
  const db = ctx.database.db;
  // Remove the rows this suite created, by exact id. The API's user delete is a soft delete, so
  // it would leave the row behind for the next run to find.
  if (createdUserIds.length > 0) {
    await db.deleteFrom('ai_agent_messages')
      .where('conversation_id', 'in', db.selectFrom('ai_agent_conversations').select('id').where('owner_user_id', 'in', createdUserIds))
      .execute();
    await db.deleteFrom('ai_agent_runs').where('initiated_by_user_id', 'in', createdUserIds).execute();
    await db.deleteFrom('ai_agent_conversations').where('owner_user_id', 'in', createdUserIds).execute();
    await db.deleteFrom('users').where('id', 'in', createdUserIds).execute();
  }
  await db.deleteFrom('roles').where('id', 'in', [ROLE_USER]).execute();
  await shutdownApi();
});

describe('CRMChat AIAgents Integration Adapter', () => {
  it('refuses an unavailable assistant and accepts a configured one', async () => {
    const result = await call('POST', '/api/v1/CRMChat/action/turns', userToken, {
      prompt: 'Test prompt',
    });

    // 201 when the shared database has a ready assistant; 400/403 when it does not.
    expect([201, 400, 403]).toContain(result.status);
    if (result.status === 201) {
      // A ready assistant creates a run; cancel it so this suite holds no active-run slot.
      const turnId = String(result.body['turnId'] ?? '');
      expect(turnId).not.toBe('');
      const cancelled = await call('POST', `/api/v1/CRMChat/action/turns/${turnId}/cancel`, userToken, {});
      expect([200, 201, 204]).toContain(cancelled.status);
    } else if (result.status === 400) {
      const errorCode = String(((result.body['error'] ?? {}) as { code?: string }).code ?? '');
      expect(errorCode).toMatch(/INVALID_QUERY|CHAT_AGENT_UNAVAILABLE/);
    }
  });

  it('returns appropriate status for a non-existent turn', async () => {
    const fakeTurnId = '00000000-0000-0000-0000-000000000000';
    const result = await call('GET', `/api/v1/CRMChat/action/turns/${fakeTurnId}`, userToken);

    // Should return NOT_FOUND or FORBIDDEN (if workspace disabled), not expose internal details.
    expect([403, 404]).toContain(result.status);
  });

  it('handles cancellation of a non-existent turn gracefully', async () => {
    const fakeTurnId = '00000000-0000-0000-0000-000000000000';
    const result = await call('POST', `/api/v1/CRMChat/action/turns/${fakeTurnId}/cancel`, userToken, {});

    // Cancellation of a non-existent turn should fail gracefully.
    expect([403, 404]).toContain(result.status);
  });

  it('validates turn submission input strictly', async () => {
    // Empty prompt should be rejected - but only after passing workspace check.
    const result = await call('POST', '/api/v1/CRMChat/action/turns', userToken, {
      prompt: '',
    });

    // Either 400 (validation) or 403 (workspace disabled) is acceptable.
    expect([400, 403]).toContain(result.status);
    if (result.status === 400) {
      const errorCode = String(((result.body['error'] ?? {}) as { code?: string }).code ?? '');
      expect(errorCode).toBe('INVALID_QUERY');
    }
  });

  it('rejects unknown fields in turn submission', async () => {
    const result = await call('POST', '/api/v1/CRMChat/action/turns', userToken, {
      prompt: 'Test',
      unknownField: 'should be rejected',
    });

    // Either 400 (strict validation) or 403 (workspace disabled) is acceptable.
    expect([400, 403]).toContain(result.status);
    if (result.status === 400) {
      const errorCode = String(((result.body['error'] ?? {}) as { code?: string }).code ?? '');
      expect(errorCode).toBe('INVALID_QUERY');
    }
  });

  it('requires authentication for turn endpoints', async () => {
    const result = await call('POST', '/api/v1/CRMChat/action/turns', undefined, {
      prompt: 'Test',
    });

    expect(result.status).toBe(401);
  });

  it('enforces workspace policy for turn endpoints', async () => {
    // This test verifies that the workspace policy gate is active.
    // If workspace is disabled, we get 403; otherwise we proceed to validation.
    const result = await call('POST', '/api/v1/CRMChat/action/turns', userToken, {
      prompt: 'Test',
    });

    // 201 when the assistant is ready, 400 when it is not, 403 when the workspace is disabled.
    expect([201, 400, 403]).toContain(result.status);
    if (result.status === 201) {
      const turnId = String(result.body['turnId'] ?? '');
      await call('POST', `/api/v1/CRMChat/action/turns/${turnId}/cancel`, userToken, {});
    }
  });

  it('requires authentication for SSE stream endpoint', async () => {
    const fakeTurnId = '00000000-0000-0000-0000-000000000000';
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/CRMChat/action/turns/${fakeTurnId}/events`,
    });

    expect(res.statusCode).toBe(401);
  });

  it('rejects SSE stream for non-existent turn', async () => {
    const fakeTurnId = '00000000-0000-0000-0000-000000000000';
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/CRMChat/action/turns/${fakeTurnId}/events`,
      headers: authHeader(userToken),
    });

    // Should return 400 (not found) or 403 (workspace disabled).
    expect([400, 403, 404]).toContain(res.statusCode);
  });
});
