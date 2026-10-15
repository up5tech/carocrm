import type { ApiContext } from './boot-api.js';
import { authHeader, purgeEntityEvents } from './boot-api.js';

/**
 * Fixtures for the Phase 19-S suites.
 *
 * Every record is created through the public API with an `AGENT_TEST_`-marked name and is deleted by
 * its own id in `cleanup()` (AGENTS.MD §3.3): nothing is shared between runs, nothing broad is
 * deleted, and the configured primary database is the only target. The number-series rows a suite
 * creates live in a dedicated code namespace (`agentTest...`) and are removed by that exact code,
 * together with the ledger rows that reference them.
 */

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface CallResult {
  status: number;
  body: Record<string, unknown>;
}

export interface SalesFixture {
  readonly runId: string;
  readonly ids: string[];
  readonly seriesCodes: string[];
  call: (method: Method, url: string, payload?: unknown, token?: string) => Promise<CallResult>;
  create: (entity: string, data?: Record<string, unknown>) => Promise<string>;
  createProduct: (data?: Record<string, unknown>) => Promise<string>;
  createCategory: (data?: Record<string, unknown>) => Promise<string>;
  createPriceBook: (data?: Record<string, unknown>) => Promise<string>;
  createEntry: (priceBookId: string, productId: string, data?: Record<string, unknown>) => Promise<string>;
  createRule: (priceBookId: string, data?: Record<string, unknown>) => Promise<string>;
  createTaxCode: (data?: Record<string, unknown>) => Promise<string>;
  createTaxRate: (taxCodeId: string, data?: Record<string, unknown>) => Promise<string>;
  createTaxRule: (taxCodeId: string, data?: Record<string, unknown>) => Promise<string>;
  createSupplier: (data?: Record<string, unknown>) => Promise<string>;
  createSupplierPrice: (supplierId: string, productId: string, data?: Record<string, unknown>) => Promise<string>;
  cleanup: () => Promise<void>;
}

/** The specific reason behind a rejected request (see the Projects fixture for the rationale). */
export function reasonOf(result: CallResult): string {
  const error = result.body['error'] as { message?: string; details?: Record<string, unknown> } | undefined;
  return String(error?.details?.['reason'] ?? error?.message ?? '');
}

export function detailsOf(result: CallResult): Record<string, unknown> {
  const error = result.body['error'] as { details?: Record<string, unknown> } | undefined;
  return error?.details ?? {};
}

