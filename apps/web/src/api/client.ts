import type {
  AclDefinition,
  EntityDefinition,
  ExtensionInstallResult,
  ExtensionListResult,
  ExtensionNavItem,
  ExtensionRow,
  IndexDefinition,
  LayoutDefinition,
  ListResult,
  LoginResult,
  Metadata,
  Principal,
  Role,
} from './types.js';

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

function simpleQuery(params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const encoded = query.toString();
  return encoded === '' ? '' : `?${encoded}`;
}

function searchQuery(params: ListParams & { q?: string | undefined }): string {
  const query = new URLSearchParams();
  if (params.q) query.set('q', params.q);
  if (params.where && params.where.length > 0) query.set('where', JSON.stringify(params.where));
  if (params.orderBy) query.set('orderBy', params.orderBy);
  if (params.offset !== undefined) query.set('offset', String(params.offset));
  if (params.maxSize !== undefined) query.set('maxSize', String(params.maxSize));
  if (params.select && params.select.length > 0) query.set('select', params.select.join(','));
  const encoded = query.toString();
  return encoded === '' ? '' : `?${encoded}`;
}

export interface StreamUser {
  userId: string;
  userName: string;
  firstName: string | null;
  lastName: string | null;
}

export interface StreamItem {
  id: string;
  entityType: string;
  entityId: string;
  type: string;
  data: Record<string, unknown>;
  post: string | null;
  createdById: string | null;
  createdBy: StreamUser | null;
  createdAt: string;
  mentions: StreamUser[];
  attachmentIds: string[];
}

export interface StreamListResult {
  list: StreamItem[];
  offset: number;
  count: number;
  total?: number | undefined;
}

export interface NotificationItem {
  id: string;
  type: string;
  data: Record<string, unknown>;
  isRead: boolean;
  createdAt: string;
}

export interface CalendarEvent {
  activityType: string;
  activityId: string;
  name: string | null;
  status: string | null;
  start: string;
  end: string | null;
  day: string;
  allDay: boolean;
  assignedUserId: string | null;
  recurring: boolean;
  base: boolean;
  duration: number | null;
}

export interface CalendarResult {
  list: CalendarEvent[];
  from: string;
  to: string;
  timeZone: string;
  count: number;
}


export interface SavedFilterRow {
  id: string;
  name: string;
  entityType: string;
  userId: string | null;
  criteria: Record<string, unknown>[];
  visibility: string;
  isShared: boolean;
  createdAt: string;
  modifiedAt: string;
}

export interface GlobalSearchResult {
  query: string;
  total: number;
  offset: number;
  count: number;
  list: { entityType: string; record: RecordData }[];
}

export interface ImportResult {
  entity: string;
  created: number;
  updated: number;
  skipped: number;
  errors: { row: number; message: string }[];
  ids: string[];
}

export interface DashletRow {
  id: string;
  name: string;
  kind: string;
  position: number;
  config: Record<string, unknown>;
}

export interface DashboardRow {
  id: string;
  name: string;
  userId: string | null;
  config: Record<string, unknown>;
  layout: unknown[];
  isShared: boolean;
  dashlets: DashletRow[];
  createdAt: string;
  modifiedAt: string;
}

export interface JobRow {
  id: string;
  job: string;
  status: string;
  schedulingType: string | null;
  attempt: number;
  maxAttempts: number;
  progress: number;
  message: string | null;
  lastError: string | null;
  cancelRequested: boolean;
  queueJobId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  data: RecordData;
  result: RecordData | null;
}

export interface JobListResult {
  list: JobRow[];
  total: number;
  offset: number;
  count: number;
  queue: Record<string, number>;
}

export interface JobLogLine {
  seq: string;
  level: string;
  message: string;
  createdAt: string;
}

export interface ScheduleRow {
  id: string;
  job: string;
  scheduling: string;
  enabled: boolean;
  lastRunAt: string | null;
  createdAt: string;
  modifiedAt: string;
  data: RecordData;
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

