import { AuthorizationDeniedError, RecordNotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { Body, Controller, Get, HttpCode, Inject, Post, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';

import { SettingsDocumentService } from '../admin-panel/settings-document.service.js';
import { Public } from '../auth/auth.guard.js';
import { REQUEST_SCOPE_TOKEN,type RequestScope } from '../common/request-scope.js';
import { I18nService } from '../i18n/i18n.service.js';
import type { BrandSettings } from './brand.service.js';
import { BrandService } from './brand.service.js';

/**
 * Instance settings (PLAN §12.2 `app_settings`). The two reads are public because the sign-in page
 * has to show the same brand as the rest of the app; the write is administrator-only.
 *
 * Phase 20 (§7.1): the write keeps this flat six-key contract for existing clients but delegates to
 * the settings document registry, so one set of rules and one version stamp serve both this route
 * and `/Settings/documents/:name`.
 */
@ApiTags('settings')
@Controller('api/v1/Settings')
export class SettingsController {
  constructor(
    @Inject(BrandService) private readonly brand: BrandService,
    @Inject(I18nService) private readonly i18n: I18nService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(SettingsDocumentService) private readonly documents: SettingsDocumentService,
  ) {}

  @Public()
  @Get()
  async read(): Promise<SettingsView> {
    const [brand, settings] = await Promise.all([this.brand.get(), this.i18n.settings()]);
    return {
      ...brand,
      // A stable URL instead of the attachment id: the file itself stays un-enumerable.
      logoUrl: brand.logoAttachmentId === null ? null : '/api/v1/Settings/logo',
      availableLocales: this.i18n.localeList(),
      defaultLocale: settings.defaultLocale,
      enabledLocales: settings.enabledLocales,
      defaultTimezone: settings.defaultTimezone,
    };
  }

  @Public()
  @Get('logo')
  async logo(@Res({ passthrough: true }) reply: FastifyReply): Promise<NodeJS.ReadableStream> {
    const stored = await this.brand.logo();
    if (!stored) throw new RecordNotFoundError('Logo', 'the instance logo is not configured');
    reply.header('content-type', stored.mimeType);
    reply.header('content-disposition', `inline; filename="${stored.name.replace(/[^\w.-]/g, '_')}"`);
    reply.header('cache-control', 'public, max-age=60');
    reply.header('x-content-type-options', 'nosniff');
    return stored.stream;
  }

  @HttpCode(200)
  @Post()
  async save(@Body() body: unknown): Promise<SettingsView> {
    if (!this.scope.isAdmin) {
      throw new AuthorizationDeniedError('Administrator access is required to change instance settings.');
    }
    const parsed = SettingsPatchSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid settings payload.', {
        issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      });
    }
    const { pageTitle, footerText, logoAttachmentId, ...locales } = parsed.data;
    const brandPatch: Partial<BrandSettings> = {
      ...(pageTitle !== undefined ? { pageTitle } : {}),
      ...(footerText !== undefined ? { footerText } : {}),
      ...(logoAttachmentId !== undefined ? { logoAttachmentId } : {}),
    };
    if (Object.keys(brandPatch).length > 0) await this.documents.write('brand', brandPatch);
    if (Object.keys(locales).length > 0) await this.documents.write('i18n', locales);
    return this.read();
  }
}

const SettingsPatchSchema = z.object({
  pageTitle: z.string().trim().min(1).max(80).nullable().optional(),
  footerText: z.string().trim().max(200).nullable().optional(),
  logoAttachmentId: z.string().max(36).nullable().optional(),
  defaultLocale: z.string().min(2).max(20).optional(),
  enabledLocales: z.array(z.string().min(2).max(20)).min(1).max(20).optional(),
  defaultTimezone: z.string().min(1).max(64).optional(),
});

export interface SettingsView extends BrandSettings {
  logoUrl: string | null;
  availableLocales: string[];
  defaultLocale: string;
  enabledLocales: string[];
  defaultTimezone: string;
}
