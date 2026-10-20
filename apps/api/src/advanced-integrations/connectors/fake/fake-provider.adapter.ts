import type {
  ConnectionValidationResult,
  ConnectorAdapter,
 ConnectorContext,  DeleteObjectInput,
  ExternalFieldSchema,
  ExternalMutationResult,
  ExternalObject,
  ExternalObjectSchema,
  FetchChangesInput,
  FetchChangesResult,
  FetchPageInput,
  FetchPageResult,
  UpsertObjectInput } from '../../connector-adapter.port.js';
import type { ConnectorCapabilities, ConnectorObjectCapability } from '../../provider-capabilities.js';
import { CONNECTOR_CAPABILITY_SCHEMA_VERSION } from '../../provider-capabilities.js';
import { ProviderError } from '../../provider-error.js';

/**
 * Phase 19-INT.6 — the deterministic fake provider adapter
 * (`PLAN_Phase_19_Advanced_Integrations.md` §17.2, §19-INT.6 acceptance; `19-INT.6`).
 *
 * The plan asks for *"adapter contract tests and a fake provider adapter"*, and the acceptance
 * criterion is that *"a fake connector can validate, list schemas, fetch pages and return
 * normalized errors without depending on a vendor SDK"*. This file is that fake.
 *
 * Why it exists:
 *
 *  - **Tests need a provider that cannot leak.** A test that talks to a real vendor creates real
 *    customer records and needs real credentials. This one never leaves the process.
 *  - **A generic REST connector needs a reference shape.** The generic connector maps a JSON
 *    payload onto `ExternalObject`; the fake shows what a provider looks like *after* that
 *    mapping, so the generic path can be exercised against a known-good shape.
 *  - **The contract suite needs a subject.** A conformance checker is only meaningful when a
 *    known-good connector passes it and a deliberately broken one fails it.
 *
 * Three properties are non-negotiable, because a test that is flaky is worse than no test:
 *
 *  1. **No clock.** Timestamps are derived from a fixed epoch and a mutation counter, so two runs
 *     produce byte-identical results. `Date.now()` is never called.
 *  2. **No randomness and no I/O.** No identifiers are random: a created object gets
 *     `<objectType>-<n>` with `n` continuing the seeded numbering.
 *  3. **No hidden state.** The seeded dataset is restored by `reset()`, and every call is counted,
 *     so a test can assert that a path was taken.
 *
 * Every failure is a `ProviderError`, never a bare `Error`: the adapter is the boundary, and the
 * runtime above it knows only the normalized error model.
 */

/** A provider key: lowercase letters, digits and hyphens, starting with a letter. */
const PROVIDER_KEY_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

/** The fake's default provider key. */
export const DEFAULT_FAKE_PROVIDER_KEY = 'fake-provider';

/** The provider's maximum page size. A request for more is clamped. */
export const FAKE_MAX_PAGE_SIZE = 100;

/**
 * The epoch every fake timestamp is derived from. It is a constant, never "now".
 */
const FAKE_EPOCH_MS = Date.UTC(2026, 0, 1, 0, 0, 0, 0);

/** The number of seeded contacts and deals. */
const SEEDED_CONTACT_COUNT = 7;
const SEEDED_DEAL_COUNT = 5;

/** The scopes the fake provider grants. */
const FAKE_REQUIRED_SCOPE = 'fake.read';
const FAKE_OPTIONAL_SCOPE = 'fake.write';

/** The cursor prefix of a page cursor. The value is opaque to the runtime. */
const CURSOR_PREFIX = 'off:';
/** The token prefix of a delta token. The value is opaque to the runtime. */
const DELTA_PREFIX = 'delta:';

/** One stored record. Mutable, because a write mutates it. */
interface FakeRecord {
  readonly objectType: string;
  readonly externalId: string;
  readonly externalParentId: string | null;
  fields: Record<string, unknown>;
  updatedAt: string;
  /** The record's version counter. `0` means "no version" (a tombstone). */
  version: number;
  /** The creation order. Never changes, so paging stays stable across updates. */
  readonly order: number;
  /** The change sequence. Drives the incremental feed. */
  changeSeq: number;
  readonly deleted: boolean;
}

