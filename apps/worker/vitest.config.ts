import { defineConfig } from 'vitest/config';

// Worker unit tests live next to the sources (apps/worker/src, files named `*.test.ts`) and
// run against the plain Queryable / logger test doubles — no Postgres or Redis needed. The
// root vitest config only collects apps/api/test plus packages/*/src, so the worker keeps
// its own config: `pnpm --filter @carocrm/worker test`.
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 20000,
  },
});
