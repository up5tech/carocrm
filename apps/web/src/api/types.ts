/** Field + entity definitions as served by `GET /api/v1/Metadata` (PLAN §12, §79). */
export interface FieldDefinition {
  type: string;
  required?: boolean | undefined;
  label?: string | undefined;
  maxLength?: number | undefined;
  defaultValue?: unknown;
  entityKey?: string | undefined;
  values?: string[] | undefined;
  enum?: string[] | undefined;
  inList?: boolean | undefined;
  inDetail?: boolean | undefined;
  inEdit?: boolean | undefined;
  inFilter?: boolean | undefined;
  sortable?: boolean | undefined;
  audited?: boolean | undefined;
  formula?: string | undefined;
}

export interface RelationDefinition {
  type: string;
  target: string;
  mappedBy?: string | undefined;
  foreign?: string | undefined;
  /** Display name for the relation panel; null means "cleared back to the relation name". */
  label?: string | null | undefined;
}

/** One index declaration (PLAN §8). Declarative metadata only — no physical index is auto-created. */
export interface IndexDefinition {
  name: string;
  fields: string[];
  unique: boolean;
}

/** One panel within a per-view layout (PLAN §8). */
export interface LayoutPanel {
  name: string;
  label?: string | undefined;
  position: number;
  fields?: string[] | undefined;
  tabs?: string[] | undefined;
}

/** A single layout definition for one view (PLAN §8). */
export interface LayoutDefinition {
  entity: string;
  type: LayoutViewType;
  panels: LayoutPanel[];
}

export type LayoutViewType = 'list' | 'detail' | 'edit' | 'filter' | 'search' | 'massUpdate';

/** Optional per-entity ACL defaults stored on the entity definition (PLAN §8). */
export interface AclDefinition {
  permissions?: Record<string, Record<string, string>> | undefined;
  fieldPermissions?: Record<string, Record<string, string>> | undefined;
  recordAccess?: Record<string, Record<string, string>> | undefined;
}

export interface EntityNavSection {
  readonly hidden?: boolean | undefined;
  readonly order?: number | undefined;
  readonly group?: string | undefined;
  readonly quickCreate?: boolean | undefined;
  readonly board?: {
    readonly enabled?: boolean | undefined;
    readonly groupBy?: string | undefined;
    readonly defaultGroupBy?: string | undefined;
  } | undefined;
}

export interface EntityDefinition {
  name: string;
  label: string;
  /** Icon name from the SPA's fixed `ENTITY_ICONS` set; null means "cleared back to the default". */
  icon?: string | null | undefined;
  isEntity: boolean;
  fields: Record<string, FieldDefinition>;
  relations: Record<string, RelationDefinition>;
  indexes?: IndexDefinition[] | undefined;
  layouts?: Record<string, LayoutDefinition[]> | undefined;
  acl?: AclDefinition | undefined;
  record?: { displayField?: string | undefined; nameField?: string | undefined } | undefined;
  /** Per-entity navigation behaviour (PLAN_Phase_20 §4.5); absent means "follow the platform default". */
  nav?: EntityNavSection | undefined;
  client?: { web?: boolean | undefined } | undefined;
  /** Declarative rules evaluated in the form and on the server (PLAN §21). */
  dynamicLogic?: { rules: Record<string, unknown>[] } | undefined;
}

/** A role as served by `GET /api/v1/Role` (the enforced ACL source, PLAN §8). */
export interface Role {
  id: string;
  name: string;
  permissions: Record<string, Record<string, string>>;
  fieldPermissions: Record<string, Record<string, Record<string, string>>>;
  createdAt: string;
  modifiedAt: string;
}

/** Account kinds the identity API can serve; mirrors `USER_ACCOUNT_TYPES` on the server. */
export type UserAccountType = 'admin' | 'regular' | 'api' | 'portal' | 'system';

/**
 * An account as served by `GET /User` and `GET /User/:id`. `teams` is only present on the single
 * record read — the list endpoint is deliberately cheaper, so the editor loads the user it opens.
 */
export interface UserRow {
  id: string;
  userName: string;
  firstName: string | null;
  lastName: string | null;
  name: string;
  emailAddress: string | null;
  isAdmin: boolean;
  isActive: boolean;
  type: UserAccountType;
  roles: string[];
  portalId: string | null;
  contactId: string | null;
  portalRoleIds: string[];
  title: string | null;
  phone: string | null;
  createdAt: string;
  modifiedAt: string;
  teams?: string[];
}

/** What the administration form sends; `null` clears a value, omitting the key keeps it. */
export interface UserInput {
  userName?: string;
  firstName?: string;
  lastName?: string;
  emailAddress?: string | null;
  password?: string;
  isAdmin?: boolean;
  isActive?: boolean;
  assignedRoleIds?: string[];
  teamIds?: string[];
  title?: string | null;
  phone?: string | null;
}

export interface TeamRow {
  id: string;
  name: string;
  userIds: string[];
  roleIds: string[];
  isPrivate: boolean;
  createdAt: string;
  modifiedAt: string;
}

/** An API account and how many of its keys still work (`GET /ApiUser`). */
export interface ApiUserRow {
  id: string;
  userName: string;
  isActive: boolean;
  roles: string[];
  createdAt: string;
  activeKeys: number;
  lastUsedAt: string | null;
}

