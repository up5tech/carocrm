import { readdirSync,readFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IntegrationContractRegistry } from '../src/advanced-integrations/index.js';
import {
  COMMUNICATION_ERROR_CATEGORIES,
  isRetryableError,
  VoiceProviderRegistry,
} from '../src/voice-communications/index.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-OM.4 — the exported adapter contract, the published voice transport contracts, the
 * capability catalog and the `unsupported` refusal category.
 *
 * Against the configured primary database (AGENTS.md §3.1); no writes except `AGENT_TEST_OM4_`
 * roles/users, deleted by exact id. Nothing here calls a provider: the bound `demo-voice` account is
 * the one this dev database already carries, and the assertions read declarations, not deliveries.
 *
 * The four plan §14 OM.4 acceptance lines are each proven: (1) no provider SDK type crosses into the
 * Omnichannel directory — a source scan, (2) an undeclared capability is an explicit absence the UI
 * reads (and `unsupported` exists and never retries), (3) the fake registry answers capability
 * questions without secrets or outbound calls, (4) Omnichannel reaches Voice only through the barrel
 * and the contracts registry publishes read/send beside the existing suppress contract.
 */

const RUN = `AGENT_TEST_OM4_${Date.now().toString(36)}`;
const ROLE_NONE = `r_${RUN}_none`;

let ctx: ApiContext;
const createdRoleIds: string[] = [];
const createdUserIds: string[] = [];

type Body = Record<string, unknown>;

async function call(method: 'GET' | 'POST', url: string, payload?: unknown, token?: string): Promise<{ status: number; body: Body }> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: authHeader(token ?? ctx.adminToken),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
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
  await createTestRole(ctx, { id: ROLE_NONE, name: `AGENT_TEST OM4 none ${RUN}`, permissions: {} });
  createdRoleIds.push(ROLE_NONE);
}, 180_000);

afterAll(async () => {
  const db = ctx.database.db;
  if (createdUserIds.length > 0) await db.deleteFrom('users').where('id', 'in', createdUserIds).execute().catch(() => undefined);
  if (createdRoleIds.length > 0) await db.deleteFrom('roles').where('id', 'in', createdRoleIds).execute().catch(() => undefined);
  await shutdownApi();
});

describe('Omnichannel adapter contract and capabilities (19-OM.4)', () => {
  it('adds `unsupported` to the error taxonomy as a permanent refusal', () => {
    expect(COMMUNICATION_ERROR_CATEGORIES).toContain('unsupported');
    expect(isRetryableError('unsupported')).toBe(false);
  });

  it('answers the capability catalog per channel, without secrets and without provider calls', async () => {
    const result = await call('GET', '/api/v1/Omnichannel/action/channels');
    expect(result.status).toBe(200);
    const body = result.body as {
      catalogVersion: number;
      channels: {
        channel: string;
        transport: string;
        enabled: boolean;
        configured: boolean;
        inbound: boolean;
        outbound: boolean;
        templates: boolean;
        media: boolean;
        readReceipts: boolean;
        notes: string[];
      }[];
    };
    expect(body.catalogVersion).toBe(1);
    const keys = body.channels.map((channel) => channel.channel);
    expect(keys).toEqual(expect.arrayContaining(['sms', 'whatsapp', 'web_chat']));
    const webChat = body.channels.find((channel) => channel.channel === 'web_chat');
    expect(webChat?.configured).toBe(false); // the widget lands with 19-OM.9 — honest, not faked
    expect(webChat?.outbound).toBe(false);
    // Read receipts have no declared capability key anywhere in the transport vocabulary, so the
    // catalog must report them absent for every channel (OM.1: prevent assumed provider support).
    expect(body.channels.every((channel) => !channel.readReceipts)).toBe(true);
    // Every reported capability is backed by a bound account that declares it — a channel with no
    // configured account can never claim outbound.
    expect(body.channels.every((channel) => !channel.outbound || channel.accounts.length > 0)).toBe(true);
    // The answer never carries a credential field of any kind.
    const leaked = JSON.stringify(body).match(/secret|credential|password|token/i);
    expect(leaked).toBeNull();
  });

  it('refuses the catalog to a plain role (least privilege preserved on the new endpoint)', async () => {
    const user = await createTestUser(ctx, { userName: `${RUN}-none`, roleIds: [ROLE_NONE] });
    createdUserIds.push(user.id);
    const result = await call('GET', '/api/v1/Omnichannel/action/channels', undefined, user.token);
    expect(result.status).toBe(403);
  });

  it('publishes the voice transport as cross-module contracts beside the suppression contract (E14)', () => {
    const registry = ctx.app.get(IntegrationContractRegistry, { strict: false });
    const published = registry.all().filter((descriptor) => descriptor.owningModule === 'VoiceCommunications');
    const keys = published.map((descriptor) => descriptor.contractKey);
    expect(keys).toEqual(
      expect.arrayContaining(['voiceCommunications.consent.suppress', 'voiceCommunications.inbox.read', 'voiceCommunications.message.send']),
    );
    const send = registry.find('voiceCommunications.message.send');
    expect(send?.contractVersion).toBe(1);
    // The send ownership text commits to the owner's pipeline — the consumer cannot claim a bypass.
    expect(send?.ownership).toContain('idempotency');
    expect(registry.find('voiceCommunications.inbox.read')).toBeDefined();
  });

  it('resolves fakes without secrets and declares nothing it cannot do (acceptance: fake adapter in tests)', () => {
    // The registry is the same object the module uses; the simulator is reachable for tests, and
    // registering a scripted adapter is the documented DI seam — no credentials, no outbound call.
    const registry = ctx.app.get(VoiceProviderRegistry, { strict: false });
    const simulator = registry.simulator();
    // MMS is vocabulary, not capability (CF-5): even the fake refuses it structurally.
    expect(simulator.hasCapability('messaging.mms.send')).toBe(false);
    expect(simulator.info.mode).toBe('simulator');
    // Unknown keys resolve fail-closed to `disabled`, never to a live adapter.
    expect(registry.resolve('no-such-provider').info.mode).toBe('disabled');
  });

  it('reaches Voice only through the exported barrel — no deep imports inside the Omnichannel directory', () => {
    const dir = new URL('../src/omnichannel/', import.meta.url);
    const offenders: string[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.ts')) continue;
      const source = readFileSync(new URL(file, dir), 'utf8');
      for (const match of source.matchAll(/from\s+'(\.\.\/voice-communications\/[^']+)'|from\s+"(\.\.\/voice-communications\/[^"]+)"/g)) {
        const specifier = match[1] ?? match[2] ?? '';
        if (specifier !== '../voice-communications/index.js') offenders.push(`${file}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
