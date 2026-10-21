import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { AclAction } from '@carocrm/acl/types/index.js';
import { AppError, AuthorizationDeniedError, NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { log } from '@carocrm/core/logger/index.js';
import type { ContentFile, DocPage, DocPageMeta, DocRedirects, DocSearchHit, DocSection, DocsIndex } from '@carocrm/docs';
import { buildIndex, contentHash, searchIndex } from '@carocrm/docs';
import { Inject, Injectable } from '@nestjs/common';

import { AclApiService } from '../acl/acl-api.service.js';
import { SettingsRegistryService } from '../admin-panel/settings-registry.service.js';
import type { DocsSettings } from '../admin-panel/settings-shapes.js';
import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { I18nService } from '../i18n/i18n.service.js';
import { DocsSettingsService } from './docs-settings.service.js';

/**
 * The content read path (PLAN_Phase_21_Documentation.md §7.4).
 *
 * Two properties are worth protecting:
 *
 *  - **Caller input never reaches `fs`.** The corpus is read as a whole, indexed into a map, and a page is
 *    looked up by its `section/slug` key. `/Docs/page/..%2f..%2fpackage.json` is therefore not "escaped
 *    safely", it is simply a key that does not exist (§10.1).
 *  - **The index is rebuilt when the files change, not on a timer.** Content is a few dozen small files, so
 *    reading them and hashing the result costs less than the cache bookkeeping a poller would, and a stale
 *    handbook is the failure mode nobody wants to debug. Parsing happens only when the signature moves.
 */

const MAX_QUERY_LENGTH = 120;
const MAX_SEARCH_LIMIT = 50;
const DEFAULT_SEARCH_LIMIT = 20;

export interface DocsTree {
  readonly enabled: boolean;
  readonly externalUrl: string | null;
  readonly locale: string;
  readonly fallbackLocale: string;
  readonly hash: string;
  readonly sections: readonly DocSection[];
  /** Present for an administrator only: what the `Docs` settings tab shows instead of a shell. */
  readonly diagnostics?: DocsDiagnostics;
}

export interface DocsLocaleReport {
  readonly locale: string;
  /** Pages the reader can reach in this locale, counting the ones served from the fallback corpus. */
  readonly pages: number;
  /** Pages actually translated here — the difference between the two is the fallback notice count. */
  readonly translated: number;
  readonly hash: string;
  readonly warnings: readonly { readonly code: string; readonly message: string; readonly key: string | null }[];
}

export interface DocsDiagnostics {
  readonly locales: readonly DocsLocaleReport[];
  /** Translated `vi` pages over English pages, 0–1. */
  readonly coverage: number;
}

/**
 * A page answer is either the page itself or the redirect the corpus declares for that key (§4.6).
 * `hash` and `locale` travel with it because the controller publishes them as the `ETag` pair, and the
 * locale a page actually came from is only known after the fallback chain has run.
 */
export type DocsPageResult =
  | { readonly kind: 'page'; readonly page: DocPage; readonly hash: string; readonly locale: string }
  | { readonly kind: 'redirect'; readonly to: string };

export interface DocsSearchResult {
  readonly query: string;
  readonly locale: string;
  readonly total: number;
  readonly hits: readonly DocSearchHit[];
}

/**
 * Locates `content/docs`. Mirrors `resolveCatalogDir()`: `process.cwd()` is not always the repository root
 * (`pnpm --filter @carocrm/api dev` starts inside `apps/api/`), so the walk upward is what makes the
 * handbook reachable in both launch modes, and `DOCS_DIR` still wins for a deployment that ships content
 * elsewhere (§15.2).
 */
function resolveDocsDir(): string {
  if (process.env.DOCS_DIR) return process.env.DOCS_DIR;
  let dir = process.cwd();
  for (let depth = 0; depth < 4; depth++) {
    const candidate = join(dir, 'content', 'docs');
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return join(process.cwd(), 'content', 'docs');
}

@Injectable()
export class DocsService {
  private readonly contentDir = resolveDocsDir();
  private cached: { readonly signature: string; readonly indexes: Map<string, DocsIndex> } | undefined;
  private redirects: DocRedirects | undefined;
  private warnedMissingDir = false;

  constructor(
    @Inject(I18nService) private readonly i18n: I18nService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(SettingsRegistryService) private readonly registry: SettingsRegistryService,
    @Inject(DocsSettingsService) private readonly docsSettings: DocsSettingsService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  async tree(requestedLocale?: string): Promise<DocsTree> {
    this.assertReader();
    const settings = await this.settings();
    const locale = await this.resolveLocale(requestedLocale);
    const index = this.index(locale);
    const sections = settings.enabled
      ? await Promise.all(index.sections.map(async (section) => ({ section, pages: await this.visiblePages(section) })))
      : [];

    const diagnostics = await this.diagnostics();
    return {
      enabled: settings.enabled,
      externalUrl: settings.externalUrl,
      locale,
      fallbackLocale: 'en',
      hash: index.hash,
      sections: sections.filter((entry) => entry.pages.length > 0).map((entry) => ({ ...entry.section, pages: entry.pages })),
      ...(diagnostics === undefined ? {} : { diagnostics }),
    };
  }

  async page(section: string, slug: string, requestedLocale?: string): Promise<DocsPageResult> {
    this.assertReader();
    const settings = await this.settings();
    if (!settings.enabled) throw featureDisabled();
    const locale = await this.resolveLocale(requestedLocale);
    const index = this.index(locale);
    const key = `${section}/${slug}`;
    const page = index.pages.get(key);

    if (page === undefined) {
      const target = this.readRedirects()[key];
      if (target !== undefined) return { kind: 'redirect', to: `/docs/${target}` };
      throw new NotFoundError(`Documentation page "${key}" does not exist.`);
    }
    if (!(await this.isVisible(page))) throw new AuthorizationDeniedError('This documentation page is not available to your account.', { key });
    return { kind: 'page', page, hash: index.hash, locale };
  }

  async search(query: string, requestedLocale?: string, limitParam?: string): Promise<DocsSearchResult> {
    this.assertReader();
    const settings = await this.settings();
    if (!settings.enabled) throw featureDisabled();
    const locale = await this.resolveLocale(requestedLocale);
    const limit = clampLimit(limitParam);
    const q = (query ?? '').slice(0, MAX_QUERY_LENGTH);
    const index = this.index(locale);

    if (q.trim().length < 2) return { query: q, locale, total: 0, hits: [] };

    // Over-fetch, then filter: the ranking is the engine's, the visibility decision is the server's, and
    // a page count that shrank because of permissions is honest — a search that leaks is not.
    const ranked = searchIndex(index, q, { limit: MAX_SEARCH_LIMIT });
    const hits: DocSearchHit[] = [];
    for (const hit of ranked.hits) {
      const page = index.pages.get(hit.key);
      if (page === undefined || !(await this.isVisible(page))) continue;
      hits.push(hit);
      if (hits.length >= limit) break;
    }
    if (hits.length === 0) log.debug({ locale, queryLength: q.length }, 'docs.search.empty');
    return { query: q, locale, total: hits.length, hits };
  }

  /**
   * Coverage and index warnings for the `Docs` settings tab (§12). An administrator should be able to
   * answer "how much of this is translated, and what is broken" from the UI; making them grep the server
   * log is how a corpus stays broken. Only the admin tier sees it, and it is the same warnings the
   * content lint already fails a build on.
   */
  private async diagnostics(): Promise<DocsDiagnostics | undefined> {
    if (!this.registry.mayRead('admin')) return undefined;
    const enabled = (await this.i18n.settings()).enabledLocales;
    const locales = enabled.map((locale) => {
      const index = this.index(locale);
      return {
        locale,
        pages: index.pages.size,
        translated: [...index.pages.values()].filter((page) => !page.fallback).length,
        hash: index.hash,
        warnings: index.warnings.map((warning) => ({ code: warning.code, message: warning.message, key: warning.key })),
      };
    });
    const english = locales.find((report) => report.locale === 'en');
    const vietnamese = locales.find((report) => report.locale === 'vi');
    const coverage = english !== undefined && english.pages > 0 && vietnamese !== undefined ? vietnamese.translated / english.pages : 0;
    return { locales, coverage };
  }

  /** The hash the controller publishes as an `ETag`; it is the content signature, not a request id. */
  contentHash(locale: string): string {
    return this.index(locale).hash;
  }

  private async settings(): Promise<DocsSettings> {
    return this.docsSettings.settings();
  }

  /**
   * Portal principals have no docs surface at all (§10.2). A tree request is refused here rather than
   * answered with an empty tree, because an empty handbook is a state a real reader can reach.
   */
  private assertReader(): void {
    if (this.scope.userType === 'portal') {
      throw new AuthorizationDeniedError('Documentation is not available to portal accounts.');
    }
  }

  /** `requested → principal → instance default`. A locale nobody installed is never an error (§8.3). */
  private async resolveLocale(requested?: string): Promise<string> {
    const enabled = (await this.i18n.settings()).enabledLocales;
    if (typeof requested === 'string' && enabled.includes(requested)) return requested;
    return this.scope.locale ?? enabled[0] ?? 'en';
  }

  private async visiblePages(section: DocSection): Promise<DocPageMeta[]> {
    const out: DocPageMeta[] = [];
    for (const page of section.pages) {
      if (await this.isVisible(page)) out.push(page);
    }
    return out;
  }

  /**
   * Audience is a convenience filter, `requires` is a real permission check: a page that documents a
   * screen the caller cannot read is hidden even from an administrator who lacks that entity (§10.2).
   */
  private async isVisible(page: DocPageMeta): Promise<boolean> {
    if (page.audience === 'admin' && !this.registry.mayRead('admin')) return false;
    if (page.requires === null) return true;
    const level = await this.acl.canUser(page.requires.entity, page.requires.action as AclAction);
    return level !== 'no';
  }

  /** Read every content file, then reuse the parsed indexes while the signature holds. */
  private index(locale: string): DocsIndex {
    const files = this.readFiles();
    const signature = contentHash(files);
    if (this.cached === undefined || this.cached.signature !== signature) this.cached = { signature, indexes: new Map() };

    const existing = this.cached.indexes.get(locale);
    if (existing !== undefined) return existing;

    const started = Date.now();
    const index = buildIndex(files, { locale });
    this.cached.indexes.set(locale, index);
    log.info({ locale, pages: index.pages.size, hash: index.hash, ms: Date.now() - started, warnings: index.warnings.length }, 'docs.index.built');
    for (const warning of index.warnings) log.warn({ locale: warning.locale, key: warning.key, code: warning.code, message: warning.message }, 'docs.index.warning');
    return index;
  }

  private readFiles(): ContentFile[] {
    if (!existsSync(this.contentDir)) {
      if (!this.warnedMissingDir) {
        this.warnedMissingDir = true;
        log.warn({ dir: this.contentDir }, 'docs.content.missing');
      }
      return [];
    }
    const out: ContentFile[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile() && entry.name.endsWith('.md')) {
          // The engine keys locale and section off the `/docs/` segment, so the path it is handed only has
          // to keep that shape; an absolute path does, and it makes the signature stable per process.
          out.push({ path, content: readFileSync(path, 'utf8') });
        }
      }
    };
    walk(this.contentDir);
    return out;
  }

  /** Malformed or absent redirects must not break reading; the corpus lint is what enforces this file. */
  private readRedirects(): DocRedirects {
    if (this.redirects !== undefined) return this.redirects;
    const path = join(this.contentDir, 'redirects.json');
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      this.redirects =
        typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? Object.fromEntries(Object.entries(parsed).filter(([, to]) => typeof to === 'string') as [string, string][])
          : {};
    } catch {
      this.redirects = {};
    }
    return this.redirects;
  }
}

function clampLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_SEARCH_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ValidationError('The "limit" parameter must be a positive integer.', { limit: raw });
  }
  return Math.min(parsed, MAX_SEARCH_LIMIT);
}

/** §8.4: a disabled surface answers a page request with 404, so a bookmark does not read as "forbidden". */
function featureDisabled(): AppError {
  return new AppError('FEATURE_DISABLED', 'Documentation is disabled on this instance.', { feature: 'docs' }, 404);
}
