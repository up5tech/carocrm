import { AppError, ValidationError } from '@carocrm/core/errors/index.js';
import { describe, expect, it } from 'vitest';

import { GlobalExceptionFilter } from '../src/common/global-exception.filter.js';

/**
 * Phase 22.15 — the error envelope the SPA is allowed to see
 * (`PLAN_Phase_22_Integration_E2E_Hardening.md` §14 tasks 2 and 10).
 *
 * One envelope, one rule: a refusal the operator needs to understand keeps its specific text, and an
 * unexpected failure keeps nothing but its code. The filter is where that line is drawn, so it is
 * tested here rather than at the ~150 call sites that render `error.message`.
 *
 * No database and no booted application: the filter is pure transformation of an exception into a
 * reply, so the cheapest honest check is to hand it a fake one.
 */

interface Captured {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

function host(url = '/api/v1/Account'): { readonly sent: Captured } {
  const sent: Captured = { status: 0, body: {} };
  const reply = {
    status(value: number) {
      sent.status = value;
      return this;
    },
    send(value: unknown) {
      sent.body = value as Record<string, unknown>;
      return this;
    },
    getHeader() {
      return undefined;
    },
  };
  const request = { id: 'req-error-hygiene', url };
  return Object.assign(
    {
      switchToHttp: () => ({
        getResponse: () => reply,
        getRequest: () => request,
      }),
    },
    { sent },
  ) as unknown as { readonly sent: Captured };
}

function catchError(exception: unknown, url?: string): Captured {
  const context = host(url);
  new GlobalExceptionFilter().catch(exception, context as unknown as never);
  return context.sent;
}

function errorOf(captured: Captured): { code: string; message: string; details?: Record<string, unknown> } {
  return ((captured.body['error'] ?? {}) as {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  });
}

describe('the error envelope (§14 task 10)', () => {
  it('answers one shape for every failure', () => {
    for (const exception of [
      new ValidationError('A case needs a requester.'),
      new AppError('CONFLICT', 'That stage belongs to another board.', undefined, 409),
      new Error('boom'),
    ]) {
      const captured = catchError(exception);
      expect(captured.status).toBeGreaterThanOrEqual(400);
      expect(Object.keys(captured.body)).toEqual(['error']);
      expect(errorOf(captured).code).toBeTruthy();
      expect(typeof errorOf(captured).message).toBe('string');
    }
  });

  it('keeps the specific reason of a 4xx refusal, because the operator has to act on it', () => {
    const captured = catchError(new ValidationError('A case needs a requester.'));
    const error = errorOf(captured);
    expect(captured.status).toBe(422);
    expect(error.code).toBe('VALIDATION_FAILED');
    // With the catalog loaded the message is the generic face of the code and the sentence travels as
    // `details.reason`; without it (this unit, no i18n service booted) the sentence stays the message.
    // Either way the caller can read WHY the request was refused, which is the contract the SPA relies on.
    expect([error.message, String(error.details?.['reason'] ?? '')]).toContain('A case needs a requester.');
    expect(JSON.stringify(captured.body)).toContain('A case needs a requester.');
  });

  it('sends a 5xx as a code and nothing else', () => {
    // A database driver quoting a statement is the case that matters: the text of an unexpected error
    // is not the caller's to read, and the request is logged with it anyway.
    const leaked = 'select id, password_hash from users where email = $1 — column "password_hash" does not exist';
    const captured = catchError(new Error(leaked));
    const error = errorOf(captured);
    expect(captured.status).toBe(500);
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.message).toBe('Internal server error.');
    expect(JSON.stringify(captured.body)).not.toContain('password_hash');
    expect(JSON.stringify(captured.body)).not.toContain('select ');
    expect(error.details?.['reason']).toBeUndefined();
  });

  it('names a duplicate from the constraint, never from the SQL that raised it', () => {
    const violation = Object.assign(new Error(`duplicate key value violates unique constraint "users_user_name_key"`), {
      code: '23505',
    });
    const captured = catchError(violation);
    const error = errorOf(captured);
    expect(captured.status).toBe(409);
    expect(error.code).toBe('DUPLICATE_RECORD');
    expect(JSON.stringify(captured.body)).not.toContain('duplicate key value violates');
    expect(JSON.stringify(captured.body)).not.toContain('users_user_name_key');
  });

  it('carries the retry number a throttled caller needs, in the body as well as the header', () => {
    const captured = catchError(new AppError('RATE_LIMITED', 'Too many requests.', undefined, 429));
    // The fake reply reports no header, so the field is absent rather than a zero — and a caller that
    // reads it must treat a missing number as "the sentence is all there is".
    expect(errorOf(captured).details?.['retryAfterSeconds']).toBeUndefined();
    expect(errorOf(captured).code).toBe('RATE_LIMITED');
  });

  it('keeps a conflict the module wrote for a human, and drops one it did not', () => {
    const refusal = catchError(new AppError('CONFLICT', 'The record changed since you opened it.', undefined, 409));
    expect(errorOf(refusal).code).toBe('CONFLICT');
    expect(JSON.stringify(refusal.body)).toContain('The record changed since you opened it.');
    // A 500 is the same class of response shape with nothing inside it.
    const accident = catchError(new Error('update invoice_lines set amount = … failed'));
    expect(errorOf(accident).code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(accident.body)).not.toContain('invoice_lines');
  });
});
