import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { VoiceProviderRegistry } from '../src/voice-communications/index.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-OM.15 — the conditional Meta connectors stay **not implemented** (plan §4.3 gate;
 * feasibility CF-8/CF-9 verdict NO-GO at 2026-10-26).
 *
 * This suite is the enforcement of that decision, not a placeholder for a connector: Meta requires a
 * reviewed app, a published Page / professional account and granted messaging permissions, none of
 * which exist for this deployment. The test proves the system fails closed rather than pretending:
 * no adapter key resolves, the catalog offers no such channel, and the database itself refuses a
 * conversation on an unimplemented channel. No fixtures are created; nothing needs cleanup.
 */

let ctx: ApiContext;
type Body = Record<string, unknown>;

async function call(url: string): Promise<{ status: number; body: Body }> {
  const res = await ctx.app.inject({ method: 'GET', url, headers: authHeader(ctx.adminToken) });
  let body: Body = {};
  try {
    body = res.json() as Body;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body };
}

beforeAll(async () => {
  ctx = await bootApi();
}, 180_000);

afterAll(async () => {
  await shutdownApi();
});

describe('Meta connectors remain gated (19-OM.15)', () => {
  it('has no Messenger or Instagram adapter — unknown keys fail closed to disabled', () => {
    const registry = ctx.app.get(VoiceProviderRegistry, { strict: false });
    for (const key of ['messenger', 'instagram', 'meta', 'meta-messenger', 'meta-instagram']) {
      expect(registry.has(key)).toBe(false);
      expect(registry.resolve(key).info.mode).toBe('disabled');
    }
    const keys = registry.keys().join(',');
    expect(keys).not.toMatch(/messenger|instagram/i);
  });

  it('offers no Messenger/Instagram channel in the capability catalog', async () => {
    const catalog = await call('/api/v1/Omnichannel/action/channels');
    expect(catalog.status).toBe(200);
    const channels = (catalog.body['channels'] as { channel: string }[]).map((row) => row.channel);
    for (const channel of ['messenger', 'instagram']) {
      expect(channels).not.toContain(channel);
    }
  });

  it('refuses a conversation on an unimplemented channel at the storage boundary', async () => {
    for (const channel of ['messenger', 'instagram']) {
      let refused = false;
      try {
        await sql`
          insert into voice_conversations (id, account_key, channel, status)
          values (${`AGENT_TEST_OM15_${channel}`}, 'omnichannel-web-chat', ${channel}, 'open')
        `.execute(ctx.database.db);
      } catch {
        refused = true;
      }
      expect(refused, `the CHECK must refuse channel "${channel}"`).toBe(true);
    }
    // Nothing leaked from a refused insert.
    const rows = (await sql<{ n: string }>`
      select count(*)::text as n from voice_conversations where id like 'AGENT_TEST_OM15_%'
    `.execute(ctx.database.db)).rows[0];
    expect(rows?.n).toBe('0');
  });
});
