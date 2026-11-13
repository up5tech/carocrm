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
      // Uses the configured project database (AGENTS.md §3.1); creates nothing.
      //
      // Phase 23.10: this used to run with `NODE_ENV=production`, which stopped working when Phase
      // 23.9 added the production boot guards — they correctly refuse an unset/placeholder
      // DATABASE_URL, and this harness has no deployment-owned secret to give them. The guards
      // themselves are covered by `apps/api/test/config-jwt-secret.test.ts`; the browser suite needs
      // a runnable API, so it boots in `test` mode against the configured database instead of
      // weakening the guard or hard-coding a connection string here.
      command: `bash -c "pnpm db:seed && APP_PORT=${apiPort} JWT_SECRET=e2e-playwright-secret STORAGE_ROOT=.data/e2e-playwright NODE_ENV=test RATE_LIMIT_MAX=2000 MAIL_TRANSPORT=memory node apps/api/dist/main.js"`,
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
