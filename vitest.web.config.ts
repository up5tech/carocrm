import { defineConfig } from 'vitest/config';

/**
 * The SPA's own test project (PLAN_Phase_20_Settings_UX.md §20.26).
 *
 * Kept separate from the root `vitest.config.ts` (which boots the API against the configured
 * database) so `pnpm test` stays database-backed while `pnpm test:web` stays fast and
 * dependency-free. These tests are pure logic plus server-rendered markup (`react-dom/server`), so
 * they run in the `node` environment and need no jsdom. The axe audit is the one piece that does need
 * a DOM; it is tracked in §20.26 as the remaining, dependency-gated step.
 */
export default defineConfig({
  test: {
    include: ['apps/web/src/**/*.test.ts', 'apps/web/src/**/*.test.tsx'],
    environment: 'node',
    testTimeout: 20000,
  },
});