export interface ApiKeyRow {
  id: string;
  apiUserId: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/**
 * The response that created a key. `secret` exists in this payload and nowhere else — the server
 * stores only a hash, so the UI has to show it once and never offer it again.
 */
export interface ApiKeySecret {
  id: string;
  userName: string;
  keyId: string;
  secret: string;
}

/** An outbound mailbox as `GET /EmailAccount` serves it — the password never leaves the server. */
export interface EmailAccountRow {
  id: string;
  name: string;
  emailAddress: string;
  fromName: string | null;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: string;
  smtpUsername: string | null;
  hasPassword: boolean;
  signature: string | null;
  isActive: boolean;
  isDefault: boolean;
  createdById: string | null;
  createdAt: string;
  modifiedAt: string;
}

/** What the administration form sends; `smtpPassword` is write-only and `null` clears it. */
export interface EmailAccountInput {
  name?: string;
  emailAddress?: string;
  fromName?: string | null;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecurity?: string;
  smtpUsername?: string | null;
  smtpPassword?: string | null;
  signature?: string | null;
  isActive?: boolean;
  isDefault?: boolean;
}

/** What `GET /Email/action/transport` advertises about the outbound mail configuration. */
export interface EmailTransportInfo {
  name: string;
  mode: 'live' | 'disabled';
  fromAddress: string | null;
  maxRecipients: number;
  strictFrom: boolean;
  holdsMessages: boolean;
}

export interface WebhookEndpointRow {
  id: string;
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
  hasSecret: boolean;
  createdAt: string;
  modifiedAt: string;
}

export interface WebhookDeliveryRow {
  id: string;
  endpointId: string;
  eventType: string;
  status: string;
  attempts: number;
  responseCode: number | null;
  error: string | null;
  createdAt: string;
}

/** The internal tab's read-only facts about this instance. */
export interface InternalInfoView {
  metadataVersion: number;
  entityCount: number;
  overrideCount: number;
  jobQueue: { name: string; counts: Record<string, number> | null };
  extensions: string[];
  nodeVersion: string;
  uptimeSeconds: number;
}

/**
 * One named preference document of the signed-in user (PLAN_Phase_20 §5.9). `value` is `null` when
 * the name has no row — the client keeps its own default then.
 */
export interface PreferenceItem {
  name: string;
  value: unknown;
  updatedAt: string;
}

/** Instance settings served by `GET /Settings` — public, so the sign-in page can paint the brand. */
export interface SettingsView {
  pageTitle: string | null;
  footerText: string | null;
  logoAttachmentId: string | null;
  logoUrl: string | null;
  availableLocales: string[];
  defaultLocale: string;
  enabledLocales: string[];
  defaultTimezone: string;
}

/** What the administrator sends back; `null` clears a text field, omitting a key keeps it. */
export interface SettingsPatch {
  pageTitle?: string | null;
  footerText?: string | null;
  logoAttachmentId?: string | null;
  defaultLocale?: string;
  enabledLocales?: string[];
  defaultTimezone?: string;
}

export type Metadata = Record<string, EntityDefinition>;

export interface ListResult<T = Record<string, unknown>> {
  list: T[];
  total?: number;
  offset: number;
  count: number;
}

/** The profile block `GET /AppUser/me` serves alongside the authority fields. */
export interface ProfileInfo {
  id: string;
  firstName: string | null;
  lastName: string | null;
  /** Display name: first + last, falling back to the user name. */
  name: string;
  emailAddress: string | null;
  phoneNumber: string | null;
  title: string | null;
  /** Attachment id, or null for the initials avatar. */
  avatarId: string | null;
  /** Phase 7A (PLAN §41.6): the user's locale/timezone, null = instance default. */
  locale: string | null;
  timezone: string | null;
}

/** What the signed-in user may change about themselves; `null` clears a value. */
export interface ProfilePatch {
  locale?: string | null;
  timezone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  emailAddress?: string | null;
  phoneNumber?: string | null;
  title?: string | null;
  avatarId?: string | null;
}

/** One stored file (`POST /Attachment/upload`); only the fields the UI reads are typed. */
export interface AttachmentInfo {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface Principal extends ProfileInfo {
  userName: string;
  type: string;
  roles: string[];
  teams: string[];
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  userId: string;
  type: string;
  role: string[];
  csrfToken: string;
}

/** Phase 14 — extension packages (PLAN §38). */
export interface ExtensionNavItem {
  route: string;
  label: string;
  icon?: string;
  adminOnly: boolean;
  order: number;
  extension: string;
  extensionOrder: number;
}

export interface ExtensionContributes {
  entities: string[];
  controllers: number;
  hooks: string[];
  jobs: string[];
  migrations: string[];
  navItems: number;
}

export interface ExtensionRow {
  id: string;
  name: string;
  version: string;
  description: string | null;
  order: number;
  installed: boolean;
  enabled: boolean;
  running: boolean;
  path: string | null;
  dependencies: { id: string; version?: string }[];
  permissions: string[];
  contributes: ExtensionContributes;
  problem: string | null;
  installedAt: string | null;
}

export interface ExtensionInstallResult {
  id: string;
  version: string;
  installed: true;
  migrations: { applied: string[]; skipped: string[] };
  /** Providers, controllers and metadata precedence are fixed at process start (PLAN §38.3). */
  restartRequired: true;
}

export interface ExtensionListResult {
  list: ExtensionRow[];
  total: number;
}

/** Phase 15 — workflows (PLAN §35). */
export type WorkflowNodeType = 'action' | 'condition' | 'delay' | 'end';
export type WorkflowVersionStatus = 'draft' | 'published' | 'archived';
export type WorkflowRunStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  name: string;
  /** action nodes only */
  action?: string | undefined;
  params?: Record<string, unknown> | undefined;
  next?: string | undefined;
  /** condition nodes only */
  formula?: string | undefined;
  then?: string | undefined;
  otherwise?: string | undefined;
  /** delay nodes only */
  seconds?: number | undefined;
}

export interface WorkflowDefinitionShape {
  trigger: { eventType: string; entityType: string };
  start: string;
  nodes: WorkflowNode[];
}

export interface WorkflowIssue {
  code: string;
  message: string;
  path?: string | undefined;
}

export interface WorkflowVersionView {
  id: string;
  version: number;
  status: WorkflowVersionStatus;
  definition: WorkflowDefinitionShape;
  createdAt: string;
  publishedAt: string | null;
}

export interface WorkflowView {
  id: string;
  name: string;
  entityType: string;
  eventType: string;
  isActive: boolean;
  currentVersion: number | null;
  currentVersionStatus: WorkflowVersionStatus | null;
  publishedVersion: number | null;
  versions: WorkflowVersionView[];
  createdAt: string;
  modifiedAt: string;
  issues: WorkflowIssue[];
}

export interface WorkflowActionSpec {
  name: string;
  label: string;
  description: string;
  mutatesRecords: boolean;
}

export interface WorkflowRunStepView {
  nodeId: string;
  nodeType: string;
  name: string;
  status: string;
  attempt: number;
  output: unknown;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface WorkflowRunView {
  id: string;
  workflowId: string;
  workflowName: string;
  version: number | null;
  entityType: string;
  entityId: string;
  status: WorkflowRunStatus;
  userId: string | null;
  error: string | null;
  attempt: number;
  startedAt: string;
  finishedAt: string | null;
  steps: WorkflowRunStepView[];
}

export interface WorkflowListResult {
  list: WorkflowView[];
  total: number;
}

export interface WorkflowRunListResult {
  list: WorkflowRunView[];
  total: number;
  offset: number;
  count: number;
}

/** Phase 16 — BPM process engine (PLAN §36). */
export type ProcessNodeType = 'userTask' | 'serviceTask' | 'gateway' | 'end';
export type ProcessVersionStatus = 'draft' | 'published' | 'archived';
export type ProcessInstanceStatus = 'running' | 'waiting' | 'completed' | 'cancelled' | 'failed';
export type ProcessTaskStatus = 'open' | 'overdue' | 'escalated' | 'completed' | 'cancelled';

/** How a task's responsible person is chosen; resolved against live data when the task is created. */
export interface ProcessAssigneeSpec {
  type: 'user' | 'role' | 'recordField';
  value: string;
}

/** A human decision: what can be answered at a task and where the flow goes afterwards. */
export interface ProcessOutcomeSpec {
  value: string;
  label: string;
  next: string;
}

export interface ProcessGatewayBranch {
  when: string;
  next: string;
}

/**
 * One step of a process, edited as an ordered list. Only the fields the node's `type` uses are
 * meaningful; the server's engine validates the whole graph before it can be published.
 */
export interface ProcessNode {
  id: string;
  type: ProcessNodeType;
  name: string;
  /** userTask */
  assignee?: ProcessAssigneeSpec | undefined;
  outcomes?: ProcessOutcomeSpec[] | undefined;
  dueSeconds?: number | undefined;
  escalateAfterSeconds?: number | undefined;
  escalateTo?: ProcessAssigneeSpec | undefined;
  /** serviceTask */
  action?: string | undefined;
  params?: Record<string, unknown> | undefined;
  onError?: 'fail' | 'continue' | undefined;
  /** gateway */
  branches?: ProcessGatewayBranch[] | undefined;
  default?: string | undefined;
  /** common targets */
  next?: string | undefined;
  /** end */
  outcome?: string | undefined;
}

export interface ProcessDefinitionShape {
  entityType?: string | undefined;
  start: string;
  nodes: ProcessNode[];
}

export interface ProcessIssue {
  code: string;
  message: string;
  path?: string | undefined;
}

export interface ProcessVersionView {
  id: string;
  version: number;
  status: ProcessVersionStatus;
  definition: ProcessDefinitionShape;
  createdAt: string;
  publishedAt: string | null;
}

export interface ProcessView {
  id: string;
  key: string;
  name: string;
  description: string | null;
  entityType: string;
  isActive: boolean;
  currentVersion: number | null;
  currentVersionStatus: ProcessVersionStatus | null;
  publishedVersion: number | null;
  versions: ProcessVersionView[];
  createdAt: string;
  modifiedAt: string;
  issues: ProcessIssue[];
}

export interface ProcessCatalog {
  actions: WorkflowActionSpec[];
  nodeTypes: { type: ProcessNodeType; label: string; description: string }[];
  assigneeTypes: { type: ProcessAssigneeSpec['type']; label: string; description: string }[];
}

export interface ProcessListResult {
  list: ProcessView[];
  total: number;
}

export interface ProcessTaskView {
  id: string;
  instanceId: string;
  nodeId: string;
  name: string;
  status: ProcessTaskStatus;
  assigneeId: string | null;
  assigneeRoleId: string | null;
  assigneeSpec: unknown;
  dueAt: string | null;
  escalatedAt: string | null;
  outcome: string | null;
  comment: string | null;
  completedById: string | null;
  createdAt: string;
  completedAt: string | null;
  updatedAt: string;
  processId: string;
  processName: string;
  entityType: string;
  entityId: string;
  /** What the answer buttons offer, taken from the task's node. */
  outcomes: { value: string; label: string }[];
}

export interface ProcessEventView {
  id: string;
  nodeId: string | null;
  type: string;
  message: string;
  actorId: string | null;
  data: unknown;
  createdAt: string;
}

export interface ProcessInstanceView {
  id: string;
  definitionId: string;
  processKey: string;
  processName: string;
  version: number | null;
  entityType: string;
  entityId: string;
  status: ProcessInstanceStatus;
  currentNode: string | null;
  outcome: string | null;
  error: string | null;
  initiatedBy: string | null;
  startedAt: string;
  finishedAt: string | null;
  createdAt: string;
  modifiedAt: string;
  tasks: ProcessTaskView[];
  events: ProcessEventView[];
}

export interface ProcessInstanceListResult {
  list: ProcessInstanceView[];
  total: number;
  offset: number;
  count: number;
}

export interface ProcessTaskListResult {
  list: ProcessTaskView[];
  total: number;
  offset: number;
  count: number;
}

/** Phase 17 — saved reports (PLAN §34). */
export type ReportKind = 'list' | 'summary' | 'grouped' | 'chart' | 'matrix' | 'kpi';
export type ReportAggregation = 'count' | 'sum' | 'avg' | 'min' | 'max';
export interface ReportMetricShape {
  name: string;
  operation: ReportAggregation;
  field?: string;
}
export interface ReportDefinitionShape {
  version?: 1;
  entityType: string;
  kind: ReportKind;
  filters: Record<string, unknown>[];
  columns: string[];
  groupBy?: { field: string; grain?: 'day' | 'month' | 'year' };
  matrix?: { rows: { field: string; grain?: 'day' | 'month' | 'year' }; columns: { field: string; grain?: 'day' | 'month' | 'year' } };
  metrics: ReportMetricShape[];
  calculatedMetrics?: { name: string; operation: 'add' | 'subtract' | 'multiply' | 'divide' | 'percentOf'; left: string; right: string }[];
}
export interface ReportRow {
  id: string;
  name: string;
  entityType: string;
  userId: string;
  visibility: 'private' | 'shared';
  isShared: boolean;
  definition: ReportDefinitionShape;
  createdAt: string;
  modifiedAt: string;
}
export interface ReportGroup {
  key: string;
  count: number;
  metrics: Record<string, number | null>;
}
export interface ReportRunResult {
  entityType: string;
  kind: ReportKind;
  scanned: number | null;
  total: number;
  truncated: boolean;
  columns?: string[];
  rows?: Record<string, unknown>[];
  metrics?: Record<string, number | null>;
  groups?: ReportGroup[];
  matrix?: { rowField: string; columnField: string; cells: { rowKey: string; columnKey: string; count: number; metrics: Record<string, number | null> }[] };
}
export interface ReportCsv {
  reportId: string;
  filename: string;
  csv: string;
  rows: number;
  truncated: boolean;
}
export interface ReportScheduleRow {
  id: string;
  reportId: string;
  cron: string;
  enabled: boolean;
  createdAt: string;
  modifiedAt: string;
}

/** Phase 18 — portals and external access (PLAN §37). */
export type PortalLevel = 'yes' | 'all' | 'team' | 'own' | 'no';

export interface PortalRow {
  id: string;
  name: string;
  urlPath: string;
  isActive: boolean;
  settings: Record<string, unknown>;
  userCount: number;
  portalRoleIds: string[];
  createdAt: string;
  modifiedAt: string;
}

export interface PortalRoleRow {
  id: string;
  name: string;
  permissions: Record<string, Record<string, PortalLevel>>;
  fieldPermissions: Record<string, Record<string, Record<string, PortalLevel>>>;
  createdAt: string;
  modifiedAt: string;
}

export interface PortalNavItemRow {
  id: string;
  portalId: string;
  label: string;
  entity: string | null;
  route: string | null;
  icon: string | null;
  position: number;
  isActive: boolean;
}

export interface PortalDashboardRow {
  id: string;
  portalId: string;
  portalRoleId: string | null;
  name: string;
  layout: unknown[];
  config: Record<string, unknown>;
  isDefault: boolean;
  dashlets: { id: string; name: string; kind: string; position: number; config: Record<string, unknown> }[];
  createdAt: string;
  modifiedAt: string;
}

export interface PortalContext {
  portal: { id: string; name: string; urlPath: string };
  user: {
    id: string;
    userName: string;
    firstName: string | null;
    lastName: string | null;
    emailAddress: string | null;
    isActive: boolean;
  };
  contact: { id: string; name: string | null } | null;
  roles: { id: string; name: string }[];
  nav: { id: string; label: string; entity: string | null; route: string | null; icon: string | null; position: number }[];
  dashboard: {
    id: string;
    name: string;
    dashlets: { id: string; name: string; kind: string; position: number; config: Record<string, unknown> }[];
  } | null;
}

export interface PortalUserRow {
  id: string;
  userName: string;
  name: string;
  firstName: string | null;
  lastName: string | null;
  emailAddress: string | null;
  isAdmin: boolean;
  isActive: boolean;
  type: string;
  roles: string[];
  portalId: string | null;
  contactId: string | null;
  portalRoleIds: string[];
  createdAt: string;
  modifiedAt: string;
}

/** Phase 19 — Projects read models (PLAN_Phase_19_Projects.md §4.12, §7). */
export interface ProjectTaskRow {
  id: string;
  name: string | null;
  status: string | null;
  stageId: string | null;
  groupId: string | null;
  parentTaskId: string | null;
  taskType: string;
  assigneeUserId: string | null;
  ownerUserId: string | null;
  priority: string | null;
  dateStart: string | null;
  dateEnd: string | null;
  points: number | null;
  estimateHours: number | null;
  sortOrder: number;
  version: number;
}

export interface ProjectStageRow {
  id: string;
  key: string;
  name: string;
  statusValue: string;
  sortOrder: number;
}

export interface ProjectPlanGroup {
  group: Record<string, unknown>;
  tasks: ProjectTaskRow[];
}

export interface ProjectPlanView {
  project: Record<string, unknown>;
  stages: Record<string, unknown>[];
  groups: ProjectPlanGroup[];
  truncated: boolean;
}

export interface ProjectBoardView {
  project: Record<string, unknown>;
  group: Record<string, unknown> | null;
  columns: { stage: Record<string, unknown>; tasks: ProjectTaskRow[] }[];
  truncated: boolean;
}

export interface ProjectGanttView {
  project: Record<string, unknown>;
  groups: Record<string, unknown>[];
  tasks: ProjectTaskRow[];
  dependencies: { id: string; taskId: string; predecessorTaskId: string; dependencyType: string | null }[];
  truncated: boolean;
}

export interface ProjectCapabilities {
  projectId: string;
  boardId: string | null;
  isMember: boolean;
  role: string | null;
  roleName: string | null;
  capabilities: Record<string, boolean>;
  features: Record<string, boolean>;
}

export interface ProjectMemberRow {
  id: string;
  projectId: string;
  userId: string;
  userName: string | null;
  projectRoleId: string | null;
  roleName: string | null;
}

export interface CloneResult {
  projectId: string;
  name: string;
  counts: Record<string, number>;
}

/** Phase 19-S.17 — Sales domain command types (PLAN_Phase_19_Sales.md §7). */

export interface SalesSettingsView {
  settings: Record<string, unknown>;
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
  defaults: Record<string, unknown>;
  warnings: readonly { code: string; message: string }[];
}

/** One command the document's current state allows, as the server's descriptor describes it. */
export interface SalesDocumentAction {
  action: string;
  label: string;
  requiresReason: boolean;
  issues: boolean;
  to: string;
}

/** One conversion the document's current state allows. */
export interface SalesDocumentConversion {
  action: string;
  label: string;
  toKind: string;
}

export interface SalesDocumentView {
  kind: string;
  id: string;
  descriptor: {
    label: string;
    entity: string;
    seriesCode: string;
    states: readonly string[];
  };
  document: Record<string, unknown>;
  items: readonly Record<string, unknown>[];
  totals: Record<string, unknown>;
  lock: Record<string, unknown> & { locked: boolean };
  fromSnapshot: boolean;
  availableTransitions: readonly string[];
  availableConversions: readonly string[];
  actions: readonly SalesDocumentAction[];
  conversions: readonly SalesDocumentConversion[];
}

export interface SalesRenderResult {
  kind: string;
  documentId: string;
  number: string | null;
  status: string;
  fromSnapshot: boolean;
  templateCode: string | null;
  format: string;
  subject: string;
  body: string;
  text: string;
  blocks: readonly Record<string, unknown>[];
  warnings: readonly string[];
  pdf: { available: boolean; reason: string | null };
}

export interface SalesSendResult {
  quote: SalesDocumentView;
  email: Record<string, unknown>;
  rendered: SalesRenderResult;
  transport: { name: string };
  job: { id: string; name: string; status: string };
  issued: boolean;
  pdfAttachment: { id: string; filename: string; mimeType: string; size: number; checksum: string | null } | null;
}

/** What a send command takes: who to mail, which template, a cover note, and the optional PDF. */
export interface SalesSendInput {
  readonly to?: readonly string[];
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly templateCode?: string;
  readonly subject?: string;
  readonly message?: string;
  readonly emailAccountId?: string;
  readonly attachPdf?: boolean;
  readonly correlationId?: string;
}

/** The same result for a document sent through `…/Sales/document/:kind/:id/send`. */
export interface SalesSendDocumentResult extends Omit<SalesSendResult, 'quote'> {
  kind: string;
  document: SalesDocumentView;
}

export interface SalesNumberingSeries {
  id: string;
  code: string;
  label: string;
  prefix: string;
  padding: number;
  nextNumber: number;
  allocation: string;
  active: boolean;
}

export interface SalesPriceResolutionResult {
  price: string;
  currency: string;
  source: string;
  entryId: string | null;
  ruleId: string | null;
  explanation: string;
  quantityBreak: { minQuantity: string; unitPrice: string } | null;
}

/**
 * `POST /Sales/action/previewTotals` answers with the server's `TotalsResult` **flat**: the totals,
 * the per-line amounts and the tax breakdown all sit beside `currency`. There is no nested `totals`
 * object, and the per-line amounts are what the editor shows as a line's net/tax/gross.
 */
export interface SalesPreviewTotalsResult {
  currency: string;
  lines: readonly Record<string, unknown>[];
  subtotal: string;
  discountTotal: string;
  shippingAmount: string;
  shippingTaxAmount: string;
  taxTotal: string;
  netTotal: string;
  grossTotal: string;
  amountDue: string;
  baseCurrency: string | null;
  baseGrossTotal: string | null;
  taxInclusive: boolean;
  taxBreakdown: readonly Record<string, unknown>[];
  warnings: readonly string[];
}

export interface SalesHealthView {
  module: {
    id: string;
    name: string;
    version: string;
    minPlatformVersion: string;
    loadOrder: number;
    apiPrefix: string;
    implementedPhases: readonly string[];
  };
  ok: boolean;
  dependencies: readonly Record<string, unknown>[];
  optionalIntegrations: readonly Record<string, unknown>[];
  features: readonly Record<string, unknown>[];
  settings: { version: number; updatedAt: string | null; warnings: readonly string[] };
  checks: readonly Record<string, unknown>[];
}

/**
 * Phase 19-SD.4/SD.5 — Service Desk command views (`/api/v1/ServiceDesk`, PLAN §5.2, §5.3).
 *
 * The server answers with the transitions the *current actor* may run and the facts the controls need
 * (resolution requirement, assignment hint). The SPA renders what it is told and never assumes a
 * command is allowed: the same rules are re-checked server-side on every command.
 */
export interface ServiceDeskCapabilities {
  caseId: string;
  status: string;
  allowedCommands: readonly string[];
  resolution: { requireCode: boolean; requireSummary: boolean; codes: readonly string[] };
  assignment: { caseId: string; canAssign: boolean };
  /** SD.6 — what the actor may do on the case conversation. */
  conversation: {
    caseId: string;
    canReply: boolean;
    canPostInternalNote: boolean;
    canViewInternal: boolean;
  };
}

/**
 * Phase 19-MA.3 — Marketing Automation campaign contracts
 * (PLAN_Phase_19_Marketing_Automation.md §8.2, §8.4). The report shape is the server's, not a client-side
 * guess: the SPA renders the findings it is given and never re-derives whether a campaign may run.
 */
export interface MarketingFinding {
  code: string;
  level: 'blocker' | 'warning';
  message: string;
  field?: string;
}

export interface MarketingValidationReport {
  campaignId: string;
  status: string;
  valid: boolean;
  blockers: MarketingFinding[];
  warnings: MarketingFinding[];
  checkedAt: string;
  validationHash: string;
}

export interface MarketingCampaignCapabilities {
  campaignId: string;
  status: string;
  mayEdit: boolean;
  allowedCommands: readonly string[];
  lastValidatedAt: string | null;
  validationHash: string | null;
  report: MarketingValidationReport;
}

export interface MarketingCampaignTransitionResult {
  campaignId: string;
  from: string;
  to: string;
  command: string;
  changed: boolean;
  idempotent: boolean;
  transitionId: string | null;
}

export interface MarketingCampaignTransitionRow {
  id: string;
  campaignId: string;
  fromStatus: string;
  toStatus: string;
  command: string;
  reason: string | null;
  actorUserId: string | null;
  actorType: string;
  validationHash: string | null;
  idempotencyKey: string | null;
  occurredAt: string | null;
}

export interface MarketingNavigationVisibility {
  visible: boolean;
  readableEntities: number;
  entities: readonly string[];
}

/**
 * Phase 19-MA.4/MA.5 — audience and consent contracts the SPA renders
 * (PLAN_Phase_19_Marketing_Automation.md §8.1–§8.4). The categories and counts are the server's; the page
 * never recomputes eligibility, so a client cannot make a blocked recipient look sendable.
 */
export interface MarketingAudienceCategory {
  category: string;
  count: number;
}

export interface MarketingAudiencePreview {
  campaignId: string | null;
  targetListId: string | null;
  purpose: string | null;
  status: string | null;
  resolved: number;
  eligible: number;
  categories: MarketingAudienceCategory[];
  samples: { entityId: string; entityType: string; name: string | null; category: string }[];
  notes: string[];
  truncated: boolean;
  limit: number;
  generatedAt: string;
}

export interface MarketingPreferenceView {
  categories: { purpose: string; status: string }[];
  globallySuppressed: boolean;
  expiresAt: string | null;
}

export interface MarketingUnsubscribeResult {
  unsubscribed: true;
  scope: 'global' | 'purpose';
  purpose: string | null;
  applied: boolean;
}


/** SD.6 — the result of posting a public reply or an internal note. */
export interface ServiceDeskMessageResult {
  caseId: string;
  messageId: string;
  visibility: string;
  created: boolean;
}

export interface ServiceDeskTransitionResult {
  caseId: string;
  from: string;
  to: string;
  command: string;
  changed: boolean;
  idempotent: boolean;
  transitionId: string | null;
}

export interface ServiceDeskTransitionRow {
  id: string;
  caseId: string;
  fromStatus: string;
  toStatus: string;
  command: string;
  reason: string | null;
  resolutionCode: string | null;
  actorUserId: string | null;
  actorType: string;
  occurredAt: string | null;
}

export interface ServiceDeskAssignmentResult {
  caseId: string;
  assignedUserId: string | null;
  teamId: string | null;
  queueId: string | null;
  strategy: string;
  changed: boolean;
  idempotent: boolean;
  warnings: readonly string[];
  assignmentId: string | null;
}

export interface ServiceDeskAssignmentRow {
  id: string;
  caseId: string;
  previousAssignedUserId: string | null;
  assignedUserId: string | null;
  previousTeamId: string | null;
  teamId: string | null;
  queueId: string | null;
  strategy: string;
  routingRuleId: string | null;
  reason: string | null;
  actorUserId: string | null;
  actorType: string;
  occurredAt: string | null;
}

export interface ServiceDeskQueueWorkload {
  queue: {
    id: string;
    name: string | null;
    code: string | null;
    strategy: string;
    fallbackBehavior: string;
    defaultTeamId: string | null;
    defaultAssignedUserId: string | null;
    isActive: boolean;
  };
  source: 'members' | 'team' | 'none';
  members: readonly { userId: string; activeCases: number }[];
  unassigned: number;
}

/** SD.15 — ACL-scoped service metrics (`GET /ServiceDesk/action/metrics`). */
export interface ServiceDeskMetricBucket {
  key: string;
  count: number;
}

export interface ServiceDeskMetrics {
  range: { from: string; to: string };
  total: number;
  active: number;
  unassigned: number;
  escalated: number;
  breached: number;
  resolved: number;
  reopened: number;
  reopenRate: number | null;
  byStatus: readonly ServiceDeskMetricBucket[];
  byPriority: readonly ServiceDeskMetricBucket[];
  bySource: readonly ServiceDeskMetricBucket[];
  csat:
    | { restricted: true }
    | { restricted: false; count: number; average: number | null; responseRate: number | null };
  definitions: Readonly<Record<string, string>>;
}

/**
 * Phase 20 — settings documents, the administration panel and the resolved navigation tree
 * (PLAN_Phase_20_Settings_UX.md §8.1). `warnings` are configuration problems the server reports but
 * does not enforce, so a tab shows them next to the values that caused them.
 */
export interface SettingsDocumentWarning {
  readonly code: string;
  readonly message: string;
}

export interface SettingsDocument<T = Record<string, unknown>> {
  readonly name: string;
  readonly group: string;
  readonly labelKey: string;
  readonly descriptionKey?: string | undefined;
  readonly readLevel: string;
  readonly writeLevel: string;
  readonly value: T;
  readonly version: number;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly warnings: readonly SettingsDocumentWarning[];
}

/** One menu override in the `navigation` document; keys are namespaced (`home`, `entity:Contact`). */
export interface NavigationMenuEntry {
  readonly key: string;
  readonly enabled: boolean;
  readonly order: number;
  readonly labelKey?: string | undefined;
  readonly icon?: string | undefined;
  readonly accent?: string | undefined;
  readonly inQuickSearch?: boolean | undefined;
}

export interface NavigationDocument {
  readonly items: readonly NavigationMenuEntry[];
  readonly groups: readonly NavigationMenuEntry[];
  readonly accentPalette: readonly string[];
}

/** A resolved menu entry: already ACL-filtered and ordered by the server. */
export interface NavigationNode {
  readonly key: string;
  readonly kind: 'page' | 'entity' | 'group' | 'extension' | 'admin';
  readonly route: string;
  readonly label: string;
  readonly icon?: string | undefined;
  readonly accent?: string | undefined;
  readonly order: number;
  readonly inQuickSearch: boolean;
  readonly children?: readonly NavigationNode[];
}

export interface NavigationTree {
  readonly version: number;
  readonly items: readonly NavigationNode[];
  readonly warnings: readonly SettingsDocumentWarning[];
}

export interface AdminPanelTab {
  readonly key: string;
  readonly labelKey: string;
  readonly descriptionKey?: string | undefined;
  readonly icon: string;
  readonly order: number;
  readonly level: string;
  readonly kind: 'tab' | 'page';
  readonly route: string;
  readonly document?: string | undefined;
  readonly moduleEndpoint?: string | undefined;
  readonly usesSaveBar?: boolean | undefined;
}

export interface AdminPanelGroup {
  readonly key: string;
  readonly labelKey: string;
  readonly order: number;
  readonly tabs: readonly AdminPanelTab[];
}

export interface AdminPanelView {
  readonly groups: readonly AdminPanelGroup[];
  readonly defaultTab: string | null;
}

/** The shape every module settings document answers with (`settings`, `version`, `warnings`). */
export interface ModuleSettingsView<T = Record<string, unknown>> {
  readonly settings: T;
  readonly version: number;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly warnings: readonly SettingsDocumentWarning[];
}

/** Phase 19-AI: the foundation diagnostics returned by `GET /AIAgents/action/health`. */
export interface AIAgentsHealthDependency {
  readonly id: string;
  readonly label: string;
  readonly present: boolean;
  readonly missing: readonly string[];
}

export interface AIAgentsHealthView {
  readonly module: {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly frontendRoute: string;
    readonly implementedPhases: readonly string[];
  };
  readonly ok: boolean;
  readonly execution: { readonly enabled: boolean; readonly paused: boolean; readonly reason: string | null };
  readonly dependencies: readonly AIAgentsHealthDependency[];
  readonly optionalIntegrations: readonly {
    readonly id: string;
    readonly label: string;
    readonly provides: string;
    readonly present: boolean;
  }[];
  readonly features: readonly { readonly key: string; readonly label: string; readonly enabled: boolean }[];
  readonly structures: readonly { readonly name: string; readonly present: boolean }[];
  readonly providers: {
    readonly count: number;
    readonly enabledCount: number;
    readonly credentialCount: number;
    readonly adapterKeys: readonly string[];
    readonly adapters: readonly { readonly key: string; readonly label: string; readonly toolCalling: boolean }[];
    readonly defaultKey: string | null;
    readonly encryptionConfigured: boolean;
  };
  readonly settings: {
    readonly version: number;
    readonly updatedAt: string | null;
    readonly warnings: readonly string[];
  };
  readonly checks: readonly { readonly name: string; readonly ok: boolean; readonly detail: string }[];
}

export interface AIAgentsCapabilitiesView {
  readonly capabilities: readonly {
    readonly key: string;
    readonly label: string;
    readonly description: string;
    readonly granted: boolean;
  }[];
  readonly execution: { readonly enabled: boolean; readonly paused: boolean; readonly available: boolean };
  readonly memory: { readonly enabled: boolean };
  readonly evaluations: { readonly enabled: boolean };
}

/** Phase 19-AI.4: a provider connection as the admin API returns it. Never contains a credential. */
export interface AIAgentsProviderConnection {
  readonly id: string;
  readonly key: string;
  readonly kind: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly models: readonly string[];
  readonly dataClasses: readonly string[];
  readonly hasApiKey: boolean;
  readonly config: { readonly allowLoopback: boolean; readonly organization?: string };
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly modifiedAt: string;
}

/** Phase 19-AI.5–19-AI.10: definition, run and approval surfaces. */
export interface AIAgentToolView {
  readonly key: string;
  readonly label: string;
  readonly effectClass: string;
  readonly requiresApproval: boolean;
  readonly enabled: boolean;
}

export interface AIAgentVersionView {
  readonly id: string;
  readonly version: number;
  readonly checksum: string;
  readonly providerKey: string | null;
  readonly model: string | null;
  readonly publishedById: string | null;
  readonly publishedAt: string;
  readonly note: string | null;
  readonly tools: readonly AIAgentToolView[];
}

export interface AIAgentConfigShape {
  readonly provider?: { key: string; model: string; fallbackModels: readonly string[] };
  readonly dataClass: string;
  readonly prompt: { system: string; inputHint?: string };
  readonly input: { mode: 'text' | 'record'; entity?: string };
  readonly tools: readonly { key: string; constraints?: Record<string, unknown> }[];
  readonly limits: {
    maxSteps: number;
    maxModelCalls: number;
    maxToolCalls: number;
    maxTokens: number;
    maxCostUsd: number;
    maxElapsedSeconds: number;
    maxRetries: number;
    maxOutputTokens: number;
    temperature: number;
  };
  readonly output: { mode: 'text' | 'json'; schema?: Record<string, unknown> };
  readonly memory: { mode: 'none' | 'conversation' | 'checkpoint'; maxMessages?: number; retentionDays?: number };
  readonly triggers: { manual: boolean; record: boolean; event: boolean; schedule: boolean; integration: boolean };
  readonly approval: { requireFor: readonly string[] };
}

export interface AIAgentConfigIssue {
  readonly path: string;
  readonly message: string;
}

export interface AIAgentView {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly purpose: string | null;
  readonly category: string | null;
  readonly icon: string | null;
  readonly visibility: string;
  readonly teamId: string | null;
  readonly ownerUserId: string | null;
  readonly status: 'draft' | 'published' | 'paused' | 'archived';
  readonly dataSensitivity: string;
  readonly currentVersion: number | null;
  readonly hasUnpublishedChanges: boolean;
  readonly draftConfig: AIAgentConfigShape;
  readonly configIssues: readonly AIAgentConfigIssue[];
  readonly inputHint: string | null;
  readonly tools: readonly AIAgentToolView[];
  readonly capabilities: {
    readonly editDraft: boolean;
    readonly publish: boolean;
    readonly lifecycle: boolean;
    readonly run: boolean;
  };
  readonly latestVersion: AIAgentVersionView | null;
  readonly createdAt: string;
  readonly modifiedAt: string;
}

export interface AIAgentListResult {
  readonly list: readonly AIAgentView[];
  readonly total: number;
  readonly offset: number;
  readonly count: number;
}

export interface AIAgentValidationReport {
  readonly ok: boolean;
  readonly issues: readonly { readonly code: string; readonly path: string; readonly message: string; readonly blocking: boolean }[];
  readonly checks: readonly { readonly id: string; readonly ok: boolean; readonly detail: string }[];
}

export interface AIAgentToolCatalogue {
  readonly tools: readonly { readonly key: string; readonly label: string; readonly effectClass: string; readonly enabled: boolean }[];
}

export interface AIAgentTemplate {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly icon: string;
  readonly config: AIAgentConfigShape;
}

export type AIAgentRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_approval'
  | 'waiting_for_input'
  | 'retry_wait'
  | 'cancel_requested'
  | 'succeeded'
  | 'partially_succeeded'
  | 'failed'
  | 'canceled'
  | 'expired'
  | 'blocked_by_policy'
  | 'outcome_unknown';

export interface AIAgentRunView {
  readonly id: string;
  readonly agentId: string;
  readonly agentKey: string;
  readonly agentName: string;
  readonly agentVersion: number;
  readonly agentVersionId: string;
  readonly status: AIAgentRunStatus;
  readonly trigger: string;
  readonly initiatedByUserId: string | null;
  readonly input: { readonly text: string | null; readonly recordEntity: string | null; readonly recordId: string | null };
  readonly result: unknown;
  readonly failureCategory: string | null;
  readonly failureMessage: string | null;
  readonly cancelRequested: boolean;
  readonly conversationId: string | null;
  readonly counters: {
    readonly steps: number;
    readonly modelCalls: number;
    readonly toolCalls: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly estimatedCostUsd: number;
  };
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly modifiedAt: string;
}

export interface AIAgentRunListResult {
  readonly list: readonly AIAgentRunView[];
  readonly total: number;
  readonly offset: number;
  readonly count: number;
}

export interface AIAgentRunEventView {
  readonly id: string;
  readonly seq: number;
  readonly category: string;
  readonly type: string;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly summary: string;
  readonly payload: unknown;
  readonly visibility: string;
  readonly createdAt: string;
}

export interface AIAgentRunToolCallView {
  readonly id: string;
  readonly step: number;
  readonly toolKey: string;
  readonly policyResult: string;
  readonly status: string;
  readonly summary: string | null;
  readonly errorCategory: string | null;
  readonly durationMs: number | null;
  readonly resultRef: string | null;
  readonly createdAt: string;
}

export interface AIAgentApprovalView {
  readonly id: string;
  readonly runId: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly agentVersion: number;
  readonly toolKey: string | null;
  readonly actionClass: string;
  readonly riskLevel: string;
  readonly summary: string;
  readonly proposal: unknown;
  readonly targets: unknown;
  readonly status: string;
  readonly requestedByUserId: string | null;
  readonly decidedByUserId: string | null;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
  readonly revalidation: unknown;
  readonly executionResult: unknown;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly selfApproval: boolean;
}

export interface AIAgentApprovalListResult {
  readonly list: readonly AIAgentApprovalView[];
  readonly total: number;
  readonly offset: number;
  readonly count: number;
  readonly expired: number;
}

export interface AIAgentConversationView {
  readonly id: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly title: string | null;
  readonly status: string;
  readonly messageCount: number;
  readonly summary: string | null;
  readonly lastActivityAt: string;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

export interface AIAgentConversationMessageView {
  readonly id: string;
  readonly seq: number;
  readonly role: string;
  readonly content: string;
  readonly redaction: string;
  readonly runId: string | null;
  readonly createdAt: string;
}

export interface AIAgentMemoryView {
  readonly id: string;
  readonly scope: string;
  readonly kind: string;
  readonly content: string;
  readonly sensitivity: string;
  readonly sourceRefs: readonly unknown[];
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

/** Phase 19-AI.13 — an admin-maintained price card; costs are estimates, never billed values. */
export interface AIAgentPricingSnapshot {
  readonly id: string;
  readonly providerKey: string;
  readonly model: string;
  readonly currency: string;
  readonly inputPricePerMillion: number;
  readonly outputPricePerMillion: number;
  readonly cachedInputPricePerMillion: number;
  readonly validFrom: string;
  readonly createdAt: string;
}

/** Phase 19-AI.13 — a scoped budget policy with its current consumption. */
export interface AIAgentBudgetPolicy {
  readonly id: string;
  readonly scope: 'global' | 'user' | 'team' | 'agent' | 'provider';
  readonly scopeRef: string | null;
  readonly providerKey: string | null;
  readonly agentId: string | null;
  readonly period: 'day' | 'month';
  readonly maxRequests: number | null;
  readonly maxTokens: string | null;
  readonly maxCostUsd: string | null;
  readonly maxRuns: number | null;
  readonly maxConcurrentRuns: number | null;
  readonly warnPercent: number | null;
  readonly enabled: boolean;
}

export interface AIAgentBudgetPolicyStatus extends AIAgentBudgetPolicy {
  readonly usage: {
    readonly runs: number;
    readonly requests: number;
    readonly tokens: number;
    readonly costUsd: number;
    readonly concurrentRuns: number;
  };
  readonly warning: boolean;
  readonly exhausted: boolean;
}

export interface AIAgentRetentionReport {
  readonly conversations: number;
  readonly memoryItems: number;
  readonly providerRequests: number;
  readonly runEvents: number;
}

export interface AIAgentUsageView {
  readonly totals: {
    readonly runs: number;
    readonly modelCalls: number;
    readonly toolCalls: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly estimatedCostUsd: number;
    /** `estimate` when priced from an admin snapshot; `none` when no price data exists (19-AI.13). */
    readonly costLabel: 'estimate' | 'none';
  };
  readonly byAgent: readonly {
    readonly agentId: string;
    readonly agentName: string;
    readonly runs: number;
    readonly modelCalls: number;
    readonly toolCalls: number;
    readonly tokens: number;
  }[];
  readonly byProvider: readonly {
    readonly providerKey: string;
    readonly model: string;
    readonly requests: number;
    readonly failures: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly averageLatencyMs: number;
  }[];
}

/**
 * Phase 19-VC.2–19-VC.5 — Voice & Communications contracts the SPA renders.
 *
 * The server's shapes are the source of truth: these types add presentation only and never a second
 * authorization path. Credentials and webhook secrets are absent by construction — the API reports
 * `hasCredential`/`hasWebhookSecret` and a masked hint, never a value.
 */
export interface VoiceDependencyView {
  readonly id: string;
  readonly label: string;
  readonly present: boolean;
  readonly missing: readonly string[];
}

export interface VoiceCommunicationsHealthView {
  readonly module: {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly minPlatformVersion: string;
    readonly loadOrder: number;
    readonly apiPrefix: string;
    readonly webhookPrefix: string;
    readonly implementedPhases: readonly string[];
  };
  readonly ok: boolean;
  readonly dependencies: readonly VoiceDependencyView[];
  readonly optionalIntegrations: readonly {
    readonly id: string;
    readonly label: string;
    readonly provides: string;
    readonly present: boolean;
    readonly status: 'available' | 'unavailable';
  }[];
  readonly features: readonly {
    readonly key: string;
    readonly label: string;
    readonly enabled: boolean;
    readonly settingsPath: string;
    readonly requires: readonly string[];
  }[];
  readonly providers: {
    readonly configuredDefaultAccount: string;
    readonly available: readonly {
      readonly key: string;
      readonly label: string;
      readonly mode: string;
      readonly channels: readonly string[];
      readonly capabilities: number;
      readonly webhookSignature: string;
    }[];
    readonly accounts: number;
    readonly enabledAccounts: number;
  };
  readonly settings: {
    readonly version: number;
    readonly updatedAt: string | null;
    readonly warnings: readonly string[];
  };
  readonly checks: readonly { readonly name: string; readonly ok: boolean; readonly detail: string }[];
}

export interface VoiceCommunicationsSettingsView {
  readonly settings: Record<string, unknown>;
  readonly version: number;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
}

export interface VoiceProviderAccountView {
  readonly id: string;
  readonly key: string;
  readonly providerKey: string;
  readonly label: string;
  readonly environment: string;
  readonly enabled: boolean;
  readonly capabilities: readonly string[];
  readonly effectiveCapabilities: readonly string[];
  readonly hasCredential: boolean;
  readonly credentialHint: string | null;
  readonly hasWebhookSecret: boolean;
  readonly webhookSecretHint: string | null;
  readonly lastHealth: {
    readonly status: string | null;
    readonly detail: string | null;
    readonly at: string | null;
  };
  readonly createdAt: string;
  readonly modifiedAt: string;
}

export interface VoiceWebhookEventView {
  readonly id: string;
  readonly accountKey: string;
  readonly providerKey: string;
  readonly vendorEventId: string | null;
  readonly eventType: string;
  readonly signatureValid: boolean;
  readonly processingStatus: string;
  readonly attempts: number;
  readonly failureCode: string | null;
  readonly failureDetail: string | null;
  readonly receivedAt: string;
  readonly processedAt: string | null;
}

export interface VoiceWebhookEventList {
  readonly list: readonly VoiceWebhookEventView[];
  readonly total: number;
}
