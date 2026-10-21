import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { api } from '../api/client.js';
import type { DocsPageView, DocsSearchView, DocsSettingsView, DocsTreeView, SettingsDocument } from '../api/types.js';
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

function readerLocale(): string {
  return i18n.language;
}

export function useDocsTree() {
  const locale = readerLocale();
  return useQuery<DocsTreeView>({
    queryKey: [...DOCS_TREE_KEY, locale],
    queryFn: () => api.docsTree(locale),
    staleTime: 5 * 60_000,
  });
}

export function useDocPage(section: string | undefined, slug: string | undefined) {
  const locale = readerLocale();
  return useQuery<DocsPageView>({
    queryKey: [...DOCS_PAGE_KEY, locale, section ?? '', slug ?? ''],
    queryFn: () => api.docsPage(section ?? '', slug ?? '', locale),
    enabled: section !== undefined && section !== '' && slug !== undefined && slug !== '',
    staleTime: 5 * 60_000,
  });
}

export function useDocSearch(query: string) {
  const locale = readerLocale();
  const trimmed = query.trim();
  return useQuery<DocsSearchView>({
    queryKey: ['docs', 'search', locale, trimmed],
    queryFn: () => api.docsSearch(trimmed, locale),
    enabled: trimmed.length >= 2,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
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