export async function salesFixture(ctx: ApiContext, token?: string): Promise<SalesFixture> {
  const runId = `sl${Date.now().toString(36)}${Math.floor(Math.random() * 10_000)}`;
  const adminToken = token ?? ctx.adminToken;
  const ids: string[] = [];
  const seriesCodes: string[] = [];

  const call = async (method: Method, url: string, payload?: unknown, asToken = adminToken): Promise<CallResult> => {
    const res = await ctx.app.inject({
      method,
      url,
      headers: authHeader(asToken),
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
    let body: Record<string, unknown> = {};
    try {
      body = res.json() as Record<string, unknown>;
    } catch {
      body = {};
    }
    return { status: res.statusCode, body };
  };

  const createdId = (result: CallResult, what: string): string => {
    if (result.status !== 201 && result.status !== 200) {
      throw new Error(`${what} failed: ${String(result.status)} ${JSON.stringify(result.body)}`);
    }
    const id = String(result.body['id'] ?? '');
    if (id === '') throw new Error(`${what} returned no id: ${JSON.stringify(result.body)}`);
    ids.push(id);
    return id;
  };

  const fixture: SalesFixture = {
    runId,
    ids,
    seriesCodes,
    call,
    async create(entity, data = {}) {
      return createdId(await call('POST', `/api/v1/${entity}`, { name: `AGENT_TEST_${runId} ${entity}`, ...data }), `create ${entity}`);
    },
    async createProduct(data = {}) {
      return createdId(
        await call('POST', '/api/v1/Product', {
          name: `AGENT_TEST_${runId} Product`,
          sku: `AGENT-${runId}-${String(ids.length + 1)}`,
          productType: 'Goods',
          active: true,
          isSellable: true,
          isPurchasable: true,
          ...data,
        }),
        'create product',
      );
    },
    async createCategory(data = {}) {
      return createdId(await call('POST', '/api/v1/ProductCategory', { name: `AGENT_TEST_${runId} Category`, active: true, ...data }), 'create category');
    },
    async createPriceBook(data = {}) {
      return createdId(
        await call('POST', '/api/v1/PriceBook', { name: `AGENT_TEST_${runId} Book`, active: true, priority: 100, ...data }),
        'create price book',
      );
    },
    async createEntry(priceBookId, productId, data = {}) {
      return createdId(
        await call('POST', '/api/v1/PriceBookEntry', { priceBookId, productId, unitPrice: '10.00', ...data }),
        'create price book entry',
      );
    },
    async createRule(priceBookId, data = {}) {
      return createdId(
        await call('POST', '/api/v1/PriceRule', {
          name: `AGENT_TEST_${runId} Rule`,
          priceBookId,
          active: true,
          priority: 100,
          actionType: 'percentAdjustment',
          actionValue: '10',
          ...data,
        }),
        'create price rule',
      );
    },
    async createTaxCode(data = {}) {
      return createdId(
        await call('POST', '/api/v1/TaxCode', { name: `AGENT_TEST_${runId} Code`, code: `AG-${runId}-${String(ids.length + 1)}`, active: true, ...data }),
        'create tax code',
      );
    },
    async createTaxRate(taxCodeId, data = {}) {
      return createdId(
        await call('POST', '/api/v1/TaxRate', { name: `AGENT_TEST_${runId} Rate`, taxCodeId, ratePercent: '19', active: true, ...data }),
        'create tax rate',
      );
    },
    async createTaxRule(taxCodeId, data = {}) {
      return createdId(
        await call('POST', '/api/v1/TaxRule', { name: `AGENT_TEST_${runId} Tax Rule`, taxCodeId, active: true, priority: 10, ...data }),
        'create tax rule',
      );
    },
    async createSupplier(data = {}) {
      return createdId(await call('POST', '/api/v1/Supplier', { name: `AGENT_TEST_${runId} Supplier`, active: true, ...data }), 'create supplier');
    },
    async createSupplierPrice(supplierId, productId, data = {}) {
      return createdId(
        await call('POST', '/api/v1/SupplierProductPrice', { supplierId, productId, unitPrice: '4.20', active: true, ...data }),
        'create supplier price',
      );
    },
    async cleanup() {
      if (ids.length > 0) {
        // Audit rows the bulk-price run wrote are keyed to the price book ids this run created.
        await ctx.database.db
          .deleteFrom('audit_log')
          .where('entity_type', '=', 'PriceBook')
          .where('record_id', 'in', ids)
          .execute()
          .catch(() => undefined);
        await ctx.database.db.deleteFrom('entity_records').where('id', 'in', ids).execute().catch(() => undefined);
      }
      if (seriesCodes.length > 0) {
        const series = await ctx.database.db
          .selectFrom('sales_number_series')
          .select('id')
          .where('code', 'in', seriesCodes)
          .execute()
          .catch(() => []);
        const seriesIds = series.map((row) => row.id);
        if (seriesIds.length > 0) {
          await ctx.database.db.deleteFrom('sales_document_numbers').where('series_id', 'in', seriesIds).execute().catch(() => undefined);
          await ctx.database.db.deleteFrom('sales_number_series').where('id', 'in', seriesIds).execute().catch(() => undefined);
        }
      }
      await purgeEntityEvents(ctx.database, [
        'Product',
        'ProductCategory',
        'PriceBook',
        'PriceBookEntry',
        'PriceRule',
        'Supplier',
        'SupplierProductPrice',
        'TaxClass',
        'TaxCode',
        'TaxRate',
        'TaxRule',
      ]);
    },
  };
  return fixture;
}
