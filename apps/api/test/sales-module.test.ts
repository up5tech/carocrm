import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SalesNumberingService } from '../src/sales/document/numbering.service.js';
import type { ApiContext } from './support/boot-api.js';
import { bootApi, createTestUser, shutdownApi } from './support/boot-api.js';
import type { SalesFixture } from './support/sales-fixtures.js';
import { salesFixture } from './support/sales-fixtures.js';

/**
 * Phase 19-S.1 / 19-S.2 — module registration, health, settings and document numbering.
 *
 * Runs against the configured primary database (AGENTS.md §3.1) through the real HTTP API and the
 * registered providers; no test database is created and every row the suite writes is removed by its
 * own id/code in `cleanup()`.
 */

let ctx: ApiContext;
let fix: SalesFixture;
let previousSettings: string | null = null;

beforeAll(async () => {
  ctx = await bootApi();
  fix = await salesFixture(ctx);
  const row = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', 'sales').executeTakeFirst();
  previousSettings = row === undefined ? null : JSON.stringify(row.data);
}, 120_000);

afterAll(async () => {
  // Restore the settings row exactly as it was: these suites must not leave altered global policy.
  if (previousSettings === null) {
    await ctx.database.db.deleteFrom('app_settings').where('name', '=', 'sales').execute().catch(() => undefined);
  } else {
    await ctx.database.db
      .updateTable('app_settings')
      .set({ data: JSON.parse(previousSettings) as Record<string, unknown>, modified_at: new Date() })
      .where('name', '=', 'sales')
      .execute()
      .catch(() => undefined);
  }
  await fix.cleanup();
  await shutdownApi();
}, 120_000);

