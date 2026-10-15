import { AuthorizationDeniedError, InvalidQueryError } from '@carocrm/core/errors/index.js';
import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { ZodTypeAny } from 'zod';

import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { SalesNumberingService } from './document/numbering.service.js';
import { BulkPriceUpdateSchema, PreviewTotalsSchema, ResolvePriceSchema, SalesSettingsPatchSchema } from './dto/sales-shapes.js';
import { BulkPriceService } from './pricing/bulk-price.service.js';
import { PriceResolutionService } from './pricing/price-resolution.service.js';
import { SalesModuleHealthService } from './sales-module-health.service.js';
import { SalesSettingsService } from './sales-settings.service.js';
import { SalesTaxService } from './tax/tax.service.js';

/**
 * Phase 19-S.1 – 19-S.5 — Sales domain commands (`/api/v1/Sales`).
 *
 * Entity CRUD stays on the generic `/api/v1/:entity` API — a Product is a metadata record, and the
 * Entity Engine already serves list/detail/create/edit/delete, relations, search and ACL for it.
 * These routes exist only for what a single record cannot express: module diagnostics, the settings
 * document, numbering state, deterministic price resolution, a previewed bulk price change and a
 * server-calculated totals preview.
 *
 * Route order: this controller is registered before `ENTITY_CONTROLLERS` in `AppModule`, so the
 * static `Sales` prefix can never be swallowed by the generic `:entity` wildcard.
 */
@ApiTags('sales')
@Controller('api/v1/Sales')
export class SalesController {
  constructor(
    @Inject(SalesModuleHealthService) private readonly health: SalesModuleHealthService,
    @Inject(SalesSettingsService) private readonly settings: SalesSettingsService,
    @Inject(SalesNumberingService) private readonly numbering: SalesNumberingService,
    @Inject(PriceResolutionService) private readonly prices: PriceResolutionService,
    @Inject(BulkPriceService) private readonly bulkPrices: BulkPriceService,
    @Inject(SalesTaxService) private readonly tax: SalesTaxService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  /** Module diagnostics: dependencies, optional integrations, features and checks. Admin only. */
  @Get('action/health')
  async moduleHealth() {
    this.requireAdmin('module diagnostics');
    return this.health.health();
  }

  /** The validated settings document plus the computed defaults and warnings. */
  @Get('action/settings')
  async readSettings() {
    return this.settings.read();
  }

  /** Update settings; high-impact policy is administrator-only (§13). */
  @HttpCode(200)
  @Post('action/settings')
  async updateSettings(@Body() body: unknown) {
    this.requireAdmin('changing Sales settings');
    parse(SalesSettingsPatchSchema, body);
    return this.settings.update(body);
  }

  /** Number series with the next unallocated number — allocation itself happens at issuance. */
  @Get('action/numbering')
  async numberingState() {
    this.requireAdmin('document numbering');
    return { list: await this.numbering.list() };
  }

  /** Resolve one line's price, with the explanation of which source won (§4.3). */
  @HttpCode(200)
  @Post('action/resolvePrice')
  async resolvePrice(@Body() body: unknown) {
    const input = parse(ResolvePriceSchema, body);
    return this.prices.resolve(input);
  }

  /** Preview or apply a bulk price change; `apply` is audited and bounded (§4.3). */
  @HttpCode(200)
  @Post('action/bulkPriceUpdate')
  async bulkPriceUpdate(@Body() body: unknown) {
    const input = parse(BulkPriceUpdateSchema, body);
    return this.bulkPrices.run(input);
  }

  /** Server-calculated totals: discounts, shipping, tax breakdown and rounding policy (§4.12, §5.7). */
  @HttpCode(200)
  @Post('action/previewTotals')
  async previewTotals(@Body() body: unknown) {
    const input = parse(PreviewTotalsSchema, body);
    return this.tax.preview(input);
  }

  private requireAdmin(action: string): void {
    if (!this.scope.isAdmin) {
      throw new AuthorizationDeniedError(`Administrator access is required for ${action}.`);
    }
  }
}

function parse<T extends ZodTypeAny>(schema: T, body: unknown): T['_output'] {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new InvalidQueryError('The request is not valid.', { issues: parsed.error.issues.map((issue) => issue.message) });
  }
  return parsed.data;
}