/** How often each adapter method was called. Useful to assert that a path was taken. */
export interface FakeProviderCallCounts {
  readonly validateConnection: number;
  readonly listObjectSchemas: number;
  readonly listFields: number;
  readonly fetchPage: number;
  readonly fetchChanges: number;
  readonly upsertObject: number;
  readonly deleteObject: number;
}

export interface FakeProviderAdapterOptions {
  /** The provider key the adapter answers to. Defaults to `fake-provider`. */
  readonly providerKey?: string | undefined;
  /**
   * A capability declaration to use instead of the default one. It lets a test declare a
   * narrower connector — for example an object that cannot be created — and observe the refusal.
   */
  readonly capabilities?: ConnectorCapabilities | undefined;
}

/** The fields of the fake's `contact` object. */
const CONTACT_FIELDS: readonly ExternalFieldSchema[] = [
  { name: 'id', label: 'ID', type: 'string', required: true, unique: true, identifier: true, sensitive: false },
  { name: 'email', label: 'Email', type: 'string', required: true, unique: true, identifier: false, sensitive: false },
  { name: 'fullName', label: 'Full Name', type: 'string', required: true, unique: false, identifier: false, sensitive: false },
  { name: 'title', label: 'Title', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'phone', label: 'Phone', type: 'string', required: false, unique: false, identifier: false, sensitive: true },
  { name: 'createdAt', label: 'Created At', type: 'datetime', required: true, unique: false, identifier: false, sensitive: false },
];

/** The fields of the fake's `deal` object. */
const DEAL_FIELDS: readonly ExternalFieldSchema[] = [
  { name: 'id', label: 'ID', type: 'string', required: true, unique: true, identifier: true, sensitive: false },
  { name: 'title', label: 'Title', type: 'string', required: true, unique: false, identifier: false, sensitive: false },
  { name: 'amount', label: 'Amount', type: 'number', required: true, unique: false, identifier: false, sensitive: true },
  { name: 'contactId', label: 'Contact', type: 'foreignKey', required: true, unique: false, identifier: false, sensitive: false },
  { name: 'updatedAt', label: 'Updated At', type: 'datetime', required: true, unique: false, identifier: false, sensitive: false },
];

/** The schemas the fake provider exposes. */
const OBJECT_SCHEMAS: readonly ExternalObjectSchema[] = [
  { objectType: 'contact', label: 'Contact', fields: CONTACT_FIELDS, incremental: true, maxPageSize: FAKE_MAX_PAGE_SIZE },
  { objectType: 'deal', label: 'Deal', fields: DEAL_FIELDS, incremental: true, maxPageSize: FAKE_MAX_PAGE_SIZE },
];

/**
 * A fresh capability declaration for the fake provider.
 *
 * A **new object every call**: a caller may adjust it (to model a narrower connector) without
 * disturbing another caller's declaration.
 */
export function fakeConnectorCapabilities(): ConnectorCapabilities {
  const contact: ConnectorObjectCapability = {
    objectType: 'contact',
    label: 'Contact',
    read: true,
    create: true,
    update: true,
    delete: true,
    upsert: false,
    webhook: false,
    syncDirections: ['inbound', 'outbound'],
    fullSync: true,
    incrementalSync: true,
    requiredScopes: [FAKE_REQUIRED_SCOPE],
    optionalScopes: [FAKE_OPTIONAL_SCOPE],
    maxPageSize: FAKE_MAX_PAGE_SIZE,
    rateLimitStrategy: 'fixed_window',
    externalIdFields: ['id'],
    uniqueFields: ['id'],
    deletionVisibility: 'tombstoned',
    transactional: true,
    dataSensitivity: 'personal',
  };
  const deal: ConnectorObjectCapability = { ...contact, objectType: 'deal', label: 'Deal' };
  return {
    schemaVersion: CONNECTOR_CAPABILITY_SCHEMA_VERSION,
    authentication: 'api_key',
    objects: [contact, deal],
    webhook: { supported: false, requiresRawBody: false, requiresEndpointValidation: false },
  };
}

/**
 * The deterministic fake provider adapter.
 *
 * It implements the full read/write/delete surface of the adapter port and deliberately omits the
 * webhook and OAuth operations, because it declares none of them.
 */
