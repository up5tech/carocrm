import { defineConfig, devices } from '@playwright/test';

const apiPort = process.env.E2E_API_PORT ?? '3140';
const webPort = process.env.E2E_WEB_PORT ?? '8140';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // Uses the configured project database from .env (AGENTS.md §3.1); creates nothing.
      command: `bash -c "pnpm db:seed && APP_PORT=${apiPort} JWT_SECRET=e2e-playwright-secret STORAGE_ROOT=.data/e2e-playwright NODE_ENV=production RATE_LIMIT_MAX=2000 MAIL_TRANSPORT=memory node apps/api/dist/main.js"`,
      url: `http://127.0.0.1:${apiPort}/health/ready`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
    {
      command: `bash -c "VITE_PORT=${webPort} VITE_API_TARGET=http://127.0.0.1:${apiPort} pnpm --filter @carocrm/web dev"`,
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
