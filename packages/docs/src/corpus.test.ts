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
const LINKED_ENTITIES = ['Account', 'Contact', 'Case', 'Call', 'Meeting', 'Task', 'Project', 'Email'];

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

  it('carries the P0 set: four getting-started, seven user, six admin', () => {
    expect(english.sections.map((section) => `${section.key}:${String(section.pages.length)}`)).toEqual([
      'getting-started:4',
      'user:7',
      'admin:6',
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

  it('is structured for `vi` before it is translated', () => {
    const vietnamese = buildIndex(files, { locale: 'vi' });
    expect(vietnamese.sections.map((section) => section.pages.length)).toEqual([4, 7, 6]);
    expect(vietnamese.pages.get('admin/main-menu')).toMatchObject({ fallback: true, locale: 'en' });
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
