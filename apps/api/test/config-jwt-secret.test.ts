import { afterAll, describe, expect, it } from 'vitest';

import { COMPOSE_JWT_SECRET, ConfigSchemaRefined, DEFAULT_JWT_SECRET } from '../src/config.js';

const PRODUCTION_BASE = {
  jwtSecret: 'a-strong-prod-secret-0123456789',
  encryptionKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  databaseUrl: 'postgres://carocrm_app:strong-password@db.internal:5432/carocrm',
  // Phase 23.6: production also requires enforced extension-package trust.
  extensionTrustMode: 'enforce',
  autoMigrate: false,
};

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
    expect(() => ConfigSchemaRefined.parse(PRODUCTION_BASE)).not.toThrow();
  });

  it('rejects the compose placeholder secret in production (Phase 23.9)', () => {
    process.env.NODE_ENV = 'production';
    expect(() => ConfigSchemaRefined.parse({ ...PRODUCTION_BASE, jwtSecret: COMPOSE_JWT_SECRET })).toThrow(/JWT_SECRET/);
  });

  it('rejects the development database fallback in production (Phase 23.9)', () => {
    process.env.NODE_ENV = 'production';
    expect(() => ConfigSchemaRefined.parse({ ...PRODUCTION_BASE, databaseUrl: undefined })).toThrow(/DATABASE_URL/);
  });

  it('requires enforced extension trust in production', () => {
    process.env.NODE_ENV = 'production';
    expect(() => ConfigSchemaRefined.parse({ ...PRODUCTION_BASE, extensionTrustMode: 'warn' })).toThrow(/EXTENSION_TRUST_MODE/);
    expect(() => ConfigSchemaRefined.parse({ ...PRODUCTION_BASE, extensionTrustMode: 'off' })).toThrow(/EXTENSION_TRUST_MODE/);
  });

  it('requires a 32-byte encryption key and rejects wildcard CORS in production', () => {
    process.env.NODE_ENV = 'production';
    expect(() => ConfigSchemaRefined.parse({ ...PRODUCTION_BASE, encryptionKey: '' })).toThrow(/ENCRYPTION_KEY/);
    expect(() => ConfigSchemaRefined.parse({ ...PRODUCTION_BASE, encryptionKey: 'x'.repeat(64) })).toThrow(/ENCRYPTION_KEY/);
    expect(() => ConfigSchemaRefined.parse({ ...PRODUCTION_BASE, corsOrigins: 'https://app.example.com,*' })).toThrow(/CORS_ORIGINS/);
    expect(() => ConfigSchemaRefined.parse({ ...PRODUCTION_BASE, corsOrigins: 'https://app.example.com' })).not.toThrow();
  });

  it('requires migrations to be disabled in production API processes', () => {
    process.env.NODE_ENV = 'production';
    expect(() => ConfigSchemaRefined.parse({ ...PRODUCTION_BASE, autoMigrate: true })).toThrow(/AUTO_MIGRATE/);
    expect(() => ConfigSchemaRefined.parse(PRODUCTION_BASE)).not.toThrow();
  });

  it('allows the development default secret outside production (dev/test)', () => {
    process.env.NODE_ENV = 'development';
    expect(() => ConfigSchemaRefined.parse({})).not.toThrow();
    process.env.NODE_ENV = 'test';
    expect(() => ConfigSchemaRefined.parse({})).not.toThrow();
  });
});
