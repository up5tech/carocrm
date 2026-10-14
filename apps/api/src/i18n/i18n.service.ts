import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { ValidationError } from '@carocrm/core/errors/index.js';
import { log } from '@carocrm/core/logger/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service.js';

/** Catalog JSON files (`i18n/<locale>/<module>.json`, PLAN §41.3) — the locale directories are discovered. */
export interface I18nSettings {
  defaultLocale: string;
  enabledLocales: string[];
  defaultTimezone: string;
}

export type Catalog = Record<string, unknown>;

const LOCALE_RE = /^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/;
/** A module namespace [a-z][a-z0-9]+, then dot-separated segments of letters/digits/underscore. */
const KEY_RE = /^[a-z][a-z0-9]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const SETTINGS_CACHE_MS = 30_000;

/**
 * Locates the catalog directory (PLAN §41.3). `process.cwd()` is **not** always the repository
 * root: `pnpm --filter @carocrm/api dev` starts the API from `apps/api/`, while the Playwright
 * config and `scripts/e2e-smoke.sh` run `node apps/api/dist/main.js` from the root. Resolving
 * against `cwd` alone therefore found no catalog under `pnpm dev` and silently disabled every
 * translation, which surfaced as raw keys (`web.login.submit`) in the SPA. Walking upwards — the
 * same way `loadDotEnv()` finds `.env` — makes both launch modes resolve `<root>/i18n`, and an
 * explicit `I18N_DIR` still wins so a deployment can point outside the source tree.
 */
