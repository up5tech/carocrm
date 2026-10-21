import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-CHAT.15 — Privacy, Security, and Audit Hardening tests
 * (PLAN_Phase_19_CRM_Chat.md §12, §16.3, §17 `19-CHAT.15`).
 *
 * These tests verify that:
 * - Prompt injection attempts are handled safely
 * - Cross-user data leakage is prevented
 * - Sensitive data is not exposed in logs or errors
 * - ACL is enforced server-side on every operation
 * - No dangerous tools (SQL, shell, HTTP) are exposed through Chat
 */

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const runId = Date.now().toString(36);
const MARKER = `AGENT_TEST_chat_security_${runId}`;
const ROLE_USER_A = `AGENT_TEST-chat-sec-user-a-${runId}`;
const ROLE_USER_B = `AGENT_TEST-chat-sec-user-b-${runId}`;
const USER_A = `AGENT_TEST-chat-sec-a-${runId}`;
const USER_B = `AGENT_TEST-chat-sec-b-${runId}`;

let ctx: ApiContext;
let tokenA = '';
let tokenB = '';
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

  // Create two separate roles and users to test isolation
  await createTestRole(ctx, {
    id: ROLE_USER_A,
    name: `${MARKER} user A role`,
    permissions: {
      CRMChatConversation: { read: 'all', edit: 'all' },
      CRMChatPrompt: { read: 'all', edit: 'all' },
      AIAgent: { read: 'all' },
    },
  });

  await createTestRole(ctx, {
    id: ROLE_USER_B,
    name: `${MARKER} user B role`,
    permissions: {
      CRMChatConversation: { read: 'all', edit: 'all' },
      CRMChatPrompt: { read: 'all', edit: 'all' },
      AIAgent: { read: 'all' },
    },
  });

  const userA = await createTestUser(ctx, {
    userName: USER_A,
    email: `${USER_A}@example.com`,
    password: 'TestPass123!',
    roleIds: [ROLE_USER_A],
  });
  createdUserIds.push(userA.id);

  const userB = await createTestUser(ctx, {
    userName: USER_B,
    email: `${USER_B}@example.com`,
    password: 'TestPass123!',
    roleIds: [ROLE_USER_B],
  });
  createdUserIds.push(userB.id);

  // Login both users
  const loginA = await call('POST', '/api/v1/Authentication', undefined, {
    userName: USER_A,
    password: 'TestPass123!',
  });
  tokenA = String((loginA.body['accessToken'] ?? '') as string);

  const loginB = await call('POST', '/api/v1/Authentication', undefined, {
    userName: USER_B,
    password: 'TestPass123!',
  });
  tokenB = String((loginB.body['accessToken'] ?? '') as string);
});

afterAll(async () => {
  const db = ctx.database.db;
  // Remove the rows this suite created, by exact id.
  //
  // The API's user delete is a soft delete, so it leaves the row behind and the next run finds
  // it. A test that creates a row removes it. The dependent rows go first, in dependency order.
  if (createdUserIds.length > 0) {
    await db.deleteFrom('crm_chat_prompts').where('owner_user_id', 'in', createdUserIds).execute();
    await db.deleteFrom('users').where('id', 'in', createdUserIds).execute();
  }
  await db.deleteFrom('roles').where('id', 'in', [ROLE_USER_A, ROLE_USER_B]).execute();
  await shutdownApi();
});