export class FakeProviderAdapter implements ConnectorAdapter {
  readonly providerKey: string;
  readonly adapterVersion = '1.0.0';
  readonly providerApiVersion = '2026-01-01';
  readonly capabilities: ConnectorCapabilities;
  readonly operations: ConnectorAdapter['operations'] = {
    implementsFetch: true,
    implementsWrite: true,
    implementsDelete: true,
    implementsWebhook: false,
  };
  readonly supportsAuthorization = false;
  readonly supportsRefresh = false;
  readonly supportsRevocation = false;

  /** The live records, per object type. */
  private readonly live = new Map<string, Map<string, FakeRecord>>();
  /** The deletion tombstones, in deletion order. */
  private readonly tombstones: FakeRecord[] = [];
  /** The next identifier number, per object type. */
  private readonly idSequence = new Map<string, number>();
  /** The call counters. */
  private counts: FakeProviderCallCounts = {
    validateConnection: 0,
    listObjectSchemas: 0,
    listFields: 0,
    fetchPage: 0,
    fetchChanges: 0,
    upsertObject: 0,
    deleteObject: 0,
  };
  /** The mutation counter, which also drives the deterministic timestamps. */
  private mutationSequence = 0;
  /** The change counter, which drives the incremental feed. */
  private changeSequence = 0;
  /** The creation counter, which fixes the paging order. */
  private orderSequence = 0;

  constructor(options: FakeProviderAdapterOptions = {}) {
    const providerKey = options.providerKey ?? DEFAULT_FAKE_PROVIDER_KEY;
    if (!PROVIDER_KEY_PATTERN.test(providerKey)) {
      throw new ProviderError(
        'CONFIGURATION_INVALID',
        `The provider key "${providerKey}" is invalid. It starts with a letter and contains lowercase letters, digits or hyphens.`,
        { category: 'configuration_invalid', retryable: false, detail: 'providerKey' },
      );
    }
    this.providerKey = providerKey;
    this.capabilities = options.capabilities ?? fakeConnectorCapabilities();
    this.reset();
  }

  /** The capability declaration. The same object the registry validates. */
  getCapabilities(): ConnectorCapabilities {
    return this.capabilities;
  }

  /**
   * Check the connection with the fake's cheapest, read-only call.
   *
   * It reads the credential and nothing else: the dataset is never touched, so a validation
   * cannot change what a later sync sees.
   */
  async validateConnection(context: ConnectorContext): Promise<ConnectionValidationResult> {
    this.counts = { ...this.counts, validateConnection: this.counts.validateConnection + 1 };
    const apiKey = context.credential.apiKey;
    if (typeof apiKey !== 'string' || apiKey.trim() === '') {
      return {
        ok: false,
        code: 'CONFIGURATION_INVALID',
        message: 'The connection holds no API key.',
        accountRef: null,
        grantedScopes: [],
      };
    }
    return {
      ok: true,
      code: null,
      message: null,
      accountRef: 'fake-account',
      grantedScopes: [FAKE_REQUIRED_SCOPE, FAKE_OPTIONAL_SCOPE],
    };
  }

  /** The objects the provider exposes, in the order the declaration names them. */
  async listObjectSchemas(_context: ConnectorContext): Promise<readonly ExternalObjectSchema[]> {
    this.counts = { ...this.counts, listObjectSchemas: this.counts.listObjectSchemas + 1 };
    const declared = new Set(this.capabilities.objects.map((object) => object.objectType));
    return OBJECT_SCHEMAS.filter((schema) => declared.has(schema.objectType));
  }

  /** The fields of one object. An unknown object type is a `not_found` failure. */
  async listFields(_context: ConnectorContext, objectType: string): Promise<readonly ExternalFieldSchema[]> {
    this.counts = { ...this.counts, listFields: this.counts.listFields + 1 };
    const schema = OBJECT_SCHEMAS.find((candidate) => candidate.objectType === objectType);
    if (!schema) {
      throw new ProviderError('NOT_FOUND', `The provider offers no object type "${objectType}".`, {
        category: 'not_found',
        retryable: false,
        detail: objectType,
      });
    }
    return schema.fields;
  }

