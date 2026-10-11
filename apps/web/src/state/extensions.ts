import { useQuery } from '@tanstack/react-query';

import { api } from '../api/client.js';
import type { ExtensionListResult, ExtensionNavItem } from '../api/types.js';

/**
 * Extension state for the SPA (PLAN §38.4, §40.1).
 *
 * Navigation entries come from `GET /api/v1/Extension/frontend`, which already removes entries the
 * signed-in user may not see — the client renders what the server allows and never decides
 * authorisation itself. An installation with no extensions answers `{ nav: [] }`, so the UI adds
 * nothing to the sidebar.
 */
export function useExtensionNav() {
  return useQuery<{ nav: ExtensionNavItem[] }>({
    queryKey: ['extensions', 'frontend'],
    queryFn: () => api.extensionFrontend(),
    staleTime: 30_000,
    retry: false,
  });
}

export function useExtensions(admin: boolean | undefined) {
  return useQuery<ExtensionListResult>({
    queryKey: ['extensions'],
    queryFn: () => api.extensions(),
    enabled: admin === true,
    staleTime: 10_000,
    retry: false,
  });
}