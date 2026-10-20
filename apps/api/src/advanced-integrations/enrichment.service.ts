import { randomUUID } from 'node:crypto';

import { NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'kysely';

import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import { EntityCrudService } from '../entity/entity.service.js';
import { assertConfigIsSafe } from './advanced-integrations-domain.js';
import { AdvancedIntegrationsPermissionService } from './advanced-integrations-permission.service.js';
import { CREDENTIAL_VAULT } from './connection-lifecycle.service.js';
import type { EnrichmentAdapter } from './connectors/enrichment/enrichment.port.js';
import { REST_ENRICHMENT_PROVIDER_KEY,RestEnrichmentAdapter } from './connectors/enrichment/rest-enrichment.adapter.js';
import type { CredentialVaultPort } from './credential-vault.js';
import { ProviderError } from './provider-error.js';

/**
 * Phase 19-INT.24 — the data enrichment service
 * (`PLAN_Phase_19_Advanced_Integrations.md` §12.9; `19-INT.24`).
 *
 * Enrichment is the one feature in this module where the platform **asks** somebody else about a
 * CRM record and then offers to change it. That makes the interesting questions not "how do I call
 * the provider" but "what may the provider see, what may it change, and who decides".
 *
 * The answers this service enforces:
 *
 *  1. **The provider sees only the opted-in fields.** A profile names the fields it may ask
 *     about. The request that leaves the platform carries those and nothing else.
 *  2. **A change is never automatic.** A preview produces a *pending* result. A human accepts or
 *     rejects it. There is no code path that writes an enriched value without a decision.
 *  3. **A protected field is never written.** A profile may name protected fields — a verified
 *     phone number, a legal name — and those are skipped whatever the provider answered.
 *  4. **A value the provider did not return is not invented.** A missing answer leaves the CRM
 *     value alone.
 *  5. **The provider's answer is kept with its provenance**: the old value, the new value, the
 *     provider, the retrieval time, the confidence and the decision. The plan requires all of it.
 *  6. **The spend is bounded.** A profile has a daily credit quota and a cache, so the same
 *     record is not paid for twice.
 */

export const ENRICHMENT_RESULT_STATUSES = ['pending', 'accepted', 'rejected', 'expired'] as const;
export type EnrichmentResultStatus = (typeof ENRICHMENT_RESULT_STATUSES)[number];

export interface EnrichmentProfileView {
  readonly id: string;
  readonly providerKey: string;
  readonly connectionId: string;
  readonly name: string;
  readonly entityType: string;
  readonly enabled: boolean;
  readonly allowedFields: readonly string[];
  readonly protectedFields: readonly string[];
  readonly dailyQuota: number;
  readonly costPerCredit: number;
  readonly cacheTtlSeconds: number;
  readonly createdAt: string;
  readonly modifiedAt: string;
}

export interface EnrichmentResultView {
  readonly id: string;
  readonly profileId: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly status: EnrichmentResultStatus;
  readonly beforeValues: Readonly<Record<string, unknown>>;
  readonly afterValues: Readonly<Record<string, unknown>>;
  readonly confidence: Readonly<Record<string, number>>;
  readonly providerRef: string | null;
  readonly creditsUsed: number;
  readonly cost: number;
  readonly retrievedAt: string;
  readonly decidedAt: string | null;
  readonly decidedById: string | null;
  /** The fields that would change, or that changed. */
  readonly changedFields: readonly string[];
}

export interface EnrichmentProfileInput {
  readonly providerKey: string;
  readonly connectionId: string;
  readonly name: string;
  readonly entityType: string;
  readonly allowedFields: readonly string[];
  readonly protectedFields?: readonly string[] | undefined;
  readonly dailyQuota?: number | undefined;
  readonly costPerCredit?: number | undefined;
  readonly cacheTtlSeconds?: number | undefined;
  readonly providerOptions?: Readonly<Record<string, unknown>> | undefined;
  readonly enabled?: boolean | undefined;
}

interface ProfileRow {
  id: string;
  provider_key: string;
  connection_id: string;
  name: string;
  entity_type: string;
  enabled: boolean;
  allowed_fields: unknown;
  protected_fields: unknown;
  daily_quota: number;
  cost_per_credit: string | number;
  cache_ttl_seconds: number;
  provider_options: unknown;
  created_at: Date;
  modified_at: Date;
}

interface ResultRow {
  id: string;
  profile_id: string;
  entity_type: string;
  entity_id: string;
  status: string;
  before_values: unknown;
  after_values: unknown;
  confidence: unknown;
  provider_ref: string | null;
  credits_used: number;
  cost: string | number;
  retrieved_at: Date;
  decided_at: Date | null;
  decided_by_id: string | null;
}

/** The token the registered enrichment providers are injected under. */
export const ENRICHMENT_ADAPTERS = Symbol('ENRICHMENT_ADAPTERS');

@Injectable()
export class EnrichmentService {
  /**
   * The registered providers.
   *
   * The array is held **by reference** and searched on every call, so a provider may be
   * registered after the service was constructed — which is what lets a test substitute a
   * provider that never opens a socket.
   */
  private readonly registered: readonly EnrichmentAdapter[];

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(AdvancedIntegrationsPermissionService) private readonly permissions: AdvancedIntegrationsPermissionService,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(CREDENTIAL_VAULT) private readonly vault: CredentialVaultPort,
    @Optional() @Inject(ENRICHMENT_ADAPTERS) adapters: readonly EnrichmentAdapter[] | null,
  ) {
    this.registered = adapters ?? [];
  }

  /** The provider that answers for a key, or `undefined`. */
  private findProvider(providerKey: string): EnrichmentAdapter | undefined {
    for (const adapter of this.registered) {
      if (adapter.providerKey === providerKey) return adapter;
    }
    if (providerKey === REST_ENRICHMENT_PROVIDER_KEY) return new RestEnrichmentAdapter();
    return undefined;
  }

  // -------------------------------------------------------------------------
  // profiles
  // -------------------------------------------------------------------------

  /** Every profile the caller may see. */
  async listProfiles(): Promise<readonly EnrichmentProfileView[]> {
    await this.permissions.assert('use');
    const rows = await sql<ProfileRow>`
      select * from integration_enrichment_profiles
      where deleted_at is null
      order by name asc
    `.execute(this.database.db);
    return rows.rows.map((row) => toProfileView(row));
  }

  /** One profile. */
  async getProfile(id: string): Promise<EnrichmentProfileView> {
    await this.permissions.assert('use');
    const row = await this.requireProfileRow(id);
    return toProfileView(row);
  }

  /**
   * Create a profile.
   *
   * The provider configuration is validated **before** the row is written, so a profile that
   * cannot work never exists.
   */
  async createProfile(input: EnrichmentProfileInput): Promise<EnrichmentProfileView> {
    await this.permissions.assert('connectionAdmin');
    const provider = this.findProvider(input.providerKey);
    if (provider === undefined) {
      throw new ValidationError(`Provider "${input.providerKey}" is not an enrichment provider.`, {
        providerKey: input.providerKey,
      });
    }
    const allowedFields = normalizeFieldList(input.allowedFields, 'allowedFields');
    if (allowedFields.length === 0) {
      throw new ValidationError('An enrichment profile must opt in to at least one field.');
    }
    const protectedFields = normalizeFieldList(input.protectedFields ?? [], 'protectedFields');
    const options = input.providerOptions ?? {};
    // A configuration that looks like it holds a credential is refused: the credential belongs in
    // the vault, and a profile's options are stored in plain text.
    assertConfigIsSafe({ ...options });
    // The provider validates its own configuration, so a profile that cannot work never exists.
    provider.validateOptions?.(options);

    const id = randomUUID();
    const now = new Date();
    const row = await sql<ProfileRow>`
      insert into integration_enrichment_profiles
        (id, provider_key, connection_id, name, entity_type, enabled, allowed_fields, protected_fields,
         daily_quota, cost_per_credit, cache_ttl_seconds, provider_options, created_at, modified_at,
         created_by_id, modified_by_id)
      values
        (${id}, ${input.providerKey}, ${input.connectionId}, ${input.name}, ${input.entityType},
         ${input.enabled ?? false}, ${JSON.stringify(allowedFields)}::jsonb,
         ${JSON.stringify(protectedFields)}::jsonb,
         ${input.dailyQuota ?? 0}, ${input.costPerCredit ?? 0}, ${input.cacheTtlSeconds ?? 86_400},
         ${JSON.stringify(options)}::jsonb, ${now}, ${now},
         ${this.scope.userId ?? null}, ${this.scope.userId ?? null})
      returning *
    `.execute(this.database.db);
    const created = row.rows[0];
    if (created === undefined) throw new ValidationError('The enrichment profile could not be created.');
    return toProfileView(created);
  }

  /** Change a profile's settings. */
  async updateProfile(
    id: string,
    patch: {
      readonly name?: string | undefined;
      readonly enabled?: boolean | undefined;
      readonly allowedFields?: readonly string[] | undefined;
      readonly protectedFields?: readonly string[] | undefined;
      readonly dailyQuota?: number | undefined;
      readonly costPerCredit?: number | undefined;
      readonly cacheTtlSeconds?: number | undefined;
      readonly providerOptions?: Readonly<Record<string, unknown>> | undefined;
    },
  ): Promise<EnrichmentProfileView> {
    await this.permissions.assert('connectionAdmin');
    const current = await this.requireProfileRow(id);
    if (patch.providerOptions !== undefined) {
      assertConfigIsSafe({ ...patch.providerOptions });
      const provider = this.findProvider(current.provider_key);
      provider?.validateOptions?.(patch.providerOptions);
    }
    const allowedFields =
      patch.allowedFields === undefined ? null : normalizeFieldList(patch.allowedFields, 'allowedFields');
    const protectedFields =
      patch.protectedFields === undefined ? null : normalizeFieldList(patch.protectedFields, 'protectedFields');
    if (patch.dailyQuota !== undefined && (!Number.isInteger(patch.dailyQuota) || patch.dailyQuota < 0)) {
      throw new ValidationError('The daily quota must be a non-negative whole number.');
    }
    if (patch.cacheTtlSeconds !== undefined && (!Number.isInteger(patch.cacheTtlSeconds) || patch.cacheTtlSeconds < 0)) {
      throw new ValidationError('The cache lifetime must be a non-negative whole number.');
    }
    const row = await sql<ProfileRow>`
      update integration_enrichment_profiles set
        name = coalesce(${patch.name ?? null}, name),
        enabled = coalesce(${patch.enabled ?? null}, enabled),
        allowed_fields = coalesce(${allowedFields === null ? null : JSON.stringify(allowedFields)}::jsonb, allowed_fields),
        protected_fields = coalesce(${protectedFields === null ? null : JSON.stringify(protectedFields)}::jsonb, protected_fields),
        daily_quota = coalesce(${patch.dailyQuota ?? null}, daily_quota),
        cost_per_credit = coalesce(${patch.costPerCredit ?? null}, cost_per_credit),
        cache_ttl_seconds = coalesce(${patch.cacheTtlSeconds ?? null}, cache_ttl_seconds),
        provider_options = coalesce(${patch.providerOptions === undefined ? null : JSON.stringify(patch.providerOptions)}::jsonb, provider_options),
        modified_at = now(),
        modified_by_id = ${this.scope.userId ?? null}
      where id = ${id} and deleted_at is null
      returning *
    `.execute(this.database.db);
    const updated = row.rows[0];
    if (updated === undefined) throw new NotFoundError(`The enrichment profile "${id}" does not exist.`);
    return toProfileView(updated);
  }

  /** Remove a profile. Its results are kept: they are the decision history. */
  async deleteProfile(id: string): Promise<void> {
    await this.permissions.assert('connectionAdmin');
    await sql`
      update integration_enrichment_profiles set deleted_at = now(), modified_at = now()
      where id = ${id} and deleted_at is null
    `.execute(this.database.db);
  }

  // -------------------------------------------------------------------------
  // enrichment
  // -------------------------------------------------------------------------

  /**
   * Fetch an answer for one record and hold it for a decision.
   *
   * Nothing is written to the CRM here. The result is `pending` until somebody accepts it.
   */
  async preview(input: { readonly profileId: string; readonly recordId: string }): Promise<EnrichmentResultView> {
    await this.permissions.assert('use');
    const profile = await this.requireProfileRow(input.profileId);
    if (!profile.enabled) {
      throw new ValidationError('The enrichment profile is disabled.');
    }
    const provider = this.findProvider(profile.provider_key);
    if (provider === undefined) {
      throw new ValidationError(`Provider "${profile.provider_key}" is not an enrichment provider.`);
    }
    const record = await this.entities.get(profile.entity_type, input.recordId);
    const allowedFields = parseFieldList(profile.allowed_fields);
    const fields: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (!Object.prototype.hasOwnProperty.call(record, field)) continue;
      fields[field] = record[field] ?? null;
    }

    // A cached answer is reused when the record has not changed since it was fetched.
    const cached = await this.findFreshResult(profile, input.recordId);
    if (cached !== null) {
      return cached;
    }

    await this.assertQuotaAvailable(profile);

    const apiKey = await this.vault.read({ connectionId: profile.connection_id, kind: 'api_key' });
    const outcome = await provider.enrich(
      {
        connectionId: profile.connection_id,
        credential: {
          accessToken: null,
          refreshToken: null,
          apiKey,
          clientSecret: null,
          expiresAt: null,
          webhookSecret: null,
        },
        options: parseObject(profile.provider_options),
      },
      { entityType: profile.entity_type, recordId: input.recordId, fields },
    );

    // The provider already mapped its answer onto the CRM's vocabulary, so only the fields the
    // profile opted in to are kept. A provider cannot introduce a field on its own.
    const after: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(outcome.fields)) {
      if (!allowedFields.includes(field)) continue;
      after[field] = value;
    }
    const before: Record<string, unknown> = {};
    for (const field of allowedFields) {
      before[field] = record[field] ?? null;
    }
    const confidence: Record<string, number> = {};
    for (const [field, value] of Object.entries(outcome.confidence)) {
      if (!Object.prototype.hasOwnProperty.call(after, field)) continue;
      confidence[field] = value;
    }

    const saved = await this.writeResult({
      profileId: profile.id,
      entityType: profile.entity_type,
      entityId: input.recordId,
      before,
      after,
      confidence,
      providerRef: outcome.providerRef,
      creditsUsed: outcome.creditsUsed,
      cost: outcome.creditsUsed * Number(profile.cost_per_credit),
      status: 'pending',
    });
    return saved;
  }

  /**
   * Accept a pending result and write the accepted values to the CRM.
   *
   * Three rules apply at the moment of the write:
   *
   *  - a field the profile did not opt in to is not written;
   *  - a protected field is not written, whatever the provider answered;
   *  - a field the provider did not answer is not written, and the old value stays.
   */
  async accept(resultId: string): Promise<EnrichmentResultView> {
    await this.permissions.assert('use');
    const row = await this.requireResultRow(resultId);
    if (row.status !== 'pending') {
      throw new ValidationError(`The enrichment result is "${row.status}" and cannot be accepted.`);
    }
    const profile = await this.requireProfileRow(row.profile_id);
    const allowed = new Set(parseFieldList(profile.allowed_fields));
    const protectedFields = new Set(parseFieldList(profile.protected_fields));
    const after = parseObject(row.after_values);
    const payload: Record<string, unknown> = {};
    const skipped: string[] = [];
    for (const [field, value] of Object.entries(after)) {
      if (!allowed.has(field)) {
        skipped.push(field);
        continue;
      }
      if (protectedFields.has(field)) {
        skipped.push(field);
        continue;
      }
      if (value === null || value === undefined) continue;
      payload[field] = value;
    }
    if (Object.keys(payload).length > 0) {
      await this.entities.update(row.entity_type, row.entity_id, payload);
    }
    const updated = await sql<ResultRow>`
      update integration_enrichment_results set
        status = 'accepted', decided_at = now(), decided_by_id = ${this.scope.userId ?? null}
      where id = ${resultId}
      returning *
    `.execute(this.database.db);
    const saved = updated.rows[0];
    if (saved === undefined) throw new NotFoundError(`The enrichment result "${resultId}" does not exist.`);
    const view = toResultView(saved);
    return { ...view, changedFields: view.changedFields.filter((field) => !skipped.includes(field)) };
  }

  /** Reject a pending result. Nothing is written to the CRM. */
  async reject(resultId: string): Promise<EnrichmentResultView> {
    await this.permissions.assert('use');
    const row = await this.requireResultRow(resultId);
    if (row.status !== 'pending') {
      throw new ValidationError(`The enrichment result is "${row.status}" and cannot be rejected.`);
    }
    const updated = await sql<ResultRow>`
      update integration_enrichment_results set
        status = 'rejected', decided_at = now(), decided_by_id = ${this.scope.userId ?? null}
      where id = ${resultId}
      returning *
    `.execute(this.database.db);
    const saved = updated.rows[0];
    if (saved === undefined) throw new NotFoundError(`The enrichment result "${resultId}" does not exist.`);
    return toResultView(saved);
  }

  /** The results of a profile, newest first. */
  async listResults(profileId: string, limit = 50): Promise<readonly EnrichmentResultView[]> {
    await this.permissions.assert('use');
    const rows = await sql<ResultRow>`
      select * from integration_enrichment_results
      where profile_id = ${profileId}
      order by retrieved_at desc
      limit ${limit}
    `.execute(this.database.db);
    return rows.rows.map((row) => toResultView(row));
  }

  /** What a profile has spent today, in credits. */
  async usageToday(profileId: string): Promise<{ readonly credits: number; readonly cost: number; readonly quota: number }> {
    await this.permissions.assert('use');
    const rows = await sql<{ credits: string | number; cost: string | number }>`
      select coalesce(sum(credits_used), 0) as credits, coalesce(sum(cost), 0) as cost
      from integration_enrichment_results
      where profile_id = ${profileId}
        and retrieved_at >= date_trunc('day', now())
    `.execute(this.database.db);
    const row = rows.rows[0];
    const profile = await this.requireProfileRow(profileId);
    return {
      credits: Number(row?.credits ?? 0),
      cost: Number(row?.cost ?? 0),
      quota: profile.daily_quota,
    };
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /** Refuse a call that would exceed the profile's daily quota. */
  private async assertQuotaAvailable(profile: ProfileRow): Promise<void> {
    if (profile.daily_quota <= 0) return;
    const usage = await this.usageToday(profile.id);
    if (usage.credits >= profile.daily_quota) {
      throw new ProviderError(
        'RATE_LIMITED',
        `The profile reached its daily quota of ${String(profile.daily_quota)} credits.`,
        { category: 'rate_limited', retryable: false, detail: 'daily_quota' },
      );
    }
  }

  /**
   * A fresh result for the same record, when the record has not changed since it was fetched.
   *
   * The comparison is against the *before* values, so a record somebody edited in the meantime is
   * fetched again rather than enriched from a stale answer.
   */
  private async findFreshResult(profile: ProfileRow, recordId: string): Promise<EnrichmentResultView | null> {
    if (profile.cache_ttl_seconds <= 0) return null;
    const rows = await sql<ResultRow>`
      select * from integration_enrichment_results
      where profile_id = ${profile.id} and entity_type = ${profile.entity_type} and entity_id = ${recordId}
      order by retrieved_at desc
      limit 1
    `.execute(this.database.db);
    const row = rows.rows[0];
    if (row === undefined) return null;
    const ageMs = Date.now() - row.retrieved_at.getTime();
    if (ageMs > profile.cache_ttl_seconds * 1000) return null;
    const record = await this.entities.get(profile.entity_type, recordId);
    const before = parseObject(row.before_values);
    for (const [field, value] of Object.entries(before)) {
      if ((record[field] ?? null) !== value) return null;
    }
    return toResultView(row);
  }

  /** Write a result, replacing the pending one for the same record. */
  private async writeResult(input: {
    readonly profileId: string;
    readonly entityType: string;
    readonly entityId: string;
    readonly before: Record<string, unknown>;
    readonly after: Record<string, unknown>;
    readonly confidence: Record<string, number>;
    readonly providerRef: string | null;
    readonly creditsUsed: number;
    readonly cost: number;
    readonly status: EnrichmentResultStatus;
  }): Promise<EnrichmentResultView> {
    const row = await sql<ResultRow>`
      insert into integration_enrichment_results
        (id, profile_id, entity_type, entity_id, status, before_values, after_values, confidence,
         provider_ref, credits_used, cost, retrieved_at, created_at)
      values
        (${randomUUID()}, ${input.profileId}, ${input.entityType}, ${input.entityId}, ${input.status},
         ${JSON.stringify(input.before)}::jsonb, ${JSON.stringify(input.after)}::jsonb,
         ${JSON.stringify(input.confidence)}::jsonb, ${input.providerRef},
         ${input.creditsUsed}, ${input.cost}, now(), now())
      on conflict (profile_id, entity_type, entity_id) where status = 'pending'
      do update set
        before_values = excluded.before_values,
        after_values = excluded.after_values,
        confidence = excluded.confidence,
        provider_ref = excluded.provider_ref,
        credits_used = excluded.credits_used,
        cost = excluded.cost,
        retrieved_at = now()
      returning *
    `.execute(this.database.db);
    const saved = row.rows[0];
    if (saved === undefined) throw new ValidationError('The enrichment result could not be written.');
    return toResultView(saved);
  }

  private async requireProfileRow(id: string): Promise<ProfileRow> {
    const rows = await sql<ProfileRow>`
      select * from integration_enrichment_profiles where id = ${id} and deleted_at is null limit 1
    `.execute(this.database.db);
    const row = rows.rows[0];
    if (row === undefined) throw new NotFoundError(`The enrichment profile "${id}" does not exist.`);
    return row;
  }

  private async requireResultRow(id: string): Promise<ResultRow> {
    const rows = await sql<ResultRow>`
      select * from integration_enrichment_results where id = ${id} limit 1
    `.execute(this.database.db);
    const row = rows.rows[0];
    if (row === undefined) throw new NotFoundError(`The enrichment result "${id}" does not exist.`);
    return row;
  }
}