  /**
   * Enumerate one page.
   *
   * The cursor is opaque to the runtime; the fake encodes the offset as `off:<n>` and refuses
   * anything it cannot decode, because a provider that silently restarts a broken cursor hides a
   * bug rather than surfacing it.
   *
   * The `since` bound is ignored: the fake holds a fixed, ordered dataset, so a look-back window
   * has nothing to select.
   */
  async fetchPage(input: FetchPageInput): Promise<FetchPageResult> {
    this.counts = { ...this.counts, fetchPage: this.counts.fetchPage + 1 };
    const capability = this.requireCapability(input.objectType);
    if (!capability.read) {
      throw this.invalidRequest(`The provider does not allow reading "${input.objectType}".`, input.objectType);
    }
    const offset = input.cursor === null ? 0 : this.decodeToken(input.cursor, CURSOR_PREFIX, 'cursor');
    const all = this.orderedRecords(input.objectType);
    const size = this.clampPageSize(input.pageSize);
    const page = all.slice(offset, offset + size);
    const nextOffset = offset + page.length;
    return {
      objects: page.map((record) => this.toExternalObject(record)),
      nextCursor: nextOffset < all.length ? `${CURSOR_PREFIX}${String(nextOffset)}` : null,
      cursorExpired: false,
    };
  }

  /**
   * Read the incremental feed.
   *
   * The delta token is opaque like the cursor; the fake encodes the change watermark as
   * `delta:<n>`. The watermark only advances to the last change that was actually delivered, so a
   * change is never skipped because it shared a page with another change.
   */
  async fetchChanges(input: FetchChangesInput): Promise<FetchChangesResult> {
    this.counts = { ...this.counts, fetchChanges: this.counts.fetchChanges + 1 };
    const capability = this.requireCapability(input.objectType);
    if (!capability.read) {
      throw this.invalidRequest(`The provider does not allow reading "${input.objectType}".`, input.objectType);
    }
    const watermark = input.deltaToken === null ? 0 : this.decodeToken(input.deltaToken, DELTA_PREFIX, 'delta token');
    const pending = this.changeRecords(input.objectType)
      .filter((record) => record.changeSeq > watermark)
      .sort((left, right) => left.changeSeq - right.changeSeq);
    const page = pending.slice(0, this.clampPageSize(input.pageSize));
    const last = page.length > 0 ? page[page.length - 1] : undefined;
    const nextWatermark = last ? last.changeSeq : this.changeSequence;
    return {
      objects: page.map((record) => this.toExternalObject(record)),
      nextDeltaToken: `${DELTA_PREFIX}${String(nextWatermark)}`,
      cursorExpired: false,
    };
  }

  /**
   * Create or update one object.
   *
   * An update bumps the version and the deterministic timestamp; a create takes the next
   * `<objectType>-<n>` identifier, so a test can predict it. The idempotency key is accepted and
   * ignored: the fake has no duplicate-suppression problem to solve.
   */
  async upsertObject(input: UpsertObjectInput): Promise<ExternalMutationResult> {
    this.counts = { ...this.counts, upsertObject: this.counts.upsertObject + 1 };
    const capability = this.requireCapability(input.objectType);
    const bucket = this.bucket(input.objectType);
    const existing = input.externalId === null ? undefined : bucket.get(input.externalId);
    if (existing) {
      if (!capability.update) {
        throw this.invalidRequest(`The provider does not allow updating "${input.objectType}".`, input.objectType);
      }
      existing.fields = { ...existing.fields, ...input.fields, id: existing.externalId };
      existing.version += 1;
      existing.updatedAt = this.nextTimestamp();
      existing.changeSeq = (this.changeSequence += 1);
      return {
        externalId: existing.externalId,
        version: `v${String(existing.version)}`,
        updatedAt: existing.updatedAt,
        created: false,
      };
    }
    if (!capability.create) {
      throw this.invalidRequest(`The provider does not allow creating "${input.objectType}".`, input.objectType);
    }
    const externalId = input.externalId ?? `${input.objectType}-${String(this.nextId(input.objectType))}`;
    const updatedAt = this.nextTimestamp();
    const record: FakeRecord = {
      objectType: input.objectType,
      externalId,
      externalParentId: null,
      fields: { ...input.fields, id: externalId },
      updatedAt,
      version: 1,
      order: (this.orderSequence += 1),
      changeSeq: (this.changeSequence += 1),
      deleted: false,
    };
    bucket.set(externalId, record);
    return { externalId, version: 'v1', updatedAt, created: true };
  }

