import type {
  AclDefinition,
  AdminPanelView,
  AttachmentInfo,
  CloneResult,
  EntityDefinition,
  ExtensionInstallResult,
  ExtensionListResult,
  ExtensionNavItem,
  ExtensionRow,
  IndexDefinition,
  LayoutDefinition,
  ListResult,
  LoginResult,
  MarketingAudiencePreview,
  MarketingCampaignCapabilities,
  MarketingCampaignTransitionResult,
  MarketingCampaignTransitionRow,
  MarketingNavigationVisibility,
  MarketingPreferenceView,
  MarketingUnsubscribeResult,
  MarketingValidationReport,
  Metadata,
  ModuleSettingsView,
  NavigationTree,
  PortalContext,
  PortalDashboardRow,
  PortalNavItemRow,
  PortalRoleRow,
  PortalRow,
  Principal,
  ProcessCatalog,
  ProcessDefinitionShape,
  ProcessInstanceListResult,
  ProcessInstanceView,
  ProcessIssue,
  ProcessListResult,
  ProcessTaskListResult,
  ProcessTaskView,
  ProcessView,
  ProfileInfo,
  ProfilePatch,
  ProjectBoardView,
  ProjectCapabilities,
  ProjectGanttView,
  ProjectMemberRow,
  ProjectPlanView,
  ProjectStageRow,
  ReportCsv,
  ReportDefinitionShape,
  ReportRow,
  ReportRunResult,
  ReportScheduleRow,
  Role,
  SalesDocumentView,
  SalesHealthView,
  SalesNumberingSeries,
  SalesPreviewTotalsResult,
  SalesPriceResolutionResult,
  SalesRenderResult,
  SalesSendDocumentResult,
  SalesSendInput,
  SalesSendResult,
  SalesSettingsView,
  ServiceDeskAssignmentResult,
  ServiceDeskAssignmentRow,
  ServiceDeskCapabilities,
  ServiceDeskMessageResult,
  ServiceDeskMetrics,
  ServiceDeskQueueWorkload,
  ServiceDeskTransitionResult,
  ServiceDeskTransitionRow,
  SettingsDocument,
  SettingsPatch,
  SettingsView,
  WorkflowActionSpec,
  WorkflowDefinitionShape,
  WorkflowIssue,
  WorkflowListResult,
  WorkflowRunListResult,
  WorkflowRunView,
  WorkflowView,
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

async function unwrap<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload: unknown = text === '' ? null : JSON.parse(text);

  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string; details?: Record<string, unknown> } })?.error;
    throw new ApiError(response.status, error?.code ?? 'INTERNAL_ERROR', error?.message ?? response.statusText, error?.details);
  }
  return payload as T;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response = await rawRequest(path, init, getStoredToken());

  if (response.status === 401 && path !== '/Authentication' && path !== '/Refresh') {
    refreshing ??= refreshAccessToken().finally(() => {
      refreshing = null;
    });
    const token = await refreshing;
    if (token) response = await rawRequest(path, init, token);
  }

  return unwrap<T>(response);
}

/** Multipart upload: the browser must set the content type itself, so no JSON default is applied. */
async function upload<T>(path: string, form: FormData): Promise<T> {
  const headers = new Headers();
  const token = getStoredToken();
  if (token) headers.set('authorization', `Bearer ${token}`);
  const response = await fetch(`/api/v1${path}`, { method: 'POST', body: form, headers, credentials: 'same-origin' });
  return unwrap<T>(response);
}

