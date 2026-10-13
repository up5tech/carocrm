import { useQuery } from '@tanstack/react-query';

import { api } from '../api/client.js';
import type { PortalContext } from '../api/types.js';
import { useSession } from './session.js';

/** Route base of the current user's app: `/portal` for portal users, '' for internal users. */
export function portalBase(principalType: string | undefined): string {
  return principalType === 'portal' ? '/portal' : '';
}

/** True when the signed-in user is a portal (external) user (PLAN §37). */
export function useIsPortalUser(): boolean {
  const { principal } = useSession();
  return principal?.type === 'portal';
}

export function usePortalContext() {
  return useQuery<PortalContext>({
    queryKey: ['portal', 'me'],
    queryFn: () => api.portalMe(),
    staleTime: 30_000,
    retry: false,
  });
}
