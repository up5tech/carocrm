import { useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../api/client.js';
import type { AdminPanelView, NavigationDocument, NavigationNode, NavigationTree, SettingsDocument } from '../api/types.js';

/**
 * Server state for Phase 20 (PLAN_Phase_20_Settings_UX.md §9.4). TanStack Query owns all of it; the
 * keys are the invalidation contract — a settings write drops the document, the public settings view
 * and the navigation tree, because a menu edit is only visible once `/Navigation` is re-resolved.
 */
export const SETTINGS_DOCUMENT_KEY = ['settings', 'document'] as const;

export function useAdminPanel() {
  return useQuery<AdminPanelView>({
    queryKey: ['adminPanel'],
    queryFn: () => api.adminPanel(),
    staleTime: 60_000,
  });
}

export function useNavigation() {
  return useQuery<NavigationTree>({
    queryKey: ['navigation'],
    queryFn: () => api.navigation(),
    staleTime: 30_000,
  });
}

export function useSettingsDocument<T>(name: string | undefined) {
  return useQuery<SettingsDocument<T>>({
    queryKey: [...SETTINGS_DOCUMENT_KEY, name ?? ''],
    queryFn: () => api.settingsDocument<T>(name ?? ''),
    enabled: name !== undefined && name !== '',
    staleTime: 30_000,
  });
}

export const useNavigationDocument = () => useSettingsDocument<NavigationDocument>('navigation');

/**
 * The navigation group keys this instance actually renders, taken from the resolved tree instead of a
 * second list in the SPA: the Entity Manager can only offer a group the menu really has, and the
 * server refuses any other name on save.
 */
export function useNavigationGroupKeys(): string[] {
  const tree = useNavigation();
  const out = new Set<string>();
  const walk = (nodes: readonly NavigationNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'group' && node.key.startsWith('group:')) out.add(node.key.slice('group:'.length));
      if (node.children !== undefined) walk(node.children);
    }
  };
  if (tree.data !== undefined) walk(tree.data.items);
  return [...out].sort();
}

/**
 * Writes a document with the version it read, then invalidates every view of it. A 409 means another
 * administrator saved first: the caller keeps its input and offers a reload rather than overwriting.
 */
export function useSettingsDocumentWriter(name: string) {
  const client = useQueryClient();
  return async <T>(value: Record<string, unknown>, version: number): Promise<SettingsDocument<T>> => {
    const saved = await api.saveSettingsDocument<T>(name, value, version);
    await invalidate(client, name);
    return saved;
  };
}

export function useSettingsDocumentResetter<T>(name: string) {
  const client = useQueryClient();
  return async (): Promise<SettingsDocument<T>> => {
    const saved = await api.resetSettingsDocument<T>(name);
    await invalidate(client, name);
    return saved;
  };
}

/**
 * A document write changes what the shell paints (`/Settings`, `/Navigation`) and what the tab reads,
 * so all three views are dropped together. Leaving one behind is how a saved menu appears not to work.
 */
async function invalidate(client: ReturnType<typeof useQueryClient>, name: string): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: [...SETTINGS_DOCUMENT_KEY, name] }),
    client.invalidateQueries({ queryKey: ['settings'] }),
    client.invalidateQueries({ queryKey: ['navigation'] }),
  ]);
}