/** The profile, as a view. */
function toProfileView(row: ProfileRow): EnrichmentProfileView {
  return {
    id: row.id,
    providerKey: row.provider_key,
    connectionId: row.connection_id,
    name: row.name,
    entityType: row.entity_type,
    enabled: row.enabled,
    allowedFields: parseFieldList(row.allowed_fields),
    protectedFields: parseFieldList(row.protected_fields),
    dailyQuota: row.daily_quota,
    costPerCredit: Number(row.cost_per_credit),
    cacheTtlSeconds: row.cache_ttl_seconds,
    createdAt: row.created_at.toISOString(),
    modifiedAt: row.modified_at.toISOString(),
  };
}

/** The result, as a view. */
function toResultView(row: ResultRow): EnrichmentResultView {
  const before = parseObject(row.before_values);
  const after = parseObject(row.after_values);
  const changed = Object.keys(after).filter((field) => before[field] !== after[field]);
  return {
    id: row.id,
    profileId: row.profile_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    status: row.status as EnrichmentResultStatus,
    beforeValues: before,
    afterValues: after,
    confidence: parseNumberMap(row.confidence),
    providerRef: row.provider_ref,
    creditsUsed: row.credits_used,
    cost: Number(row.cost),
    retrievedAt: row.retrieved_at.toISOString(),
    decidedAt: row.decided_at === null ? null : row.decided_at.toISOString(),
    decidedById: row.decided_by_id,
    changedFields: changed,
  };
}

/** A field list from a JSON column. */
function parseFieldList(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === 'string');
}

/** A JSON object from a JSON column. */
function parseObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

/** A number map from a JSON column. */
function parseNumberMap(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(parseObject(raw))) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/** Normalize and validate a field list. */
function normalizeFieldList(fields: readonly string[], name: string): readonly string[] {
  const out: string[] = [];
  for (const field of fields) {
    const trimmed = field.trim();
    if (trimmed === '') continue;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(trimmed)) {
      throw new ValidationError(`"${trimmed}" is not a usable field name.`, { field: trimmed });
    }
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  if (name === 'allowedFields' && out.length === 0) {
    throw new ValidationError('An enrichment profile must opt in to at least one field.');
  }
  return out;
}
