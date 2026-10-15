import { ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import { isKnownCurrency } from './money/currency.js';
import { ROUNDING_MODES, type RoundingMode } from './money/decimal.js';

/**
 * Phase 19-S.2 — Sales domain settings (PLAN_Phase_19_Sales.md §13).
 *
 * The platform already owns instance settings (`app_settings`, `POST /api/v1/Settings`), so this
 * module does not introduce a second store: it keeps one validated, versioned row named `sales`
 * in the same table. Every value that changes a calculation is validated here, and a change bumps
 * the version so a stored document snapshot can name the policy it was produced under
 * (§13 "version settings changes where they affect calculations").
 */

export const SALES_FEATURE_KEYS = [
  'productPrices',
  'taxInclusivePrices',
  'priceBooks',
  'productVariants',
  'supplierPrices',
  'purchases',
  'inventory',
  'subscriptions',
  'paymentRequests',
  'multiCurrency',
  'issuanceLocking',
] as const;

export type SalesFeatureKey = (typeof SALES_FEATURE_KEYS)[number];

const FeatureSchema = z.object({
  /** Product-level cost/list/unit prices are usable as a fallback price source (§4.3). */
  productPrices: z.boolean().default(true),
  /** Prices are quoted tax-inclusive by default (documents may still state their own policy). */
  taxInclusivePrices: z.boolean().default(false),
  priceBooks: z.boolean().default(true),
  /** Variants arrive in 19-S.15; the flag lets the catalog work without them. */
  productVariants: z.boolean().default(false),
  supplierPrices: z.boolean().default(true),
  purchases: z.boolean().default(false),
  inventory: z.boolean().default(false),
  subscriptions: z.boolean().default(false),
  paymentRequests: z.boolean().default(false),
  multiCurrency: z.boolean().default(false),
  /** Lock commercial fields of an issued document (§4.7). */
  issuanceLocking: z.boolean().default(true),
}).strict();

const RoundingModeSchema = z.enum(ROUNDING_MODES as [RoundingMode, ...RoundingMode[]]);

export const SalesSettingsSchema = z
  .object({
    features: FeatureSchema.default({}),
    currency: z
      .object({
        /** The installation's base currency; documents may still carry another when multiCurrency is on. */
        defaultCurrency: z.string().trim().min(3).max(3).default('USD'),
      })
      .strict()
      .default({}),
    pricing: z
      .object({
        /** Which source wins when both exist; see §4.3 for the full precedence. */
        resolution: z.enum(['priceBookFirst', 'productFirst']).default('priceBookFirst'),
        allowCustomPrice: z.boolean().default(true),
        /** `error` refuses to save a line without a price; it is never silently zero (plan §4.3 rule 4). */
        missingPricePolicy: z.enum(['error', 'allowExplicit']).default('error'),
      })
      .strict()
      .default({}),
    tax: z
      .object({
        /** `error` refuses a line with no applicable tax; zero tax must be configured, not assumed. */
        missingTaxPolicy: z.enum(['error', 'zero']).default('error'),
        /** Tax code id applied to shipping charges; null means shipping is not taxed by default. */
        shippingTaxCode: z.string().trim().min(1).max(64).nullable().default(null),
        /** Where totals are rounded: per line (sum of rounded lines) or once per document (§4.12). */
        roundingStage: z.enum(['line', 'document']).default('line'),
        roundingMode: RoundingModeSchema.default('half-up'),
      })
      .strict()
      .default({}),
    numbering: z
      .object({
        /** Series-level policy default; per-series rows may override it (`sales_number_series`). */
        allocation: z.enum(['issuance', 'creation']).default('issuance'),
      })
      .strict()
      .default({}),
    /** Fraction digits accepted for quantities (server-side; clients may not exceed it). */
    quantityPrecision: z.number().int().min(0).max(6).default(2),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!isKnownCurrency(value.currency.defaultCurrency)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['currency', 'defaultCurrency'],
        message: `"${value.currency.defaultCurrency}" is not a supported currency code.`,
      });
    }
  });

export type SalesSettings = z.infer<typeof SalesSettingsSchema>;

export const DEFAULT_SALES_SETTINGS: SalesSettings = SalesSettingsSchema.parse({});

export interface SettingsWarning {
  readonly code: string;
  readonly message: string;
}

