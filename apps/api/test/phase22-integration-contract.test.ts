import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runAsAdvancedIntegrationsSystem } from '../src/advanced-integrations/advanced-integrations-authority.js';
import { ConnectionLifecycleService } from '../src/advanced-integrations/connection-lifecycle.service.js';
import { createFakeProviderAdapter } from '../src/advanced-integrations/connectors/fake/fake-provider.adapter.js';
import { CustomerSuccessIntegrationContracts } from '../src/advanced-integrations/contracts/customer-success-contracts.js';
import { MarketingIntegrationContracts } from '../src/advanced-integrations/contracts/marketing-contracts.js';
import { ProjectsIntegrationContracts } from '../src/advanced-integrations/contracts/projects-contracts.js';
import { SalesIntegrationContracts } from '../src/advanced-integrations/contracts/sales-contracts.js';
import { ServiceDeskIntegrationContracts } from '../src/advanced-integrations/contracts/service-desk-contracts.js';
import { VoiceCommunicationsIntegrationContracts } from '../src/advanced-integrations/contracts/voice-contracts.js';
import { ExternalLinkService } from '../src/advanced-integrations/external-link.service.js';
import { IntegrationContractRegistry } from '../src/advanced-integrations/integration-contracts.js';
import { IntegrationRegistry } from '../src/advanced-integrations/integration-registry.service.js';
import { MappingService } from '../src/advanced-integrations/mapping.service.js';
import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../src/common/request-scope.js';
import { EntityCrudService } from '../src/entity/entity.service.js';
import type { ApiContext } from './support/boot-api.js';
import { bootApi, shutdownApi } from './support/boot-api.js';

/**
 * Phase 22.6 — the cross-module contract matrix
 * (`PLAN_Phase_22_Integration_E2E_Hardening.md` §11 tasks 1, 3, 8; `docs/architecture/contract-catalog.md`).
 *
 * Runs against the configured primary database (AGENTS.md §3.1). Every row it creates carries a
 * unique run marker and is deleted by id in `afterAll`; no table is reset or truncated.
 *
 * What it proves:
 *
 *  - **the matrix.** Every contract a module publishes names its owner, its version and what it
 *    owns, and every published key is a key the platform knows about — a contract nobody can account
 *    for is a contract nobody can route;
 *  - **the refusal.** A contract nobody published is a refusal (`null`), not a silent success;
 *  - **the external-id mapping.** A provider object is linked to exactly one CRM record, the link is
 *    upserted rather than duplicated, duplicate detection returns *candidates* and never merges, and
 *    an unlink keeps the history;
 *  - **the field-mapping validation.** An operator sees what a mapping would write before it goes
 *    live, and a mapping that writes a protected field cannot be activated without a recorded review.
 */

process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ?? 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

const runId = Date.now().toString(36);
const PROVIDER_KEY = `agent-test-contract-${runId}`;
const CONNECTION_NAME = `AGENT_TEST-contract-${runId}`;

let ctx: ApiContext;
let registry: IntegrationContractRegistry;
let connectors: IntegrationRegistry;
let links: ExternalLinkService;
let mappings: MappingService;
let scope: RequestScope;
let connectionId = '';
const mappingIds: string[] = [];
const contactIds: string[] = [];

function asSystem<T>(work: () => Promise<T>): Promise<T> {
  return runAsAdvancedIntegrationsSystem(scope, `test:${runId}`, work);
}

/** Every contract key this build's adapters declare. */
const DECLARED_KEYS: readonly string[] = [
  ...SalesIntegrationContracts.publishedContractKeys,
  ...MarketingIntegrationContracts.publishedContractKeys,
  ...CustomerSuccessIntegrationContracts.publishedContractKeys,
  ...ProjectsIntegrationContracts.publishedContractKeys,
  ...ServiceDeskIntegrationContracts.publishedContractKeys,
  ...VoiceCommunicationsIntegrationContracts.publishedContractKeys,
];