/** A JSON POST — every Phase 19 domain command is an action POST (PLAN §7.2). */
function post(input: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(input ?? {}) };
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
  /** §5.4 visibility: `public` | `internal` | `system`. */
  visibility: string;
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
  patchMyProfile: (input: ProfilePatch) => request<ProfileInfo>('/AppUser/me', { method: 'PATCH', body: JSON.stringify(input) }),
  changeMyPassword: (input: { currentPassword: string; newPassword: string }) =>
    request<{ status: boolean }>('/AppUser/me/password', post(input)),
  /** Streams one file into the configured storage; the caller links it to a record afterwards. */
  uploadAttachment: (file: File, input?: { field?: string; role?: string; parentType?: string; parentId?: string }) => {
    const form = new FormData();
    form.append('file', file);
    if (input?.field !== undefined) form.append('field', input.field);
    if (input?.role !== undefined) form.append('role', input.role);
    if (input?.parentType !== undefined) form.append('parentType', input.parentType);
    if (input?.parentId !== undefined) form.append('parentId', input.parentId);
    return upload<AttachmentInfo>('/Attachment/upload', form);
  },
  /** Metadata (name, size, visibility) of one stored file. */
  attachment: (id: string) => request<AttachmentInfo & { visibility?: string }>(`/Attachment/${encodeURIComponent(id)}`),
  logout: () => request<{ status: boolean }>('/Logout', { method: 'POST' }),

  // Instance settings (PLAN §12.2 `app_settings`): brand text, logo, footer, locale/timezone defaults.
  settings: () => request<SettingsView>('/Settings'),
  saveSettings: (input: SettingsPatch) => request<SettingsView>('/Settings', post(input)),

  // Phase 20: the administration panel, the resolved menu and the settings document registry
  // (PLAN_Phase_20_Settings_UX.md §8.1).
  adminPanel: () => request<AdminPanelView>('/AdminPanel'),
  navigation: () => request<NavigationTree>('/Navigation'),
  settingsDocument: <T>(name: string) => request<SettingsDocument<T>>(`/Settings/documents/${encodeURIComponent(name)}`),
  saveSettingsDocument: <T>(name: string, value: Record<string, unknown>, version?: number) =>
    request<SettingsDocument<T>>(
      `/Settings/documents/${encodeURIComponent(name)}`,
      post(version === undefined ? { value } : { value, version }),
    ),
  resetSettingsDocument: <T>(name: string) =>
    request<SettingsDocument<T>>(`/Settings/documents/${encodeURIComponent(name)}/reset`, post({})),

  // Module settings documents hosted by the settings shell (§8.3): each keeps its own endpoint.
  serviceDeskSettings: () => request<ModuleSettingsView>('/ServiceDesk/action/settings'),
  saveServiceDeskSettings: (input: Record<string, unknown>) => request<ModuleSettingsView>('/ServiceDesk/action/settings', post(input)),
  customerSuccessSettings: () => request<ModuleSettingsView>('/CustomerSuccess/action/settings'),
  saveCustomerSuccessSettings: (input: Record<string, unknown>) =>
    request<ModuleSettingsView>('/CustomerSuccess/action/settings', post(input)),

  // Phase 7A (PLAN §41.5): merged translation catalog, cacheable by content hash.
  i18nCatalog: (locale: string | undefined, clientCache?: string) => {
    const params = new URLSearchParams();
    if (locale) params.set('locale', locale);
    if (clientCache) params.set('clientCache', clientCache);
    const suffix = params.toString() === '' ? '' : `?${params.toString()}`;
    return request<{ locale: string; instance: { defaultLocale: string; enabledLocales: string[]; defaultTimezone: string }; hash: string; catalog?: Record<string, unknown>; unchanged?: boolean }>(`/I18n${suffix}`);
  },

  metadata: () => request<Metadata>('/Metadata'),
  entity: (name: string) => request<EntityDefinition>(`/Metadata/${encodeURIComponent(name)}`),
  patchEntity: (name: string, patch: Record<string, unknown>) =>
    request<EntityDefinition>(`/Metadata/${encodeURIComponent(name)}`, { method: 'POST', body: JSON.stringify(patch) }),
  disableField: (name: string, field: string) =>
    request<EntityDefinition>(`/Metadata/${encodeURIComponent(name)}/Field/${encodeURIComponent(field)}`, { method: 'DELETE' }),

  roles: () => request<ListResult<Role>>('/Role'),
  users: (params: { offset?: number | undefined; maxSize?: number | undefined; where?: string | undefined } = {}) =>
    request<ListResult<{ id: string; name: string; userName: string; isActive: boolean }>>(`/User${simpleQuery(params)}`),
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

  // Phase 17 — saved reports; preview/run/export all execute through the server's ACL-aware Query Engine path.
  reports: () => request<ReportRow[]>('/Report'),
  createReport: (input: { name: string; definition: ReportDefinitionShape; visibility?: 'private' | 'shared' }) =>
    request<ReportRow>('/Report', { method: 'POST', body: JSON.stringify(input) }),
  updateReport: (id: string, input: Partial<{ name: string; definition: ReportDefinitionShape; visibility: 'private' | 'shared' }>) =>
    request<ReportRow>(`/Report/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deleteReport: (id: string) => request<{ id: string; deleted: true }>(`/Report/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  previewReport: (definition: ReportDefinitionShape) =>
    request<{ result: ReportRunResult }>('/Report/action/preview', { method: 'POST', body: JSON.stringify({ definition }) }),
  runReport: (id: string) =>
    request<{ report: ReportRow; result: ReportRunResult }>(`/Report/${encodeURIComponent(id)}/action/run`, { method: 'POST', body: '{}' }),
  exportReport: (id: string) => request<ReportCsv>(`/Report/${encodeURIComponent(id)}/action/export`),
  reportSchedule: (id: string) => request<ReportScheduleRow | null>(`/Report/${encodeURIComponent(id)}/schedule`),
  saveReportSchedule: (id: string, input: { cron: string; enabled?: boolean }) =>
    request<ReportScheduleRow>(`/Report/${encodeURIComponent(id)}/schedule`, { method: 'POST', body: JSON.stringify(input) }),
  setReportScheduleEnabled: (id: string, enabled: boolean) =>
    request<ReportScheduleRow>(`/Report/${encodeURIComponent(id)}/schedule/${enabled ? 'enable' : 'disable'}`, { method: 'POST', body: '{}' }),
  deleteReportSchedule: (id: string) => request<{ reportId: string; deleted: true }>(`/Report/${encodeURIComponent(id)}/schedule`, { method: 'DELETE' }),

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

  // Phase 15 — workflow authoring. `/Workflow` and `/WorkflowRun` are admin-only.
  workflows: () => request<WorkflowListResult>('/Workflow'),
  workflow: (id: string) => request<WorkflowView>(`/Workflow/${encodeURIComponent(id)}`),
  workflowCatalog: () => request<{ events: string[]; actions: WorkflowActionSpec[] }>('/Workflow/action/catalog'),
  createWorkflow: (input: { name: string; definition: WorkflowDefinitionShape }) =>
    request<WorkflowView>('/Workflow', { method: 'POST', body: JSON.stringify(input) }),
  updateWorkflow: (id: string, input: { name?: string; definition?: WorkflowDefinitionShape }) =>
    request<WorkflowView>(`/Workflow/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(input) }),
  publishWorkflow: (id: string) => request<WorkflowView>(`/Workflow/${encodeURIComponent(id)}/action/publish`, { method: 'POST' }),
  setWorkflowEnabled: (id: string, enabled: boolean) =>
    request<WorkflowView>(`/Workflow/${encodeURIComponent(id)}/action/${enabled ? 'enable' : 'disable'}`, { method: 'POST' }),
  deleteWorkflow: (id: string) => request<unknown>(`/Workflow/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  validateWorkflow: (definition: WorkflowDefinitionShape) =>
    request<{ valid: boolean; issues: WorkflowIssue[] }>('/Workflow/action/validate', { method: 'POST', body: JSON.stringify({ definition }) }),

  workflowRuns: (params: { workflowId?: string | undefined; status?: string | undefined; offset?: number | undefined; limit?: number | undefined } = {}) =>
    request<WorkflowRunListResult>(`/WorkflowRun${simpleQuery(params)}`),
  workflowRun: (id: string) => request<WorkflowRunView>(`/WorkflowRun/${encodeURIComponent(id)}`),

  // Phase 16 — process engine (PLAN §36). `/Process` is admin-only; `/ProcessInstance` and
  // `/ProcessTask` are usable by whoever owns the record / holds the task.
  processes: () => request<ProcessListResult>('/Process'),
  process: (id: string) => request<ProcessView>(`/Process/${encodeURIComponent(id)}`),
  processCatalog: () => request<ProcessCatalog>('/Process/action/catalog'),
  validateProcess: (definition: ProcessDefinitionShape) =>
    request<{ valid: boolean; issues: ProcessIssue[] }>('/Process/action/validate', { method: 'POST', body: JSON.stringify({ definition }) }),
  createProcess: (input: { key: string; name: string; description?: string; definition: ProcessDefinitionShape }) =>
    request<ProcessView>('/Process', { method: 'POST', body: JSON.stringify(input) }),
  updateProcess: (id: string, input: { name?: string; description?: string; definition?: ProcessDefinitionShape }) =>
    request<ProcessView>(`/Process/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(input) }),
  publishProcess: (id: string) => request<ProcessView>(`/Process/${encodeURIComponent(id)}/action/publish`, { method: 'POST' }),
  setProcessEnabled: (id: string, enabled: boolean) =>
    request<ProcessView>(`/Process/${encodeURIComponent(id)}/action/${enabled ? 'enable' : 'disable'}`, { method: 'POST' }),
  deleteProcess: (id: string) => request<unknown>(`/Process/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  processInstances: (params: { definitionId?: string | undefined; status?: string | undefined; offset?: number | undefined; limit?: number | undefined } = {}) =>
    request<ProcessInstanceListResult>(`/ProcessInstance${simpleQuery(params)}`),
  processInstance: (id: string) => request<ProcessInstanceView>(`/ProcessInstance/${encodeURIComponent(id)}`),
  startProcess: (input: { processId?: string; processKey?: string; entityType: string; entityId: string }) =>
    request<ProcessInstanceView>('/ProcessInstance', { method: 'POST', body: JSON.stringify(input) }),
  cancelProcessInstance: (id: string) =>
    request<ProcessInstanceView>(`/ProcessInstance/${encodeURIComponent(id)}/action/cancel`, { method: 'POST' }),

  processTasks: (params: { status?: string | undefined; all?: boolean | undefined; offset?: number | undefined; limit?: number | undefined } = {}) =>
    request<ProcessTaskListResult>(
      `/ProcessTask${simpleQuery({
        ...(params.status === undefined ? {} : { status: params.status }),
        ...(params.all === undefined ? {} : { all: params.all ? 'true' : 'false' }),
        ...(params.offset === undefined ? {} : { offset: params.offset }),
        ...(params.limit === undefined ? {} : { limit: params.limit }),
      })}`,
    ),
  processTask: (id: string) => request<ProcessTaskView>(`/ProcessTask/${encodeURIComponent(id)}`),
  completeProcessTask: (id: string, input: { outcome: string; comment?: string }) =>
    request<ProcessInstanceView>(`/ProcessTask/${encodeURIComponent(id)}/action/complete`, { method: 'POST', body: JSON.stringify(input) }),

  // Phase 18 — portal user's own surface (PLAN §37). The internal shell never calls these;
  // the portal shell does, and every record read behind them is portal-ACL scoped.
  portalMe: () => request<PortalContext>('/Portal/me'),
  portalNav: () => request<PortalContext['nav']>('/Portal/nav'),
  portalDashboard: () => request<PortalContext['dashboard']>('/Portal/dashboard'),
  runPortalDashlet: (dashletId: string) =>
    request<Record<string, unknown>>(`/Portal/dashboard/dashlets/${encodeURIComponent(dashletId)}/action/run`, { method: 'POST', body: '{}' }),

  // Phase 18 — portal administration (admin only).
  portals: () => request<PortalRow[]>('/Portal'),
  portal: (id: string) => request<PortalRow>(`/Portal/${encodeURIComponent(id)}`),
  createPortal: (input: { name: string; urlPath?: string | undefined; isActive?: boolean | undefined; settings?: Record<string, unknown> | undefined }) =>
    request<PortalRow>('/Portal', { method: 'POST', body: JSON.stringify(input) }),
  updatePortal: (id: string, input: Partial<{ name: string; urlPath: string; isActive: boolean; settings: Record<string, unknown> }>) =>
    request<PortalRow>(`/Portal/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deletePortal: (id: string) => request<{ id: string; deleted: boolean }>(`/Portal/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  setPortalRoles: (id: string, portalRoleIds: string[]) =>
    request<{ portalId: string; portalRoleIds: string[] }>(`/Portal/${encodeURIComponent(id)}/roles`, {
      method: 'POST',
      body: JSON.stringify({ portalRoleIds }),
    }),

  portalRoles: () => request<PortalRoleRow[]>('/PortalRole'),
  createPortalRole: (input: { name: string; permissions?: Record<string, Record<string, string>> | undefined; fieldPermissions?: Record<string, Record<string, Record<string, string>>> | undefined }) =>
    request<PortalRoleRow>('/PortalRole', { method: 'POST', body: JSON.stringify(input) }),
  updatePortalRole: (id: string, input: Partial<{ name: string; permissions: Record<string, Record<string, string>>; fieldPermissions: Record<string, Record<string, Record<string, string>>> }>) =>
    request<PortalRoleRow>(`/PortalRole/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deletePortalRole: (id: string) => request<{ id: string; deleted: boolean }>(`/PortalRole/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  portalNavItems: (portalId: string) => request<PortalNavItemRow[]>(`/Portal/${encodeURIComponent(portalId)}/navigation`),
  createPortalNavItem: (portalId: string, input: { label: string; entity?: string | null | undefined; route?: string | null | undefined; icon?: string | null | undefined; position?: number | undefined; isActive?: boolean | undefined }) =>
    request<PortalNavItemRow>(`/Portal/${encodeURIComponent(portalId)}/navigation`, { method: 'POST', body: JSON.stringify(input) }),
  updatePortalNavItem: (portalId: string, itemId: string, input: Partial<{ label: string; entity: string | null; route: string | null; icon: string | null; position: number; isActive: boolean }>) =>
    request<PortalNavItemRow>(`/Portal/${encodeURIComponent(portalId)}/navigation/${encodeURIComponent(itemId)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  deletePortalNavItem: (portalId: string, itemId: string) =>
    request<{ id: string; deleted: boolean }>(`/Portal/${encodeURIComponent(portalId)}/navigation/${encodeURIComponent(itemId)}`, { method: 'DELETE' }),

  portalDashboards: (portalId: string) => request<PortalDashboardRow[]>(`/Portal/${encodeURIComponent(portalId)}/dashboards`),
  createPortalDashboard: (portalId: string, input: { name: string; portalRoleId?: string | null | undefined; layout?: unknown[] | undefined; config?: Record<string, unknown> | undefined; isDefault?: boolean | undefined }) =>
    request<PortalDashboardRow>(`/Portal/${encodeURIComponent(portalId)}/dashboards`, { method: 'POST', body: JSON.stringify(input) }),
  updatePortalDashboard: (portalId: string, dashboardId: string, input: Partial<{ name: string; portalRoleId: string | null; layout: unknown[]; config: Record<string, unknown>; isDefault: boolean }>) =>
    request<PortalDashboardRow>(`/Portal/${encodeURIComponent(portalId)}/dashboards/${encodeURIComponent(dashboardId)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  deletePortalDashboard: (portalId: string, dashboardId: string) =>
    request<{ id: string; deleted: boolean }>(`/Portal/${encodeURIComponent(portalId)}/dashboards/${encodeURIComponent(dashboardId)}`, { method: 'DELETE' }),
  createPortalDashlet: (portalId: string, dashboardId: string, input: { name: string; kind: string; position?: number | undefined; config: Record<string, unknown> }) =>
    request<Record<string, unknown>>(`/Portal/${encodeURIComponent(portalId)}/dashboards/${encodeURIComponent(dashboardId)}/dashlets`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updatePortalDashlet: (portalId: string, dashboardId: string, dashletId: string, input: Partial<{ name: string; kind: string; position: number; config: Record<string, unknown> }>) =>
    request<Record<string, unknown>>(`/Portal/${encodeURIComponent(portalId)}/dashboards/${encodeURIComponent(dashboardId)}/dashlets/${encodeURIComponent(dashletId)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  deletePortalDashlet: (portalId: string, dashboardId: string, dashletId: string) =>
    request<{ id: string; deleted: boolean }>(`/Portal/${encodeURIComponent(portalId)}/dashboards/${encodeURIComponent(dashboardId)}/dashlets/${encodeURIComponent(dashletId)}`, {
      method: 'DELETE',
    }),

  // Phase 19 — Projects domain commands (PLAN_Phase_19_Projects.md §7.2).
  projectCapabilities: (projectId: string) =>
    request<ProjectCapabilities>(`/Project/${encodeURIComponent(projectId)}/action/capabilities`),
  projectPlan: (projectId: string) => request<ProjectPlanView>(`/Project/${encodeURIComponent(projectId)}/action/plan`),
  projectBoard: (projectId: string, groupId?: string) =>
    request<ProjectBoardView>(
      `/Project/${encodeURIComponent(projectId)}/action/board${simpleQuery({ groupId })}`,
    ),
  projectGantt: (projectId: string, allGroupTypes?: boolean) =>
    request<ProjectGanttView>(
      `/Project/${encodeURIComponent(projectId)}/action/gantt${simpleQuery({ allGroupTypes: allGroupTypes === true ? 'true' : undefined })}`,
    ),
  projectStages: (projectId: string) =>
    request<{ list: ProjectStageRow[] }>(`/Project/${encodeURIComponent(projectId)}/action/stages`),
  projectMembers: (projectId: string) =>
    request<{ list: ProjectMemberRow[] }>(`/Project/${encodeURIComponent(projectId)}/action/members`),
  addProjectMember: (projectId: string, input: { userId: string; projectRoleId: string }) =>
    request<Record<string, unknown>>(`/Project/${encodeURIComponent(projectId)}/action/members`, post(input)),
  updateProjectMember: (projectId: string, input: { memberId: string; projectRoleId: string }) =>
    request<Record<string, unknown>>(`/Project/${encodeURIComponent(projectId)}/action/memberUpdate`, post(input)),
  removeProjectMember: (projectId: string, input: { memberId: string; transferToMemberId?: string }) =>
    request<{ memberId: string; clearedTasks: number }>(`/Project/${encodeURIComponent(projectId)}/action/memberRemove`, post(input)),
  bulkProjectMembers: (projectId: string, input: { projectIds: string[]; userIds: string[]; projectRoleId: string; operation: 'add' | 'remove' | 'role' }) =>
    request<{ succeeded: string[]; failed: { projectId: string; message: string }[] }>(
      `/Project/${encodeURIComponent(projectId)}/action/memberBulk`,
      post(input),
    ),
  projectSettings: (projectId: string, input: Record<string, unknown>) =>
    request<Record<string, unknown>>(`/Project/${encodeURIComponent(projectId)}/action/settings`, post(input)),
  cloneProject: (projectId: string, input: Record<string, unknown>) =>
    request<CloneResult>(`/Project/${encodeURIComponent(projectId)}/action/clone`, post(input)),
  createProjectGroup: (projectId: string, input: Record<string, unknown>) =>
    request<Record<string, unknown>>(`/Project/${encodeURIComponent(projectId)}/action/groupCreate`, post(input)),
  updateProjectGroup: (projectId: string, input: Record<string, unknown>) =>
    request<Record<string, unknown>>(`/Project/${encodeURIComponent(projectId)}/action/groupUpdate`, post(input)),
  removeProjectGroup: (projectId: string, input: { groupId: string; moveToGroupId?: string }) =>
    request<{ groupId: string; moved: number }>(`/Project/${encodeURIComponent(projectId)}/action/groupRemove`, post(input)),
  reorderProjectGroups: (projectId: string, groupIds: string[]) =>
    request<{ count: number }>(`/Project/${encodeURIComponent(projectId)}/action/groupReorder`, post({ groupIds })),
  createProjectTask: (projectId: string, input: Record<string, unknown>) =>
    request<Record<string, unknown>>(`/Project/${encodeURIComponent(projectId)}/action/taskCreate`, post(input)),
  createProjectMilestone: (projectId: string, input: Record<string, unknown>) =>
    request<Record<string, unknown>>(`/Project/${encodeURIComponent(projectId)}/action/milestone`, post(input)),
  reorderProjectTasks: (projectId: string, input: { groupId?: string; parentTaskId?: string; taskIds: string[] }) =>
    request<{ count: number }>(`/Project/${encodeURIComponent(projectId)}/action/taskReorder`, post(input)),
  updateProjectTask: (taskId: string, input: Record<string, unknown>) =>
    request<Record<string, unknown>>(`/ProjectTask/${encodeURIComponent(taskId)}/action/update`, post(input)),
  moveProjectTask: (taskId: string, input: Record<string, unknown>) =>
    request<Record<string, unknown>>(`/ProjectTask/${encodeURIComponent(taskId)}/action/move`, post(input)),
  transitionProjectTask: (taskId: string, kind: 'start' | 'complete' | 'cancel') =>
    request<Record<string, unknown>>(`/ProjectTask/${encodeURIComponent(taskId)}/action/transition`, post({ kind })),
  bulkProjectTasks: (input: { ids: string[]; operation: 'complete' | 'cancel' | 'selfAssign' }) =>
    request<{ succeeded: string[]; failed: { id: string; message: string }[] }>('/ProjectTask/action/bulk', post(input)),
  projectTaskDependencies: (taskId: string) =>
    request<{ predecessors: Record<string, unknown>[]; successors: Record<string, unknown>[] }>(
      `/ProjectTask/${encodeURIComponent(taskId)}/action/dependencies`,
    ),
  addProjectTaskDependency: (taskId: string, input: { predecessorTaskId: string; dependencyType?: string | null }) =>
    request<Record<string, unknown>>(`/ProjectTask/${encodeURIComponent(taskId)}/action/dependencies`, post(input)),
  updateProjectTaskDependency: (taskId: string, input: { dependencyId: string; dependencyType: string | null }) =>
    request<Record<string, unknown>>(`/ProjectTask/${encodeURIComponent(taskId)}/action/dependencyUpdate`, post(input)),
  removeProjectTaskDependency: (taskId: string, dependencyId: string) =>
    request<{ removed: boolean }>(`/ProjectTask/${encodeURIComponent(taskId)}/action/dependencyRemove`, post({ dependencyId })),
  projectTaskCollaborators: (taskId: string) =>
    request<{ list: { id: string; userId: string }[] }>(`/ProjectTask/${encodeURIComponent(taskId)}/action/collaborators`),
  addProjectTaskCollaborator: (taskId: string, userId: string) =>
    request<Record<string, unknown>>(`/ProjectTask/${encodeURIComponent(taskId)}/action/collaboratorAdd`, post({ userId })),
  removeProjectTaskCollaborator: (taskId: string, userId: string) =>
    request<{ removed: boolean }>(`/ProjectTask/${encodeURIComponent(taskId)}/action/collaboratorRemove`, post({ userId })),

  // Phase 19-S.17 — Sales domain commands (PLAN_Phase_19_Sales.md §7.2).
  salesHealth: () => request<SalesHealthView>('/Sales/action/health'),
  salesNavigation: () =>
    request<{ visible: boolean; readableEntities: number; entities: readonly string[] }>('/Sales/action/nav'),
  salesSettings: () => request<SalesSettingsView>('/Sales/action/settings'),
  saveSalesSettings: (input: Record<string, unknown>) =>
    request<SalesSettingsView>('/Sales/action/settings', post(input)),
  salesNumbering: () => request<{ list: SalesNumberingSeries[] }>('/Sales/action/numbering'),
  salesResolvePrice: (input: Record<string, unknown>) =>
    request<SalesPriceResolutionResult>('/Sales/action/resolvePrice', post(input)),
  salesResolveSupplierPrice: (input: Record<string, unknown>) =>
    request<SalesPriceResolutionResult>('/Sales/action/resolveSupplierPrice', post(input)),
  salesBulkPriceUpdate: (input: Record<string, unknown>) =>
    request<{ preview: boolean; affected: number }>('/Sales/action/bulkPriceUpdate', post(input)),
  salesPreviewTotals: (input: Record<string, unknown>) =>
    request<SalesPreviewTotalsResult>('/Sales/action/previewTotals', post(input)),
  salesCreateDocument: (kind: string, input: { data?: Record<string, unknown>; items: readonly Record<string, unknown>[] }) =>
    request<SalesDocumentView>('/Sales/document', { method: 'POST', body: JSON.stringify({ kind, ...input }) }),
  salesReadDocument: (kind: string, id: string) =>
    request<SalesDocumentView>(`/Sales/document/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`),
  salesUpdateDocument: (kind: string, id: string, input: { data?: Record<string, unknown>; items?: readonly Record<string, unknown>[] }) =>
    request<SalesDocumentView>(`/Sales/document/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  salesTransitionDocument: (kind: string, id: string, input: { action: string; reason?: string; correlationId?: string }) =>
    request<SalesDocumentView>(`/Sales/document/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/transition`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  salesUnlockDocument: (kind: string, id: string, reason: string) =>
    request<SalesDocumentView>(`/Sales/document/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/unlock`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  salesConvertDocument: (kind: string, id: string, input: { action: string; correlationId?: string; overrides?: Record<string, unknown> }) =>
    request<SalesDocumentView>(`/Sales/document/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/convert`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  salesCreateFromOpportunity: (input: {
    opportunityId: string;
    kind: string;
    items?: readonly Record<string, unknown>[];
    overrides?: Record<string, unknown>;
    correlationId?: string;
  }) => request<SalesDocumentView>('/Sales/document/fromOpportunity', post(input)),
  salesRenderDocument: (kind: string, id: string, templateCode?: string) =>
    request<SalesRenderResult>(`/Sales/document/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/render`, {
      method: 'POST',
      body: JSON.stringify({ templateCode }),
    }),
  salesRecalculateDocument: (kind: string, id: string) =>
    request<SalesDocumentView>(`/Sales/document/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/recalculate`, {
      method: 'POST',
      body: '{}',
    }),
  salesDeleteDocument: (kind: string, id: string) =>
    request<unknown>(`/Sales/document/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  salesRenderQuote: (id: string, templateCode?: string) =>
    request<SalesRenderResult>(`/Sales/quote/${encodeURIComponent(id)}/render`, {
      method: 'POST',
      body: JSON.stringify({ templateCode }),
    }),
  salesSendQuote: (id: string, input: SalesSendInput) =>
    request<SalesSendResult>(`/Sales/quote/${encodeURIComponent(id)}/send`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  salesSendDocument: (kind: string, id: string, input: SalesSendInput) =>
    request<SalesSendDocumentResult>(`/Sales/document/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/send`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  // Phase 19-SD.4/SD.5 — Service Desk commands (PLAN_Phase_19_ServiceDesk.md §8.2). Entity CRUD stays
  // on the generic `/Case` API; these cover the state machine and assignment/routing only.
  serviceDeskCapabilities: (caseId: string) =>
    request<ServiceDeskCapabilities>(`/ServiceDesk/action/case/${encodeURIComponent(caseId)}/capabilities`),
  serviceDeskTransition: (caseId: string, input: Record<string, unknown>) =>
    request<ServiceDeskTransitionResult>(`/ServiceDesk/action/case/${encodeURIComponent(caseId)}/transition`, post(input)),
  serviceDeskHistory: (caseId: string) =>
    request<{ list: ServiceDeskTransitionRow[] }>(`/ServiceDesk/action/case/${encodeURIComponent(caseId)}/history`),
  serviceDeskAssign: (caseId: string, input: Record<string, unknown>) =>
    request<ServiceDeskAssignmentResult>(`/ServiceDesk/action/case/${encodeURIComponent(caseId)}/assign`, post(input)),
  serviceDeskRoute: (caseId: string, input: Record<string, unknown> = {}) =>
    request<ServiceDeskAssignmentResult>(`/ServiceDesk/action/case/${encodeURIComponent(caseId)}/route`, post(input)),
  serviceDeskAssignments: (caseId: string) =>
    request<{ list: ServiceDeskAssignmentRow[] }>(`/ServiceDesk/action/case/${encodeURIComponent(caseId)}/assignments`),
  serviceDeskQueueWorkload: (queueId: string) =>
    request<ServiceDeskQueueWorkload>(`/ServiceDesk/action/queues/${encodeURIComponent(queueId)}/workload`),
  serviceDeskMetrics: (range: { from?: string; to?: string } = {}) =>
    request<ServiceDeskMetrics>(`/ServiceDesk/action/metrics${simpleQuery(range)}`),

  // Phase 19-SD.6 — case conversation (PLAN_Phase_19_ServiceDesk.md §5.4). The reply/note commands
  // fix the visibility server-side; the composer only chooses which command to send.
  serviceDeskConversation: (caseId: string, params: { maxSize?: number; offset?: number } = {}) =>
    request<StreamListResult>(
      `/ServiceDesk/action/case/${encodeURIComponent(caseId)}/conversation${simpleQuery({
        maxSize: params.maxSize,
        offset: params.offset,
      })}`,
    ),
  serviceDeskReply: (caseId: string, input: { text: string; attachmentIds?: string[]; mentionIds?: string[] }) =>
    request<ServiceDeskMessageResult>(`/ServiceDesk/action/case/${encodeURIComponent(caseId)}/reply`, post(input)),
  serviceDeskNote: (caseId: string, input: { text: string; attachmentIds?: string[]; mentionIds?: string[] }) =>
    request<ServiceDeskMessageResult>(`/ServiceDesk/action/case/${encodeURIComponent(caseId)}/note`, post(input)),


  // Phase 19-MA.1/MA.3 — Marketing Automation commands (PLAN_Phase_19_Marketing_Automation.md §8.1–§8.2).
  // Campaign CRUD stays on the generic `/Campaign` API; these are the module surface and the state machine,
  // and every command is re-validated server-side. `capabilities` is the answer the panel renders, so the
  // buttons a user sees are the moves the server will accept for them.
  marketingNavigation: () => request<MarketingNavigationVisibility>(`/MarketingAutomation/action/nav`),
  marketingCampaignCapabilities: (campaignId: string) =>
    request<MarketingCampaignCapabilities>(
      `/MarketingAutomation/action/campaign/${encodeURIComponent(campaignId)}/capabilities`,
    ),
  marketingCampaignHistory: (campaignId: string) =>
    request<{ list: MarketingCampaignTransitionRow[] }>(
      `/MarketingAutomation/action/campaign/${encodeURIComponent(campaignId)}/history`,
    ),
  marketingCampaignValidate: (campaignId: string, as?: string) =>
    request<MarketingValidationReport>(
      `/MarketingAutomation/action/campaign/${encodeURIComponent(campaignId)}/validate${
        as === undefined ? '' : simpleQuery({ as })
      }`,
      post({}),
    ),
  marketingCampaignCommand: (
    campaignId: string,
    command: 'schedule' | 'unschedule' | 'start' | 'pause' | 'resume' | 'complete' | 'cancel' | 'archive',
    input: Record<string, unknown> = {},
  ) =>
    request<MarketingCampaignTransitionResult>(
      `/MarketingAutomation/action/campaign/${encodeURIComponent(campaignId)}/${command}`,
      post(input),
    ),
  marketingCampaignDuplicate: (campaignId: string, input: Record<string, unknown> = {}) =>
    request<Record<string, unknown>>(
      `/MarketingAutomation/action/campaign/${encodeURIComponent(campaignId)}/duplicateAsDraft`,
      post(input),
    ),


  // Phase 19-MA.4/MA.5 — audience preview and the public preference surface. The public calls carry only
  // the token: no session, no record id, and no address is ever sent from this page (§5.3.1).
  marketingAudiencePreview: (campaignId: string) =>
    request<MarketingAudiencePreview>(
      `/MarketingAutomation/action/campaign/${encodeURIComponent(campaignId)}/audiencePreview`,
    ),
  marketingAudienceSnapshot: (campaignId: string, mode: 'preview' | 'final') =>
    request<Record<string, unknown>>(
      `/MarketingAutomation/action/campaign/${encodeURIComponent(campaignId)}/audienceSnapshot`,
      post({ mode }),
    ),
  marketingPreferences: (token: string) =>
    request<MarketingPreferenceView>(`/MarketingAutomation/public/preferences/${encodeURIComponent(token)}`),
  marketingUnsubscribe: (token: string, input: { all?: boolean } = {}) =>
    request<MarketingUnsubscribeResult>(
      `/MarketingAutomation/public/unsubscribe/${encodeURIComponent(token)}`,
      post(input),
    ),

  // Phase 19-SD.11 — portal-safe Knowledge Base and CSAT entry points.
  serviceDeskKnowledgePortal: () =>
    request<{ id: string; title: string; summary: string | null }[]>(`/ServiceDesk/action/knowledge/portal`),
  serviceDeskKnowledgeSuggestions: (caseId: string) =>
    request<{ id: string; title: string; summary: string | null }[]>(
      `/ServiceDesk/action/case/${encodeURIComponent(caseId)}/knowledgeSuggestions`,
    ),
  serviceDeskCsatSubmit: (input: { token: string; rating: number; feedback?: string }) =>
    request<{ submitted: boolean }>(`/ServiceDesk/action/csat/submit`, post(input)),
};