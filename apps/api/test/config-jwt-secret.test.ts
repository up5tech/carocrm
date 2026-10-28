import { afterAll, describe, expect, it } from 'vitest';

import { ConfigSchemaRefined, DEFAULT_JWT_SECRET } from '../src/config.js';

/**
 * Phase 22.4 (PLAN §9) — regression lock for the production JWT-secret guard.
 *
 * This is a pure unit test: it only parses the config schema, so it needs no database. It exists so
 * the development default secret (`dev-only-secret-change-me`) can never silently be accepted in a
 * production deployment, which would be a full authentication bypass.
 *
 * `singleFork: true` runs every API test in one worker process, so we restore NODE_ENV afterwards to
 * avoid leaking the value into neighbouring test files.
 */
describe('config JWT secret production guard', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('rejects the development default secret when NODE_ENV=production', () => {
    process.env.NODE_ENV = 'production';
    // Parsing with no overrides lets jwtSecret fall back to the development default.
    expect(() => ConfigSchemaRefined.parse({})).toThrow();
  });

  it('rejects the development default even when an operator types it explicitly in production', () => {
    process.env.NODE_ENV = 'production';
    expect(() => ConfigSchemaRefined.parse({ jwtSecret: DEFAULT_JWT_SECRET })).toThrow();
  });

  it('accepts an operator-supplied strong secret in production', () => {
    process.env.NODE_ENV = 'production';
    expect(() => ConfigSchemaRefined.parse({ jwtSecret: 'a-strong-prod-secret-0123456789' })).not.toThrow();
  });

  it('allows the development default secret outside production (dev/test)', () => {
    process.env.NODE_ENV = 'development';
    expect(() => ConfigSchemaRefined.parse({})).not.toThrow();
    process.env.NODE_ENV = 'test';
    expect(() => ConfigSchemaRefined.parse({})).not.toThrow();
  });
});