  /**
   * Delete one object.
   *
   * The object leaves the collection and a tombstone remains, because the declaration promises
   * `deletionVisibility: 'tombstoned'`: a sync must be able to see that the object is gone.
   */
  async deleteObject(input: DeleteObjectInput): Promise<ExternalMutationResult> {
    this.counts = { ...this.counts, deleteObject: this.counts.deleteObject + 1 };
    const capability = this.requireCapability(input.objectType);
    if (!capability.delete) {
      throw this.invalidRequest(`The provider does not allow deleting "${input.objectType}".`, input.objectType);
    }
    const bucket = this.bucket(input.objectType);
    const record = bucket.get(input.externalId);
    if (!record) {
      throw new ProviderError('NOT_FOUND', `The provider holds no "${input.objectType}" with id "${input.externalId}".`, {
        category: 'not_found',
        retryable: false,
        detail: input.externalId,
      });
    }
    bucket.delete(input.externalId);
    this.tombstones.push({
      ...record,
      fields: { ...record.fields },
      version: 0,
      updatedAt: this.nextTimestamp(),
      changeSeq: (this.changeSequence += 1),
      deleted: true,
    });
    return { externalId: input.externalId, version: null, updatedAt: null, created: false };
  }

  /**
   * Restore the seeded dataset and clear the counters.
   *
   * The whole state is rebuilt, so a test can run the same sequence twice.
   */
  reset(): void {
    this.live.clear();
    this.tombstones.length = 0;
    this.idSequence.clear();
    this.counts = {
      validateConnection: 0,
      listObjectSchemas: 0,
      listFields: 0,
      fetchPage: 0,
      fetchChanges: 0,
      upsertObject: 0,
      deleteObject: 0,
    };
    this.mutationSequence = 0;
    this.changeSequence = 0;
    this.orderSequence = 0;
    this.seed();
  }

  /** The live records of one object type, in creation order. */
  records(objectType: string): readonly ExternalObject[] {
    return this.orderedRecords(objectType).map((record) => this.toExternalObject(record));
  }

  /** The deletion tombstones of one object type, in deletion order. */
  tombstonesOf(objectType: string): readonly ExternalObject[] {
    return this.tombstones
      .filter((record) => record.objectType === objectType)
      .map((record) => this.toExternalObject(record));
  }

  /** How often each method was called since the last `reset()`. */
  get callCounts(): FakeProviderCallCounts {
    return this.counts;
  }

  // ---------------------------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------------------------

  /** The seeded dataset: seven contacts and five deals, with fixed identifiers and timestamps. */
  private seed(): void {
    for (let index = 1; index <= SEEDED_CONTACT_COUNT; index += 1) {
      const suffix = String(index);
      const externalId = `contact-${suffix}`;
      const fields: Record<string, unknown> = {
        id: externalId,
        email: `contact-${suffix}@example.test`,
        fullName: `Fake Contact ${suffix}`,
        phone: `+1-555-010${suffix}`,
        createdAt: `2025-12-${String(index).padStart(2, '0')}T09:00:00.000Z`,
      };
      if (index % 3 === 0) fields['title'] = `Fake Lead ${suffix}`;
      this.insertSeeded('contact', externalId, fields, `2025-12-${String(index).padStart(2, '0')}T09:00:00.000Z`);
    }
    this.idSequence.set('contact', SEEDED_CONTACT_COUNT + 1);

    for (let index = 1; index <= SEEDED_DEAL_COUNT; index += 1) {
      const suffix = String(index);
      const externalId = `deal-${suffix}`;
      const fields: Record<string, unknown> = {
        id: externalId,
        title: `Fake Deal ${suffix}`,
        amount: index * 1000,
        contactId: `contact-${String(((index - 1) % SEEDED_CONTACT_COUNT) + 1)}`,
        updatedAt: `2025-12-${String(index).padStart(2, '0')}T10:00:00.000Z`,
      };
      this.insertSeeded('deal', externalId, fields, `2025-12-${String(index).padStart(2, '0')}T10:00:00.000Z`);
    }
    this.idSequence.set('deal', SEEDED_DEAL_COUNT + 1);
  }

