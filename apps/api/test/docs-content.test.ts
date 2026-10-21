import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { lintContent } from '@carocrm/docs';
import { describe, expect, it } from 'vitest';

import { adminTabDocKeys } from '../src/admin-panel/admin-panel.service.js';

/**
 * The content contract test (`PLAN_Phase_21_Documentation.md` §13.3): the shipped corpus linted with the
 * server's own knowledge, which is the one thing the engine's `corpus.test.ts` cannot check from inside
 * `packages/docs`.
 *
 * It exists for the failure nobody notices until a reader reports it: a settings tab renamed, a handbook
 * page moved, and eighteen "Learn more" links quietly pointing at nothing. The admin tab catalog is the
 * list of `docKey`s the product publishes, so every one of them has to resolve to a page in this
 * repository, or the release is broken.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CONTENT_DIR = `${ROOT}content/docs`;
const ASSET_DIR = `${ROOT}apps/web/public/docs-assets`;

/** The record types the handbook links to. A page may only link to a type it actually documents. */
const LINKED_ENTITIES = ['Account', 'Contact', 'Case', 'Call', 'Meeting', 'Task', 'Project', 'Email'];

function walk(dir: string): string[] {
  try {
    return readdirSync(dir).flatMap((entry) => {
      const path = `${dir}/${entry}`;
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  } catch {
    return [];
  }
}

const files = walk(CONTENT_DIR)
  .filter((path) => path.endsWith('.md'))
  .map((path) => ({ path: path.slice(ROOT.length), content: readFileSync(path, 'utf8') }));

const redirects = JSON.parse(readFileSync(`${CONTENT_DIR}/redirects.json`, 'utf8')) as Record<string, string>;
const assets = walk(ASSET_DIR).map((path) => path.slice(ASSET_DIR.length + 1));

const options = { tabDocKeys: adminTabDocKeys(), routes: { entities: LINKED_ENTITIES }, assets, redirects };

describe('the shipped corpus against the server catalog', () => {
  it('publishes admin tab docKeys, and they all resolve to a real page', () => {
    // Six distinct pages cover ten tabs: users/teams/roles share one page, as do general/localization.
    const keys = adminTabDocKeys();
    expect(keys.length).toBeGreaterThanOrEqual(6);
    const report = lintContent(files, options);
    expect(report.errors.filter((error) => error.code === 'unknownDocKey')).toEqual([]);
  });

  it('lints the corpus clean, including its links to the admin catalog', () => {
    expect(lintContent(files, options).errors).toEqual([]);
  });

  it('carries the P0 page set', () => {
    expect(lintContent(files, options).stats.pagesByLocale.en).toBeGreaterThanOrEqual(17);
  });

  it('would fail if a tab pointed at a page that does not exist', () => {
    // A cross-check that cannot fail is not a check, so prove the rule bites.
    const report = lintContent(files, { ...options, tabDocKeys: [...adminTabDocKeys(), 'admin/deleted-page'] });
    expect(report.errors.map((error) => error.key)).toContain('admin/deleted-page');
  });

  it('reads the redirect table as a map of old key to new key', () => {
    expect(typeof redirects).toBe('object');
    for (const [source, target] of Object.entries(redirects)) {
      expect(source).toMatch(/^[a-z0-9-]+\/[a-z0-9-]+$/);
      expect(target).toMatch(/^[a-z0-9-]+\/[a-z0-9-]+$/);
    }
  });
});