/** Dependency/coherence warnings — surfaced by the module health endpoint, never by refusing a save. */
export function settingsWarnings(settings: SalesSettings): SettingsWarning[] {
  const warnings: SettingsWarning[] = [];
  if (!settings.features.priceBooks && settings.pricing.resolution === 'priceBookFirst') {
    warnings.push({
      code: 'priceBooksDisabledWithPriceBookFirst',
      message: 'Price books are disabled but price resolution still prefers them; product prices will be used.',
    });
  }
  if (!settings.features.productPrices && !settings.features.priceBooks) {
    warnings.push({
      code: 'noPriceSource',
      message: 'Both product prices and price books are disabled: every line needs an explicit price.',
    });
  }
  if (settings.features.purchases && !settings.features.supplierPrices) {
    warnings.push({
      code: 'purchasesWithoutSupplierPrices',
      message: 'Purchases are enabled while supplier prices are disabled; purchase orders will need manual prices.',
    });
  }
  if (settings.features.inventory && !settings.features.purchases) {
    warnings.push({
      code: 'inventoryWithoutPurchases',
      message: 'Inventory is enabled without purchases; stock can only change through sales documents and adjustments.',
    });
  }
  if (settings.features.multiCurrency && settings.currency.defaultCurrency === '') {
    warnings.push({ code: 'multiCurrencyWithoutBase', message: 'Multi-currency is enabled but no base currency is configured.' });
  }
  return warnings;
}

export interface SalesSettingsView {
  readonly settings: SalesSettings;
  readonly version: number;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly defaults: SalesSettings;
  readonly warnings: readonly SettingsWarning[];
}

interface StoredSettings {
  version?: unknown;
  settings?: unknown;
  updatedAt?: unknown;
  updatedBy?: unknown;
}

const SETTINGS_ROW = 'sales';

@Injectable()
export class SalesSettingsService {
  private cache: SalesSettingsView | undefined;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  /** Validated settings for calculation paths; defaults when the row is absent. */
  async settings(): Promise<SalesSettings> {
    return (await this.read()).settings;
  }

  async read(): Promise<SalesSettingsView> {
    if (this.cache !== undefined) return this.cache;
    const row = await this.database.db.selectFrom('app_settings').select('data').where('name', '=', SETTINGS_ROW).executeTakeFirst();
    this.cache = toView(row?.data);
    return this.cache;
  }

  /**
   * Apply a validated patch. Unknown keys are refused (a typo in a policy name must not be stored
   * and silently ignored), and every accepted change bumps the settings version.
   */
  async update(patch: unknown): Promise<SalesSettingsView> {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      throw new ValidationError('Sales settings must be an object.');
    }
    const current = await this.read();
    const merged = deepMerge(current.settings as unknown as Record<string, unknown>, patch as Record<string, unknown>);
    const parsed = SalesSettingsSchema.safeParse(merged);
    if (!parsed.success) {
      throw new ValidationError('Invalid Sales settings.', {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }
    const next = parsed.data;
    const version = current.version + 1;
    const updatedAt = new Date().toISOString();
    const updatedBy = this.scope.principal?.userName ?? this.scope.userId ?? null;
    const stored: StoredSettings = { version, settings: next, updatedAt, updatedBy };
    await this.database.db
      .insertInto('app_settings')
      .values({ name: SETTINGS_ROW, data: JSON.stringify(stored), modified_at: new Date() })
      .onConflict((oc) => oc.column('name').doUpdateSet({ data: JSON.stringify(stored), modified_at: new Date() }))
      .execute();
    this.cache = toView(stored);
    return this.cache;
  }

  /** Only tests and explicit reloads call this; the row cache is otherwise write-through. */
  invalidate(): void {
    this.cache = undefined;
  }
}

function toView(data: unknown): SalesSettingsView {
  const stored = isRecord(data) ? (data as StoredSettings) : {};
  const parsed = SalesSettingsSchema.safeParse(stored.settings ?? {});
  // A stored row that no longer satisfies the schema (an upgrade changed a policy) falls back to
  // defaults for the invalid parts instead of refusing to boot — health reports the mismatch.
  const settings = parsed.success ? parsed.data : SalesSettingsSchema.parse({});
  return {
    settings,
    version: typeof stored.version === 'number' && Number.isInteger(stored.version) ? stored.version : 0,
    updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : null,
    updatedBy: typeof stored.updatedBy === 'string' ? stored.updatedBy : null,
    defaults: DEFAULT_SALES_SETTINGS,
    warnings: settingsWarnings(settings),
  };
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = merged[key];
    if (isRecord(current) && isRecord(value)) merged[key] = deepMerge(current, value);
    else merged[key] = value;
  }
  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