function resolveCatalogDir(): string {
  if (process.env.I18N_DIR) return process.env.I18N_DIR;
  let dir = process.cwd();
  for (let depth = 0; depth < 4; depth++) {
    const candidate = join(dir, 'i18n');
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return join(process.cwd(), 'i18n');
}

@Injectable()
export class I18nService {
  private catalogs: Map<string, Catalog> | undefined;
  private locales: string[] | undefined;
  private warnings = new Set<string>();
  private settingsCache: { value: I18nSettings; loadedAt: number } | undefined;
  private sourceDir = resolveCatalogDir();

  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {
    // The exception filter resolves error messages through this service instance; a self-referential
    // module function would recurse forever, hence the bound lambda (PLAN §41.9).
    registerErrorTranslator((locale, code, original) => this.translateError(locale, code, original));
  }

  /** Discovers the locale directories and loads every `*.json` catalog file. */
  private ensureCatalogs(): Map<string, Catalog> {
    if (this.catalogs) return this.catalogs;
    const map = new Map<string, Catalog>();
    if (!existsSync(this.sourceDir)) {
      log.warn({ dir: this.sourceDir }, 'i18n catalog directory is missing; translation disabled');
      this.catalogs = map;
      this.locales = [];
      return map;
    }
    for (const entry of readdirSync(this.sourceDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !LOCALE_RE.test(entry.name)) continue;
      const localeDir = join(this.sourceDir, entry.name);
      const catalog: Catalog = {};
      for (const file of readdirSync(localeDir)) {
        if (!file.endsWith('.json')) continue;
        const module = file.slice(0, -'.json'.length);
        if (!/^[a-z][a-z0-9]*$/.test(module)) {
          throw new ValidationError(`i18n module namespace "${module}" must be lowercase alphanumeric (${entry.name}/${file}).`);
        }
        const doc = JSON.parse(readFileSync(join(localeDir, file), 'utf8')) as unknown;
        for (const [path, value] of Object.entries(flatten(module, doc))) {
          validateKey(path, entry.name, module, file);
          catalog[path] = value;
        }
      }
      map.set(entry.name, catalog);
    }
    if (!map.has('en')) {
      log.warn({ dir: this.sourceDir }, 'i18n catalogs have no "en" directory; key fallback has no source strings');
    }
    this.catalogs = map;
    this.locales = [...map.keys()];
    log.info({ locales: this.locales, dir: this.sourceDir }, 'i18n catalogs loaded');
    return map;
  }

  has(locale: string): boolean {
    return this.ensureCatalogs().has(locale);
  }

  localeList(): string[] {
    this.ensureCatalogs();
    return this.locales ?? [];
  }

  async settings(): Promise<I18nSettings> {
    const now = Date.now();
    if (this.settingsCache && now - this.settingsCache.loadedAt < SETTINGS_CACHE_MS) return this.settingsCache.value;
    const fallback: I18nSettings = { defaultLocale: 'en', enabledLocales: ['en', 'vi'], defaultTimezone: 'UTC' };
    try {
      const row = await this.database.db.selectFrom('app_settings').select('data').where('name', '=', 'i18n').limit(1).executeTakeFirst();
      if (row) {
        const data = row.data as Partial<I18nSettings> | null;
        const value: I18nSettings = {
          defaultLocale: guardLocale(data?.defaultLocale, fallback.defaultLocale),
          enabledLocales: Array.isArray(data?.enabledLocales) && data.enabledLocales.length > 0 ? (data.enabledLocales as string[]).map((l) => guardLocale(l, '')).filter((l) => l !== '') : fallback.enabledLocales,
          defaultTimezone: typeof data?.defaultTimezone === 'string' && data.defaultTimezone !== '' ? data.defaultTimezone : fallback.defaultTimezone,
        };
        this.settingsCache = { value, loadedAt: now };
        return value;
      }
    } catch {
      log.debug({}, 'i18n settings unavailable; using defaults');
    }
    this.settingsCache = { value: fallback, loadedAt: now };
    return fallback;
  }

  invalidateSettings(): void {
    this.settingsCache = undefined;
  }

  /**
   * Admin write of the instance defaults (the Settings page). Omitted keys keep their stored value.
   * A locale has to exist as a catalog directory (§41.3) and the default has to be enabled, so the
   * SPA can never be pointed at a language it cannot paint.
   */
  async saveSettings(
    patch: {
      defaultLocale?: string | undefined;
      enabledLocales?: string[] | undefined;
      defaultTimezone?: string | undefined;
    },
  ): Promise<I18nSettings> {
    const current = await this.settings();
    const available = this.localeList();
    const next: I18nSettings = {
      defaultLocale: patch.defaultLocale ?? current.defaultLocale,
      enabledLocales: patch.enabledLocales && patch.enabledLocales.length > 0 ? patch.enabledLocales : current.enabledLocales,
      defaultTimezone: patch.defaultTimezone ?? current.defaultTimezone,
    };
    if (!available.includes(next.defaultLocale)) {
      throw new ValidationError(`Unknown locale "${next.defaultLocale}".`, { available });
    }
    const unknown = next.enabledLocales.filter((locale) => !available.includes(locale));
    if (unknown.length > 0) {
      throw new ValidationError('Enabled locales must exist in the catalog directory.', { unknown, available });
    }
    if (!next.enabledLocales.includes(next.defaultLocale)) {
      throw new ValidationError('The default locale has to be one of the enabled locales.');
    }
    try {
      Intl.DateTimeFormat(undefined, { timeZone: next.defaultTimezone });
    } catch {
      throw new ValidationError(`Unknown time zone "${next.defaultTimezone}".`, { defaultTimezone: next.defaultTimezone });
    }
    await this.database.db
      .insertInto('app_settings')
      .values({ name: 'i18n', data: JSON.stringify(next), modified_at: new Date() })
      .onConflict((oc) => oc.column('name').doUpdateSet({ data: JSON.stringify(next), modified_at: new Date() }))
      .execute();
    this.invalidateSettings();
    return next;
  }

  /** Deep merged catalog: definitions from `en` under anything the requested locale overrides. */
  catalogFor(locale: string): Catalog {
    const catalogs = this.ensureCatalogs();
    const merged: Catalog = {};
    for (const [key, value] of Object.entries(catalogs.get('en') ?? {})) merged[key] = value;
    for (const [key, value] of Object.entries(catalogs.get(locale) ?? {})) merged[key] = value;
    return merged;
  }

  contentHash(locale: string): string {
    return createHash('sha256').update(JSON.stringify(this.catalogFor(locale))).digest('hex');
  }

  /**
   * Resolution chain (PLAN §41.4): requested locale → `en` → humanized key by the caller.
   * A key missing in **both** layers is a catalog gap: it must stay observable (§41.4),
   * so it emits a structured warning once per (locale, key).
   */
  translate(locale: string, key: string, variables?: Record<string, unknown>): string | undefined {
    // Translation must never be able to fail a request (PLAN §41.4): any problem loading
    // catalogs returns "missing", and the caller keeps its original string as the fallback.
    try {
      const catalogs = this.ensureCatalogs();
      // A header-derived tag like "vi-VN" resolves to its base language when only "vi" exists.
      const base = locale.includes('-') ? locale.split('-')[0] ?? locale : locale;
      const value = catalogs.get(locale)?.[key] ?? catalogs.get(base)?.[key] ?? catalogs.get('en')?.[key];
      if (typeof value === 'string') return interpolate(value, variables);
      if (!this.warnings.has(`${locale}:${key}`) && catalogs.get('en')?.[key] === undefined) {
        this.warnings.add(`${locale}:${key}`);
        log.warn({ key, locale }, 'i18n missing key');
      }
      return undefined;
    } catch (error) {
      if (!this.warnings.has(`catalog:${this.sourceDir}`)) {
        this.warnings.add(`catalog:${this.sourceDir}`);
        log.error({ err: error, dir: this.sourceDir }, 'i18n catalog load failed; translations disabled');
      }
      return undefined;
    }
  }

  /**
   * Metadata label resolution (PLAN §41.7). Metadata may carry a literal label; a catalog key
   * `crm.<entity>.label` / `crm.<entity>.fields.<field>` replaces it per request locale and the
   * literal stays the fallback for locales without a translation.
   */
  translateMetadata(metadata: Record<string, unknown>, locale: string): Record<string, unknown> {
    const out = structuredClone(metadata) as Record<string, Record<string, unknown>>;
    for (const [entityKey, raw] of Object.entries(out)) {
      if (typeof raw !== 'object' || raw === null) continue;
      const slug = entityKey.toLowerCase();
      const translated = this.translate(locale, `crm.${slug}.label`);
      if (translated !== undefined) raw['label'] = translated;
      const fields = raw['fields'];
      if (typeof fields === 'object' && fields !== null) {
        for (const [fieldName, field] of Object.entries(fields as Record<string, unknown>)) {
          if (typeof field !== 'object' || field === null) continue;
          const fieldLabel = this.translate(locale, `crm.${slug}.fields.${fieldName.toLowerCase()}`);
          if (fieldLabel !== undefined) (field as Record<string, unknown>)['label'] = fieldLabel;
        }
      }
      const layouts = raw['layouts'];
      if (typeof layouts === 'object' && layouts !== null) {
        for (const view of Object.values(layouts as Record<string, unknown>)) {
          if (!Array.isArray(view)) continue;
          for (const group of view) {
            const panels = (group as { panels?: unknown }).panels;
            if (!Array.isArray(panels)) continue;
            for (const panel of panels) {
              if (typeof panel !== 'object' || panel === null) continue;
              const name = (panel as Record<string, unknown>)['name'];
              if (typeof name === 'string') {
                const label = this.translate(locale, `crm.${slug}.panels.${name.toLowerCase()}`);
                if (label !== undefined) (panel as Record<string, unknown>)['label'] = label;
              }
            }
          }
        }
      }
    }
    return out as unknown as Record<string, unknown>;
  }

/** @deprecated sync callers should prefer `settings()`; kept only for quick checks. */
  syncSettings(): I18nSettings {
    if (this.settingsCache) return this.settingsCache.value;
    return { defaultLocale: 'en', enabledLocales: ['en', 'vi'], defaultTimezone: 'UTC' };
  }

  /** Resolves the error-message override for an error code under the request locale (§41.9). */
  translateError(locale: string, code: string, original: string): string {
    return this.translate(locale, `errors.${code}`) ?? original;
  }
}

/** Flattens nested catalog JSON into `module.a.b` leaf keys; never emits intermediate keys. */
function flatten(prefix: string, doc: unknown): Record<string, unknown> {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return { [prefix]: doc };
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc as Record<string, unknown>)) {
    Object.assign(out, flatten(`${prefix}.${key}`, value));
  }
  return out;
}

