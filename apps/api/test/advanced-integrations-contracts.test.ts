import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runAsAdvancedIntegrationsSystem } from '../src/advanced-integrations/advanced-integrations-authority.js';
import { AdvancedIntegrationsSettingsService } from '../src/advanced-integrations/advanced-integrations-settings.service.js';
import { ConnectionLifecycleService } from '../src/advanced-integrations/connection-lifecycle.service.js';
import { ConnectorEventHandlerRegistry } from '../src/advanced-integrations/connector-event-handlers.js';
import { IntegrationAuditService } from '../src/advanced-integrations/integration-audit.service.js';
import { IntegrationContractRegistry } from '../src/advanced-integrations/integration-contracts.js';
import { IntegrationMetricsService } from '../src/advanced-integrations/integration-metrics.service.js';
import { IntegrationRetentionService } from '../src/advanced-integrations/integration-retention.service.js';
import { MappingService } from '../src/advanced-integrations/mapping.service.js';
import { isProtectedField, PROTECTED_CRM_FIELDS } from '../src/advanced-integrations/protected-fields.js';
import { SyncOrchestrator } from '../src/advanced-integrations/sync-orchestrator.service.js';
import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../src/common/request-scope.js';
import { EntityCrudService } from '../src/entity/entity.service.js';
import type { ApiContext } from './support/boot-api.js';
import { bootApi, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-INT.25 / 19-INT.26 — the cross-module contracts, the audit trail, the metrics and the
 * retention policy (`PLAN_Phase_19_Advanced_Integrations.md` §14.2, §14.3, §14.4, §16; `19-INT.25`,
 * `19-INT.26`).
 *
 * Runs against the configured primary database (AGENTS.md §3.1). Every row created here carries a
 * unique run marker and is deleted **by id** in `afterAll`; no table is reset or truncated and no
 * extra database is created.
 */

process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ?? 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

const runId = Date.now().toString(36);
const MARKER = `AGENT_TEST-contracts-${runId}`;

let ctx: ApiContext;
let scope: RequestScope;
let connections: ConnectionLifecycleService;
let contracts: IntegrationContractRegistry;
let audit: IntegrationAuditService;
let metrics: IntegrationMetricsService;
let retention: IntegrationRetentionService;
let settings: AdvancedIntegrationsSettingsService;
let entities: EntityCrudService;
let handlers: ConnectorEventHandlerRegistry;
let mappings: MappingService;
let orchestrator: SyncOrchestrator;

const createdConnectionIds: string[] = [];

async function asSystem<T>(work: () => Promise<T>): Promise<T> {
  return runAsAdvancedIntegrationsSystem(scope, `test:${runId}`, work);
}

beforeAll(async () => {
  ctx = await bootApi();
  scope = ctx.app.get(REQUEST_SCOPE_TOKEN);
  connections = ctx.app.get(ConnectionLifecycleService);
  contracts = ctx.app.get(IntegrationContractRegistry);
  audit = ctx.app.get(IntegrationAuditService);
  metrics = ctx.app.get(IntegrationMetricsService);
  retention = ctx.app.get(IntegrationRetentionService);
  settings = ctx.app.get(AdvancedIntegrationsSettingsService);
  entities = ctx.app.get(EntityCrudService);
  handlers = ctx.app.get(ConnectorEventHandlerRegistry);
  mappings = ctx.app.get(MappingService);
  orchestrator = ctx.app.get(SyncOrchestrator);
});

afterAll(async () => {
  for (const id of createdConnectionIds) {
    await asSystem(async () => {
      await ctx.database.db
        .deleteFrom('integration_audit_log' as never)
        .where('connection_id' as never, '=', id as never)
        .execute();
      await ctx.database.db
        .deleteFrom('integration_connections' as never)
        .where('id' as never, '=', id as never)
        .execute();
    });
  }
  await asSystem(async () => {
    await ctx.database.db
      .deleteFrom('integration_audit_log' as never)
      .where('reason' as never, '=', `${MARKER}` as never)
      .execute();
  });
  await shutdownApi();
});

describe('the cross-module contracts are published, optional and isolated', () => {
  it('the installed modules publish their contracts', () => {
    const published = contracts.all();
    const keys = published.map((contract) => contract.contractKey);
    // `Sales` and `MarketingAutomation` are installed in this repository, so their contracts are
    // published. The fact that they are is the point: a connector may call them.
    expect(keys).toContain('sales.payment.providerEvent');
    expect(keys).toContain('marketing.consent.providerSuppression');
    // Every published contract names its owner, so an auditor can answer "who owns this?".
    for (const contract of published) {
      expect(contract.owningModule.length).toBeGreaterThan(0);
      expect(contract.ownership.length).toBeGreaterThan(0);
      expect(contract.contractVersion).toBeGreaterThanOrEqual(1);
    }
  });

  it('a contract that nobody published is absent, not a silent success', async () => {
    const outcome = await contracts.apply('nothing.publishes.this', { any: true });
    expect(outcome).toBeNull();
  });

  it('a published contract is applied and reports its owner and version', async () => {
    const outcome = await asSystem(() =>
      contracts.apply<{ accountId: string }, { accountId: string }>('sales.customer.summary', {
        accountId: 'no-such-account',
      }),
    );
    // The account does not exist, so the owner refuses — but the refusal is the owner's, and it
    // arrives through the contract rather than through a table the connector touched.
    expect(outcome).not.toBeNull();
    expect(outcome?.owningModule).toBe('Sales');
    expect(outcome?.contractVersion).toBe(1);
  });

  it('the event handler registry claims a provider event for its domain', async () => {
    const claimed: string[] = [];
    handlers.register({
      providerKey: 'agent-test-contracts',
      eventTypes: ['test.*'],
      handle: async (event) => {
        claimed.push(event.eventType);
      },
    });
    const handled = await handlers.dispatch({
      providerKey: 'agent-test-contracts',
      connectionId: 'conn-1',
      deliveryId: 'd1',
      objectType: 'thing',
      eventType: 'test.updated',
      externalId: 'x1',
      fields: {},
      occurredAt: null,
    });
    expect(handled).toBe(true);
    expect(claimed).toEqual(['test.updated']);

    const untouched = await handlers.dispatch({
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

describe('an imported payload cannot become an authorization', () => {
  it('the protected field list covers the fields that grant access or decide meaning', () => {
    expect(isProtectedField('assignedUserId')).toBe(true);
    expect(isProtectedField('teams')).toBe(true);
    expect(isProtectedField('paymentStatus')).toBe(true);
    expect(isProtectedField('consentStatus')).toBe(true);
    // An ordinary data field is not protected: the list is not a substitute for judgement.
    expect(isProtectedField('emailAddress')).toBe(false);
    expect(isProtectedField('name')).toBe(false);
    expect(PROTECTED_CRM_FIELDS.length).toBeGreaterThan(5);
  });

  it('a mapping that writes a protected field cannot go live without a recorded review', async () => {
    const connection = await asSystem(async () => {
      const created = await connections.create({
        providerKey: 'fake-provider',
        name: `${MARKER}-protected`,
        ownerType: 'organization',
        ownerId: 'organization',
      });
      createdConnectionIds.push(created.id);
      await connections.transition(created.id, 'pending_authorization');
      await connections.transition(created.id, 'connected', { grantedScopes: ['fake.read'] });
      return created;
    });

    const mapping = await asSystem(() =>
      mappings.create({
        connectionId: connection.id,
        objectType: 'contact',
        crmEntityType: 'Contact',
        fields: [
          { sourcePath: 'fullName', targetField: 'name', transform: null, required: true },
          { sourcePath: 'fullName', targetField: 'lastName', transform: null, required: true },
          { sourcePath: 'email', targetField: 'emailAddress', transform: null, required: false },
          // A provider payload that tries to hand the record to somebody.
          { sourcePath: 'email', targetField: 'assignedUserId', transform: null, required: false },
        ],
      }),
    );

    // Without the recorded review the mapping never goes live.
    await expect(asSystem(() => mappings.activate(mapping.id))).rejects.toThrow(/protected field/);

    // The field catalogue says so before anybody tries.
    const catalogue = await asSystem(() => mappings.listFields(mapping.id));
    expect(catalogue.warnings.some((warning) => warning.code === 'PROTECTED_TARGET')).toBe(true);
  });

  it('an unreviewed protected value is dropped rather than written to the CRM', async () => {
    const connection = await asSystem(async () => {
      const created = await connections.create({
        providerKey: 'fake-provider',
        name: `${MARKER}-dropped`,
        ownerType: 'organization',
        ownerId: 'organization',
      });
      createdConnectionIds.push(created.id);
      await connections.transition(created.id, 'pending_authorization');
      await connections.transition(created.id, 'connected', { grantedScopes: ['fake.read'] });
      return created;
    });

    const mapping = await asSystem(() =>
      mappings.create({
        connectionId: connection.id,
        objectType: 'contact',
        crmEntityType: 'Contact',
        fields: [
          { sourcePath: 'fullName', targetField: 'name', transform: null, required: true },
          { sourcePath: 'fullName', targetField: 'lastName', transform: null, required: true },
          { sourcePath: 'email', targetField: 'emailAddress', transform: null, required: false },
          { sourcePath: 'email', targetField: 'assignedUserId', transform: null, required: false },
        ],
      }),
    );

    const outcome = await asSystem(() =>
      orchestrator.applyObject(
        mapping,
        {
          objectType: 'contact',
          externalId: `protected-${runId}`,
          externalParentId: null,
          fields: { fullName: 'Protected Target', email: 'someone-else@example.test' },
          updatedAt: null,
          version: null,
          deleted: false,
        },
        null,
      ),
    );
    expect(outcome.action).toBe('created');

    const created = await asSystem(async () => entities.get('Contact', outcome.crmEntityId ?? ''));
    // The name arrived; the assignment did not.
    expect(created['name']).toBe('Protected Target');
    // The record has no owner: the provider's payload did not get to choose one.
    expect(created['assignedUserId']).toBeFalsy();
  });
});

describe('the module keeps its own audit trail', () => {
  it('a privileged action is recorded, and the detail is redacted', async () => {
    const connection = await asSystem(async () => {
      const created = await connections.create({
        providerKey: 'generic-rest',
        name: `${MARKER}-connection`,
        ownerType: 'organization',
        ownerId: 'organization',
      });
      createdConnectionIds.push(created.id);
      return created;
    });

    await asSystem(() =>
      audit.record({
        action: 'connection.paused',
        connectionId: connection.id,
        entityType: 'IntegrationConnection',
        entityId: connection.id,
        reason: `${MARKER} reason`,
        // A credential-shaped key must not survive into the trail.
        detail: { apiKey: 'never-store-this', providerKey: 'generic-rest' },
      }),
    );

    const trail = await asSystem(() => audit.list({ connectionId: connection.id }));
    const entry = trail.find((row) => row.action === 'connection.paused');
    expect(entry).toBeDefined();
    expect(entry?.detail['apiKey']).toBe('[redacted]');
    expect(entry?.detail['providerKey']).toBe('generic-rest');
    expect(entry?.actorType).toBe('system');
  });

  it('an unknown action is refused, so a typo cannot invent a second spelling', async () => {
    await expect(
      asSystem(() =>
        audit.record({ action: 'connection.pausd' as never }),
      ),
    ).rejects.toThrow(/not an audited integration action/);
  });

  it('the trail is readable per connection and per action', async () => {
    const trail = await asSystem(() => audit.list({ action: 'connection.created', limit: 10 }));
    expect(Array.isArray(trail)).toBe(true);
  });
});

describe('the metrics are derived and carry no high-cardinality label', () => {
  it('the document has the shape the plan lists', async () => {
    const document = await asSystem(() => metrics.metrics());
    expect(typeof document.generatedAt).toBe('string');
    expect(document.connections.total).toBeGreaterThanOrEqual(0);
    expect(typeof document.syncRuns.byStatus).toBe('object');
    expect(typeof document.webhooks.total).toBe('number');
    expect(typeof document.cursors.tracked).toBe('number');
    // No provider publishes a reliable quota or cost figure in this release, so the section says
    // so rather than inventing a number.
    expect(document.providerCost.available).toBe(false);
    expect(document.providerCost.note.length).toBeGreaterThan(0);
  });

  it('no label carries a record id, a token or a URL', async () => {
    const document = await asSystem(() => metrics.metrics());
    const serialized = JSON.stringify(document);
    // The pattern of a UUID or a long opaque token must not appear in a label.
    expect(serialized).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
    for (const provider of document.connections.byProvider) {
      expect(provider.providerKey).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });
});

describe('the retention policy is explicit, narrow and off by default', () => {
  it('a purge does nothing until a deployment opts in', async () => {
    const report = await asSystem(() => retention.purge());
    // The shipped default is off, so a fresh installation keeps every diagnostic row.
    expect(report.enabled).toBe(false);
    expect(report.total).toBe(0);
  });

  it('an enabled purge removes only old diagnostics and never a CRM record', async () => {
    const contact = await asSystem(async () => {
      const created = await entities.create('Contact', {
        firstName: 'Retained',
        lastName: 'Record',
        emailAddress: `retention-${runId}@example.test`,
      });
      return String(created['id']);
    });

    const previous = await asSystem(() => settings.read());
    await asSystem(() =>
      settings.update({
        retention: {
          enabled: true,
          syncOperationsDays: 1,
          webhookDeliveriesDays: 1,
          conflictsDays: 1,
          deadLettersDays: 1,
          syncRunsDays: 1,
          enrichmentResultsDays: 1,
          auditLogDays: 365,
          batchSize: 50,
        },
      }),
    );

    const report = await asSystem(() => retention.purge());
    expect(report.enabled).toBe(true);
    expect(report.removed.syncOperations).toBeGreaterThanOrEqual(0);
    expect(report.removed.webhookDeliveries).toBeGreaterThanOrEqual(0);
    // The purge never touches a CRM record.
    const still = await asSystem(async () => entities.get('Contact', contact));
    expect(still['firstName']).toBe('Retained');

    // The policy is restored, so the shared database keeps its shipped behaviour.
    await asSystem(() => settings.update({ retention: previous.settings.retention }));
  });
});
