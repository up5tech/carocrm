import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';

import { api } from '../api/client.js';
import type { SettingsView } from '../api/types.js';
import { DEFAULT_BRAND, setBrandTitle } from './page-title.js';

export { DEFAULT_BRAND };

/**
 * Instance settings (`GET /Settings`) — public by design, so the sign-in page shows the same brand
 * as the rest of the app.
 *
 * The brand is also one of the two writers of the browser-tab title (`state/page-title.ts`): the
 * screen supplies the page name, this query supplies the brand — the tab reads
 * `"<page> · <brand>"`. Writing here keeps the sign-in page (no page yet) on the brand alone.
 */
export function useSettings() {
  const query = useQuery<SettingsView>({
    queryKey: ['settings'],
    queryFn: () => api.settings(),
    staleTime: 60_000,
  });
  const title = query.data?.pageTitle ?? DEFAULT_BRAND;

  useEffect(() => {
    setBrandTitle(title);
  }, [title]);

  return query;
}
