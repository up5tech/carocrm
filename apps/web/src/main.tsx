import './styles/lizant.css';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider } from 'antd';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { AppRoutes } from './AppRoutes.js';
import { initI18n, initI18nFromCache } from './state/i18n.js';
import { lizantTheme } from './theme.js';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

const root = document.getElementById('root');
if (!root) throw new Error('root element missing');

const render = (): void => {
  createRoot(root).render(
    <StrictMode>
      <ConfigProvider theme={lizantTheme}>
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
 */
initI18nFromCache()
  .catch(() => undefined)
  .finally(() => {
    render();
    // Refresh against the live instance in the background; failures here are non-fatal.
    void initI18n().catch(() => undefined);
  });
