import type { EntityDefinition, ListResult, LoginResult, Metadata, Principal } from './types.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Where clause in the API grammar: [{ field, operator?, value }] serialised as JSON (PLAN §15.2). */
export type WhereClause = Record<string, unknown>[];

export interface ListParams {
  where?: WhereClause | undefined;
  orderBy?: string | undefined;
  offset?: number | undefined;
  maxSize?: number | undefined;
  select?: string[] | undefined;
  total?: boolean | undefined;
}

export interface RecordData {
  id?: string;
  [key: string]: unknown;
}

const TOKEN_KEY = 'carocrm.accessToken';

export function getStoredToken(): string | null {
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setStoredToken(token: string | null): void {
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
}

async function rawRequest(path: string, init: RequestInit, token: string | null): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (init.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return fetch(`/api/v1${path}`, { ...init, headers, credentials: 'same-origin' });
}

/** Rotates the access token using the HttpOnly CRM-REFRESH cookie set at login. */
export async function refreshAccessToken(): Promise<string | null> {
  const response = await fetch('/api/v1/Refresh', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' });
  if (!response.ok) return null;
  const payload = (await response.json()) as { accessToken?: string };
  const token = typeof payload.accessToken === 'string' ? payload.accessToken : null;
  if (token) setStoredToken(token);
  return token;
}

let refreshing: Promise<string | null> | null = null;

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response = await rawRequest(path, init, getStoredToken());

  if (response.status === 401 && path !== '/Authentication' && path !== '/Refresh') {
    refreshing ??= refreshAccessToken().finally(() => {
      refreshing = null;
    });
    const token = await refreshing;
    if (token) response = await rawRequest(path, init, token);
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload: unknown = text === '' ? null : JSON.parse(text);

  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string; details?: Record<string, unknown> } })?.error;
    throw new ApiError(response.status, error?.code ?? 'INTERNAL_ERROR', error?.message ?? response.statusText, error?.details);
  }
  return payload as T;
}

function listQuery(params: ListParams): string {
  const query = new URLSearchParams();
  if (params.where && params.where.length > 0) query.set('where', JSON.stringify(params.where));
  if (params.orderBy) query.set('orderBy', params.orderBy);
  if (params.offset !== undefined) query.set('offset', String(params.offset));
  if (params.maxSize !== undefined) query.set('maxSize', String(params.maxSize));
  if (params.select && params.select.length > 0) query.set('select', params.select.join(','));
  if (params.total === false) query.set('total', 'false');
  const encoded = query.toString();
  return encoded === '' ? '' : `?${encoded}`;
}

export const api = {
  login: (userName: string, password: string) =>
    request<LoginResult>('/Authentication', { method: 'POST', body: JSON.stringify({ userName, password }) }),
  me: () => request<Principal>('/AppUser/me'),
  logout: () => request<{ status: boolean }>('/Logout', { method: 'POST' }),

  metadata: () => request<Metadata>('/Metadata'),
  entity: (name: string) => request<EntityDefinition>(`/Metadata/${encodeURIComponent(name)}`),
  patchEntity: (name: string, patch: Record<string, unknown>) =>
    request<EntityDefinition>(`/Metadata/${encodeURIComponent(name)}`, { method: 'POST', body: JSON.stringify(patch) }),
  disableField: (name: string, field: string) =>
    request<EntityDefinition>(`/Metadata/${encodeURIComponent(name)}/Field/${encodeURIComponent(field)}`, { method: 'DELETE' }),

  list: (entity: string, params: ListParams = {}) =>
    request<ListResult>(`/${encodeURIComponent(entity)}${listQuery(params)}`),
  get: (entity: string, id: string) => request<RecordData>(`/${encodeURIComponent(entity)}/${encodeURIComponent(id)}`),
  create: (entity: string, data: RecordData) =>
    request<RecordData>(`/${encodeURIComponent(entity)}`, { method: 'POST', body: JSON.stringify(data) }),
  update: (entity: string, id: string, data: RecordData) =>
    request<RecordData>(`/${encodeURIComponent(entity)}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  remove: (entity: string, id: string) => request<unknown>(`/${encodeURIComponent(entity)}/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  massDelete: (entity: string, ids: string[]) =>
    request<unknown>(`/${encodeURIComponent(entity)}/action/massDelete`, { method: 'POST', body: JSON.stringify({ ids }) }),

  related: (entity: string, id: string, relation: string, params: ListParams = {}) =>
    request<ListResult>(`/${encodeURIComponent(entity)}/${encodeURIComponent(id)}/${encodeURIComponent(relation)}${listQuery(params)}`),
  link: (entity: string, id: string, relation: string, relatedId: string) =>
    request<unknown>(`/${encodeURIComponent(entity)}/${encodeURIComponent(id)}/${encodeURIComponent(relation)}/${encodeURIComponent(relatedId)}`, {
      method: 'PUT',
    }),
  unlink: (entity: string, id: string, relation: string, relatedId: string) =>
    request<unknown>(`/${encodeURIComponent(entity)}/${encodeURIComponent(id)}/${encodeURIComponent(relation)}/${encodeURIComponent(relatedId)}`, {
      method: 'DELETE',
    }),

  auditLog: (params: ListParams & { entityId?: string | undefined; entityType?: string | undefined }) => {
    const query = new URLSearchParams();
    if (params.entityId) query.set('entityId', params.entityId);
    if (params.entityType) query.set('entityType', params.entityType);
    if (params.offset !== undefined) query.set('offset', String(params.offset));
    if (params.maxSize !== undefined) query.set('maxSize', String(params.maxSize));
    return request<ListResult>(`/AuditLog?${query.toString()}`);
  },
};