  private insertSeeded(objectType: string, externalId: string, fields: Record<string, unknown>, updatedAt: string): void {
    this.bucket(objectType).set(externalId, {
      objectType,
      externalId,
      externalParentId: null,
      fields,
      updatedAt,
      version: 1,
      order: (this.orderSequence += 1),
      changeSeq: (this.changeSequence += 1),
      deleted: false,
    });
  }

  /** The record bucket of one object type, created on demand. */
  private bucket(objectType: string): Map<string, FakeRecord> {
    const existing = this.live.get(objectType);
    if (existing) return existing;
    const created = new Map<string, FakeRecord>();
    this.live.set(objectType, created);
    return created;
  }

  /** The capability of one object type, or a `not_found` failure. */
  private requireCapability(objectType: string): ConnectorObjectCapability {
    const found = this.capabilities.objects.find((object) => object.objectType === objectType);
    if (!found) {
      throw new ProviderError('NOT_FOUND', `The provider offers no object type "${objectType}".`, {
        category: 'not_found',
        retryable: false,
        detail: objectType,
      });
    }
    return found;
  }

  /** The live records of one object type, in creation order. */
  private orderedRecords(objectType: string): readonly FakeRecord[] {
    const bucket = this.live.get(objectType);
    if (!bucket) return [];
    return [...bucket.values()].sort((left, right) => left.order - right.order);
  }

  /** Every record of one object type that the incremental feed may report, tombstones included. */
  private changeRecords(objectType: string): readonly FakeRecord[] {
    return [...this.orderedRecords(objectType), ...this.tombstones.filter((record) => record.objectType === objectType)];
  }

  /** The external shape of one record. */
  private toExternalObject(record: FakeRecord): ExternalObject {
    return {
      objectType: record.objectType,
      externalId: record.externalId,
      externalParentId: record.externalParentId,
      fields: { ...record.fields },
      updatedAt: record.updatedAt,
      version: record.version === 0 ? null : `v${String(record.version)}`,
      deleted: record.deleted,
    };
  }

  /** The next identifier number of one object type. */
  private nextId(objectType: string): number {
    const current = this.idSequence.get(objectType) ?? 1;
    this.idSequence.set(objectType, current + 1);
    return current;
  }

  /** The next deterministic timestamp: the fixed epoch plus one second per mutation. */
  private nextTimestamp(): string {
    this.mutationSequence += 1;
    return new Date(FAKE_EPOCH_MS + this.mutationSequence * 1000).toISOString();
  }

  /** The page size, clamped to what the provider publishes. */
  private clampPageSize(pageSize: number): number {
    if (!Number.isFinite(pageSize)) return 0;
    return Math.max(0, Math.min(Math.trunc(pageSize), FAKE_MAX_PAGE_SIZE));
  }

  /** Decode an opaque token, or refuse it. */
  private decodeToken(token: string, prefix: string, label: string): number {
    if (!token.startsWith(prefix)) {
      throw this.invalidRequest(`The provider refused the ${label} "${token}".`, label);
    }
    const raw = token.slice(prefix.length);
    if (!/^\d+$/.test(raw)) {
      throw this.invalidRequest(`The provider refused the ${label} "${token}".`, label);
    }
    return Number(raw);
  }

  /** The normalized error for a request the provider will not accept. */
  private invalidRequest(message: string, detail: string): ProviderError {
    return new ProviderError('INVALID_REQUEST', message, {
      category: 'permanent_validation',
      retryable: false,
      detail,
    });
  }
}

/**
 * A fake provider adapter.
 *
 * The factory exists so a caller never has to construct the class directly, and so the option
 * type stays with the implementation.
 */
export function createFakeProviderAdapter(options: FakeProviderAdapterOptions = {}): FakeProviderAdapter {
  return new FakeProviderAdapter(options);
}
