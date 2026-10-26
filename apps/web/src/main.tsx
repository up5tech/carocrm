import './styles/tokens.css';
import './styles/carocrm.css';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider } from 'antd';
import type { ReactNode } from 'react';
import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';

import { AppRoutes } from './AppRoutes.js';
import { AppErrorBoundary } from './components/AppErrorBoundary.js';
import { i18n, initI18n, initI18nFromCache } from './state/i18n.js';
import { useSettings } from './state/settings.js';
import { accentTone, themeForBrand } from './theme.js';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

// §20.13: a data router, because the unsaved-changes guard needs `useBlocker` — the plain
// BrowserRouter offers no navigation lifecycle to intercept. One catch-all route keeps
// AppRoutes' own <Routes> tree exactly as it was.
const router = createBrowserRouter([{ path: '*', element: <AppRoutes /> }]);

const container = document.getElementById('root');
if (!container) throw new Error('root element missing');

// One React root for the lifetime of the page. The catalog can arrive after the first paint (and
// the user can switch language later), so the tree is re-rendered in place — never re-rooted.
const root = createRoot(container);

/**
 * Applies the instance brand accent to the whole SPA: the shell's own CSS reads `--carocrm-accent*`
 * (set here on :root), and Ant Design's primary/info/link tokens come from `themeForBrand`. A null
 * brand keeps the shipped blue (§20.20). ConfigProvider lives inside the query provider because it
 * reads the public settings view.
 */
function BrandTheme({ children }: { children: ReactNode }): ReactNode {
  const settings = useSettings();
  const primaryColor = settings.data?.primaryColor ?? null;
  useEffect(() => {
    const tone = accentTone(primaryColor);
    const el = document.documentElement;
    el.style.setProperty('--carocrm-accent', tone.fg);
    el.style.setProperty('--carocrm-accent-hover', tone.hover);
    el.style.setProperty('--carocrm-accent-strong', tone.strong);
    el.style.setProperty('--carocrm-accent-soft', tone.soft);
  }, [primaryColor]);
  return (
    <ConfigProvider theme={themeForBrand(primaryColor)}>
      <AntApp>{children}</AntApp>
    </ConfigProvider>
  );
}

const render = (): void => {
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrandTheme>
          {/* §20.22: the outermost boundary. A failure in the shell itself has no other net. */}
          <AppErrorBoundary scope="app">
            <RouterProvider router={router} />
          </AppErrorBoundary>
        </BrandTheme>
      </QueryClientProvider>
    </StrictMode>,
  );
};

/**
 * Phase 7A (PLAN §41.4): restore the locale and paint before the first render — no flash of
 * English. The catalog fetch must never block (or abort) mounting: on a first visit there is no
 * cached catalog and the request can still fail (network, or server warming up), so `initI18n`
 * is guarded and the React tree is rendered with whatever resources are ready. The session
 * loader calls `activateLocale()` again once a token exists, completing the reconciliation.
 *
 * `t()` is a plain function, not a hook, so nothing subscribes to i18next by itself. Without a
 * re-render when the catalog lands, a screen painted before it arrived — the sign-in page, which
 * is the first thing anyone sees — would keep rendering raw keys such as `web.login.submit`.
 * The explicit `finally(render)` covers the cached/unchanged path where the language never
 * actually changes; the `languageChanged` listener also repaints the avatar language switch.
 */
initI18nFromCache()
  .catch(() => undefined)
  .finally(() => {
    render();
    i18n.on('languageChanged', render);
    // Refresh against the live instance in the background; failures here are non-fatal.
    void initI18n()
      .catch(() => undefined)
      .finally(render);
  });
