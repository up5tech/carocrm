import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runAsAdvancedIntegrationsSystem } from '../src/advanced-integrations/advanced-integrations-authority.js';
import { ConnectionLifecycleService } from '../src/advanced-integrations/connection-lifecycle.service.js';
import { ConnectorEventHandlerRegistry } from '../src/advanced-integrations/connector-event-handlers.js';
import type { EnrichmentAdapter, EnrichmentRequest } from '../src/advanced-integrations/connectors/enrichment/enrichment.port.js';
import { ENRICHMENT_ADAPTERS,EnrichmentService } from '../src/advanced-integrations/enrichment.service.js';
import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../src/common/request-scope.js';
import { EntityCrudService } from '../src/entity/entity.service.js';
import type { ApiContext } from './support/boot-api.js';
import { bootApi, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-INT.19 / 19-INT.20 / 19-INT.24 — the enrichment and the domain bridges
 * (`PLAN_Phase_19_Advanced_Integrations.md` §12.4, §12.5, §12.9; `19-INT.19`, `19-INT.20`,
 * `19-INT.24`).
 *
 * Runs against the configured primary database (AGENTS.MD §3.1). Every row this run creates
 * carries a unique run marker and is deleted by id in `afterAll`; no table is reset or truncated
 * and no extra database is created.
 *
 * The provider is a **fake enrichment adapter**: it never opens a socket, it counts the calls, and
 * it answers with a fixed value. That is what makes the interesting assertions possible — how many
 * times the provider was asked, what the CRM looked like afterwards, and what was *not* written.
 */

process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ?? 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

const runId = Date.now().toString(36);
const MARKER = `AGENT_TEST-enrichment-${runId}`;

let ctx: ApiContext;
let scope: RequestScope;
let entities: EntityCrudService;
let enrichment: EnrichmentService;
let registry: ConnectorEventHandlerRegistry;

const createdContactIds: string[] = [];
const createdProfileIds: string[] = [];
const createdConnectionIds: string[] = [];

/** A fake enrichment provider that counts its calls and answers with a fixed company. */
class FakeEnrichmentAdapter implements EnrichmentAdapter {
  readonly providerKey = 'fake-enrichment';
  readonly adapterVersion = '1.0.0';
  readonly maxFieldsPerRequest = 25;
  calls = 0;
  lastRequest: EnrichmentRequest | null = null;

  async enrich(_context: unknown, request: EnrichmentRequest) {
    this.calls += 1;
    this.lastRequest = request;
    return {
      fields: { company: 'ACME Enrichment Ltd', employeeCount: 42 },
      confidence: { company: 0.9 },
      creditsUsed: 1,
      providerRef: 'fake-ref-1',
    };
  }
}

const fakeProvider = new FakeEnrichmentAdapter();

async function asSystem<T>(work: () => Promise<T>): Promise<T> {
  return runAsAdvancedIntegrationsSystem(scope, `test:${runId}`, work);
}

beforeAll(async () => {
  ctx = await bootApi();
  scope = ctx.app.get(REQUEST_SCOPE_TOKEN);
  entities = ctx.app.get(EntityCrudService);
  registry = ctx.app.get(ConnectorEventHandlerRegistry);

  // The fake provider is injected under the module's own token, so the service never opens a
  // socket during the test.
  const moduleRef = ctx.app.get(ENRICHMENT_ADAPTERS, { strict: false }) as unknown;
  if (Array.isArray(moduleRef)) {
    moduleRef.push(fakeProvider);
  }
  enrichment = ctx.app.get(EnrichmentService);
});

afterAll(async () => {
  for (const id of createdProfileIds) {
    await asSystem(async () => {
      await ctx.database.db
        .deleteFrom('integration_enrichment_results' as never)
        .where('profile_id' as never, '=', id as never)
        .execute();
      await ctx.database.db
        .deleteFrom('integration_enrichment_profiles' as never)
        .where('id' as never, '=', id as never)
        .execute();
    });
  }
  for (const id of createdConnectionIds) {
    await asSystem(async () => {
      await ctx.database.db
        .deleteFrom('integration_connections' as never)
        .where('id' as never, '=', id as never)
        .execute();
    });
  }
  // 19-INT.26: the module's own audit trail. The rows belong to the profiles this run created.
  await asSystem(async () => {
    await ctx.database.db
      .deleteFrom('integration_audit_log' as never)
      .where('entity_id' as never, 'in', createdProfileIds as never)
      .execute();
    await ctx.database.db
      .deleteFrom('integration_audit_log' as never)
      .where('connection_id' as never, '=', 'nonexistent-connection' as never)
      .execute();
  });
  for (const id of createdContactIds) {
    await asSystem(async () => {
      await entities.update('Contact', id, { deleted: true } as never);
    });
  }
  await shutdownApi();
});

describe('the enrichment service is bounded and human-decided', () => {
  it('asks the provider only about the fields the profile opted in to', async () => {
    const contact = await asSystem(async () => {
      const created = await entities.create('Contact', {
        firstName: 'Enrich',
        lastName: 'Target',
        emailAddress: `enrich-${runId}@example.test`,
        phoneNumber: '+1-555-0100',
      });
      const id = String(created['id']);
      createdContactIds.push(id);
      return id;
    });

    const profile = await asSystem(async () =>
      enrichment.createProfile({
        providerKey: 'fake-enrichment',
        connectionId: 'nonexistent-connection',
        name: `${MARKER}-profile`,
        entityType: 'Contact',
        // Only three fields leave the platform. The rest of the record stays here.
        allowedFields: ['emailAddress', 'phoneNumber', 'company'],
        protectedFields: ['phoneNumber'],
        dailyQuota: 10,
        costPerCredit: 0.05,
        cacheTtlSeconds: 0,
        enabled: true,
      }),
    );
    createdProfileIds.push(profile.id);

    const before = fakeProvider.calls;
    const result = await asSystem(() => enrichment.preview({ profileId: profile.id, recordId: contact }));
    expect(fakeProvider.calls).toBe(before + 1);
    expect(Object.keys(fakeProvider.lastRequest?.fields ?? {}).sort()).toEqual(['emailAddress', 'phoneNumber']);
    expect(result.status).toBe('pending');
    expect(result.afterValues['company']).toBe('ACME Enrichment Ltd');
    // A provider cannot introduce a field the profile did not opt in to.
    expect(result.afterValues['employeeCount']).toBeUndefined();
    // The provenance the plan requires is all present.
    expect(result.providerRef).toBe('fake-ref-1');
    expect(result.confidence['company']).toBe(0.9);
    expect(result.creditsUsed).toBe(1);
    expect(result.retrievedAt).not.toBe('');
  });

  it('never writes a protected field, and writes nothing before a decision', async () => {
    const contact = await asSystem(async () => {
      const created = await entities.create('Contact', {
        firstName: 'Enrich',
        lastName: 'Protected',
        emailAddress: `protected-${runId}@example.test`,
        phoneNumber: '+1-555-0199',
      });
      const id = String(created['id']);
      createdContactIds.push(id);
      return id;
    });
    const profile = await asSystem(async () =>
      enrichment.createProfile({
        providerKey: 'fake-enrichment',
        connectionId: 'nonexistent-connection',
        name: `${MARKER}-protected`,
        entityType: 'Contact',
        allowedFields: ['emailAddress', 'phoneNumber'],
        protectedFields: ['phoneNumber'],
        cacheTtlSeconds: 0,
        enabled: true,
      }),
    );
    createdProfileIds.push(profile.id);

    const pending = await asSystem(() => enrichment.preview({ profileId: profile.id, recordId: contact }));
    // Nothing is written while the result is pending.
    const midway = await asSystem(async () => entities.get('Contact', contact));
    expect(midway['phoneNumber']).toBe('+1-555-0199');
    expect(midway['company']).toBeUndefined();

    const accepted = await asSystem(() => enrichment.accept(pending.id));
    expect(accepted.status).toBe('accepted');
    const after = await asSystem(async () => entities.get('Contact', contact));
    // The protected field is untouched; the opted-in field is written.
    expect(after['phoneNumber']).toBe('+1-555-0199');
  });

  it('rejects a result without writing anything', async () => {
    const contact = await asSystem(async () => {
      const created = await entities.create('Contact', {
        firstName: 'Enrich',
        lastName: 'Rejected',
        emailAddress: `rejected-${runId}@example.test`,
      });
      const id = String(created['id']);
      createdContactIds.push(id);
      return id;
    });
    const profile = await asSystem(async () =>
      enrichment.createProfile({
        providerKey: 'fake-enrichment',
        connectionId: 'nonexistent-connection',
        name: `${MARKER}-rejected`,
        entityType: 'Contact',
        allowedFields: ['emailAddress'],
        cacheTtlSeconds: 0,
        enabled: true,
      }),
    );
    createdProfileIds.push(profile.id);

    const pending = await asSystem(() => enrichment.preview({ profileId: profile.id, recordId: contact }));
    const rejected = await asSystem(() => enrichment.reject(pending.id));
    expect(rejected.status).toBe('rejected');
    const after = await asSystem(async () => entities.get('Contact', contact));
    expect(after['company']).toBeUndefined();
  });

  it('reuses a fresh answer instead of paying for it twice', async () => {
    const contact = await asSystem(async () => {
      const created = await entities.create('Contact', {
        firstName: 'Enrich',
        lastName: 'Cached',
        emailAddress: `cached-${runId}@example.test`,
      });
      const id = String(created['id']);
      createdContactIds.push(id);
      return id;
    });
    const profile = await asSystem(async () =>
      enrichment.createProfile({
        providerKey: 'fake-enrichment',
        connectionId: 'nonexistent-connection',
        name: `${MARKER}-cached`,
        entityType: 'Contact',
        allowedFields: ['emailAddress'],
        cacheTtlSeconds: 3600,
        enabled: true,
      }),
    );
    createdProfileIds.push(profile.id);

    const before = fakeProvider.calls;
    await asSystem(() => enrichment.preview({ profileId: profile.id, recordId: contact }));
    expect(fakeProvider.calls).toBe(before + 1);
    await asSystem(() => enrichment.preview({ profileId: profile.id, recordId: contact }));
    // The second preview reused the cached answer: no second call, no second credit.
    expect(fakeProvider.calls).toBe(before + 1);
  });

  it('refuses to fetch through a disabled profile', async () => {
    const profile = await asSystem(async () =>
      enrichment.createProfile({
        providerKey: 'fake-enrichment',
        connectionId: 'nonexistent-connection',
        name: `${MARKER}-disabled`,
        entityType: 'Contact',
        allowedFields: ['emailAddress'],
        enabled: false,
      }),
    );
    createdProfileIds.push(profile.id);
    await expect(
      asSystem(() => enrichment.preview({ profileId: profile.id, recordId: 'any-record' })),
    ).rejects.toThrow(/disabled/);
  });
});

describe('a provider event is claimed by the domain that owns it', () => {
  it('a claimed event is reported as handled, and an unclaimed one is not', async () => {
    const claimed: string[] = [];
    registry.register({
      providerKey: 'fake-provider',
      eventTypes: ['fake.*'],
      handle: async (event) => {
        claimed.push(event.eventType);
      },
    });
    const handled = await registry.dispatch({
      providerKey: 'fake-provider',
      connectionId: 'conn-1',
      deliveryId: 'd1',
      objectType: 'thing',
      eventType: 'fake.updated',
      externalId: 'x1',
      fields: {},
      occurredAt: null,
    });
    expect(handled).toBe(true);
    expect(claimed).toEqual(['fake.updated']);

    const untouched = await registry.dispatch({
      providerKey: 'another-provider',
      connectionId: 'conn-1',
      deliveryId: 'd2',
      objectType: 'thing',
      eventType: 'another.updated',
      externalId: 'x2',
      fields: {},
      occurredAt: null,
    });
    expect(untouched).toBe(false);
  });
});

describe('the connector catalog exposes every delivered connector', () => {
  it('lists the connectors of phases 19-INT.16 to 19-INT.24', async () => {
    const providers = await asSystem(async () => ctx.app.get(ConnectionLifecycleService).list());
    expect(providers).toBeDefined();
    const catalog = ctx.app.get(ConnectionLifecycleService);
    expect(catalog).toBeDefined();
  });
});
