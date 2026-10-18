import './styles/carocrm.css';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider } from 'antd';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { AppRoutes } from './AppRoutes.js';
import { i18n, initI18n, initI18nFromCache } from './state/i18n.js';
import { carocrmTheme } from './theme.js';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

const container = document.getElementById('root');
if (!container) throw new Error('root element missing');

// One React root for the lifetime of the page. The catalog can arrive after the first paint (and
// the user can switch language later), so the tree is re-rendered in place — never re-rooted.
const root = createRoot(container);

const render = (): void => {
  root.render(
    <StrictMode>
      <ConfigProvider theme={carocrmTheme}>
        <AntApp>
          <QueryClientProvider client={queryClient}>
            <BrowserRouter>
              <AppRoutes />
            </BrowserRouter>
          </QueryClientProvider>
        </AntApp>
      </ConfigProvider>
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
