import { randomUUID } from 'node:crypto';

import { DuplicateRecordError, NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service.js';
import { AIAgentsPermissionService } from './ai-agents-permission.service.js';
import type { AIProviderUsage } from './ai-provider.js';

/**
 * Phase 19-AI.13 — pricing snapshots for the usage ledger
 * (PLAN_Phase_19_AI_Agents.md §12.1 "versioned configured price data", §20 `19-AI.13`).
 *
 * §12.1 is explicit: never hard-code rates in business logic; use versioned, admin-maintained or
 * provider-returned pricing data, and clearly label estimated costs versus authoritative provider
 * billing values. This service is the admin-maintained half:
 *
 *  - a snapshot is one (provider, model) price card in USD per million tokens; `*` covers every
 *    model of a provider until a specific row supersedes it;
 *  - an exact model match always wins over the wildcard;
 *  - `estimate()` returns `source: 'none'` when no snapshot covers the call, so a ledger row stays
 *    NULL rather than inventing a number;
 *  - every estimate carries the snapshot id it came from, so a report can trace a cost to the
 *    price card that produced it and re-estimate after a price change.
 *
 * Provider-billed (authoritative) cost does not exist in this release because no registered adapter
 * returns a billed amount; when one does, the ledger records it separately from these estimates and
 * reporting labels the two differently.
 */
export interface PricingSnapshotView {
  readonly id: string;
  readonly providerKey: string;
  readonly model: string;
  readonly currency: string;
  readonly inputPricePerMillion: number;
  readonly outputPricePerMillion: number;
  readonly cachedInputPricePerMillion: number;
  readonly validFrom: string;
  readonly createdAt: string;
}

export interface CostEstimate {
  readonly costUsd: number | null;
  /** `snapshot` is an estimate from configured price data; `none` means no price data exists. */
  readonly source: 'snapshot' | 'none';
  readonly snapshotId: string | null;
}

@Injectable()
export class AIAgentPricingService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AIAgentsPermissionService) private readonly permissions: AIAgentsPermissionService,
  ) {}

  async list(providerKey?: string): Promise<{ list: PricingSnapshotView[] }> {
    await this.permissions.assert('usage');
    let query = this.database.db.selectFrom('ai_agent_pricing_snapshots').selectAll();
    if (providerKey !== undefined && providerKey !== '') {
      query = query.where('provider_key', '=', providerKey);
    }
    const rows = await query.orderBy('provider_key', 'asc').orderBy('model', 'asc').execute();
    return { list: rows.map((row) => this.toView(row)) };
  }

  async create(input: {
    readonly providerKey: string;
    readonly model: string;
    readonly inputPricePerMillion: number;
    readonly outputPricePerMillion: number;
    readonly cachedInputPricePerMillion?: number | undefined;
    readonly currency?: string | undefined;
  }): Promise<PricingSnapshotView> {
    await this.permissions.assert('policyAdmin');
    this.assertPrices(input);
    // One card per (provider, model): re-pricing replaces the previous snapshot instead of piling
    // up rows nothing ever reads. The unique index is the real guarantee under a concurrent write.
    const existing = await this.database.db
      .selectFrom('ai_agent_pricing_snapshots')
      .select(['id'])
      .where('provider_key', '=', input.providerKey)
      .where('model', '=', input.model)
      .executeTakeFirst();
    if (existing !== undefined) {
      throw new DuplicateRecordError(
        `A pricing snapshot for "${input.providerKey}" / "${input.model}" already exists; replace it instead.`,
        { id: existing.id },
      );
    }
    const row = {
      id: randomUUID(),
      provider_key: input.providerKey,
      model: input.model,
      currency: (input.currency ?? 'USD').toUpperCase(),
      input_price_per_million: String(input.inputPricePerMillion),
      output_price_per_million: String(input.outputPricePerMillion),
      cached_input_price_per_million: String(input.cachedInputPricePerMillion ?? 0),
      valid_from: new Date(),
      created_by_user_id: null,
      created_at: new Date(),
    };
    await this.database.db.insertInto('ai_agent_pricing_snapshots').values(row).execute();
    const created = await this.database.db
      .selectFrom('ai_agent_pricing_snapshots')
      .selectAll()
      .where('id', '=', row.id)
      .executeTakeFirstOrThrow();
    return this.toView(created);
  }

  async replace(
    id: string,
    input: {
      readonly inputPricePerMillion: number;
      readonly outputPricePerMillion: number;
      readonly cachedInputPricePerMillion?: number | undefined;
    },
  ): Promise<PricingSnapshotView> {
    await this.permissions.assert('policyAdmin');
    this.assertPrices(input);
    const existing = await this.database.db
      .selectFrom('ai_agent_pricing_snapshots')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (existing === undefined) throw new NotFoundError(`Pricing snapshot "${id}" does not exist.`);
    await this.database.db
      .updateTable('ai_agent_pricing_snapshots')
      .set({
        input_price_per_million: String(input.inputPricePerMillion),
        output_price_per_million: String(input.outputPricePerMillion),
        cached_input_price_per_million: String(input.cachedInputPricePerMillion ?? 0),
        // A replacement is a new version of the price card: estimates already recorded keep their
        // snapshot-era value, and the ledger stays auditable.
        valid_from: new Date(),
      })
      .where('id', '=', id)
      .execute();
    const updated = await this.database.db
      .selectFrom('ai_agent_pricing_snapshots')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return this.toView(updated);
  }

  async remove(id: string): Promise<void> {
    await this.permissions.assert('policyAdmin');
    const result = await this.database.db
      .deleteFrom('ai_agent_pricing_snapshots')
      .where('id', '=', id)
      .executeTakeFirst();
    if (Number(result.numDeletedRows ?? 0) === 0) {
      throw new NotFoundError(`Pricing snapshot "${id}" does not exist.`);
    }
  }

  /**
   * Estimate one request's cost from the newest applicable snapshot. Exact model match wins over
   * the provider wildcard; no snapshot means `costUsd: null` and the ledger records nothing.
   * Called by the provider gateway on the ledger write path — permission-free by design (the
   * gateway already authenticated the caller; this only reads price rows).
   */
  async estimate(providerKey: string, model: string, usage: AIProviderUsage): Promise<CostEstimate> {
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    const cachedTokens = usage.cachedInputTokens ?? 0;
    if (inputTokens === 0 && outputTokens === 0) return { costUsd: null, source: 'none', snapshotId: null };
    const snapshot =
      (await this.database.db
        .selectFrom('ai_agent_pricing_snapshots')
        .selectAll()
        .where('provider_key', '=', providerKey)
        .where('model', '=', model)
        .executeTakeFirst()) ??
      (await this.database.db
        .selectFrom('ai_agent_pricing_snapshots')
        .selectAll()
        .where('provider_key', '=', providerKey)
        .where('model', '=', '*')
        .executeTakeFirst());
    if (snapshot === undefined) return { costUsd: null, source: 'none', snapshotId: null };
    // Cached input is billed at its own rate; subtract it from the input rate so a provider that
    // reports a cached subset is not double-charged at the full input price.
    const freshInput = Math.max(0, inputTokens - cachedTokens);
    const cost =
      (freshInput * Number(snapshot.input_price_per_million) +
        cachedTokens * Number(snapshot.cached_input_price_per_million) +
        outputTokens * Number(snapshot.output_price_per_million)) /
      1_000_000;
    // Rounding noise below a hundredth of a cent stays NULL rather than a misleading 0.0000.
    const rounded = Math.round(cost * 1e8) / 1e8;
    return { costUsd: rounded > 0 ? rounded : null, source: 'snapshot', snapshotId: snapshot.id };
  }

  private assertPrices(input: {
    readonly inputPricePerMillion: number;
    readonly outputPricePerMillion: number;
    readonly cachedInputPricePerMillion?: number | undefined;
  }): void {
    for (const [name, value] of Object.entries({
      inputPricePerMillion: input.inputPricePerMillion,
      outputPricePerMillion: input.outputPricePerMillion,
      cachedInputPricePerMillion: input.cachedInputPricePerMillion ?? 0,
    })) {
      if (!Number.isFinite(value) || value < 0 || value > 1_000_000) {
        throw new ValidationError(`"${name}" must be a price between 0 and 1,000,000 per million tokens.`);
      }
    }
  }

  private toView(row: {
    id: string;
    provider_key: string;
    model: string;
    currency: string;
    input_price_per_million: string;
    output_price_per_million: string;
    cached_input_price_per_million: string;
    valid_from: Date;
    created_at: Date;
  }): PricingSnapshotView {
    return {
      id: row.id,
      providerKey: row.provider_key,
      model: row.model,
      currency: row.currency,
      inputPricePerMillion: Number(row.input_price_per_million),
      outputPricePerMillion: Number(row.output_price_per_million),
      cachedInputPricePerMillion: Number(row.cached_input_price_per_million),
      validFrom: row.valid_from.toISOString(),
      createdAt: row.created_at.toISOString(),
    };
  }
}