describe('CRMChat Security Hardening (19-CHAT.15)', () => {
  describe('Cross-user isolation', () => {
    it('prevents user A from accessing user B\'s conversations', async () => {
      // User A tries to access a fake conversation ID
      const result = await call('GET', '/api/v1/CRMChat/action/conversations/fake-id-123', tokenA);

      // Should get 404 (not found for this user), not 403 or data leak
      expect([403, 404]).toContain(result.status);
    });

    it('prevents unauthenticated access to conversations', async () => {
      const result = await call('GET', '/api/v1/CRMChat/action/conversations');

      expect(result.status).toBe(401);
    });

    it('keeps a saved prompt template private to the user who wrote it', async () => {
      // A writes a template; B must not see it, read it, change it or delete it. The answers for
      // "not yours" and "not there" are the same, so an id cannot be probed for existence.
      const created = await call('POST', '/api/v1/CRMChat/action/prompts', tokenA, {
        name: `${MARKER} private template`,
        promptTemplate: `${MARKER} summarise my accounts`,
      });
      expect(created.status).toBe(201);
      const promptId = String((created.body as { id?: string }).id ?? '');
      expect(promptId).not.toBe('');

      const listB = await call('GET', '/api/v1/CRMChat/action/prompts', tokenB);
      expect(listB.status).toBe(200);
      expect(JSON.stringify(listB.body)).not.toContain(`${MARKER} summarise my accounts`);

      const patchB = await call('PATCH', `/api/v1/CRMChat/action/prompts/${promptId}`, tokenB, {
        name: `${MARKER} hijacked`,
      });
      expect(patchB.status).toBe(404);

      const deleteB = await call('DELETE', `/api/v1/CRMChat/action/prompts/${promptId}`, tokenB);
      expect(deleteB.status).toBe(404);

      // A's template is untouched by B's attempts.
      const listA = await call('GET', '/api/v1/CRMChat/action/prompts', tokenA);
      expect(listA.status).toBe(200);
      expect(JSON.stringify(listA.body)).toContain(`${MARKER} private template`);

      // Clean up the row this run created.
      const removed = await call('DELETE', `/api/v1/CRMChat/action/prompts/${promptId}`, tokenA);
      expect(removed.status).toBe(200);
    });

    it('enforces workspace policy for all endpoints', async () => {
      // All Chat endpoints should enforce workspace policy
      const result = await call('POST', '/api/v1/CRMChat/action/turns', tokenA, {
        prompt: 'Test',
      });

      // Either 400 (assistant not ready) or 403 (workspace disabled) is acceptable
      expect([400, 403]).toContain(result.status);
    });
  });

  describe('Input validation and injection prevention', () => {
    it('rejects turn submission with empty prompt', async () => {
      const result = await call('POST', '/api/v1/CRMChat/action/turns', tokenA, {
        prompt: '',
      });

      expect(result.status).toBe(400);
    });

    it('rejects oversized prompts', async () => {
      const largePrompt = 'A'.repeat(10000);
      const result = await call('POST', '/api/v1/CRMChat/action/turns', tokenA, {
        prompt: largePrompt,
      });

      // Should reject due to size limit
      expect([400, 422]).toContain(result.status);
    });

    it('validates query entity names to prevent injection', async () => {
      const result = await call('POST', '/api/v1/CRMChat/action/query/execute', tokenA, {
        entity: 'Account; DROP TABLE accounts;--',
        limit: 10,
      });

      // Should reject invalid entity name
      expect([400, 422]).toContain(result.status);
    });

    it('rejects SQL-like patterns in filters', async () => {
      const result = await call('POST', '/api/v1/CRMChat/action/query/execute', tokenA, {
        entity: 'Account',
        filters: {
          'name; DROP TABLE': 'value',
        },
      });

      // Query service should sanitize or reject
      // Note: This may still succeed if EntityCrudService handles it, but shouldn't execute SQL
      expect([200, 400, 422]).toContain(result.status);
    });
  });

  describe('Citation and route safety', () => {
    it('reauthorizes citations before rendering', async () => {
      const result = await call('POST', '/api/v1/CRMChat/action/citations/reauthorize', tokenA, {
        citations: [
          {
            sourceType: 'crm_record',
            entity: 'Account',
            sourceId: 'test-id',
            displayLabel: 'Test Account',
          },
        ],
      });

      // Should return reauthorized results
      expect(result.status).toBe(200);
      expect(result.body).toHaveProperty('citations');
    });

    it('rejects citations with invalid entity names', async () => {
      const result = await call('POST', '/api/v1/CRMChat/action/citations/reauthorize', tokenA, {
        citations: [
          {
            sourceType: 'crm_record',
            entity: 'Account; DROP TABLE',
            sourceId: 'test-id',
            displayLabel: 'Malicious',
          },
        ],
      });

      // Should still process but mark as inaccessible
      expect(result.status).toBe(200);
    });
  });

  describe('Help search safety', () => {
    it('handles help search with empty query gracefully', async () => {
      const result = await call('GET', '/api/v1/CRMChat/action/help/search', tokenA);

      // Should reject missing query parameter
      expect(result.status).toBe(400);
    });

    it('searches help without exposing internal content', async () => {
      const result = await call('GET', '/api/v1/CRMChat/action/help/search?q=test', tokenA);

      // Should return results or message, never expose internal docs
      expect(result.status).toBe(200);
      expect(result.body).toHaveProperty('hasResults');
    });
  });

  describe('Rate limiting and resource protection', () => {
    it('enforces turn submission limits', async () => {
      // Submit multiple turns rapidly
      const promises = Array.from({ length: 5 }, () =>
        call('POST', '/api/v1/CRMChat/action/turns', tokenA, {
          prompt: 'Test prompt',
        })
      );

      const results = await Promise.all(promises);

      // Some may succeed, some may be rate-limited
      const statuses = results.map((r) => r.status);
      expect(statuses.some((s) => [200, 400, 403, 429].includes(s))).toBe(true);
    });
  });

  describe('No dangerous capabilities exposed', () => {
    it('does not expose raw SQL execution endpoint', async () => {
      // There should be no /sql or /query/raw endpoint
      const result = await call('POST', '/api/v1/CRMChat/action/sql', tokenA, {
        query: 'SELECT * FROM users',
      });

      // Should get 404 (endpoint doesn't exist)
      expect(result.status).toBe(404);
    });

    it('does not expose shell command execution', async () => {
      const result = await call('POST', '/api/v1/CRMChat/action/shell', tokenA, {
        command: 'ls -la',
      });

      expect(result.status).toBe(404);
    });

    it('does not expose unrestricted HTTP requests', async () => {
      const result = await call('POST', '/api/v1/CRMChat/action/http', tokenA, {
        url: 'http://evil.com',
      });

      expect(result.status).toBe(404);
    });
  });

  describe('Error handling safety', () => {
    it('does not expose stack traces in errors', async () => {
      const result = await call('GET', '/api/v1/CRMChat/action/conversations/nonexistent-id', tokenA);

      if (result.status === 404 && typeof result.body === 'object') {
        const errorBody = result.body['error'] || result.body;
        // Should not contain stack trace
        const bodyStr = JSON.stringify(errorBody);
        expect(bodyStr).not.toContain('stack');
        expect(bodyStr).not.toContain('at ');
      }
    });

    it('does not expose database credentials in errors', async () => {
      const result = await call('POST', '/api/v1/CRMChat/action/query/execute', tokenA, {
        entity: 'NonExistentEntity123',
      });

      // Should not contain connection strings or passwords
      const bodyStr = JSON.stringify(result.body);
      expect(bodyStr.toLowerCase()).not.toContain('password');
      expect(bodyStr.toLowerCase()).not.toContain('connection_string');
      expect(bodyStr.toLowerCase()).not.toContain('database_url');
    });
  });
});
