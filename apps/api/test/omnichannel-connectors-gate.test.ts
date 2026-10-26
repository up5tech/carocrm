import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { INBOUND_MAIL_PROVIDER_TOKEN } from '../src/email/email.constants.js';
import { VoiceProviderRegistry } from '../src/voice-communications/index.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-OM.16 — optional email and Telegram connectors stay **gated** (plan §14 `19-OM.16`;
 * feasibility CF-6/CF-10; contract §15).
 *
 * Neither channel has passed its own gate:
 *  - **Email**: the shared seam exists (`packages/mail`) but the API binds `NullInboundProvider`
 *    (verified in code here), so there is no inbound provider, no mailbox and no credentials. Adding
 *    the channel requires an operator-configured provider (E13) and the pre-decided Email↔Email-to-Case
 *    non-competition rules (contract §15) — one ingestion path, honour the ServiceDesk markers, never
 *    poll a second mailbox.
 *  - **Telegram**: no adapter and no bot; the Bot API only reaches chats **with the bot** and its
 *    webhook secret travels in `X-Telegram-Bot-Api-Secret-Token`, which would be verified by a future
 *    adapter. The product decision (how customers initiate a bot chat) and operator bot credentials
 *    are missing.
 *
 * The suite proves the system does not pretend: no adapter key, no catalog row, the database refuses
 * a conversation on either channel, and the inbound email path is the null provider (so nothing in
 * Omnichannel can poll a mailbox).
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

describe('Email and Telegram connectors remain gated (19-OM.16)', () => {
  it('has no email or Telegram adapter — unknown keys fail closed', () => {
    const registry = ctx.app.get(VoiceProviderRegistry, { strict: false });
    for (const key of ['email', 'telegram', 'telegram-bot', 'imap']) {
      expect(registry.has(key)).toBe(false);
      expect(registry.resolve(key).info.mode).toBe('disabled');
    }
  });

  it('offers no email/Telegram channel in the capability catalog', async () => {
    const catalog = await call('/api/v1/Omnichannel/action/channels');
    expect(catalog.status).toBe(200);
    const channels = (catalog.body['channels'] as { channel: string }[]).map((row) => row.channel);
    expect(channels).not.toContain('email');
    expect(channels).not.toContain('telegram');
  });

  it('refuses a conversation on email or Telegram at the storage boundary', async () => {
    for (const channel of ['email', 'telegram']) {
      let refused = false;
      try {
        await sql`
          insert into voice_conversations (id, account_key, channel, status)
          values (${`AGENT_TEST_OM16_${channel}`}, 'omnichannel-web-chat', ${channel}, 'open')
        `.execute(ctx.database.db);
      } catch {
        refused = true;
      }
      expect(refused, `the CHECK must refuse channel "${channel}"`).toBe(true);
    }
    const rows = (await sql<{ n: string }>`
      select count(*)::text as n from voice_conversations where id like 'AGENT_TEST_OM16_%'
    `.execute(ctx.database.db)).rows[0];
    expect(rows?.n).toBe('0');
  });

  it('keeps one inbound email path: the shared provider binding is the null provider', () => {
    const provider = ctx.app.get(INBOUND_MAIL_PROVIDER_TOKEN, { strict: false }) as { constructor: { name: string } };
    // No inbound mailbox is configured, so no email event can enter the CRM at all — and Omnichannel
    // therefore cannot poll one (contract §15: never a second mailbox, never a competing marker).
    expect(provider.constructor.name).toBe('NullInboundProvider');
  });
});
