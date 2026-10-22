import { afterAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap.js';
import { buildConfig } from '../src/config.js';

/**
 * The global limiter is a Fastify hook, and its refusal used to reach the SPA as
 * `INTERNAL_ERROR` / 500 — "the server crashed" for what is really "you are going too fast".
 * A CRM list screen fires several small calls per interaction, so paging quickly must produce a
 * 429 the client can act on, not a 500 it cannot.
 *
 * The app boots with `rateLimitMax: 1` so the second call trips the limiter; the counter lives in
 * this process' memory only, so nothing else is affected.
 */
process.env.LOG_LEVEL = 'error';

const app = await createApp({ ...buildConfig(), rateLimitMax: 1 }, { skipMigrations: true });

afterAll(async () => {
  await app.close();
});

describe('global rate limiter', () => {
  it('answers 429 RATE_LIMITED with a retry hint instead of a 500', async () => {
    const first = await app.inject({ method: 'GET', url: '/api/v1/OpenApi' });
    expect(first.statusCode).toBe(200);

    const limited = await app.inject({ method: 'GET', url: '/api/v1/OpenApi' });
    expect(limited.statusCode).toBe(429);

    const body = limited.json() as {
      error: { code: string; message: string; details?: { reason?: string; retryAfterSeconds?: number } };
    };
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.message).toBe('Rate limit exceeded. Please try again later.');
    expect(body.error.details?.reason).toContain('Rate limit exceeded, retry in');
    expect(body.error.details?.retryAfterSeconds).toBeGreaterThan(0);
    expect(limited.headers['retry-after']).toBeDefined();
  });
});
