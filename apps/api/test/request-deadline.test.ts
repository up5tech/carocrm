import { RequestTimeoutError } from '@carocrm/core/errors/index.js';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { of, throwError, timer } from 'rxjs';
import { describe, expect, it } from 'vitest';

import { GlobalExceptionFilter } from '../src/common/global-exception.filter.js';
import { RequestTimeoutInterceptor } from '../src/common/request-timeout.interceptor.js';
import { buildConfig } from '../src/config.js';
import { DatabaseService } from '../src/database/database.service.js';

/**
 * G74 — nothing bounded a request's *duration*: the pool set no `statement_timeout`/`lock_timeout`,
 * no route had a deadline, and the rate limiter bounds request rate, not request length. These tests
 * pin the three halves of the fix: the caps the pool really sends, the envelope a cancelled statement
 * becomes, and the HTTP deadline that answers `REQUEST_TIMEOUT` instead of letting the client wait.
 */

function httpContext(contentType?: string): ExecutionContext {
  const request = { headers: contentType === undefined ? {} : { 'content-type': contentType } };
  return {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }),
  } as unknown as ExecutionContext;
}

function firstValue<T>(observable: { subscribe: (observer: unknown) => unknown }): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    observable.subscribe({
      next: (value: T) => resolve(value),
      error: (error: unknown) => reject(error instanceof Error ? error : new Error(String(error))),
    });
  });
}

describe('request deadline (G74)', () => {
  it('answers REQUEST_TIMEOUT / 503 when a handler outlives its budget', async () => {
    const interceptor = new RequestTimeoutInterceptor(20);
    const slow: CallHandler = { handle: () => timer(500) };

    let error: unknown;
    try {
      await firstValue(interceptor.intercept(httpContext(), slow));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RequestTimeoutError);
    expect(error).toMatchObject({ code: 'REQUEST_TIMEOUT', statusCode: 503 });
  });

  it('leaves a handler that finishes inside the budget alone', async () => {
    const interceptor = new RequestTimeoutInterceptor(1_000);
    const fast: CallHandler = { handle: () => of({ ok: true }) };
    await expect(firstValue(interceptor.intercept(httpContext(), fast))).resolves.toEqual({ ok: true });
  });

  it('does not put a deadline on a streaming multipart upload', async () => {
    const interceptor = new RequestTimeoutInterceptor(20);
    const slow: CallHandler = { handle: () => timer(80) };
    await expect(
      firstValue(interceptor.intercept(httpContext('multipart/form-data; boundary=x'), slow)),
    ).resolves.toBe(0);
  });

  it('passes an unrelated failure through untouched', async () => {
    const interceptor = new RequestTimeoutInterceptor(1_000);
    const failing: CallHandler = { handle: () => throwError(() => new Error('hook exploded')) };
    await expect(firstValue(interceptor.intercept(httpContext(), failing))).rejects.toThrow('hook exploded');
  });

  it('disables the deadline when the budget is 0', async () => {
    const interceptor = new RequestTimeoutInterceptor(0);
    const slow: CallHandler = { handle: () => timer(60) };
    await expect(firstValue(interceptor.intercept(httpContext(), slow))).resolves.toBe(0);
  });
});

describe('database deadlines (G74)', () => {
  it('cancels a statement that outlives the configured cap, and answers 503', async () => {
    // Only the two ceilings change; the connection string stays the configured primary database.
    const database = new DatabaseService({ ...buildConfig(), databaseStatementTimeoutMs: 120, databaseLockTimeoutMs: 120 });
    try {
      let error: unknown;
      try {
        await database.db.selectNoFrom([(eb) => eb.lit(1).as('one')]).execute();
      } catch (caught) {
        error = caught;
      }
      // A normal statement is unaffected by the cap.
      expect(error).toBeUndefined();

      let cancelled: unknown;
      try {
        await database.pool.query('select pg_sleep(0.6)');
      } catch (caught) {
        cancelled = caught;
      }
      // PostgreSQL error 57014, query_canceled.
      expect(cancelled).toMatchObject({ code: '57014' });

      // The filter turns that driver error into the platform's own envelope, never a bare 500.
      const sent = { status: 0, body: {} as Record<string, unknown> };
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
      const host = {
        switchToHttp: () => ({ getResponse: () => reply, getRequest: () => ({ id: 'req-g74', url: '/api/v1/Account' }) }),
      };
      new GlobalExceptionFilter().catch(cancelled, host as unknown as never);
      expect(sent.status).toBe(503);
      expect((sent.body['error'] as { code?: string }).code).toBe('REQUEST_TIMEOUT');
    } finally {
      await database.onModuleDestroy();
    }
  });
});
