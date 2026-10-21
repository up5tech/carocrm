import { keepPreviousData, type QueryKey,useQuery } from '@tanstack/react-query';

import { api } from '../api/client.js';
import type { DocPageMeta, DocsPageView, DocsSearchView, DocsSettingsView, DocsTreeView, SettingsDocument } from '../api/types.js';
import { SETTINGS_DOCUMENT_KEY } from './admin.js';
import { i18n } from './i18n.js';

/**
 * Server state for the in-app handbook (PLAN_Phase_21_Documentation.md §9.4), following `state/admin.ts`.
 *
 * Every key carries the locale the reader is looking at, because the same URL answers differently in `en`
 * and `vi` — and a `vi` page may be English text under a fallback notice. Switching language from the
 * avatar menu therefore repaints the whole surface without an explicit invalidation: the new key simply has
 * no cached result yet.
 *
 * Content is a release artifact, not live data, so the stale window is long (5 min) and there is no
 * background refetch. The server already publishes an `ETag` per locale and hash for a returning reader.
 */
export const DOCS_TREE_KEY = ['docs', 'tree'] as const;
export const DOCS_PAGE_KEY = ['docs', 'page'] as const;
export const DOCS_SEARCH_KEY = ['docs', 'search'] as const;

const TREE_STALE_MS = 5 * 60_000;

function readerLocale(): string {
  return i18n.language;
}

/**
 * The tree query, shared by the reader and the command palette. The palette passes `enabled: open`, which
 * is what keeps a shell that mounts the palette on every screen from spending a request on a handbook the
 * user never opened (§5.7: "nothing is fetched before the palette opens").
 */
function treeQuery(locale: string, enabled: boolean): {
  queryKey: QueryKey;
  queryFn: () => Promise<DocsTreeView>;
  staleTime: number;
  enabled: boolean;
} {
  return { queryKey: [...DOCS_TREE_KEY, locale], queryFn: () => api.docsTree(locale), staleTime: TREE_STALE_MS, enabled };
}

export function useDocsTree() {
  return useQuery(treeQuery(readerLocale(), true));
}

export function useDocPage(section: string | undefined, slug: string | undefined) {
  const locale = readerLocale();
  return useQuery<DocsPageView>({
    queryKey: [...DOCS_PAGE_KEY, locale, section ?? '', slug ?? ''],
    queryFn: () => api.docsPage(section ?? '', slug ?? '', locale),
    enabled: section !== undefined && section !== '' && slug !== undefined && slug !== '',
    staleTime: TREE_STALE_MS,
  });
}

/** A search is worth reusing for half a minute, and the previous results stay on screen while typing. */
export function useDocSearch(query: string, enabled = true) {
  const locale = readerLocale();
  const trimmed = query.trim();
  return useQuery<DocsSearchView>({
    queryKey: [...DOCS_SEARCH_KEY, locale, trimmed],
    queryFn: () => api.docsSearch(trimmed, locale),
    enabled: enabled && trimmed.length >= 2,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

export interface DocPaletteItem {
  readonly key: string;
  readonly title: string;
  readonly path: string;
  readonly detail: string;
}

/**
 * What the palette's `Documentation` group shows: ranked hits from the server once the reader has typed
 * two characters, and the getting-started pages before that — an empty box that lists nothing looks
 * broken, and those four pages are the right answer to "where do I start?" (§5.7).
 *
 * The ranking and the ACL scoping are the server's; the palette never filters content of its own.
 */
export function useDocPaletteItems(open: boolean, query: string): { items: readonly DocPaletteItem[]; pending: boolean } {
  const locale = readerLocale();
  const trimmed = query.trim();
  const searching = open && trimmed.length >= 2;

  const tree = useQuery(treeQuery(locale, open && !searching));
  const results = useQuery<DocsSearchView>({
    queryKey: [...DOCS_SEARCH_KEY, locale, trimmed],
    queryFn: () => api.docsSearch(trimmed, locale, 5),
    enabled: searching,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });

  if (searching) {
    const items = (results.data?.hits ?? []).map((hit) => ({ key: hit.key, title: hit.title, path: hit.path, detail: hit.section }));
    return { items, pending: results.isPending && results.data === undefined };
  }

  const gettingStarted = tree.data?.sections.find((section) => section.key === 'getting-started');
  const items: readonly DocPaletteItem[] = (gettingStarted?.pages ?? []).map((page: DocPageMeta) => ({
    key: page.key,
    title: page.title,
    path: page.path,
    detail: page.summary,
  }));
  return { items, pending: tree.isPending };
}

/**
 * The `docs` switches, read as a settings document (§6.1). The reader needs `supportEmail` for its empty
 * and disabled states, and the avatar menu needs `showHelpMenu`; both are the same small row.
 */
export function useDocsSettings() {
  return useQuery<SettingsDocument<DocsSettingsView>>({
    queryKey: [...SETTINGS_DOCUMENT_KEY, 'docs'],
    queryFn: () => api.settingsDocument<DocsSettingsView>('docs'),
    staleTime: 60_000,
  });
}

/** Every page key this caller may reach, from the server-filtered tree: what a doc link is checked against. */
export function useDocsPageKeys(): ReadonlySet<string> {
  const tree = useDocsTree();
  const keys = new Set<string>();
  for (const section of tree.data?.sections ?? []) {
    for (const page of section.pages) keys.add(page.key);
  }
  return keys;
}
