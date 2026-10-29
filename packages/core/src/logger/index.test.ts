import { Writable } from 'node:stream';

import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { REDACT_PATHS } from './index.js';

/**
 * Phase 22.21 — the log redaction contract.
 *
 * The logger's singleton is configured with {@link REDACT_PATHS}; this test builds a logger with the
 * same list and a captured stream, so it proves the paths actually redact rather than that the list
 * is non-empty. A credential that reaches a log line is unrecoverable, so the check covers the shapes
 * this codebase actually logs: top-level credential fields, nested connector results, request
 * headers with vendor names, and an OAuth-carrying database URL.
 */

function capture(): { stream: Writable; lines: () => string } {
  let output = '';
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  return { stream, lines: () => output };
}

describe('structured log redaction (22.21)', () => {
  it('drops credentials at the top level, one level down and in request headers', () => {
    const { stream, lines } = capture();
    const logger = pino({ redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' } }, stream);

    logger.info(
      {
        accessToken: 'agent-test-access-token',
        clientSecret: 'agent-test-client-secret',
        password: 'agent-test-password',
        databaseUrl: 'postgres://user:agent-test-password@db:5432/crm',
        connector: { refreshToken: 'agent-test-refresh', apiKey: 'agent-test-key' },
        req: {
          headers: {
            authorization: 'Bearer agent-test-bearer',
            cookie: 'session=agent-test-cookie',
            'x-api-key': 'agent-test-header-key',
            'x-webhook-signature': 'agent-test-signature',
          },
        },
        safe: 'this field stays',
      },
      'provider call failed',
    );

    const output = lines();
    for (const secret of [
      'agent-test-access-token',
      'agent-test-client-secret',
      'agent-test-password',
      'agent-test-refresh',
      'agent-test-key',
      'agent-test-bearer',
      'agent-test-cookie',
      'agent-test-header-key',
      'agent-test-signature',
    ]) {
      expect(output, secret).not.toContain(secret);
    }
    expect(output).toContain('[REDACTED]');
    expect(output).toContain('this field stays');
  });
});
