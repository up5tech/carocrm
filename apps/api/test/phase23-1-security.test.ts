import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { randomCsrf } from '../src/auth/auth.controller.js';
import { resolveCorsOrigins } from '../src/bootstrap.js';
import { ConfigSchemaRefined } from '../src/config.js';

describe('phase 23.1 fail-closed configuration', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('CORS: unset allowlist fails closed', () => {
    expect(resolveCorsOrigins('')).toBe(false);
    expect(resolveCorsOrigins('   ')).toBe(false);
  });

  it('CORS: trims entries and drops empties', () => {
    expect(resolveCorsOrigins('http://a, http://b')).toEqual(['http://a', 'http://b']);
  });

  it('CORS: configured allowlist is preserved', () => {
    expect(resolveCorsOrigins('https://app.example.com')).toEqual(['https://app.example.com']);
  });

  it('CSRF: randomCsrf uses CSPRNG and varies', () => {
    const a = randomCsrf();
    const b = randomCsrf();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });

  it('JWT secret: rejects the development default in production', () => {
    process.env.NODE_ENV = 'production';
    expect(() => ConfigSchemaRefined.parse({})).toThrow();
  });

  it('encryption key: rejects an empty key in production', () => {
    process.env.NODE_ENV = 'production';
    expect(() =>
      ConfigSchemaRefined.parse({ jwtSecret: 'a-strong-prod-secret-0123456789', encryptionKey: '' }),
    ).toThrow();
  });

  it('encryption key: accepts a configured key in production', () => {
    process.env.NODE_ENV = 'production';
    expect(() =>
      ConfigSchemaRefined.parse({
        jwtSecret: 'a-strong-prod-secret-0123456789',
        encryptionKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        // Phase 23.9: production must name its own database URL, not the dev fallback.
        databaseUrl: 'postgres://carocrm_app:strong-password@db.internal:5432/carocrm',
        // Phase 23.6: production also requires enforced extension-package trust.
        extensionTrustMode: 'enforce',
        // Phase 24.3: production API processes never run DDL at startup.
        autoMigrate: false,
      }),
    ).not.toThrow();
  });

  it('JWT secret: allows the development default outside production', () => {
    process.env.NODE_ENV = 'development';
    expect(() => ConfigSchemaRefined.parse({})).not.toThrow();
  });
});

describe('phase 23.1 API key compare', () => {
  it('uses timingSafeEqual on the stored hash', () => {
    const src = readFileSync(resolve(process.cwd(), 'apps/api/src/auth/auth.service.ts'), 'utf8');
    expect(src).toContain('timingSafeEqual(Buffer.from(key.secret_hash');
  });
});

describe('phase 23.1 G94', () => {
  it('enforces CSRF on the cookie-driven refresh route', () => {
    const src = readFileSync(resolve(process.cwd(), 'apps/api/src/auth/auth.guard.ts'), 'utf8');
    expect(src).toContain("path.endsWith('/Refresh')");
    expect(src).toContain('timingSafeEqualStrings(csrfCookie, csrfHeader)');
  });
});

describe('phase 23.1 G52', () => {
  it('does not echo provider error text', () => {
    const src = readFileSync(resolve(process.cwd(), 'apps/api/src/advanced-integrations/oauth-flow.service.ts'), 'utf8');
    expect(src).not.toContain('The provider refused the authorization: ${input.error}');
    expect(src).toContain("The provider refused the authorization.");
  });
});

describe('phase 23.1 CSP', () => {
  it('does not permit unsafe-eval and declares the core directives', () => {
    const src = readFileSync(resolve(process.cwd(), 'apps/api/src/bootstrap.ts'), 'utf8');
    expect(src).not.toContain('unsafe-eval');
    expect(src).toContain("defaultSrc:");
    expect(src).toContain("scriptSrc:");
    expect(src).toContain("objectSrc:");
  });
});