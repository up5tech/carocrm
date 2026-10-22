import type {
  AclDefinition,
  AdminPanelView,
  AdvancedIntegrationsCapabilitiesView,
  AIAgentApprovalListResult,
  AIAgentApprovalView,
  AIAgentBudgetPolicy,
  AIAgentBudgetPolicyStatus,
  AIAgentConversationMessageView,
  AIAgentConversationView,
  AIAgentListResult,
  AIAgentMemoryView,
  AIAgentPricingSnapshot,
  AIAgentProviderCheckResult,
  AIAgentRetentionReport,
  AIAgentRunEventView,
  AIAgentRunListResult,
  AIAgentRunToolCallView,
  AIAgentRunView,
  AIAgentsCapabilitiesView,
  AIAgentsHealthView,
  AIAgentsProviderConnection,
  AIAgentsSettingsView,
  AIAgentTemplate,
  AIAgentToolCatalogue,
  AIAgentUsageView,
  AIAgentValidationReport,
  AIAgentVersionView,
  AIAgentView,
  ApiKeyRow,
  ApiKeySecret,
  ApiUserRow,
  AttachmentInfo,
  AvailableProcessListResult,
  CloneResult,
  CRMChatActionView,
  CRMChatCapabilitiesView,
  CRMChatConversationDetail,
  CRMChatConversationList,
  CRMChatCrossModuleScenario,
  CRMChatFeedbackView,
  CRMChatHealthView,
  CRMChatMessagePage,
  CRMChatPromptView,
  CRMChatSettingsView,
  CRMChatTurnResult,
  CRMChatTurnStatus,
  CRMChatUsageSummary,
  DocsPageView,
  DocsSearchView,
  DocsTreeView,
  EmailAccountInput,
  EmailAccountRow,
  EmailTemplatePreviewInput,
  EmailTemplatePreviewView,
  EmailTransportInfo,
  EntityDefinition,
  ESignatureAuthorizationStart,
  ESignatureCapabilitiesView,
  ESignatureConnectionTest,
  ESignatureConnectionView,
  ESignatureHealthView,
  ESignatureNavView,
  ESignatureSettingsView,
  ExtensionInstallResult,
  ExtensionListResult,
  ExtensionNavItem,
  ExtensionRow,
  IndexDefinition,
  IntegrationCatalogResult,
  IntegrationConflict,
  IntegrationConflictListResult,
  IntegrationConflictResolution,
  IntegrationConnection,
  IntegrationConnectionDetail,
  IntegrationConnectionListResult,
  IntegrationConnectionTestResult,
  IntegrationJobLogResult,
  IntegrationMappingFields,
  IntegrationMappingListResult,
  IntegrationMappingPreview,
  IntegrationMappingView,
  IntegrationReconcileResult,
  IntegrationSyncOperation,
  IntegrationSyncOperationListResult,
  IntegrationSyncRun,
  IntegrationSyncRunListResult,
  InternalInfoView,
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
  PreferenceItem,
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
  SetupChecklistView,
  TeamRow,
  UserAccountType,
  UserInput,
  UserRow,
  VoiceCallContextView,
  VoiceCallControlAction,
  VoiceCallSessionView,
  VoiceCommunicationsHealthView,
  VoiceCommunicationsSettingsView,
  VoiceComposerValidation,
  VoiceConversationHistoryEntry,
  VoiceConversationView,
  VoiceEndpointInput,
  VoiceEndpointView,
  VoiceInboxList,
  VoiceIncomingCallView,
  VoiceMediaView,
  VoiceMessageView,
  VoiceProviderAccountInput,
  VoiceProviderAccountPatch,
  VoiceProviderAccountView,
  VoiceProviderCatalogView,
  VoiceRecordPanelView,
  VoiceSnippetRender,
  VoiceSnippetView,
  VoiceTimelineEntry,
  VoiceTranscriptView,
  VoiceWebhookEventList,
  WebhookDeliveryRow,
  WebhookEndpointRow,
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

/** A JSON PATCH — a partial update of one record. */
function patch(input: unknown): RequestInit {
  return { method: 'PATCH', body: JSON.stringify(input ?? {}) };
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

export interface NotificationListResult {
  list: NotificationItem[];
  /** Notifications matching the query's filter; with `unreadOnly` this is the unread count. */
  total: number;
  offset: number;
  count: number;
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
  /** If set, this dashboard is the default for users holding this role. */
  roleScoped: string | null;
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

/** The one query every docs read accepts: the language the reader is looking at (§8.1). */
function localeSuffix(locale: string | undefined): string {
  return locale === undefined || locale === '' ? '' : `?locale=${encodeURIComponent(locale)}`;
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

  // Phase 21: the in-app handbook (§8.1). Three reads and no write route — documentation is content that
  // ships with the release, and its switches live in the `docs` settings document above.
  docsTree: (locale?: string) => request<DocsTreeView>(`/Docs/tree${localeSuffix(locale)}`),
  docsPage: (section: string, slug: string, locale?: string) =>
    request<DocsPageView>(`/Docs/page/${encodeURIComponent(section)}/${encodeURIComponent(slug)}${localeSuffix(locale)}`),
  docsSearch: (q: string, locale?: string, limit?: number) => {
    const query = new URLSearchParams({ q });
    if (limit !== undefined) query.set('limit', String(limit));
    return request<DocsSearchView>(`/Docs/search?${query.toString()}${locale === undefined ? '' : `&locale=${encodeURIComponent(locale)}`}`);
  },

  // Module settings documents hosted by the settings shell (§8.3): each keeps its own endpoint.
  aiAgentsHealth: () => request<AIAgentsHealthView>('/AIAgents/action/health'),
  aiAgentsCapabilities: () => request<AIAgentsCapabilitiesView>('/AIAgents/action/capabilities'),

  // Phase 19-CHAT.2 — the Chat workspace shell. Capabilities and health are reads the server gates on
  // the caller's Chat capability; settings are the administrative surface and need `admin`.
  crmChatCapabilities: () => request<CRMChatCapabilitiesView>('/CRMChat/action/capabilities'),
  crmChatHealth: () => request<CRMChatHealthView>('/CRMChat/action/health'),
  crmChatSettings: () => request<CRMChatSettingsView>('/CRMChat/action/settings'),
  crmChatUpdateSettings: (patch: Record<string, unknown>) =>
    request<CRMChatSettingsView>('/CRMChat/action/settings', post(patch)),

  // Phase 19-CHAT.4 — the caller's own conversations. The server scopes every read to the owner, so
  // there is no user parameter here and there must never be one.
  crmChatConversations: (
    params: {
      status?: 'active' | 'archived' | 'all';
      offset?: number;
      maxSize?: number;
      /** Phase 19-CHAT.14 — free-text search over the caller's own threads. */
      q?: string;
    } = {},
  ) => {
    const query = new URLSearchParams();
    if (params.status !== undefined) query.set('status', params.status);
    if (params.offset !== undefined) query.set('offset', String(params.offset));
    if (params.maxSize !== undefined) query.set('maxSize', String(params.maxSize));
    if (params.q !== undefined && params.q !== '') query.set('q', params.q);
    const suffix = query.toString();
    return request<CRMChatConversationList>(`/CRMChat/action/conversations${suffix === '' ? '' : `?${suffix}`}`);
  },
  crmChatConversation: (id: string) =>
    request<CRMChatConversationDetail>(`/CRMChat/action/conversations/${encodeURIComponent(id)}`),
  crmChatConversationMessages: (id: string, params: { before?: number; maxSize?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.before !== undefined) query.set('before', String(params.before));
    if (params.maxSize !== undefined) query.set('maxSize', String(params.maxSize));
    const suffix = query.toString();
    return request<CRMChatMessagePage>(
      `/CRMChat/action/conversations/${encodeURIComponent(id)}/messages${suffix === '' ? '' : `?${suffix}`}`,
    );
  },
  /** Phase 19-CHAT.5 — submit a turn to the assistant agent. */
  crmChatSubmitTurn: (input: {
    prompt: string;
    conversationId?: string | undefined;
    idempotencyKey?: string | undefined;
    contextRefs?: readonly { entity: string; id: string }[] | undefined;
  }) => request<CRMChatTurnResult>('/CRMChat/action/turns', post(input)),
  /** Phase 19-CHAT.5 — get turn status. */
  crmChatGetTurn: (turnId: string) => request<CRMChatTurnStatus>(`/CRMChat/action/turns/${encodeURIComponent(turnId)}`),
  /** Phase 19-CHAT.5 — cancel a running turn. */
  crmChatCancelTurn: (turnId: string) =>
    request<CRMChatTurnStatus>(`/CRMChat/action/turns/${encodeURIComponent(turnId)}/cancel`, post({})),
  /** Phase 19-CHAT.8 — reauthorize citations before rendering. */
  crmChatReauthorizeCitations: (citations: readonly unknown[]) =>
    request<{ citations: readonly { accessible: boolean; resolvedRoute?: string | undefined }[] }>(
      '/CRMChat/action/citations/reauthorize',
      post({ citations }),
    ),
  /** Phase 19-CHAT.9 — search help content for "how do I" questions. */
  crmChatSearchHelp: (query: string) =>
    request<{ query: string; sources: readonly unknown[]; hasResults: boolean; message?: string | undefined }>(
      `/CRMChat/action/help/search?q=${encodeURIComponent(query)}`,
    ),

  // Phase 19-CHAT.14 — saved prompt templates. The body is data the SPA inserts into the
  // composer; the server never executes it.
  crmChatPrompts: () => request<{ list: readonly CRMChatPromptView[]; count: number }>('/CRMChat/action/prompts'),
  crmChatCreatePrompt: (input: { name: string; promptTemplate: string; description?: string }) =>
    request<CRMChatPromptView>('/CRMChat/action/prompts', post(input)),
  crmChatPatchPrompt: (
    id: string,
    changes: { name?: string; promptTemplate?: string; description?: string | null; enabled?: boolean },
  ) => request<CRMChatPromptView>(`/CRMChat/action/prompts/${encodeURIComponent(id)}`, patch(changes)),
  crmChatDeletePrompt: (id: string) =>
    request<{ status: true }>(`/CRMChat/action/prompts/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /** Phase 19-CHAT.14 — rate the answer a turn produced. */
  crmChatSubmitFeedback: (turnId: string, input: { rating: 'up' | 'down'; category?: string; comment?: string }) =>
    request<{ status: true; feedback: CRMChatFeedbackView }>(
      `/CRMChat/action/turns/${encodeURIComponent(turnId)}/feedback`,
      post(input),
    ),

  // Phase 19-CHAT.12 — an action proposal and its decision.
  crmChatAction: (approvalId: string) =>
    request<CRMChatActionView>(`/CRMChat/action/actions/${encodeURIComponent(approvalId)}`),
  crmChatConfirmAction: (approvalId: string, note?: string) =>
    request<{ action: CRMChatActionView; resumed: boolean }>(
      `/CRMChat/action/actions/${encodeURIComponent(approvalId)}/confirm`,
      post(note === undefined ? {} : { note }),
    ),
  crmChatRejectAction: (approvalId: string, note?: string) =>
    request<{ action: CRMChatActionView; resumed: boolean }>(
      `/CRMChat/action/actions/${encodeURIComponent(approvalId)}/reject`,
      post(note === undefined ? {} : { note }),
    ),

  // Phase 19-CHAT.11 — curated cross-module paths.
  crmChatCrossModuleScenarios: () =>
    request<{ list: readonly CRMChatCrossModuleScenario[] }>('/CRMChat/action/cross-module/scenarios'),
  crmChatAnalyzeCrossModule: (scenario: string, rootId: string) =>
    request<{ steps: readonly { relation: string; label: string; count: number; records: readonly unknown[] }[] }>(
      '/CRMChat/action/cross-module/analyze',
      post({ scenario, rootId }),
    ),

  /** Phase 19-CHAT.17 — the usage of one turn. */
  crmChatTurnUsage: (turnId: string) =>
    request<CRMChatUsageSummary>(`/CRMChat/action/turns/${encodeURIComponent(turnId)}/usage`),

  // Phase 19-AI.2/19-AI.4 — the administrative surfaces of the module: the policy settings row and
  // the provider connections. Both are guarded by a capability the server asserts; the SPA only
  // presents them to a caller who already holds it.
  aiAgentsSettings: () => request<AIAgentsSettingsView>('/AIAgents/action/settings'),
  /** A validated patch; the server merges it into the stored row and bumps the version. */
  saveAiAgentsSettings: (patch: Record<string, unknown>) =>
    request<AIAgentsSettingsView>('/AIAgents/action/settings', post(patch)),
  aiAgentsProvider: (key: string) => request<AIAgentsProviderConnection>(`/AIAgents/action/providers/${encodeURIComponent(key)}`),
  aiAgentsCreateProvider: (input: Record<string, unknown>) =>
    request<AIAgentsProviderConnection>('/AIAgents/action/providers', post(input)),
  aiAgentsUpdateProvider: (key: string, input: Record<string, unknown>) =>
    request<AIAgentsProviderConnection>(`/AIAgents/action/providers/${encodeURIComponent(key)}`, patch(input)),
  aiAgentsDeleteProvider: (key: string) =>
    request<{ success: boolean }>(`/AIAgents/action/providers/${encodeURIComponent(key)}`, { method: 'DELETE' }),
  /** One tiny provider turn; returns status, latency and usage only — never the model text. */
  aiAgentsCheckProvider: (key: string, input: { model?: string; prompt?: string } = {}) =>
    request<AIAgentProviderCheckResult>(`/AIAgents/action/providers/${encodeURIComponent(key)}/check`, post(input)),

  // Phase 19-AI.5–19-AI.10: definitions, runs and approvals. Every method is an existing, guarded
  // module endpoint; the SPA adds presentation only and never a second authorization path.
  aiAgentsTools: () => request<AIAgentToolCatalogue>('/AIAgents/action/tools'),
  aiAgentsProviders: () => request<{ list: AIAgentsProviderConnection[] }>('/AIAgents/action/providers'),
  aiAgentsTemplates: () => request<{ list: AIAgentTemplate[] }>('/AIAgents/action/templates'),
  aiAgentsAgents: (params: { offset?: number; maxSize?: number; status?: string; q?: string; scope?: 'mine' | 'all' } = {}) => {
    const query = new URLSearchParams();
    if (params.offset !== undefined) query.set('offset', String(params.offset));
    if (params.maxSize !== undefined) query.set('maxSize', String(params.maxSize));
    if (params.status) query.set('status', params.status);
    if (params.q) query.set('q', params.q);
    if (params.scope) query.set('scope', params.scope);
    const suffix = query.toString() === '' ? '' : `?${query.toString()}`;
    return request<AIAgentListResult>(`/AIAgents/action/agents${suffix}`);
  },
  aiAgentsAgent: (id: string) => request<AIAgentView>(`/AIAgents/action/agents/${encodeURIComponent(id)}`),
  aiAgentsCreateAgent: (input: Record<string, unknown>) => request<AIAgentView>('/AIAgents/action/agents', post(input)),
  aiAgentsUpdateAgent: (id: string, input: Record<string, unknown>) =>
    request<AIAgentView>(`/AIAgents/action/agents/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  aiAgentsValidate: (id: string) =>
    request<AIAgentValidationReport>(`/AIAgents/action/agents/${encodeURIComponent(id)}/validate`),
  aiAgentsPublish: (id: string, note?: string) =>
    request<{ agent: AIAgentView; version: AIAgentVersionView; report: AIAgentValidationReport }>(
      `/AIAgents/action/agents/${encodeURIComponent(id)}/publish`,
      post({ note }),
    ),
  aiAgentsPause: (id: string) =>
    request<AIAgentView>(`/AIAgents/action/agents/${encodeURIComponent(id)}/pause`, post({})),
  aiAgentsResume: (id: string) =>
    request<AIAgentView>(`/AIAgents/action/agents/${encodeURIComponent(id)}/resume`, post({})),
  aiAgentsArchive: (id: string) =>
    request<AIAgentView>(`/AIAgents/action/agents/${encodeURIComponent(id)}/archive`, post({})),
  aiAgentsRestore: (id: string) =>
    request<AIAgentView>(`/AIAgents/action/agents/${encodeURIComponent(id)}/restore`, post({})),
  aiAgentsVersions: (id: string) =>
    request<{ list: AIAgentVersionView[] }>(`/AIAgents/action/agents/${encodeURIComponent(id)}/versions`),
  aiAgentsVersion: (id: string, version: number) =>
    request<AIAgentVersionView & { config: AIAgentView['draftConfig'] }>(
      `/AIAgents/action/agents/${encodeURIComponent(id)}/versions/${String(version)}`,
    ),
  aiAgentsRuns: (params: { offset?: number; maxSize?: number; status?: string; agentId?: string; scope?: 'mine' | 'all' } = {}) => {
    const query = new URLSearchParams();
    if (params.offset !== undefined) query.set('offset', String(params.offset));
    if (params.maxSize !== undefined) query.set('maxSize', String(params.maxSize));
    if (params.status) query.set('status', params.status);
    if (params.agentId) query.set('agentId', params.agentId);
    if (params.scope) query.set('scope', params.scope);
    const suffix = query.toString() === '' ? '' : `?${query.toString()}`;
    return request<AIAgentRunListResult>(`/AIAgents/action/runs${suffix}`);
  },
  aiAgentsRun: (id: string) => request<AIAgentRunView>(`/AIAgents/action/runs/${encodeURIComponent(id)}`),
  aiAgentsRunEvents: (id: string) =>
    request<{ list: AIAgentRunEventView[] }>(`/AIAgents/action/runs/${encodeURIComponent(id)}/events`),
  aiAgentsRunToolCalls: (id: string) =>
    request<{ list: AIAgentRunToolCallView[] }>(`/AIAgents/action/runs/${encodeURIComponent(id)}/toolCalls`),
  aiAgentsRunsForAgent: (agentId: string) =>
    request<AIAgentRunListResult>(`/AIAgents/action/runs?agentId=${encodeURIComponent(agentId)}&maxSize=50`),
  aiAgentsCreateRun: (
    agentId: string,
    input: { text?: string; record?: { entity: string; id: string } },
    idempotencyKey?: string,
    conversationId?: string,
  ) =>
    request<AIAgentRunView>(
      `/AIAgents/action/agents/${encodeURIComponent(agentId)}/runs`,
      post({ input, idempotencyKey, conversationId }),
    ),
  aiAgentsRetryRun: (id: string, idempotencyKey?: string) =>
    request<AIAgentRunView>(`/AIAgents/action/runs/${encodeURIComponent(id)}/retry`, post({ idempotencyKey })),
  aiAgentsCancelRun: (id: string) =>
    request<AIAgentRunView>(`/AIAgents/action/runs/${encodeURIComponent(id)}/cancel`, post({})),
  aiAgentsInputRun: (id: string, text: string) =>
    request<AIAgentRunView>(`/AIAgents/action/runs/${encodeURIComponent(id)}/input`, post({ text })),
  aiAgentsResumeRun: (id: string) =>
    request<AIAgentRunView>(`/AIAgents/action/runs/${encodeURIComponent(id)}/resume`, post({})),
  aiAgentsExecuteRun: (id: string) =>
    request<{ run: AIAgentRunView; claimed: boolean; waitingForApproval: boolean }>(
      `/AIAgents/action/runs/${encodeURIComponent(id)}/execute`,
      post({}),
    ),
  aiAgentsApprovals: (params: { status?: string; runId?: string; agentId?: string } = {}) => {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (params.runId) query.set('runId', params.runId);
    if (params.agentId) query.set('agentId', params.agentId);
    const suffix = query.toString() === '' ? '' : `?${query.toString()}`;
    return request<AIAgentApprovalListResult>(`/AIAgents/action/approvals${suffix}`);
  },
  aiAgentsRunApprovals: (runId: string) =>
    request<{ list: AIAgentApprovalView[] }>(`/AIAgents/action/runs/${encodeURIComponent(runId)}/approvals`),
  aiAgentsApprove: (id: string, note?: string) =>
    request<{ approval: AIAgentApprovalView; resumed: boolean }>(
      `/AIAgents/action/approvals/${encodeURIComponent(id)}/approve`,
      post({ note }),
    ),
  aiAgentsReject: (id: string, note?: string) =>
    request<{ approval: AIAgentApprovalView; resumed: boolean }>(
      `/AIAgents/action/approvals/${encodeURIComponent(id)}/reject`,
      post({ note }),
    ),
  aiAgentsConversations: (params: { agentId?: string; maxSize?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.agentId) query.set('agentId', params.agentId);
    if (params.maxSize !== undefined) query.set('maxSize', String(params.maxSize));
    const suffix = query.toString() === '' ? '' : `?${query.toString()}`;
    return request<{ list: AIAgentConversationView[] }>(`/AIAgents/action/conversations${suffix}`);
  },
  aiAgentsConversation: (id: string) =>
    request<{ conversation: AIAgentConversationView; messages: AIAgentConversationMessageView[] }>(
      `/AIAgents/action/conversations/${encodeURIComponent(id)}`,
    ),
  aiAgentsArchiveConversation: (id: string) =>
    request<AIAgentConversationView>(`/AIAgents/action/conversations/${encodeURIComponent(id)}/archive`, post({})),
  aiAgentsDeleteConversation: (id: string) =>
    request<{ status: boolean }>(`/AIAgents/action/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  aiAgentsMemory: (params: { agentId?: string } = {}) => {
    const suffix = params.agentId === undefined ? '' : `?agentId=${encodeURIComponent(params.agentId)}`;
    return request<{ list: AIAgentMemoryView[] }>(`/AIAgents/action/memory${suffix}`);
  },
  aiAgentsDeleteMemory: (id: string) =>
    request<{ status: boolean }>(`/AIAgents/action/memory/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  aiAgentsRetentionDryRun: () => request<AIAgentRetentionReport>('/AIAgents/action/retention/dryRun'),
  aiAgentsRetentionRun: () =>
    request<AIAgentRetentionReport>('/AIAgents/action/retention/run', post({})),
  aiAgentsUsage: () => request<AIAgentUsageView>('/AIAgents/action/usage'),
  aiAgentsEvalSuites: () => request<{ list: unknown[] }>('/AIAgents/action/evaluations'),
  aiAgentsEnsureEvalSuite: () => request<unknown>('/AIAgents/action/evaluations', post({})),
  aiAgentsCreateEvalCase: (suiteKey: string, input: { caseKey: string; title: string; grader: string; graderConfig?: Record<string, unknown> }) =>
    request<unknown>(`/AIAgents/action/evaluations/${encodeURIComponent(suiteKey)}`, post(input)),
  aiAgentsRunEval: (agentId: string, suiteId: string) =>
    request<unknown>(`/AIAgents/action/agents/${encodeURIComponent(agentId)}/evaluations/run`, post({ suiteId })),
  aiAgentsEvalRuns: (agentId: string, maxSize?: number) =>
    request<{ list: unknown[] }>(`/AIAgents/action/agents/${encodeURIComponent(agentId)}/evaluations${maxSize === undefined ? '' : `?maxSize=${maxSize}`}`),
  aiAgentsDecideEval: (agentId: string, runId: string, caseKey: string, decision: 'passed' | 'failed', note?: string) =>
    request<unknown>(`/AIAgents/action/agents/${encodeURIComponent(agentId)}/evaluations/${encodeURIComponent(runId)}/decide`, post({ caseKey, decision, note })),
  aiAgentsCompareEval: (agentId: string) =>
    request<unknown>(`/AIAgents/action/agents/${encodeURIComponent(agentId)}/evaluations/compare`),
  aiAgentsPricing: (providerKey?: string) =>
    request<{ list: AIAgentPricingSnapshot[] }>(
      `/AIAgents/action/pricing${providerKey === undefined ? '' : `?providerKey=${encodeURIComponent(providerKey)}`}`,
    ),
  aiAgentsCreatePricing: (input: {
    providerKey: string;
    model: string;
    inputPricePerMillion: number;
    outputPricePerMillion: number;
    cachedInputPricePerMillion?: number;
  }) => request<AIAgentPricingSnapshot>('/AIAgents/action/pricing', post(input)),
  aiAgentsReplacePricing: (
    id: string,
    input: { inputPricePerMillion: number; outputPricePerMillion: number; cachedInputPricePerMillion?: number },
  ) => request<AIAgentPricingSnapshot>(`/AIAgents/action/pricing/${encodeURIComponent(id)}/replace`, post(input)),
  aiAgentsDeletePricing: (id: string) =>
    request<{ deleted: boolean }>(`/AIAgents/action/pricing/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  aiAgentsQuotas: () => request<{ list: AIAgentBudgetPolicy[] }>('/AIAgents/action/quotas'),
  aiAgentsQuotaStatus: () => request<{ list: AIAgentBudgetPolicyStatus[] }>('/AIAgents/action/quotas/status'),
  aiAgentsCreateQuota: (input: {
    scope: 'global' | 'user' | 'team' | 'agent' | 'provider';
    scopeRef?: string;
    providerKey?: string;
    agentId?: string;
    period: 'day' | 'month';
    maxRequests?: number;
    maxTokens?: number;
    maxCostUsd?: number;
    maxRuns?: number;
    maxConcurrentRuns?: number;
    warnPercent?: number;
  }) => request<AIAgentBudgetPolicy>('/AIAgents/action/quotas', post(input)),
  aiAgentsDeleteQuota: (id: string) =>
    request<{ deleted: boolean }>(`/AIAgents/action/quotas/${encodeURIComponent(id)}`, { method: 'DELETE' }),
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

  // Phase 20.7 — identity administration (PLAN_Phase_20 §4.3 rows 9–12). These are the existing
  // `/User`, `/Role`, `/Team`, `/ApiUser`, `/ApiKey` endpoints; the UI adds no second authority path.
  roles: (params: { offset?: number | undefined; maxSize?: number | undefined } = {}) =>
    request<ListResult<Role>>(`/Role${simpleQuery(params)}`),
  role: (id: string) => request<Role>(`/Role/${encodeURIComponent(id)}`),
  createRole: (input: { name: string; permissions?: Record<string, Record<string, string>>; fieldPermissions?: Role['fieldPermissions'] }) =>
    request<Role>('/Role', post(input)),
  patchRole: (id: string, patch: Record<string, unknown>) =>
    request<Role>(`/Role/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteRole: (id: string) => request<{ success: boolean }>(`/Role/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  users: (
    params: {
      offset?: number | undefined;
      maxSize?: number | undefined;
      where?: string | undefined;
      isActive?: 'true' | 'false' | undefined;
      type?: UserAccountType | undefined;
      roleId?: string | undefined;
      teamId?: string | undefined;
    } = {},
  ) => request<ListResult<UserRow>>(`/User${simpleQuery(params)}`),
  user: (id: string) => request<UserRow>(`/User/${encodeURIComponent(id)}`),
  createUser: (input: UserInput) => request<UserRow>('/User', post(input)),
  updateUser: (id: string, input: UserInput) =>
    request<UserRow>(`/User/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deleteUser: (id: string) => request<{ success: boolean }>(`/User/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  resetUserPassword: (id: string, password: string) =>
    request<{ success: boolean }>(`/User/${encodeURIComponent(id)}/password-reset`, post({ password })),

  teams: (params: { offset?: number | undefined; maxSize?: number | undefined } = {}) =>
    request<ListResult<TeamRow>>(`/Team${simpleQuery(params)}`),
  getTeam: (id: string) => request<TeamRow>(`/Team/${encodeURIComponent(id)}`),
  createTeam: (input: { name: string; userIds?: string[]; roleIds?: string[]; isPrivate?: boolean }) =>
    request<TeamRow>('/Team', post(input)),
  updateTeam: (id: string, input: Partial<{ name: string; userIds: string[]; roleIds: string[]; isPrivate: boolean }>) =>
    request<TeamRow>(`/Team/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deleteTeam: (id: string) => request<{ success: boolean }>(`/Team/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  apiUsers: () => request<{ list: ApiUserRow[]; total: number }>('/ApiUser'),
  createApiUser: (input: { userName: string; assignedRoleIds?: string[] }) => request<ApiKeySecret>('/ApiUser', post(input)),
  issueApiKey: (apiUserId: string) => request<ApiKeySecret>(`/ApiUser/${encodeURIComponent(apiUserId)}/key`, { method: 'POST' }),
  apiKeys: (apiUserId: string) => request<{ list: ApiKeyRow[] }>(`/ApiKey/${encodeURIComponent(apiUserId)}`),
  revokeApiKey: (keyId: string) => request<{ success: boolean }>(`/ApiKey/${encodeURIComponent(keyId)}`, { method: 'DELETE' }),

  // Phase 20.9 — security, messaging and internal administration. Mailboxes and webhook endpoints are
  // existing APIs; the internal routes are the guarded danger zone, each requiring a typed confirmation.
  emailAccounts: () => request<EmailAccountRow[]>('/EmailAccount'),
  createEmailAccount: (input: EmailAccountInput) => request<EmailAccountRow>('/EmailAccount', post(input)),
  updateEmailAccount: (id: string, input: EmailAccountInput) =>
    request<EmailAccountRow>(`/EmailAccount/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deleteEmailAccount: (id: string) => request<{ id: string; deleted: boolean }>(`/EmailAccount/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  verifyEmailAccount: (id: string) => request<{ verified: boolean; error: string | null }>(`/EmailAccount/${encodeURIComponent(id)}/action/verify`, { method: 'POST' }),
  emailTransport: () => request<EmailTransportInfo>('/Email/action/transport'),
  verifyEmailTransport: () => request<{ transport: string; verified: boolean; error: string | null }>('/Email/action/verify', { method: 'POST' }),
  // The designer previews the draft it holds in memory, so the content travels in the body and nothing
  // is stored: the response is the rendered parts plus the tokens that did not resolve.
  previewEmailTemplate: (input: EmailTemplatePreviewInput) =>
    request<EmailTemplatePreviewView>('/EmailTemplate/action/preview', post(input)),

  webhookEndpoints: () => request<{ list: WebhookEndpointRow[]; total: number }>('/WebhookEndpoint'),
  createWebhookEndpoint: (input: { name: string; url: string; events?: string[]; secret?: string; enabled?: boolean }) =>
    request<WebhookEndpointRow>('/WebhookEndpoint', post(input)),
  updateWebhookEndpoint: (id: string, input: { name?: string; url?: string; events?: string[]; secret?: string; enabled?: boolean }) =>
    request<WebhookEndpointRow>(`/WebhookEndpoint/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(input) }),
  deleteWebhookEndpoint: (id: string) => request<{ id: string; removed: boolean }>(`/WebhookEndpoint/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  webhookDeliveries: (id: string) => request<{ list: WebhookDeliveryRow[]; total: number }>(`/WebhookEndpoint/${encodeURIComponent(id)}/deliveries`),

  internalInfo: () => request<InternalInfoView>('/AdminInternal'),
  resetMetadataOverrides: (confirm: string) => request<{ cleared: number }>('/AdminInternal/action/metadata-reset', post({ confirm })),
  purgeJobQueue: (confirm: string) => request<{ drained: number | null }>('/AdminInternal/action/queue-purge', post({ confirm })),

  // Phase 20.10 — per-user preferences. The routes carry no user id: the caller's own rows are the
  // only ones reachable, so a preference cannot leak between accounts by construction.
  preferences: () => request<{ items: PreferenceItem[] }>('/Preferences'),
  preference: (name: string) => request<PreferenceItem>(`/Preferences/${encodeURIComponent(name)}`),
  savePreference: (name: string, value: unknown) =>
    request<PreferenceItem>(`/Preferences/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ value }) }),

  // Phase 20.15 — setup checklist for first-run administrators.
  setupChecklist: () => request<SetupChecklistView>('/SetupChecklist'),

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
  massUpdate: (entity: string, input: { ids: string[]; values: Record<string, unknown> }) =>
    request<unknown>(`/${encodeURIComponent(entity)}/action/massUpdate`, { method: 'POST', body: JSON.stringify(input) }),

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
  notifications: (params: { unreadOnly?: boolean; maxSize?: number; offset?: number } = {}) =>
    request<NotificationListResult>(
      `/Notification${simpleQuery({
        unreadOnly: params.unreadOnly ? 'true' : undefined,
        maxSize: params.maxSize,
        offset: params.offset,
      })}`,
    ),
  markNotificationRead: (id: string) => request<unknown>(`/Notification/${encodeURIComponent(id)}/Read`, { method: 'POST' }),
  markAllNotificationsRead: () => request<{ status: boolean; updated: number }>('/Notification/Read-all', { method: 'POST' }),

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
  /** The start menu on a record: published + enabled processes bound to this type (or any). */
  availableProcesses: (entityType: string) =>
    request<AvailableProcessListResult>(`/Process/action/available${simpleQuery({ entityType })}`),
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

  processInstances: (params: {
    definitionId?: string | undefined;
    status?: string | undefined;
    entityType?: string | undefined;
    entityId?: string | undefined;
    offset?: number | undefined;
    limit?: number | undefined;
  } = {}) => request<ProcessInstanceListResult>(`/ProcessInstance${simpleQuery(params)}`),
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

  // Phase 19-VC.2–19-VC.5 — Voice & Communications diagnostics and its admin screen (19-VC.18).
  // The settings document, provider accounts and sender numbers are writable here; credentials are
  // write-only, so no method here ever returns a stored secret.
  voiceCommunicationsHealth: () =>
    request<VoiceCommunicationsHealthView>('/VoiceCommunications/action/health'),
  voiceCommunicationsSettings: () =>
    request<VoiceCommunicationsSettingsView>('/VoiceCommunications/action/settings'),
  saveVoiceCommunicationsSettings: (input: Record<string, unknown>) =>
    request<VoiceCommunicationsSettingsView>('/VoiceCommunications/action/settings', post(input)),
  voiceCommunicationsAccounts: () =>
    request<{ list: VoiceProviderAccountView[] }>('/VoiceCommunications/action/accounts'),
  voiceProviderCatalog: () =>
    request<VoiceProviderCatalogView>('/VoiceCommunications/action/providers'),
  createVoiceProviderAccount: (input: VoiceProviderAccountInput) =>
    request<VoiceProviderAccountView>('/VoiceCommunications/action/accounts', post(input)),
  updateVoiceProviderAccount: (key: string, input: VoiceProviderAccountPatch) =>
    request<VoiceProviderAccountView>(`/VoiceCommunications/action/accounts/${encodeURIComponent(key)}`, patch(input)),
  removeVoiceProviderAccount: (key: string) =>
    request<{ success: boolean }>(`/VoiceCommunications/action/accounts/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    }),
  setVoiceProviderAccountEnabled: (key: string, enabled: boolean) =>
    request<VoiceProviderAccountView>(`/VoiceCommunications/action/accounts/${encodeURIComponent(key)}/enabled`, post({ enabled })),
  voiceProviderAccountHealth: (key: string) =>
    request<{ ok: boolean; checkedAt: string; detail: string; persisted: boolean }>(
      `/VoiceCommunications/action/accounts/${encodeURIComponent(key)}/health`,
      post({}),
    ),
  voiceProviderEndpoints: (key: string) =>
    request<{ list: VoiceEndpointView[] }>(`/VoiceCommunications/action/accounts/${encodeURIComponent(key)}/endpoints`),
  createVoiceProviderEndpoint: (key: string, input: VoiceEndpointInput) =>
    request<VoiceEndpointView>(`/VoiceCommunications/action/accounts/${encodeURIComponent(key)}/endpoints`, post(input)),
  setVoiceProviderEndpointActive: (key: string, endpointKey: string, active: boolean) =>
    request<VoiceEndpointView>(
      `/VoiceCommunications/action/accounts/${encodeURIComponent(key)}/endpoints/${encodeURIComponent(endpointKey)}`,
      patch({ active }),
    ),
  voiceCommunicationsWebhookEvents: (limit = 25) =>
    request<VoiceWebhookEventList>(`/VoiceCommunications/action/webhook-events${simpleQuery({ limit })}`),

  // Phase 19-VC.12–19-VC.17 — the agent workspace. Every method maps to one documented action; the
  // server owns ACL, policy and idempotency, so the UI never decides who may do what.
  voiceInbox: (params: { status?: string; channel?: string; assignee?: string; limit?: number; offset?: number } = {}) =>
    request<VoiceInboxList>(`/VoiceCommunications/action/inbox${simpleQuery(params)}`),
  voiceConversationTimeline: (id: string, params: { limit?: number; offset?: number } = {}) =>
    request<{ entries: VoiceTimelineEntry[] }>(
      `/VoiceCommunications/action/conversations/${encodeURIComponent(id)}/timeline${simpleQuery(params)}`,
    ),
  voiceConversationHistory: (id: string) =>
    request<{ list: VoiceConversationHistoryEntry[] }>(
      `/VoiceCommunications/action/conversations/${encodeURIComponent(id)}/history`,
    ),
  voiceMarkConversationRead: (id: string) =>
    request<{ unreadCount: number }>(`/VoiceCommunications/action/conversations/${encodeURIComponent(id)}/read`, post({})),
  voiceSetConversationStatus: (id: string, status: string, reason?: string) =>
    request<VoiceConversationView>(
      `/VoiceCommunications/action/conversations/${encodeURIComponent(id)}/status`,
      post({ status, ...(reason !== undefined ? { reason } : {}) }),
    ),
  voiceAssignConversation: (id: string, input: { userId?: string | null; teamId?: string | null; reason?: string }) =>
    request<VoiceConversationView>(
      `/VoiceCommunications/action/conversations/${encodeURIComponent(id)}/assign`,
      post(input),
    ),
  voiceHandoffConversation: (id: string, input: { subject: string; description: string; reason?: string }) =>
    request<{ caseId: string; duplicate: boolean }>(
      `/VoiceCommunications/action/conversations/${encodeURIComponent(id)}/case/handoff`,
      post(input),
    ),
  voiceLinkConversationRecord: (id: string, input: { entityType: string; entityId: string }) =>
    request<{ linked: boolean }>(
      `/VoiceCommunications/action/conversations/${encodeURIComponent(id)}/link-record`,
      post(input),
    ),
  voiceSnippets: (channel?: string) =>
    request<{ list: VoiceSnippetView[] }>(`/VoiceCommunications/action/snippets${simpleQuery({ channel })}`),
  voiceRenderSnippet: (key: string, variables: Record<string, string>) =>
    request<VoiceSnippetRender>(
      `/VoiceCommunications/action/snippets/${encodeURIComponent(key)}/render`,
      post({ variables }),
    ),
  voiceValidateComposer: (channel: 'sms' | 'mms' | 'whatsapp', body: string) =>
    request<VoiceComposerValidation>('/VoiceCommunications/action/composer/validate', post({ channel, body })),
  voiceSendMessage: (input: {
    channel: 'sms' | 'mms' | 'whatsapp';
    conversationId: string;
    body: string;
    idempotencyKey: string;
    isInternalNote?: boolean;
    templateKey?: string;
  }) => request<{ message: VoiceMessageView; duplicate: boolean }>('/VoiceCommunications/action/messages/send', post(input)),
  voiceInitiateCall: (input: { to: string; idempotencyKey: string; relatedEntityType?: string; relatedEntityId?: string }) =>
    request<{ session: VoiceCallSessionView; duplicate: boolean }>(
      '/VoiceCommunications/action/calls/initiate',
      post(input),
    ),
  voiceCalls: (params: { state?: string; limit?: number; offset?: number } = {}) =>
    request<{ list: VoiceCallSessionView[] }>(`/VoiceCommunications/action/calls${simpleQuery(params)}`),
  voiceIncomingCalls: () =>
    request<{ list: VoiceIncomingCallView[] }>('/VoiceCommunications/action/calls/incoming'),
  /** Answer or end a live call. The server refuses an action the provider account does not grant. */
  voiceCallControl: (callId: string, action: VoiceCallControlAction) =>
    request<VoiceCallSessionView>(
      `/VoiceCommunications/action/calls/${encodeURIComponent(callId)}/control`,
      post({ action }),
    ),
  voiceCallContext: (callId: string) =>
    request<VoiceCallContextView>(`/VoiceCommunications/action/calls/${encodeURIComponent(callId)}/context`),
  voiceCallNote: (callId: string, description: string) =>
    request<VoiceCallSessionView>(`/VoiceCommunications/action/calls/${encodeURIComponent(callId)}/note`, post({ description })),
  voiceCallLink: (callId: string, entityType: string, entityId: string) =>
    request<VoiceCallSessionView>(
      `/VoiceCommunications/action/calls/${encodeURIComponent(callId)}/link`,
      post({ entityType, entityId }),
    ),
  voiceCallMedia: (callId: string) =>
    request<{ list: VoiceMediaView[] }>(`/VoiceCommunications/action/calls/${encodeURIComponent(callId)}/media`),
  voiceMediaPlayback: (mediaId: string) =>
    request<{ contentType: string; filename: string; dataBase64: string }>(
      `/VoiceCommunications/action/media/${encodeURIComponent(mediaId)}/playback`,
    ),
  voiceCallTranscript: (callId: string) =>
    request<{ transcript: VoiceTranscriptView | null }>(
      `/VoiceCommunications/action/calls/${encodeURIComponent(callId)}/transcript`,
    ),
  voiceRequestTranscript: (callId: string) =>
    request<VoiceTranscriptView>(
      `/VoiceCommunications/action/calls/${encodeURIComponent(callId)}/transcript/request`,
      post({}),
    ),
  voiceEnrichTranscript: (callId: string) =>
    request<VoiceTranscriptView>(
      `/VoiceCommunications/action/calls/${encodeURIComponent(callId)}/transcript/enrich`,
      post({}),
    ),
  voiceReviewTranscript: (callId: string, status: 'approved' | 'dismissed') =>
    request<VoiceTranscriptView>(
      `/VoiceCommunications/action/calls/${encodeURIComponent(callId)}/transcript/review`,
      post({ status }),
    ),
  voiceRecordPanel: (entityType: string, entityId: string, params: { limit?: number; offset?: number } = {}) =>
    request<VoiceRecordPanelView>(
      `/VoiceCommunications/action/panels/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}${simpleQuery(params)}`,
    ),

  /* ---------------------------------------------------------------------
   * Phase 19-INT.14 / 19-INT.15 — the Advanced Integrations admin surface.
   * ------------------------------------------------------------------- */

  advancedIntegrationsCapabilities: () =>
    request<AdvancedIntegrationsCapabilitiesView>('/AdvancedIntegrations/action/capabilities'),
  integrationCatalog: () => request<IntegrationCatalogResult>('/AdvancedIntegrations/action/catalog'),
  integrationConnections: () => request<IntegrationConnectionListResult>('/AdvancedIntegrations/action/connections'),
  integrationConnection: (id: string) =>
    request<IntegrationConnectionDetail>(`/AdvancedIntegrations/action/connections/${encodeURIComponent(id)}/detail`),
  integrationConnectionTest: (id: string) =>
    request<IntegrationConnectionTestResult>(
      `/AdvancedIntegrations/action/connections/${encodeURIComponent(id)}/test`,
      post({}),
    ),
  integrationRotateSecret: (id: string, input: { kind: string; value: string }) =>
    request<IntegrationConnection>(
      `/AdvancedIntegrations/action/connections/${encodeURIComponent(id)}/rotate-secret`,
      post(input),
    ),
  integrationReconcile: (id: string) =>
    request<IntegrationReconcileResult>(
      `/AdvancedIntegrations/action/connections/${encodeURIComponent(id)}/reconcile`,
      post({}),
    ),
  integrationLogs: (id: string, params: { limit?: number } = {}) =>
    request<IntegrationJobLogResult>(
      `/AdvancedIntegrations/action/connections/${encodeURIComponent(id)}/logs${simpleQuery(params)}`,
    ),
  integrationMappings: () => request<IntegrationMappingListResult>('/AdvancedIntegrations/action/mappings'),
  integrationMapping: (id: string) =>
    request<IntegrationMappingView>(`/AdvancedIntegrations/action/mappings/${encodeURIComponent(id)}`),
  integrationMappingFields: (id: string) =>
    request<IntegrationMappingFields>(`/AdvancedIntegrations/action/mappings/${encodeURIComponent(id)}/fields`),
  integrationMappingUpdate: (
    id: string,
    input: {
      crmEntityType?: string;
      direction?: string;
      syncMode?: string;
      conflictPolicy?: string;
      deletionPolicy?: string;
      fieldAuthority?: Record<string, string>;
      fields?: { sourcePath: string; targetField: string; transform: unknown; required: boolean; direction: string }[];
    },
  ) => request<IntegrationMappingView>(`/AdvancedIntegrations/action/mappings/${encodeURIComponent(id)}`, patch(input)),
  integrationMappingActivate: (id: string) =>
    request<IntegrationMappingView>(`/AdvancedIntegrations/action/mappings/${encodeURIComponent(id)}/activate`, post({})),
  integrationMappingRetire: (id: string) =>
    request<IntegrationMappingView>(`/AdvancedIntegrations/action/mappings/${encodeURIComponent(id)}/retire`, post({})),
  integrationMappingPreview: (id: string, sample: Record<string, unknown>) =>
    request<IntegrationMappingPreview>(`/AdvancedIntegrations/action/mappings/${encodeURIComponent(id)}/preview`, post({ sample })),
  integrationMappingCreate: (input: Record<string, unknown>) =>
    request<IntegrationMappingView>('/AdvancedIntegrations/action/mappings', post(input)),
  integrationRun: (id: string) => request<IntegrationSyncRun>(`/AdvancedIntegrations/action/runs/${encodeURIComponent(id)}`),
  integrationRuns: (connectionId: string) =>
    request<IntegrationSyncRunListResult>(
      `/AdvancedIntegrations/action/connections/${encodeURIComponent(connectionId)}/runs`,
    ),
  integrationRunStart: (mappingId: string, input: { runType?: string; maxRecords?: number; pageSize?: number } = {}) =>
    request<IntegrationSyncRun>(`/AdvancedIntegrations/action/mappings/${encodeURIComponent(mappingId)}/sync`, post(input)),
  integrationRunOperations: (runId: string, params: { status?: string; limit?: number } = {}) =>
    request<IntegrationSyncOperationListResult>(
      `/AdvancedIntegrations/action/runs/${encodeURIComponent(runId)}/operations${simpleQuery(params)}`,
    ),
  integrationOperationRetry: (id: string) =>
    request<IntegrationSyncOperation>(`/AdvancedIntegrations/action/operations/${encodeURIComponent(id)}/retry`, post({})),
  integrationConflicts: (connectionId: string) =>
    request<IntegrationConflictListResult>(
      `/AdvancedIntegrations/action/connections/${encodeURIComponent(connectionId)}/conflicts`,
    ),
  integrationConflict: (id: string) => request<IntegrationConflict>(`/AdvancedIntegrations/action/conflicts/${encodeURIComponent(id)}`),
  integrationConflictResolve: (id: string, resolution: IntegrationConflictResolution) =>
    request<IntegrationConflict>(`/AdvancedIntegrations/action/conflicts/${encodeURIComponent(id)}/resolve`, post({ resolution })),
  integrationConnectionCreate: (input: Record<string, unknown>) =>
    request<IntegrationConnection>('/AdvancedIntegrations/action/connections', post(input)),
  integrationConnectionUpdate: (id: string, input: Record<string, unknown>) =>
    request<IntegrationConnection>(
      `/AdvancedIntegrations/action/connections/${encodeURIComponent(id)}`,
      patch(input),
    ),
  integrationConnectionPause: (id: string) =>
    request<IntegrationConnection>(
      `/AdvancedIntegrations/action/connections/${encodeURIComponent(id)}/pause`,
      post({}),
    ),
  integrationConnectionResume: (id: string) =>
    request<IntegrationConnection>(
      `/AdvancedIntegrations/action/connections/${encodeURIComponent(id)}/resume`,
      post({}),
    ),
  integrationConnectionAuthorize: (id: string, scopes?: string[]) =>
    request<{ authorizationUrl: string; expiresAt: string }>(
      `/AdvancedIntegrations/action/connections/${encodeURIComponent(id)}/authorize`,
      post(scopes && scopes.length > 0 ? { scopes } : {}),
    ),
  integrationConnectionRevoke: (id: string) =>
    request<{ success: boolean; providerRevoked: boolean }>(
      `/AdvancedIntegrations/action/connections/${encodeURIComponent(id)}/revoke`,
      post({}),
    ),
  integrationConnectionDelete: (id: string) =>
    request<{ success: boolean }>(`/AdvancedIntegrations/action/connections/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  integrationWebhookDeliveries: (connectionId: string) =>
    request<{ list: readonly { id: string; deliveryId: string; status: string; signatureValid: boolean; eventType: string | null; externalId: string | null; receivedAt: string }[] }>(
      `/AdvancedIntegrations/action/connections/${encodeURIComponent(connectionId)}/webhook-deliveries`,
    ),
  integrationOutbound: (connectionId: string) =>
    request<{ list: readonly { id: string; status: string; operationType: string; errorCode: string | null; createdAt: string }[] }>(
      `/AdvancedIntegrations/action/connections/${encodeURIComponent(connectionId)}/outbound`,
    ),

  // Phase 19-ES.1 — the ESignature control plane: identity, capabilities, the security policy and
  // the gate. Every read is answered from the server's own ACL; the page never infers a right.
  eSignatureHealth: () => request<ESignatureHealthView>('/ESignature/action/health'),
  eSignatureCapabilities: () => request<ESignatureCapabilitiesView>('/ESignature/action/capabilities'),
  eSignatureNav: () => request<ESignatureNavView>('/ESignature/action/nav'),
  eSignatureSettings: () => request<ESignatureSettingsView>('/ESignature/action/settings'),
  saveESignatureSettings: (patch: Record<string, unknown>) =>
    request<ESignatureSettingsView>('/ESignature/action/settings', post(patch)),
  eSignatureGateOperations: () => request<{ operations: readonly string[] }>('/ESignature/action/gate/operations'),
  eSignatureGateCheck: (operation: string) => request<{ operation: string; admitted: boolean }>('/ESignature/action/gate/check', post({ operation })),

  // Phase 19-ES.4 — the provider connection lifecycle. A secret is a write parameter only: no method
  // here can read one back, because no endpoint returns one.
  eSignatureConnections: () => request<readonly ESignatureConnectionView[]>('/ESignature/connections'),
  createESignatureConnection: (input: Record<string, unknown>) =>
    request<ESignatureConnectionView>('/ESignature/connections', post(input)),
  updateESignatureConnection: (id: string, input: Record<string, unknown>) =>
    request<ESignatureConnectionView>(`/ESignature/connections/${encodeURIComponent(id)}`, patch(input)),
  storeESignatureConnectionSecret: (id: string, kind: string, value: string) =>
    request<ESignatureConnectionView>(`/ESignature/connections/${encodeURIComponent(id)}/secret`, post({ kind, value })),
  authorizeESignatureConnection: (id: string) =>
    request<ESignatureAuthorizationStart>(`/ESignature/connections/${encodeURIComponent(id)}/authorize`, post({})),
  testESignatureConnection: (id: string) =>
    request<ESignatureConnectionTest>(`/ESignature/connections/${encodeURIComponent(id)}/test`, post({})),
  setESignatureConnectionActive: (id: string, active: boolean) =>
    request<ESignatureConnectionView>(`/ESignature/connections/${encodeURIComponent(id)}/${active ? 'enable' : 'disable'}`, post({})),
  disconnectESignatureConnection: (id: string) =>
    request<{ credentialsRemoved: number; statesDiscarded: number; hadRequests: boolean }>(
      `/ESignature/connections/${encodeURIComponent(id)}/disconnect`,
      post({}),
    ),
};