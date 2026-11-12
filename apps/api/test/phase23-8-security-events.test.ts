import { log } from '@carocrm/core/logger/index.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { recordSecurityEvent, resetSecurityEventCounters, securityEventSnapshot } from '../src/common/security-events.js';

/**
 * Phase 23.8 — the bounded security-event seam (PLAN §14 task 4).
 *
 * No database and no app boot: this suite pins the contract that a caller cannot put a payload into
 * a security log, that counts are deterministic, and that the snapshot is sorted (a stable admin
 * view). The wiring at the auth guard, webhook ingresses and denial audit is covered by their own
 * suites and the operator snapshot test.
 */

afterEach(() => {
  vi.restoreAllMocks();
  resetSecurityEventCounters();
});

describe('security event telemetry', () => {
  it('counts events by name and outcome for the operations snapshot', () => {
    resetSecurityEventCounters();
    recordSecurityEvent('access.denied', 'denied', { reason: 'AUTHORIZATION_DENIED' });
    recordSecurityEvent('access.denied', 'denied', { reason: 'AUTHORIZATION_DENIED' });
    recordSecurityEvent('webhook.replay', 'detected', { provider: 'stripe' });

    expect(securityEventSnapshot().events).toEqual({
      'access.denied:denied': 2,
      'webhook.replay:detected': 1,
    });
    expect(securityEventSnapshot().since).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('drops a detail that is not a short allowlisted label instead of logging it', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    recordSecurityEvent('webhook.signature.rejected', 'denied', {
      provider: 'docusign',
      reason: 'Bearer secret-token-value that must never be logged',
    });

    const fields = warn.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(fields).toMatchObject({
      securityEvent: 'webhook.signature.rejected',
      outcome: 'denied',
      provider: 'docusign',
    });
    expect(fields?.['reason']).toBeUndefined();
    expect(JSON.stringify(fields)).not.toContain('secret-token-value');
  });

  it('resets counts without touching the vocabulary', () => {
    recordSecurityEvent('auth.login.failed', 'failed', { reason: 'invalid_credentials' });
    expect(securityEventSnapshot().events).not.toEqual({});
    resetSecurityEventCounters();
    expect(securityEventSnapshot().events).toEqual({});
  });
});
