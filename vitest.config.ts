import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/api/test/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    globalSetup: [],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});
