/**
 * Per-user preferences (PLAN_Phase_20_Settings_UX.md §5.9, §20.10) — a small module on purpose: the
 * named-document schemas, the owner-only service and the three routes. Nothing else depends on it;
 * consumers (list density, default dashboard, later 20.12 column sets) talk to the SPA client.
 */
import type { Provider, Type } from '@nestjs/common';

import { PreferencesController } from './preferences.controller.js';
import { PreferencesService } from './preferences.service.js';

export { PREFERENCE_NAMES, preferenceSchema } from './preference-shapes.js';
export { PreferencesController } from './preferences.controller.js';
export type { PreferenceView } from './preferences.service.js';
export { PreferencesService } from './preferences.service.js';

export const PREFERENCES_PROVIDERS: Provider[] = [PreferencesService];

export const PREFERENCES_CONTROLLERS: Type<unknown>[] = [PreferencesController];
