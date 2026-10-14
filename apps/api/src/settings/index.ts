/**
 * Settings module barrel — integrator entry point.
 *
 * Wire into AppModule:
 *   controllers: [...SETTINGS_CONTROLLERS]
 *   providers:   [...SETTINGS_PROVIDERS]
 *
 * Reads the `brand` and `i18n` rows of `app_settings`; needs `FILE_STORAGE_TOKEN` from the
 * attachment module (the logo is a stored attachment), plus DatabaseService and I18nService.
 */
import type { Provider, Type } from '@nestjs/common';

import { BrandService } from './brand.service.js';
import { SettingsController } from './settings.controller.js';

export type { BrandLogo, BrandSettings } from './brand.service.js';
export { BrandService } from './brand.service.js';
export type { SettingsView } from './settings.controller.js';
export { SettingsController } from './settings.controller.js';

export const SETTINGS_PROVIDERS: Provider[] = [BrandService];
export const SETTINGS_CONTROLLERS: Type<unknown>[] = [SettingsController];