function validateKey(path: string, locale: string, module: string, fileName: string): void {
  if (!KEY_RE.test(path)) {
    throw new ValidationError(`i18n key "${path}" violates the naming convention (${locale}/${fileName}): ` + 'module-first, dot-separated lowercase segments [a-z][a-z0-9_]* (later segments may carry UPPER CODE).');
  }
  if (!path.startsWith(`${module}.`)) {
    throw new ValidationError(`i18n key "${path}" must live under its module namespace "${module}" (${locale}/${fileName}).`);
  }
}

function interpolate(template: string, variables?: Record<string, unknown>): string {
  if (!variables) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in variables ? String(variables[name]) : match));
}

function guardLocale(value: string | undefined, fallback: string): string {
  return typeof value === 'string' && LOCALE_RE.test(value) ? value : fallback;
}

/**
 * Parses `Accept-Language` against the enabled list (PLAN §41.4): the first exact tag wins,
 * then any language-prefix match, else undefined. Shared by the metadata and I18n controllers.
 */
export function acceptLanguageLocale(header: string | undefined, enabled: readonly string[]): string | undefined {
  if (!header) return undefined;
  for (const tag of header.split(',')) {
    const base = (tag.trim().split(';')[0] ?? '').toLowerCase().replace('_', '-');
    if (base === '') continue;
    if (enabled.includes(base)) return base;
    const prefix = base.split('-')[0] ?? '';
    if (prefix !== '' && enabled.includes(prefix)) return prefix;
  }
  return undefined;
}

/** Global error-message translator the exception filter reads instead of importing Nest wiring. */
type ErrorTranslator = (locale: string, code: string, original: string) => string;
let errorTranslator: ErrorTranslator | undefined;

export function registerErrorTranslator(translator: ErrorTranslator): void {
  errorTranslator = translator;
}

export function translateErrorMessage(locale: string, code: string, original: string): string {
  return errorTranslator ? errorTranslator(locale, code, original) : original;
}
