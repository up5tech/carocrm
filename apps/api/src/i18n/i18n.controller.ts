import { ValidationError } from '@carocrm/core/errors/index.js';
import { Controller, Get, Inject, Query } from '@nestjs/common';

import { Public } from '../auth/auth.guard.js';
import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import type { Catalog } from './i18n.service.js';
import { acceptLanguageLocale, I18nService } from './i18n.service.js';

/**
 * `GET /api/v1/I18n` (PLAN §41.5). Mounted on the static `I18n` prefix so the generic
 * `:entity` wildcard never shadows it. Resolution order (§41.4): `?locale=` → the
 * authenticated user's locale → `Accept-Language` → the instance default. A requested
 * locale outside the instance's enabled list is rejected (§41.5).
 *
 * Public (no bearer token) so the SPA can restore the locale and paint the sign-in page
 * before authentication (§41.4). Only translation strings and the public instance
 * locale/timezone settings are returned — never a user's own locale, which still requires
 * an authenticated principal to resolve.
 */
@Public()
@Controller('api/v1/I18n')
export class I18nController {
  constructor(
    @Inject(I18nService) private readonly i18n: I18nService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  @Get()
  async catalog(
    @Query('locale') localeParam?: string,
    @Query('clientCache') clientCache?: string,
  ): Promise<unknown> {
    const settings = await this.i18n.settings();
    const requested = typeof localeParam === 'string' && localeParam !== '' ? localeParam : undefined;
    if (requested !== undefined && !settings.enabledLocales.includes(requested)) {
      throw new ValidationError(`Locale "${requested}" is not enabled on this instance.`, {
        enabledLocales: settings.enabledLocales,
      });
    }
    const locale =
      requested ??
      this.scope.locale ??
      acceptLanguageLocale(this.scope.acceptLanguage, settings.enabledLocales) ??
      settings.defaultLocale;
    const effective: string = this.i18n.has(locale) ? locale : settings.defaultLocale;
    const hash = this.i18n.contentHash(effective);

    if (clientCache !== undefined && clientCache === hash) {
      // Content-hash caching (PLAN §41.5): the SPA skips the whole catalog when its stored hash matches.
      return { locale: effective, hash, unchanged: true };
    }
    return {
      locale: effective,
      instance: settings,
      hash,
      catalog: this.i18n.catalogFor(effective) as Catalog,
    };
  }
}
