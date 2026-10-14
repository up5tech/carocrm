import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';

import { api } from '../api/client.js';
import type { SettingsView } from '../api/types.js';

/** Fallback brand text, matching the static `<title>` in `index.html`. */
export const DEFAULT_BRAND = 'CaroCRM';

/**
 * Instance settings (`GET /Settings`) — public by design, so the sign-in page shows the same brand
 * as the rest of the app.
 *
 * The hook also owns the browser tab title: the page title is an instance setting, and a static
 * `index.html` can only carry the default. Every consumer of this query sets the same value, so
 * running the effect more than once per render pass is harmless.
 */
export function useSettings() {
  const query = useQuery<SettingsView>({
    queryKey: ['settings'],
    queryFn: () => api.settings(),
    staleTime: 60_000,
  });
  const title = query.data?.pageTitle ?? DEFAULT_BRAND;

  useEffect(() => {
    document.title = title;
  }, [title]);

  return query;
}
