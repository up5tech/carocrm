import './styles/tokens.css';
import './styles/carocrm.css';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider, theme as antdTheme } from 'antd';
import type { ReactNode } from 'react';
import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';

import { AppRoutes } from './AppRoutes.js';
import { AppErrorBoundary } from './components/AppErrorBoundary.js';
import { i18n, initI18n, initI18nFromCache } from './state/i18n.js';
import { usePreference } from './state/preferences.js';
import { useSettings } from './state/settings.js';
import { applyResolvedTheme, applyThemePreference, cacheThemePreference, readCachedThemePreference, type ResolvedTheme, systemTheme, ThemeModeContext, type ThemePreference, watchSystemTheme } from './state/theme.js';
import { accentToneSet, themeForBrand } from './theme.js';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: 'always' } },
});

// §20.13: a data router, because the unsaved-changes guard needs `useBlocker` — the plain
// BrowserRouter offers no navigation lifecycle to intercept. One catch-all route keeps
// AppRoutes' own <Routes> tree exactly as it was.
const router = createBrowserRouter([{ path: '*', element: <AppRoutes /> }]);

// Apply the cached theme preference before first paint to avoid a flash.
applyThemePreference(readCachedThemePreference());

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
 *
 * The theme is built for the *resolved* mode — the preference, or the OS when the preference is
 * `system`. Ant Design does not recompute a token the caller sets explicitly when the algorithm
 * changes, so a light-mode value left in the theme config would survive into dark mode and paint a
 * white panel in a dark shell.
 */
function BrandTheme({ children }: { children: ReactNode }): ReactNode {
  const settings = useSettings();
  const themePref = usePreference<ThemePreference>('theme');
  const primaryColor = settings.data?.primaryColor ?? null;
  const resolvedPref: ThemePreference =
    themePref.value === 'light' || themePref.value === 'dark' || themePref.value === 'system'
      ? themePref.value
      : readCachedThemePreference();
  // The OS colour scheme, tracked so a `system` preference repaints when the OS flips while the tab
  // is open. Ant Design's algorithm is chosen from the resolved mode, so the two halves of the
  // interface — the CSS custom properties and the component theme — always agree.
  const [osTheme, setOsTheme] = useState<ResolvedTheme>(() => systemTheme());
  const resolvedTheme: ResolvedTheme = resolvedPref === 'system' ? osTheme : resolvedPref;
  const isDark = resolvedTheme === 'dark';

  useEffect(() => {
    if (resolvedPref !== 'system') return undefined;
    return watchSystemTheme(setOsTheme);
  }, [resolvedPref]);

  useEffect(() => {
    const tone = accentToneSet(primaryColor, isDark);
    const el = document.documentElement;
    el.style.setProperty('--carocrm-accent', tone.fg);
    el.style.setProperty('--carocrm-accent-hover', tone.hover);
    el.style.setProperty('--carocrm-accent-strong', tone.strong);
    el.style.setProperty('--carocrm-accent-primary', tone.primary);
    el.style.setProperty('--carocrm-accent-soft', tone.soft);
  }, [primaryColor, isDark]);
  useEffect(() => {
    applyResolvedTheme(resolvedTheme);
  }, [resolvedTheme]);
  useEffect(() => {
    cacheThemePreference(resolvedPref);
  }, [resolvedPref]);

  const theme = useMemo(
    () => ({
      ...themeForBrand(primaryColor, isDark),
      algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    }),
    [primaryColor, isDark],
  );
  return (
    <ThemeModeContext.Provider value={resolvedTheme}>
      <ConfigProvider theme={theme}>
        <AntApp>{children}</AntApp>
      </ConfigProvider>
    </ThemeModeContext.Provider>
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