  roles: () => request<ListResult<Role>>('/Role'),
  patchRole: (id: string, patch: Record<string, unknown>) =>
    request<Role>(`/Role/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  // Phase 8 — index / layout / ACL metadata editing.
  saveIndexes: (name: string, indexes: IndexDefinition[]) =>
    request<EntityDefinition>(`/Metadata/${encodeURIComponent(name)}`, { method: 'POST', body: JSON.stringify({ indexes }) }),
  saveLayouts: (name: string, layouts: Record<string, LayoutDefinition[]>) =>
    request<EntityDefinition>(`/Metadata/${encodeURIComponent(name)}`, { method: 'POST', body: JSON.stringify({ layouts }) }),
  saveEntityAcl: (name: string, acl: AclDefinition) =>
    request<EntityDefinition>(`/Metadata/${encodeURIComponent(name)}`, { method: 'POST', body: JSON.stringify({ acl }) }),

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

  streamFor: (entity: string, id: string, params: { maxSize?: number; offset?: number; order?: 'asc' | 'desc' } = {}) =>
    request<StreamListResult>(
      `/${encodeURIComponent(entity)}/${encodeURIComponent(id)}/stream${simpleQuery({
        maxSize: params.maxSize,
        offset: params.offset,
        order: params.order,
      })}`,
    ),
  postNote: (entity: string, id: string, post: string) =>
    request<StreamItem>('/Note', { method: 'POST', body: JSON.stringify({ type: 'Post', parentType: entity, parentId: id, post }) }),
  deleteNote: (itemId: string) => request<unknown>(`/Note/${encodeURIComponent(itemId)}`, { method: 'DELETE' }),
  follow: (entity: string, id: string) =>
    request<{ status: boolean }>(`/${encodeURIComponent(entity)}/${encodeURIComponent(id)}/subscription`, { method: 'PUT' }),
  unfollow: (entity: string, id: string) =>
    request<{ status: boolean }>(`/${encodeURIComponent(entity)}/${encodeURIComponent(id)}/subscription`, { method: 'DELETE' }),
  isFollowed: (entity: string, id: string) =>
    request<{ followed: boolean }>(`/${encodeURIComponent(entity)}/${encodeURIComponent(id)}/subscription`),
  activityStream: (params: { view?: 'all' | 'followed' | 'own'; maxSize?: number; offset?: number } = {}) =>
    request<StreamListResult>(`/Stream${simpleQuery({ view: params.view, maxSize: params.maxSize, offset: params.offset })}`),
  notifications: (params: { unreadOnly?: boolean; maxSize?: number } = {}) =>
    request<ListResult & { list: NotificationItem[] }>(
      `/Notification${simpleQuery({ unreadOnly: params.unreadOnly ? 'true' : undefined, maxSize: params.maxSize })}`,
    ),
  markNotificationRead: (id: string) => request<unknown>(`/Notification/${encodeURIComponent(id)}/Read`, { method: 'POST' }),

  calendar: (params: {
    from: string;
    to: string;
    timeZone?: string | undefined;
    entities?: string[] | undefined;
    userId?: string | undefined;
    maxSize?: number | undefined;
  }) =>
    request<CalendarResult>(
      `/Calendar${simpleQuery({
        from: params.from,
        to: params.to,
        ...(params.timeZone !== undefined ? { timeZone: params.timeZone } : {}),
        ...(params.entities !== undefined && params.entities.length > 0 ? { entities: params.entities.join(',') } : {}),
        ...(params.userId !== undefined ? { userId: params.userId } : {}),
        ...(params.maxSize !== undefined ? { maxSize: params.maxSize } : {}),
      })}`,
    ),

  jobs: (params: { status?: string | undefined; job?: string | undefined; offset?: number | undefined; limit?: number | undefined } = {}) =>
    request<JobListResult>(
      `/Job${simpleQuery({ status: params.status, job: params.job, offset: params.offset, limit: params.limit })}`,
    ),
  job: (id: string) => request<JobRow>(`/Job/${encodeURIComponent(id)}`),
  jobLogs: (id: string) => request<{ jobId: string; lines: JobLogLine[] }>(`/Job/${encodeURIComponent(id)}/log`),
  runJob: (jobName: string, data: RecordData = {}) =>
    request<JobRow>('/Job', { method: 'POST', body: JSON.stringify({ jobName, data }) }),
  cancelJob: (id: string) => request<JobRow>(`/Job/${encodeURIComponent(id)}/action/cancel`, { method: 'POST' }),

  schedules: () => request<{ list: ScheduleRow[] }>('/ScheduledJob'),
  saveSchedule: (input: { id: string; job: string; scheduling: string; data?: RecordData | undefined; enabled?: boolean | undefined }) =>
    request<ScheduleRow>('/ScheduledJob', { method: 'POST', body: JSON.stringify(input) }),
  setScheduleEnabled: (id: string, enabled: boolean) =>
    request<ScheduleRow>(`/ScheduledJob/${encodeURIComponent(id)}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' }),
  runScheduleNow: (id: string) => request<JobRow>(`/ScheduledJob/${encodeURIComponent(id)}/action/runNow`, { method: 'POST' }),
  previewCron: (scheduling: string) =>
    request<{ valid: boolean; next: string[] }>('/ScheduledJob/action/preview', { method: 'POST', body: JSON.stringify({ scheduling }) }),

  globalSearch: (params: { q: string; entities?: string | undefined; limit?: number | undefined; offset?: number | undefined }) =>
    request<GlobalSearchResult>(
      `/Search${simpleQuery({ q: params.q, entities: params.entities, limit: params.limit, offset: params.offset })}`,
    ),
  entitySearch: (entity: string, params: ListParams & { q?: string | undefined }) =>
    request<ListResult>(`/Search/${encodeURIComponent(entity)}${searchQuery(params)}`),

  savedFilters: (entityType?: string | undefined) =>
    request<SavedFilterRow[]>(`/SavedFilter${simpleQuery({ entityType })}`),
  savedFilter: (id: string) => request<SavedFilterRow>(`/SavedFilter/${encodeURIComponent(id)}`),
  createSavedFilter: (input: { name: string; entityType: string; criteria: Record<string, unknown>[]; visibility?: string | undefined }) =>
    request<SavedFilterRow>('/SavedFilter', { method: 'POST', body: JSON.stringify(input) }),
  updateSavedFilter: (id: string, input: Partial<{ name: string; entityType: string; criteria: Record<string, unknown>[]; visibility: string }>) =>
    request<SavedFilterRow>(`/SavedFilter/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deleteSavedFilter: (id: string) => request<unknown>(`/SavedFilter/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  runSavedFilter: (id: string, params: ListParams = {}) =>
    request<{ filter: SavedFilterRow; result: ListResult }>(`/SavedFilter/${encodeURIComponent(id)}/action/run`, {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  importCsv: (entity: string, csv: string, updateOnName = false) =>
    request<ImportResult>(`/${encodeURIComponent(entity)}/action/import${updateOnName ? '?updateOnName=true' : ''}`, {
      method: 'POST',
      body: JSON.stringify({ csv }),
    }),
  exportColumns: (entity: string) =>
    request<{ entity: string; columns: { name: string; type: string }[] }>(`/${encodeURIComponent(entity)}/action/exportColumns`),

  dashboards: () => request<DashboardRow[]>('/Dashboard'),
  dashboard: (id: string) => request<DashboardRow>(`/Dashboard/${encodeURIComponent(id)}`),
  createDashboard: (input: { name: string; layout?: unknown[] | undefined; config?: Record<string, unknown> | undefined; isShared?: boolean | undefined }) =>
    request<DashboardRow>('/Dashboard', { method: 'POST', body: JSON.stringify(input) }),
  updateDashboard: (id: string, input: Partial<{ name: string; layout: unknown[]; config: Record<string, unknown>; isShared: boolean }>) =>
    request<DashboardRow>(`/Dashboard/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deleteDashboard: (id: string) => request<unknown>(`/Dashboard/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  createDashlet: (dashboardId: string, input: { name: string; kind: string; position?: number | undefined; config: Record<string, unknown> }) =>
    request<DashletRow>(`/Dashboard/${encodeURIComponent(dashboardId)}/dashlets`, { method: 'POST', body: JSON.stringify(input) }),
  updateDashlet: (dashboardId: string, dashletId: string, input: Partial<{ name: string; kind: string; position: number; config: Record<string, unknown> }>) =>
    request<DashletRow>(`/Dashboard/${encodeURIComponent(dashboardId)}/dashlets/${encodeURIComponent(dashletId)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  deleteDashlet: (dashboardId: string, dashletId: string) =>
    request<unknown>(`/Dashboard/${encodeURIComponent(dashboardId)}/dashlets/${encodeURIComponent(dashletId)}`, { method: 'DELETE' }),
  runDashlet: (dashboardId: string, dashletId: string) =>
    request<Record<string, unknown>>(`/Dashboard/${encodeURIComponent(dashboardId)}/dashlets/${encodeURIComponent(dashletId)}/action/run`, {
      method: 'POST',
      body: '{}',
    }),

  // Phase 14 — extension administration. `/Extension` is admin-only; `/Extension/frontend` is
  // readable by any signed-in user and already filters admin-only entries server-side.
  extensions: () => request<ExtensionListResult>('/Extension'),
  extensionFrontend: () => request<{ nav: ExtensionNavItem[] }>('/Extension/frontend'),
  installExtension: (id: string) =>
    request<ExtensionInstallResult>('/Extension/action/install', { method: 'POST', body: JSON.stringify({ id }) }),
  uninstallExtension: (id: string) =>
    request<{ id: string; uninstalled: true; restartRequired: true }>(`/Extension/${encodeURIComponent(id)}/action/uninstall`, {
      method: 'POST',
    }),
  setExtensionEnabled: (id: string, enabled: boolean) =>
    request<ExtensionRow>(`/Extension/${encodeURIComponent(id)}/action/${enabled ? 'enable' : 'disable'}`, { method: 'POST' }),
};
