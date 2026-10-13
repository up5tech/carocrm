import './styles/lizant.css';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider } from 'antd';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { AppRoutes } from './AppRoutes.js';
import { initI18n } from './state/i18n.js';
import { lizantTheme } from './theme.js';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

const container = document.getElementById('root');
if (!container) throw new Error('root element missing');

/** Phase 7A (PLAN §41.4): the locale is restored before the first paint — no flash of English. */
void initI18n().then(() => {
  createRoot(container).render(
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
});
