import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildIndex } from './index-builder.js';
import { lintContent } from './lint.js';
import { searchIndex } from './search.js';
import type { ContentFile } from './types.js';

/**
 * The contract test for the shipped corpus (§13.3), and the reason "we released a screen without a page"
 * cannot stay invisible. It runs the same lint an author runs, against the real files in `content/docs`,
 * so a dead link, a renamed route or a page with no audience fails `pnpm test` instead of failing a reader.
 *
 * The route allowlist names the entities this corpus links to. It is deliberately not the whole CRM
 * schema: a page may only link to a record type it actually documents.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CONTENT_DIR = `${ROOT}content/docs`;
const ASSET_DIR = `${ROOT}apps/web/public/docs-assets`;
const LINKED_ENTITIES = ['Account', 'Contact', 'Case', 'Call', 'Meeting', 'Task', 'Project', 'Email', 'EmailTemplate'];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = `${dir}/${entry}`;
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function assetNames(): string[] {
  try {
    return readdirSync(ASSET_DIR);
  } catch {
    return [];
  }
}

const files: readonly ContentFile[] = walk(CONTENT_DIR)
  .filter((path) => path.endsWith('.md'))
  .map((path) => ({ path: path.slice(ROOT.length), content: readFileSync(path, 'utf8') }));

const report = lintContent(files, { assets: assetNames(), routes: { entities: LINKED_ENTITIES } });
const english = buildIndex(files, { locale: 'en' });

describe('the shipped documentation corpus', () => {
  it('has pages to lint at all', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('lints without an error', () => {
    expect(report.errors).toEqual([]);
  });

  it('carries the §4.8 inventory: 4 getting-started, 15 user, 24 admin, 5 reference', () => {
    expect(english.sections.map((section) => `${section.key}:${String(section.pages.length)}`)).toEqual([
      'getting-started:4',
      'user:15',
      'admin:24',
      'reference:5',
    ]);
  });

  it('gives every page a summary a card can show and an audience that filters it', () => {
    for (const page of english.pages.values()) {
      expect(page.summary.length).toBeGreaterThan(0);
      expect(page.audience).toMatch(/^(user|admin)$/);
      expect(english.sections.find((section) => section.key === page.section)?.audience).toBe(page.audience);
    }
  });

  it('deep-links most pages into the screen they describe', () => {
    const withLink = [...english.pages.values()].filter((page) => page.appLink !== null);
    expect(withLink.length).toBeGreaterThanOrEqual(12);
  });

  it('translates the 17 P0 pages into `vi` and falls back to English for the rest', () => {
    const vietnamese = buildIndex(files, { locale: 'vi' });
    // `en` still defines the tree, so a `vi` reader sees all four sections and all 40 pages.
    expect(vietnamese.sections.map((section) => section.pages.length)).toEqual([4, 15, 24, 5]);

    const p0 = [
      'getting-started/sign-in',
      'getting-started/find-your-way',
      'getting-started/your-profile',
      'getting-started/keyboard-shortcuts',
      'user/lists-and-views',
      'user/record-page',
      'user/activities-and-tasks',
      'user/stream-and-notifications',
      'user/search',
      'user/dashboards-and-reports',
      'user/import-export',
      'admin/settings-overview',
      'admin/branding-and-localization',
      'admin/main-menu',
      'admin/users-teams-roles',
      'admin/api-keys',
      'admin/entities-and-fields',
    ];
    expect(p0).toHaveLength(17);
    for (const key of p0) {
      expect(vietnamese.pages.get(key)).toMatchObject({ fallback: false, locale: 'vi' });
    }
    // Nothing beyond the P0 set is translated yet, and each of those pages carries the flag that makes the
    // reader see it is reading English (§4.7).
    expect([...vietnamese.pages.values()].filter((page) => !page.fallback)).toHaveLength(17);
    expect(vietnamese.pages.get('reference/glossary')).toMatchObject({ fallback: true, locale: 'en' });
  });

  it('gives every untranslated page a Vietnamese alias a reader can search for', () => {
    // A page served in English to a Vietnamese reader is only findable by its English words unless it
    // carries aliases. `CRMChat`'s handbook tools search the reader's own locale, so a page without an
    // alias is invisible to the question that would have been asked about it in Vietnamese.
    const vietnamese = buildIndex(files, { locale: 'vi' });
    const fallbacks = [...vietnamese.pages.values()].filter((page) => page.fallback);
    expect(fallbacks.length).toBeGreaterThan(0);
    for (const page of fallbacks) {
      expect(page.aliases.length, `${page.key} needs at least one alias`).toBeGreaterThan(0);
    }
  });

  it('finds an admin page from a diacritic-free query', () => {
    const vietnamese = buildIndex(files, { locale: 'vi' });
    expect(searchIndex(vietnamese, 'sidebar').hits.map((hit) => hit.key)).toContain('admin/main-menu');
  });

  it('builds the index inside the timing budget', () => {
    const started = performance.now();
    buildIndex(files, { locale: 'en' });
    expect(performance.now() - started).toBeLessThan(100);
  });
});
