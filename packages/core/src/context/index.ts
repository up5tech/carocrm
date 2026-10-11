import { AsyncLocalStorage } from 'node:async_hooks';

import { generateId } from '../utils/id.js';

export interface RequestContext {
  requestId: string;
  traceId?: string | undefined;
  userId?: string | undefined;
  userType?: 'admin' | 'regular' | 'api' | 'portal' | 'system' | undefined;
  roles?: string[] | undefined;
  tenantId?: string | undefined;
  locale?: string | undefined;
  timezone?: string | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getRequestId(): string {
  return storage.getStore()?.requestId ?? 'unknown';
}

export function getUserId(): string | undefined {
  return storage.getStore()?.userId;
}

export function getUserType(): RequestContext['userType'] | undefined {
  return storage.getStore()?.userType;
}

export function getTenantId(): string | undefined {
  return storage.getStore()?.tenantId;
}

export function getLocale(): string | undefined {
  return storage.getStore()?.locale;
}

export function getTimezone(): string | undefined {
  return storage.getStore()?.timezone;
}

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export async function runWithRequestContextAsync<T>(context: RequestContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(context, fn);
}

export function createRequestContext(partial: Partial<RequestContext> = {}): RequestContext {
  return {
    ...partial,
    requestId: partial.requestId ?? generateId(),
  };
}