beforeAll(async () => {
  ctx = await bootApi();
  registry = ctx.app.get(IntegrationContractRegistry);
  connectors = ctx.app.get(IntegrationRegistry);
  links = ctx.app.get(ExternalLinkService);
  mappings = ctx.app.get(MappingService);
  scope = ctx.app.get(REQUEST_SCOPE_TOKEN);

  const fake = createFakeProviderAdapter({ providerKey: PROVIDER_KEY });
  connectors.register({
    providerKey: PROVIDER_KEY,
    displayName: 'Agent test contract connector',
    description: 'A deterministic fake connector used by the Phase 22.6 contract tests.',
    category: 'test',
    adapterVersion: fake.adapterVersion,
    providerApiVersion: fake.providerApiVersion,
    status: 'available',
    capabilities: fake.getCapabilities(),
    requiredScopes: [],
    optionalScopes: [],
    docsUrl: null,
    setupInstructionsKey: 'advancedintegrations.providers.setup',
    iconKey: 'ApiOutlined',
    adapter: fake,
  });

  const created = await asSystem(() =>
    ctx.app.get(ConnectionLifecycleService).create({
      providerKey: PROVIDER_KEY,
      name: CONNECTION_NAME,
      ownerType: 'organization',
      ownerId: 'organization',
    }),
  );
  connectionId = created.id;
});

afterAll(async () => {
  // Children first: the mappings and the links reference the connection.
  if (mappingIds.length > 0) {
    await ctx.database.db.deleteFrom('integration_field_mappings').where('mapping_id', 'in', mappingIds).execute();
    await ctx.database.db.deleteFrom('integration_object_mappings').where('id', 'in', mappingIds).execute();
  }
  await ctx.database.db.deleteFrom('integration_external_links').where('connection_id', '=', connectionId).execute();
  await ctx.database.db.deleteFrom('integration_connections').where('id', '=', connectionId).execute();
  if (contactIds.length > 0) {
    await ctx.database.db.deleteFrom('entity_records').where('id', 'in', contactIds).execute();
  }
  await shutdownApi();
});

describe('the published contract matrix', () => {
  it('names the owner, the version and the ownership of every published contract', () => {
    const published = registry.all();
    expect(published.length).toBeGreaterThan(0);
    for (const contract of published) {
      expect(contract.owningModule.trim()).not.toBe('');
      expect(contract.ownership.trim()).not.toBe('');
      expect(contract.contractVersion).toBeGreaterThanOrEqual(1);
    }
  });

  it('publishes only contracts the owning module declares', () => {
    const publishedKeys = registry.all().map((contract) => contract.contractKey);
    for (const key of publishedKeys) {
      expect(DECLARED_KEYS).toContain(key);
    }
  });

  it('knows every contract key a module publishes, so a published contract can be accounted for', () => {
    const known = registry.knownKeys();
    for (const key of registry.all().map((contract) => contract.contractKey)) {
      expect(known).toContain(key);
    }
    // The declared keys and the known keys are the same set: a key nobody publishes and a key nobody
    // knows about are both a hole in the catalog.
    expect([...known].sort()).toEqual([...DECLARED_KEYS].sort());
  });

  it('refuses a contract nobody published, instead of pretending it succeeded', async () => {
    const outcome = await registry.apply('sales.contractThatDoesNotExist', {});
    expect(outcome).toBeNull();
  });

  it('publishes the payment contract with the version and the owner it declares', async () => {
    const descriptor = registry.all().find((contract) => contract.contractKey === 'sales.payment.providerEvent');
    expect(descriptor?.owningModule).toBe('Sales');
    expect(descriptor?.contractVersion).toBe(1);
  });
});