describe('module registration and health (19-S.1)', () => {
  it('reports the module, its required dependencies and its optional integrations', async () => {
    const result = await fix.call('GET', '/api/v1/Sales/action/health');
    expect(result.status).toBe(200);
    const body = result.body as {
      module: { id: string; version: string; apiPrefix: string };
      ok: boolean;
      dependencies: { id: string; present: boolean }[];
      optionalIntegrations: { id: string; present: boolean; status: string }[];
      features: { key: string; enabled: boolean }[];
      checks: { name: string; ok: boolean }[];
    };
    expect(body.module.id).toBe('sales');
    expect(body.module.apiPrefix).toBe('/api/v1/Sales');
    expect(body.module.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(body.ok).toBe(true);
    // Every required kernel capability is a fact the health check verifies, not a claim.
    expect(body.dependencies.every((dependency) => dependency.present)).toBe(true);
    expect(body.dependencies.map((dependency) => dependency.id)).toContain('entity-engine');
    // Optional modules are absent and reported as such — the boot itself proves absence is survivable.
    const optional = new Map(body.optionalIntegrations.map((integration) => [integration.id, integration]));
    expect(optional.get('stripe-integration')?.status).toBe('unavailable');
    expect(optional.get('accounting-integration')?.status).toBe('unavailable');
    expect(optional.get('customer-success')?.status).toBe('unavailable');
    expect(optional.get('stripe-integration')?.present).toBe(false);
    expect(body.features.some((feature) => feature.key === 'priceBooks' && feature.enabled)).toBe(true);
    const entityCheck = body.checks.find((check) => check.name === 'entity-metadata');
    expect(entityCheck?.ok).toBe(true);
    expect(body.checks.find((check) => check.name === 'numbering')?.ok).toBe(true);
  });

  it('refuses module diagnostics to a non-administrator', async () => {
    const user = await createTestUser(ctx, { userName: `sales-reader-${fix.runId}`, roleIds: ['noAccess'] });
    try {
      const result = await fix.call('GET', '/api/v1/Sales/action/health', undefined, user.token);
      expect(result.status).toBe(403);
    } finally {
      await ctx.database.db.deleteFrom('users').where('id', '=', user.id).execute().catch(() => undefined);
    }
  });

  it('serves the module prefix instead of treating it as an entity', async () => {
    // `/api/v1/Sales/action/settings` must not fall through to the generic `:entity` wildcard.
    const result = await fix.call('GET', '/api/v1/Sales/action/settings');
    expect(result.status).toBe(200);
    expect(result.body['settings']).toBeDefined();
  });
});

describe('Sales settings (19-S.2)', () => {
  it('returns validated defaults with a version and no warnings', async () => {
    const result = await fix.call('GET', '/api/v1/Sales/action/settings');
    expect(result.status).toBe(200);
    const settings = result.body['settings'] as Record<string, unknown>;
    expect((settings['currency'] as { defaultCurrency: string }).defaultCurrency).toBe('USD');
    expect((settings['tax'] as { missingTaxPolicy: string }).missingTaxPolicy).toBe('error');
    expect((settings['pricing'] as { resolution: string }).resolution).toBe('priceBookFirst');
    expect(result.body['warnings']).toEqual([]);
  });

  it('refuses an unknown policy name and an unsupported currency', async () => {
    const unknown = await fix.call('POST', '/api/v1/Sales/action/settings', { pricing: { resolution: 'cheapest' } });
    expect(unknown.status).toBe(422);
    const currency = await fix.call('POST', '/api/v1/Sales/action/settings', { currency: { defaultCurrency: 'ZZZ' } });
    expect(currency.status).toBe(422);
  });

  it('refuses settings changes to a non-administrator', async () => {
    const user = await createTestUser(ctx, { userName: `sales-writer-${fix.runId}`, roleIds: ['noAccess'] });
    try {
      const result = await fix.call('POST', '/api/v1/Sales/action/settings', { quantityPrecision: 4 }, user.token);
      expect(result.status).toBe(403);
    } finally {
      await ctx.database.db.deleteFrom('users').where('id', '=', user.id).execute().catch(() => undefined);
    }
  });

  it('accepts a valid patch, bumps the version and warns about a disabled price source', async () => {
    const before = await fix.call('GET', '/api/v1/Sales/action/settings');
    const beforeVersion = Number(before.body['version'] ?? 0);
    const result = await fix.call('POST', '/api/v1/Sales/action/settings', {
      features: { productPrices: false, priceBooks: false },
      tax: { roundingStage: 'document' },
      quantityPrecision: 3,
    });
    expect(result.status).toBe(200);
    expect(Number(result.body['version'])).toBe(beforeVersion + 1);
    const warnings = result.body['warnings'] as { code: string }[];
    expect(warnings.map((warning) => warning.code)).toContain('noPriceSource');
    const settings = result.body['settings'] as Record<string, unknown>;
    expect((settings['tax'] as { roundingStage: string }).roundingStage).toBe('document');
    expect(settings['quantityPrecision']).toBe(3);
  });
});

describe('document numbering (19-S.2)', () => {
  const seriesCode = `agentTest${Date.now().toString(36)}`;

  it('seeds the document series the later phases allocate from', async () => {
    const result = await fix.call('GET', '/api/v1/Sales/action/numbering');
    expect(result.status).toBe(200);
    const list = result.body['list'] as { code: string; prefix: string; nextPreview: string }[];
    const invoice = list.find((series) => series.code === 'invoice');
    expect(invoice?.prefix).toBe('INV-');
    expect(invoice?.nextPreview).toMatch(/^INV-\d{6}$/);
  });

  it('allocates concurrent numbers exactly once each', async () => {
    fix.seriesCodes.push(seriesCode);
    await ctx.database.db
      .insertInto('sales_number_series')
      .values({
        id: `sns_${seriesCode}`,
        code: seriesCode,
        label: 'AGENT_TEST series',
        prefix: 'AT-',
        padding: 4,
        next_number: 1,
        allocation: 'issuance',
        active: true,
        created_at: new Date(),
        modified_at: new Date(),
      })
      .execute();
    const numbering = ctx.app.get(SalesNumberingService);

    const previewBefore = await numbering.preview(seriesCode);
    expect(previewBefore.nextPreview).toBe('AT-0001');
    // Preview consumes nothing.
    await numbering.preview(seriesCode);

    const allocations = await Promise.all(
      Array.from({ length: 8 }, (_unused, index) =>
        numbering.allocate(seriesCode, { documentType: 'Invoice', documentId: `AGENT_TEST_${seriesCode}_${String(index)}` }),
      ),
    );
    const numbers = allocations.map((allocation) => allocation.number).sort((left, right) => left - right);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(allocations.map((allocation) => allocation.formatted)).size).toBe(8);
    expect(allocations.every((allocation) => allocation.reused === false)).toBe(true);

    // A retried issuance for the same document returns its existing number instead of a new one.
    const again = await numbering.allocate(seriesCode, { documentType: 'Invoice', documentId: `AGENT_TEST_${seriesCode}_0` });
    expect(again.reused).toBe(true);
    expect(again.number).toBe(1);
    const ledger = await ctx.database.db
      .selectFrom('sales_document_numbers')
      .select('number')
      .where('series_id', '=', `sns_${seriesCode}`)
      .execute();
    expect(ledger).toHaveLength(8);
  });

  it('refuses allocation from an inactive series', async () => {
    const inactive = `${seriesCode}off`;
    fix.seriesCodes.push(inactive);
    await ctx.database.db
      .insertInto('sales_number_series')
      .values({
        id: `sns_${inactive}`,
        code: inactive,
        label: 'AGENT_TEST inactive series',
        prefix: 'AX-',
        padding: 4,
        next_number: 1,
        allocation: 'issuance',
        active: false,
        created_at: new Date(),
        modified_at: new Date(),
      })
      .execute();
    const numbering = ctx.app.get(SalesNumberingService);
    await expect(numbering.allocate(inactive, { documentType: 'Invoice', documentId: 'AGENT_TEST_inactive' })).rejects.toThrow(/inactive/);
  });

  it('requires both the document type and id when an allocation is document-bound', async () => {
    const numbering = ctx.app.get(SalesNumberingService);
    await expect(numbering.allocate(seriesCode, { documentType: 'Invoice' })).rejects.toThrow(/both/);
  });
});
