import type { NavigationNode } from '../api/types.js';
import { usePreference } from './preferences.js';

/**
 * Favorites / pinned navigation (PLAN_Phase_20_Settings_UX.md §5.1).
 *
 * The list is the `favorites` preference, which lives on the server so it follows the account to the
 * next device (§5.9) — never `localStorage`. It stores **routes**, and the shell resolves them
 * against the tree the server already filtered for this caller: a route the user may no longer open
 * simply does not render, so a favorite can never become a permission bypass or a dead link.
 */
export const MAX_FAVORITES = 20;

/** The route a path selects: `/Contact/42` → `/Contact`, `/admin/jobs` → `/admin/jobs`. */
export function currentNavRoute(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return '/home';
  if (segments[0] === 'admin') return `/${segments.slice(0, 2).join('/')}`;
  return `/${segments[0]}`;
}

export interface FavoriteLeaf {
  readonly key: string;
  readonly route: string;
  readonly label: string;
}

/** Leaves of the resolved tree whose route the user pinned, in the user's own order. */
export function favoriteLeaves(nodes: readonly NavigationNode[], routes: readonly string[]): FavoriteLeaf[] {
  const byRoute = new Map<string, FavoriteLeaf>();
  const walk = (list: readonly NavigationNode[]): void => {
    for (const node of list) {
      if (node.kind !== 'group' && routes.includes(node.route)) {
        byRoute.set(node.route, { key: node.key, route: node.route, label: node.label });
      }
      if (node.children !== undefined) walk(node.children);
    }
  };
  walk(nodes);
  return routes
    .map((route) => byRoute.get(route))
    .filter((leaf): leaf is FavoriteLeaf => leaf !== undefined)
    .slice(0, MAX_FAVORITES);
}

export function useFavorites(): {
  routes: string[];
  isFavorite: (route: string) => boolean;
  toggle: (route: string) => void;
  saving: boolean;
} {
  const preference = usePreference<string[]>('favorites');
  const routes = preference.value ?? [];
  return {
    routes,
    isFavorite: (route: string) => routes.includes(route),
    toggle: (route: string) => {
      const next = routes.includes(route)
        ? routes.filter((candidate) => candidate !== route)
        : [...routes, route].slice(0, MAX_FAVORITES);
      preference.save(next);
    },
    saving: preference.saving,
  };
}