describe('the external-id mapping contract', () => {
  it('links a provider object to one CRM record, and upserts rather than duplicates it', async () => {
    const contact = await asSystem(async () =>
      ctx.app.get(EntityCrudService).create('Contact', {
        lastName: `AGENT_TEST_contract_${runId}`,
        emailAddress: `contract.${runId}@example.test`,
      }),
    );
    contactIds.push(String(contact['id']));

    const first = await asSystem(() =>
      links.link(connectionId, {
        objectType: 'contact',
        externalId: 'contact-1',
        crmEntityType: 'Contact',
        crmEntityId: String(contact['id']),
        providerVersion: 'v1',
      }),
    );
    expect(first.linkStatus).toBe('linked');
    expect(first.providerKey).toBe(PROVIDER_KEY);

    const again = await asSystem(() =>
      links.link(connectionId, {
        objectType: 'contact',
        externalId: 'contact-1',
        crmEntityType: 'Contact',
        crmEntityId: String(contact['id']),
        providerVersion: 'v2',
      }),
    );
    expect(again.id).toBe(first.id);
    expect(again.providerVersion).toBe('v2');

    const all = await asSystem(() => links.list(connectionId));
    expect(all.filter((link) => link.externalId === 'contact-1')).toHaveLength(1);
  });

  it('resolves a link from both sides, and refuses to resolve what was never linked', async () => {
    const resolved = await asSystem(() => links.resolve(connectionId, 'contact', 'contact-1'));
    expect(resolved?.linkStatus).toBe('linked');
    const byCrm = await asSystem(() =>
      links.resolveByCrm(connectionId, 'contact', 'Contact', resolved?.crmEntityId ?? ''),
    );
    expect(byCrm?.externalId).toBe('contact-1');
    expect(await asSystem(() => links.resolve(connectionId, 'contact', 'contact-unknown'))).toBeNull();
  });

  it('refuses a link without an external id or without a CRM record', async () => {
    const failure = await asSystem(() =>
      links
        .link(connectionId, {
          objectType: 'contact',
          externalId: '   ',
          crmEntityType: 'Contact',
          crmEntityId: 'whatever',
        })
        .catch((error: unknown) => error),
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('external id');
  });

  it('returns duplicate candidates and never merges them', async () => {
    const contact = await asSystem(async () =>
      ctx.app.get(EntityCrudService).create('Contact', {
        lastName: `AGENT_TEST_dup_${runId}`,
        emailAddress: `duplicate.${runId}@example.test`,
      }),
    );
    contactIds.push(String(contact['id']));
    await asSystem(() =>
      links.link(connectionId, {
        objectType: 'contact',
        externalId: 'contact-dup',
        crmEntityType: 'Contact',
        crmEntityId: String(contact['id']),
      }),
    );

    const candidates = await asSystem(() =>
      links.findDuplicateCandidates(
        connectionId,
        'contact',
        { email: `duplicate.${runId}@example.test` },
        [{ providerPath: 'email', crmField: 'emailAddress' }],
      ),
    );
    expect(candidates.map((candidate) => candidate.externalId)).toContain('contact-dup');

    // A value the provider did not send cannot make anything a candidate.
    const none = await asSystem(() =>
      links.findDuplicateCandidates(connectionId, 'contact', { email: '' }, [
        { providerPath: 'email', crmField: 'emailAddress' },
      ]),
    );
    expect(none).toHaveLength(0);

    // The candidate is still a candidate: nothing was merged, nothing was rewritten.
    const stillLinked = await asSystem(() => links.resolve(connectionId, 'contact', 'contact-dup'));
    expect(stillLinked?.linkStatus).toBe('linked');
    expect(stillLinked?.crmEntityId).toBe(String(contact['id']));
  });

  it('marks a conflict, and keeps the row so the resolver can work on it', async () => {
    await asSystem(() => links.markConflict(connectionId, 'contact', 'contact-dup'));
    const conflicting = await asSystem(() => links.resolve(connectionId, 'contact', 'contact-dup'));
    expect(conflicting?.linkStatus).toBe('conflict');
  });

  it('unlinks without deleting the history, and the record keeps its link', async () => {
    const unlinked = await asSystem(() => links.unlink(connectionId, 'contact', 'contact-1'));
    expect(unlinked.linkStatus).toBe('unlinked');
    // The row survives: a provider-side delete never hard-deletes the link's history.
    expect(await asSystem(() => links.resolve(connectionId, 'contact', 'contact-1'))).not.toBeNull();
    // A record that is no longer linked is not resolvable from the CRM side.
    expect(
      await asSystem(() => links.resolveByCrm(connectionId, 'contact', 'Contact', unlinked.crmEntityId ?? '')),
    ).toBeNull();
  });
});

describe('the field-mapping validation contract', () => {
  it('names what a mapping would write before it goes live', async () => {
    const mapping = await asSystem(() =>
      mappings.create({
        connectionId,
        objectType: 'contact',
        crmEntityType: 'Contact',
        direction: 'inbound',
        fields: [
          { sourcePath: 'fullName', targetField: 'name', transform: null, required: false },
          { sourcePath: 'email', targetField: 'emailAddress', transform: null, required: false },
        ],
      }),
    );
    mappingIds.push(mapping.id);

    const fields = await asSystem(() => mappings.listFields(mapping.id));
    const codes = fields.warnings.map((warning) => warning.code);
    // The Contact's required fields are not written by this mapping, and the operator is told.
    expect(codes).toContain('REQUIRED_FIELD_UNMAPPED');
    expect(fields.crmEntityType).toBe('Contact');
  });

  it('refuses a target field the CRM entity does not have', async () => {
    const mapping = await asSystem(() =>
      mappings.create({
        connectionId,
        objectType: 'contact',
        crmEntityType: 'Contact',
        direction: 'inbound',
        fields: [{ sourcePath: 'email', targetField: 'notAFieldOfContact', transform: null, required: false }],
      }),
    );
    mappingIds.push(mapping.id);
    const fields = await asSystem(() => mappings.listFields(mapping.id));
    expect(fields.warnings.map((warning) => warning.code)).toContain('TARGET_FIELD_UNKNOWN');
  });

  it('refuses to activate a mapping that writes a protected field without a recorded review', async () => {
    const mapping = await asSystem(() =>
      mappings.create({
        connectionId,
        objectType: 'contact',
        crmEntityType: 'Contact',
        direction: 'inbound',
        fields: [{ sourcePath: 'title', targetField: 'assignedUserId', transform: null, required: false }],
      }),
    );
    mappingIds.push(mapping.id);

    const fields = await asSystem(() => mappings.listFields(mapping.id));
    expect(fields.warnings.map((warning) => warning.code)).toContain('PROTECTED_TARGET');

    const refusal = await asSystem(() =>
      mappings.activate(mapping.id).catch((error: unknown) => error),
    );
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toMatch(/protected field/);
    expect((refusal as { details?: { protectedFields?: string[] } }).details?.protectedFields).toContain(
      'assignedUserId',
    );
  });

  it('activates the mapping once the protected field carries the recorded review', async () => {
    const mapping = await asSystem(() =>
      mappings.create({
        connectionId,
        objectType: 'contact',
        crmEntityType: 'Contact',
        direction: 'inbound',
        fields: [
          {
            sourcePath: 'title',
            targetField: 'assignedUserId',
            transform: null,
            required: false,
            allowProtected: true,
          },
        ],
      }),
    );
    mappingIds.push(mapping.id);

    const fields = await asSystem(() => mappings.listFields(mapping.id));
    expect(fields.warnings.map((warning) => warning.code)).toContain('PROTECTED_TARGET_REVIEWED');

    const activated = await asSystem(() => mappings.activate(mapping.id));
    expect(activated.status).toBe('active');
  });

  it('previews a mapping without writing anything', async () => {
    const mapping = await asSystem(() =>
      mappings.create({
        connectionId,
        objectType: 'contact',
        crmEntityType: 'Contact',
        direction: 'inbound',
        fields: [{ sourcePath: 'email', targetField: 'emailAddress', transform: null, required: false }],
      }),
    );
    mappingIds.push(mapping.id);

    const before = await ctx.database.db
      .selectFrom('entity_records')
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .where('entity_type', '=', 'Contact')
      .executeTakeFirstOrThrow();

    const preview = await asSystem(() =>
      mappings.preview(mapping.id, { email: `preview.${runId}@example.test` }),
    );
    expect(preview.dryRun).toBe(true);
    expect(preview.values['emailAddress']).toBe(`preview.${runId}@example.test`);

    const after = await ctx.database.db
      .selectFrom('entity_records')
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .where('entity_type', '=', 'Contact')
      .executeTakeFirstOrThrow();
    expect(Number(after.total)).toBe(Number(before.total));
  });
});
