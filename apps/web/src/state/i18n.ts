import type { i18n as I18n } from 'i18next';
import { createInstance } from 'i18next';

import { api } from '../api/client.js';

/**
 * SPA internationalization (PLAN §41): one i18next instance fed by `GET /api/v1/I18n`.
 * A locale's catalog is cached in `localStorage` keyed by the server's content hash, so a
 * returning visitor re-downloads nothing (§41.5). Dates and numbers always go through Intl
 * with the active locale/timezone — never the host default (§41.6).
 */

const ACTIVE_LOCALE_KEY = 'carocrm.locale';
const CATALOG_KEY = 'carocrm.i18nCatalog';

export interface I18nCatalogResponse {
  locale: string;
  instance: { defaultLocale: string; enabledLocales: string[]; defaultTimezone: string };
  hash: string;
  catalog?: Record<string, unknown>;
  unchanged?: boolean;
}

export const i18n: I18n = createInstance();

let activeLocale = 'en';
let enabledLocales: string[] = ['en', 'vi'];
let formatTz = 'UTC';

function storedLocale(): string {
  return window.localStorage.getItem(ACTIVE_LOCALE_KEY) ?? 'en';
}

function storedCatalog(locale: string): { hash: string; catalog: Record<string, unknown> } | undefined {
  try {
    const raw = window.localStorage.getItem(`${CATALOG_KEY}.${locale}`);
    if (!raw) return undefined;
    return JSON.parse(raw) as { hash: string; catalog: Record<string, unknown> };
  } catch {
    return undefined;
  }
}

/** Rebuilds the nested object i18next expects from the API's flat `module.sub.…` keys. */
function nestedFromFlat(flat: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split('.');
    let node = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const next = parts[i] ?? '';
      if (typeof node[next] !== 'object' || node[next] === null) node[next] = {};
      node = node[next] as Record<string, unknown>;
    }
    node[parts[parts.length - 1] ?? ''] = value;
  }
  return out;
}

async function applyCatalog(locale: string, catalog: Record<string, unknown>): Promise<void> {
  i18n.addResourceBundle(locale, 'translation', nestedFromFlat(catalog), true, true);
  await i18n.changeLanguage(locale);
  activeLocale = locale;
}

export function activeLocaleName(): string {
  return activeLocale;
}

export function localesEnabled(): string[] {
  return enabledLocales;
}

/** Instance defaults the switcher and date formatting fall back to (PLAN §41.6). */
export function defaultLocaleName(): string {
  return window.localStorage.getItem('carocrm.defaultLocale') ?? 'en';
}

export function defaultTimezone(): string {
  return window.localStorage.getItem('carocrm.defaultTimezone') ?? 'UTC';
}

/** Loads the merged catalog for a locale, using the content-hash conditional request (§41.5). */
export async function activateLocale(locale: string): Promise<void> {
  const cached = storedCatalog(locale);
  let response: I18nCatalogResponse;
  if (cached) {
    response = await api.i18nCatalog(locale, cached.hash);
    if (response.unchanged && cached.catalog) {
      await applyCatalog(locale, cached.catalog);
      enabledLocales = window.localStorage.getItem('carocrm.i18nLocales')?.split(',') ?? enabledLocales;
      return;
    }
  } else {
    response = await api.i18nCatalog(locale, undefined);
  }
  if (response.catalog) {
    window.localStorage.setItem(`${CATALOG_KEY}.${locale}`, JSON.stringify({ hash: response.hash, catalog: response.catalog }));
    await applyCatalog(locale, response.catalog);
  }
  if (response.locale) {
    enabledLocales = response.instance.enabledLocales;
    window.localStorage.setItem('carocrm.i18nLocales', enabledLocales.join(','));
    window.localStorage.setItem('carocrm.defaultLocale', response.instance.defaultLocale);
    window.localStorage.setItem('carocrm.defaultTimezone', response.instance.defaultTimezone);
  }
}

/**
 * Bootstraps rendering: initialize with the stored locale (so first paint already has UI
 * strings), then reconcile with the user's server-side preference once the session loads.
 */
export async function initI18n(): Promise<void> {
  if (!i18n.isInitialized) {
    await i18n.init({
      lng: storedLocale(),
      fallbackLng: 'en',
      keySeparator: '.',
      nsSeparator: false,
      interpolation: { escapeValue: false },
      resources: {},
      returnEmptyString: false,
    });
  }
  const cached = storedCatalog(storedLocale());
  if (cached) await applyCatalog(storedLocale(), cached.catalog);
  await activateLocale(storedLocale());
}

/**
 * Synchronous (network-free) bootstrap for the very first paint (PLAN §41.4). Initializes
 * i18next and applies the locally cached catalog when one exists, so the app can mount with UI
 * strings ready even before — or without — a successful `GET /I18n`. The subsequent live
 * `initI18n()` reconciles against the instance; if the cache is absent the UI starts in the
 * stored/`en` language and fills in once the network call succeeds.
 */
export async function initI18nFromCache(): Promise<void> {
  if (i18n.isInitialized) return;
  await i18n.init({
    lng: storedLocale(),
    fallbackLng: 'en',
    keySeparator: '.',
    nsSeparator: false,
    interpolation: { escapeValue: false },
    resources: {},
    returnEmptyString: false,
  });
  const locale = storedLocale();
  const cached = storedCatalog(locale);
  if (cached) {
    i18n.addResourceBundle(locale, 'translation', nestedFromFlat(cached.catalog), true, true);
    activeLocale = locale;
  }
}

/** Called by the session loader: the user's own locale/timezone now drive formatting. */
export function setActiveUserInfo(locale: string | null | undefined, timezone: string | null | undefined): void {
  if (locale) window.localStorage.setItem(ACTIVE_LOCALE_KEY, locale);
  formatTz = timezone || defaultTimezone();
}

export function activeTimezone(): string {
  return formatTz;
}

const fallbackCache = new Map<string, string>();

/** Formats an instant in the user's timezone with their locale (PLAN §41.6). */
export function formatDateTime(value: string | null | undefined, withTime = true): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const format = new Intl.DateTimeFormat(activeLocale, {
    timeZone: formatTz,
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return format.format(date);
}

/** Locale-aware number formatting (PLAN §41.6). */
export function formatNumber(value: number): string {
  return new Intl.NumberFormat(activeLocale).format(value);
}

export function t(key: string, variables?: Record<string, unknown>): string {
  const translated = (variables === undefined ? i18n.t(key) : i18n.t(key, variables)) as string | undefined;
  if (translated !== undefined && translated !== key) return translated;
  // Observable fallback (§41.4): remember missing keys so they can be found in dev tooling.
  if (!fallbackCache.has(key)) fallbackCache.set(key, key);
  return key;
}
