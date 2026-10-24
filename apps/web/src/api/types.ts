/** Field + entity definitions as served by `GET /api/v1/Metadata` (PLAN §12, §79). */
import type { DocPage, DocSearchHit, DocSection } from '@carocrm/docs';
import type { EntityRelationTabs } from '@carocrm/metadata/relation-tabs.js';

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

export type LayoutViewType = 'list' | 'detail' | 'edit' | 'filter' | 'search' | 'massUpdate' | 'panel' | 'popup';

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
  /**
   * The relation area of the record page (PLAN_Phase_20 §5.11): either today's stacked panels or the
   * tabs the entity's detail layout arranges. Absent means the stacked page.
   */
  detailTabs?: EntityRelationTabs | undefined;
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

/** The draft parts the designer previews, plus the one sample record it personalises with. */
export interface EmailTemplatePreviewInput {
  subject?: string | null;
  body?: string | null;
  bodyHtml?: string | null;
  sampleEntityType?: string;
  sampleEntityId?: string;
}

export interface EmailTemplatePreviewView {
  subject: string | null;
  body: string | null;
  bodyHtml: string | null;
  /** Every `{{token}}` the draft names, in order of first appearance. */
  placeholders: string[];
  /** Tokens the sample record has no readable value for: they go out empty. */
  unresolved: string[];
  sample: { type: string; id: string; label: string } | null;
}

/** A document preview: either a stored template code, or the draft body being designed. */
export interface DocumentPreviewInput {
  templateCode?: string;
  body?: string;
  subject?: string | null;
  format?: 'html' | 'text';
  data: Record<string, unknown>;
}

export interface DocumentPreviewView {
  format: string;
  subject: string;
  body: string;
  /** Placeholders the data could not answer; they stay in place and are reported. */
  warnings: string[];
  templateCode?: string | null;
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

/** One item in the first-run setup checklist (PLAN §20.15). */
export interface SetupChecklistItem {
  id: string;
  labelKey: string;
  descriptionKey: string;
  route: string;
  completed: boolean;
  order: number;
}

export interface SetupChecklistView {
  items: SetupChecklistItem[];
  progress: { done: number; total: number };
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

/** Batch-resolved link display labels: response key → target record id → label. */
export type LinkLabels = Record<string, Record<string, string>>;

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

/** What a participant may start on a record type — identity only, never the definition itself. */
export interface AvailableProcessView {
  id: string;
  key: string;
  name: string;
  description: string | null;
  entityType: string;
}

export interface AvailableProcessListResult {
  list: AvailableProcessView[];
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
  _linkLabels?: LinkLabels;
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
  _linkLabels?: LinkLabels;
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
  _linkLabels?: LinkLabels;
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
  members: readonly { userId: string; activeCases: number; _linkLabels?: LinkLabels }[];
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
  /** The handbook page that documents this screen (§21.7); the shell renders a book link for it. */
  readonly docKey?: string | undefined;
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
    /**
     * The curated catalog of popular endpoints. A preset is configuration, not access: it carries
     * a base URL, a model suggestion and the credential header.
     */
    readonly presets: readonly {
      readonly key: string;
      readonly label: string;
      readonly kind: string;
      readonly baseUrl: string;
      readonly models: readonly string[];
      readonly group: 'hosted' | 'self-hosted' | 'other';
      readonly authHeader: 'bearer' | 'api-key';
      readonly requiresApiKey: boolean;
      readonly note: string | null;
    }[];
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
  readonly config: {
    readonly allowLoopback: boolean;
    readonly organization?: string;
    readonly authHeader: 'bearer' | 'api-key';
  };
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly modifiedAt: string;
}

/**
 * Phase 19-AI.4 — the result of an administrator-triggered connectivity check. It reports status,
 * latency and usage only: never the model's text, the request body or the credential.
 */
export interface AIAgentProviderCheckResult {
  readonly ok: boolean;
  readonly connectionKey: string;
  readonly model: string;
  readonly latencyMs: number;
  readonly category: string | null;
  readonly message: string;
  readonly providerRequestId: string | null;
  readonly usage: { readonly inputTokens: number | null; readonly outputTokens: number | null; readonly cachedInputTokens: number | null } | null;
}

/**
 * Phase 19-AI.2 — the `aiAgents` module settings row. Every group is a validated, closed shape:
 * the server refuses an unknown key rather than ignoring it, so the SPA sends what the schema
 * defines and nothing else.
 */
export interface AIAgentsSettings {
  readonly features: {
    readonly definitions: boolean;
    readonly execution: boolean;
    readonly memory: boolean;
    readonly evaluations: boolean;
    readonly eventTriggers: boolean;
    readonly scheduledTriggers: boolean;
    readonly portalAssistant: boolean;
  };
  readonly provider: { readonly defaultKey: string };
  readonly limits: {
    readonly maxSteps: number;
    readonly maxModelCalls: number;
    readonly maxToolCalls: number;
    readonly maxTokens: number;
    readonly maxCostUsd: number;
    readonly maxElapsedSeconds: number;
    readonly maxRetries: number;
    readonly maxConcurrency: number;
    readonly maxResultBytes: number;
  };
  readonly approval: {
    readonly requireFor: readonly string[];
    readonly ttlMinutes: number;
  };
  readonly retention: {
    readonly runEventsDays: number;
    readonly providerRequestsDays: number;
    readonly conversationsDays: number;
    readonly evaluationsDays: number;
  };
  readonly safety: {
    readonly globalExecutionPaused: boolean;
    readonly reason: string | null;
  };
  readonly tools: { readonly disabled: readonly string[] };
  readonly dataPolicy: {
    readonly allowedExternalDataClasses: readonly string[];
    readonly logPrompts: boolean;
  };
}

/** Phase 19-AI.2 — the settings row as the module returns it, with the warnings it reports. */
export interface AIAgentsSettingsView {
  readonly settings: AIAgentsSettings;
  readonly version: number;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly defaults: AIAgentsSettings;
  readonly warnings: readonly SettingsDocumentWarning[];
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

/** The validated `voiceCommunications` document (19-VC.2 §13). */
export interface VoiceCommunicationsSettings {
  readonly features: {
    readonly voice: boolean;
    readonly sms: boolean;
    readonly mms: boolean;
    readonly whatsapp: boolean;
    readonly recordings: boolean;
    readonly transcripts: boolean;
    readonly aiEnrichment: boolean;
  };
  readonly provider: {
    readonly defaultAccountKey: string;
  };
  readonly policy: {
    readonly defaultRegion: string;
    readonly requireConsent: {
      readonly sms: boolean;
      readonly mms: boolean;
      readonly whatsapp: boolean;
    };
    readonly quietHours: {
      readonly enabled: boolean;
      readonly start: string;
      readonly end: string;
      readonly timezone: string;
    };
    readonly whatsappWindowHours: number;
    readonly maxMessageLength: number;
    readonly maxSendsPerMinute: number;
  };
  readonly webhook: {
    readonly replayWindowSeconds: number;
  };
  readonly media: {
    readonly fetchMode: 'off' | 'privateStorage';
    readonly allowedHosts: readonly string[];
    readonly allowLoopback: boolean;
    readonly maxBytes: number;
    readonly retentionDays: number;
    readonly noticeRequired: boolean;
  };
  readonly ai: {
    readonly connectionKey: string;
    readonly model: string;
    readonly maxTranscriptChars: number;
  };
}

export interface VoiceCommunicationsSettingsView {
  readonly settings: VoiceCommunicationsSettings;
  readonly version: number;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly defaults: VoiceCommunicationsSettings;
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
}

/** One adapter the registry can resolve, as the admin screen needs it (§6.3). */
export interface VoiceProviderInfo {
  readonly key: string;
  readonly label: string;
  readonly mode: string;
  readonly capabilities: readonly string[];
  readonly channels: readonly string[];
  readonly ratePerMinute: number;
  readonly maxConcurrency: number;
  readonly webhookSignature: string;
}

export interface VoiceProviderCatalogView {
  readonly providers: readonly VoiceProviderInfo[];
  readonly defaultAccountKey: string;
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
  readonly config: Record<string, unknown>;
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

export interface VoiceProviderAccountInput {
  readonly key: string;
  readonly providerKey: string;
  readonly label: string;
  readonly environment: 'test' | 'production';
  readonly capabilities: readonly string[];
  readonly config: Record<string, unknown>;
  readonly credential?: string;
  readonly webhookSecret?: string;
}

export interface VoiceProviderAccountPatch {
  readonly label?: string;
  readonly environment?: 'test' | 'production';
  readonly capabilities?: readonly string[];
  readonly config?: Record<string, unknown>;
  readonly credential?: string | null;
  readonly webhookSecret?: string | null;
}

/** A sender number (or WhatsApp phone id) registered for one provider account. */
export interface VoiceEndpointView {
  readonly id: string;
  readonly accountKey: string;
  readonly key: string;
  readonly channel: string;
  readonly address: string;
  readonly displayAddress: string;
  readonly country: string | null;
  readonly active: boolean;
  readonly teamId: string | null;
  readonly createdAt: string;
  readonly modifiedAt: string;
}

export interface VoiceEndpointInput {
  readonly key: string;
  readonly channel: string;
  readonly address: string;
  readonly active: boolean;
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

/**
 * Phase 19-VC.12–19-VC.17 — the inbox, composer, media, transcript and panel contracts the SPA
 * renders. Presentation only: every list is the server's, and no type here adds an authorization
 * path. Internal notes are surfaced with a flag so the UI can badge them, never as customer text.
 */
export interface VoiceConversationView {
  readonly id: string;
  readonly accountKey: string;
  readonly channel: string;
  readonly status: string;
  readonly subject: string | null;
  readonly externalThreadId: string | null;
  readonly unreadCount: number;
  readonly assignedUserId: string | null;
  readonly assignedTeamId: string | null;
  readonly lastActivityAt: string | null;
  readonly lastInboundAt: string | null;
  readonly relatedEntityType: string | null;
  readonly relatedEntityId: string | null;
  readonly caseId: string | null;
  readonly archived: boolean;
}

export interface VoiceInboxList {
  readonly list: readonly VoiceConversationView[];
  readonly total: number;
}

export interface VoiceTimelineEntry {
  readonly kind: 'message' | 'event';
  readonly id: string;
  readonly at: string;
  readonly message?: {
    readonly direction: 'inbound' | 'outbound';
    readonly body: string | null;
    readonly state: string;
    readonly isInternalNote: boolean;
    readonly authorUserId: string | null;
    readonly channel: string;
  };
  readonly event?: {
    readonly kind: string;
    readonly actorUserId: string | null;
    readonly actorType: string;
    readonly fromValue: string | null;
    readonly toValue: string | null;
    readonly detail: string | null;
  };
}

export interface VoiceConversationHistoryEntry {
  readonly id: string;
  readonly kind: string;
  readonly actorUserId: string | null;
  readonly actorType: string;
  readonly fromValue: string | null;
  readonly toValue: string | null;
  readonly detail: string | null;
  readonly createdAt: string;
}

export interface VoiceSnippetView {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly channel: 'sms' | 'mms' | 'whatsapp' | 'any';
  readonly body: string;
  readonly placeholders: readonly string[];
  readonly active: boolean;
}

export interface VoiceSnippetRender {
  readonly body: string;
  readonly segments: {
    readonly encoding: 'GSM-7' | 'UCS-2';
    readonly segments: number;
    readonly characters: number;
    readonly charsPerSegment: number;
  };
}

export interface VoiceComposerValidation {
  readonly ok: boolean;
  readonly segments: VoiceSnippetRender['segments'];
  readonly warnings: readonly string[];
}

export interface VoiceMessageView {
  readonly id: string;
  readonly conversationId: string;
  readonly channel: string;
  readonly direction: 'inbound' | 'outbound';
  readonly body: string | null;
  readonly state: string;
  readonly providerMessageId: string | null;
  readonly isInternalNote: boolean;
  readonly templateKey: string | null;
  readonly failureCategory: string | null;
  readonly sentAt: string | null;
  readonly deliveredAt: string | null;
  readonly createdAt: string;
}

export interface VoiceCallSessionView {
  readonly id: string;
  readonly accountKey: string;
  readonly direction: 'inbound' | 'outbound';
  readonly state: string;
  readonly providerCallId: string | null;
  readonly fromNumber: string | null;
  readonly toNumber: string | null;
  readonly fromDisplay: string | null;
  readonly toDisplay: string | null;
  readonly startedAt: string | null;
  readonly answeredAt: string | null;
  readonly endedAt: string | null;
  readonly durationSeconds: number | null;
  readonly result: string | null;
  readonly failureCategory: string | null;
  readonly assignedUserId: string | null;
  readonly activityId: string | null;
  readonly createdAt: string;
}

/** The control an agent may ask for on a live call; the server only offers granted ones. */
export type VoiceCallControlAction = 'answer' | 'hangup';

export interface VoiceIncomingCallView extends VoiceCallSessionView {
  readonly controls: readonly VoiceCallControlAction[];
}

export interface VoiceCallerMatch {
  readonly entityType: string;
  readonly id: string;
  readonly name: string;
}

/** Caller context for the incoming-call popup: permitted matches only, ambiguity preserved. */
export interface VoiceCallContextView {
  readonly session: VoiceCallSessionView;
  readonly matches: readonly VoiceCallerMatch[];
  readonly hiddenMatches: number;
}

export interface VoiceMediaView {
  readonly id: string;
  readonly kind: string;
  readonly messageId: string | null;
  readonly callSessionId: string | null;
  readonly providerRef: string | null;
  readonly mimeType: string | null;
  readonly sizeBytes: number | null;
  readonly durationSeconds: number | null;
  readonly scanStatus: string;
  readonly retentionAt: string | null;
  readonly createdAt: string;
}

export interface VoiceTranscriptView {
  readonly id: string;
  readonly callSessionId: string;
  readonly state: 'pending' | 'ready' | 'failed';
  readonly language: string | null;
  readonly segments: readonly {
    readonly startMs: number;
    readonly endMs: number | null;
    readonly speaker: string | null;
    readonly text: string;
  }[];
  readonly text: string | null;
  readonly ai: {
    readonly summary: string | null;
    readonly topics: readonly string[];
    readonly actions: readonly string[];
    readonly suggestedReply: string | null;
    readonly reviewStatus: 'none' | 'pending' | 'approved' | 'dismissed';
    readonly connectionKey: string | null;
    readonly model: string | null;
    readonly generatedAt: string | null;
  };
  readonly error: string | null;
}

export interface VoiceRecordPanelView {
  readonly record: { readonly entityType: string; readonly id: string };
  readonly conversations: readonly VoiceConversationView[];
  readonly calls: readonly VoiceCallSessionView[];
  readonly total: { readonly conversations: number; readonly calls: number };
}

/* ---------------------------------------------------------------------------
 * Phase 19-INT.14 / 19-INT.15 — the Advanced Integrations admin surface.
 *
 * The types mirror the server's response shapes exactly. A credential is only ever
 * `hasCredential` + a non-secret `credentialHint`; no type here can carry a token.
 * ------------------------------------------------------------------------- */

export type IntegrationConnectionStatus =
  | 'draft'
  | 'pending_authorization'
  | 'connected'
  | 'degraded'
  | 'reauthorization_required'
  | 'paused'
  | 'revoked'
  | 'error';

export type IntegrationProviderStatus = 'available' | 'disabled' | 'deprecated' | 'unsupported';

export type IntegrationProviderTier = 'core' | 'optional' | 'experimental' | 'deprecated';

export type IntegrationAuthenticationType = 'oauth' | 'api_key' | 'service_account' | 'none';

export type IntegrationWarningSeverity = 'info' | 'warning' | 'error';

export interface IntegrationWarning {
  readonly code: string;
  readonly severity: IntegrationWarningSeverity;
  readonly message: string;
}

export interface IntegrationProviderObject {
  readonly objectType: string;
  readonly label: string;
  readonly read: boolean;
  readonly write: boolean;
  readonly webhook: boolean;
}

export interface IntegrationCatalogProvider {
  readonly providerKey: string;
  readonly displayName: string;
  readonly description: string;
  readonly category: string;
  readonly status: IntegrationProviderStatus;
  readonly tier: IntegrationProviderTier;
  readonly authentication: IntegrationAuthenticationType;
  readonly objects: readonly IntegrationProviderObject[];
  readonly requiredScopes: readonly string[];
  readonly optionalScopes: readonly string[];
  readonly docsUrl: string | null;
  readonly connectionCount: number;
  readonly healthyCount: number;
  readonly executable: boolean;
}

export interface IntegrationCatalogResult {
  readonly list: readonly IntegrationCatalogProvider[];
}

export interface IntegrationConnection {
  readonly id: string;
  readonly providerKey: string;
  readonly name: string;
  readonly ownerType: 'organization' | 'user';
  readonly ownerId: string;
  readonly tenantRef: string | null;
  readonly status: IntegrationConnectionStatus;
  readonly enabled: boolean;
  readonly grantedScopes: readonly string[];
  readonly requiredScopes: readonly string[];
  readonly missingScopes: readonly string[];
  readonly connectionOptions: Readonly<Record<string, unknown>>;
  readonly adapterVersion: string;
  readonly healthStatus: string | null;
  readonly healthSummaryCode: string | null;
  readonly lastValidatedAt: string | null;
  readonly lastSuccessfulSyncAt: string | null;
  readonly lastErrorCode: string | null;
  readonly credentialReferenceId: string | null;
  readonly hasCredential: boolean;
  readonly credentialHint: string | null;
  readonly createdAt: string;
  readonly modifiedAt: string;
}

export interface IntegrationConnectionListResult {
  readonly list: readonly IntegrationConnection[];
}

export interface IntegrationMappingSummary {
  readonly id: string;
  readonly objectType: string;
  readonly crmEntityType: string;
  readonly direction: 'inbound' | 'outbound' | 'bidirectional';
  readonly status: 'draft' | 'active' | 'retired';
  readonly mappingVersion: number;
  readonly syncMode: 'full' | 'incremental';
  readonly conflictPolicy: 'provider_wins' | 'crm_wins' | 'manual' | 'newest_wins';
  readonly deletionPolicy: 'unlink' | 'archive' | 'ignore';
  readonly fieldCount: number;
}

export interface IntegrationConnectionDetail {
  readonly connection: IntegrationConnection;
  readonly provider: {
    readonly providerKey: string;
    readonly displayName: string;
    readonly adapterVersion: string;
    readonly providerApiVersion: string;
    readonly status: string;
  };
  readonly tenant: {
    readonly ownerType: string;
    readonly ownerId: string;
    readonly tenantRef: string | null;
  };
  readonly lastTest: {
    readonly ok: boolean;
    readonly code: string | null;
    readonly message: string | null;
    readonly checkedAt: string;
  } | null;
  readonly lastRun: {
    readonly id: string;
    readonly status: string;
    readonly finishedAt: string | null;
    readonly recordsApplied: number;
    readonly recordsFailed: number;
  } | null;
  readonly syncLagSeconds: number | null;
  readonly lastWebhook: {
    readonly receivedAt: string;
    readonly status: string;
    readonly signatureValid: boolean;
    readonly eventType: string | null;
  } | null;
  readonly mappings: readonly IntegrationMappingSummary[];
  readonly warnings: readonly IntegrationWarning[];
  readonly missingScopes: readonly string[];
}

export interface IntegrationConnectionTestResult {
  readonly ok: boolean;
  readonly code: string | null;
  readonly message: string | null;
  readonly accountRef: string | null;
  readonly grantedScopes: readonly string[];
  readonly checkedAt: string;
}

export interface IntegrationReconcileResult {
  readonly resetMappings: number;
  readonly message: string;
}

export interface IntegrationJobLogRow {
  readonly id: string;
  readonly job: string;
  readonly status: string;
  readonly createdAt: string;
  readonly finishedAt: string | null;
  readonly message: string | null;
  readonly lastError: string | null;
}

export interface IntegrationJobLogResult {
  readonly list: readonly IntegrationJobLogRow[];
}

export interface IntegrationFieldMapping {
  readonly id: string;
  readonly sourcePath: string;
  readonly targetField: string;
  readonly transform: unknown;
  readonly required: boolean;
  readonly direction: 'inbound' | 'outbound' | 'bidirectional';
  readonly position: number;
}

export interface IntegrationProviderField {
  readonly name: string;
  readonly label: string;
  readonly type: string;
  readonly required: boolean;
  readonly unique: boolean;
  readonly identifier: boolean;
  readonly sensitive: boolean;
}

export interface IntegrationCrmField {
  readonly name: string;
  readonly label: string;
  readonly type: string;
  readonly required: boolean;
  readonly identifier: boolean;
  readonly sensitive: boolean;
}

export interface IntegrationMappingFields {
  readonly mappingId: string;
  readonly mappingVersion: number;
  readonly crmEntityType: string;
  readonly objectType: string;
  readonly direction: string;
  readonly providerFields: readonly IntegrationProviderField[];
  readonly crmFields: readonly IntegrationCrmField[];
  readonly fields: readonly IntegrationFieldMapping[];
  readonly warnings: readonly IntegrationWarning[];
}

export interface IntegrationMappingView {
  readonly id: string;
  readonly connectionId: string;
  readonly providerKey: string;
  readonly objectType: string;
  readonly crmEntityType: string;
  readonly direction: 'inbound' | 'outbound' | 'bidirectional';
  readonly mappingVersion: number;
  readonly status: 'draft' | 'active' | 'retired';
  readonly syncMode: 'full' | 'incremental';
  readonly conflictPolicy: 'provider_wins' | 'crm_wins' | 'manual' | 'newest_wins';
  readonly deletionPolicy: 'unlink' | 'archive' | 'ignore';
  readonly fieldAuthority: Readonly<Record<string, string>>;
  readonly fields: readonly IntegrationFieldMapping[];
  readonly createdAt: string;
  readonly modifiedAt: string;
}

export interface IntegrationMappingListResult {
  readonly list: readonly IntegrationMappingView[];
}

export interface IntegrationMappingPreview {
  readonly mappingId: string;
  readonly mappingVersion: number;
  readonly values: Readonly<Record<string, unknown>>;
  readonly missingRequired: readonly string[];
  readonly emptySources: readonly string[];
  readonly dryRun: true;
}

export type IntegrationRunStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type IntegrationRunType = 'full' | 'incremental' | 'webhook' | 'manual';

export interface IntegrationSyncRun {
  readonly id: string;
  readonly connectionId: string;
  readonly mappingId: string;
  readonly runType: IntegrationRunType;
  readonly status: IntegrationRunStatus;
  readonly triggerSource: string;
  readonly direction: string;
  readonly mappingVersion: number;
  readonly cursorBefore: string | null;
  readonly cursorAfter: string | null;
  readonly recordsScanned: number;
  readonly recordsApplied: number;
  readonly recordsSkipped: number;
  readonly recordsFailed: number;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorDetail: string | null;
  readonly createdAt: string;
}

export interface IntegrationSyncRunListResult {
  readonly list: readonly IntegrationSyncRun[];
}

export type IntegrationOperationStatus =
  | 'pending'
  | 'applied'
  | 'skipped'
  | 'failed'
  | 'dead_letter';

export interface IntegrationSyncOperation {
  readonly id: string;
  readonly operationType: string;
  readonly externalId: string | null;
  readonly crmEntityType: string | null;
  readonly crmEntityId: string | null;
  readonly status: IntegrationOperationStatus;
  readonly attempts: number;
  readonly errorCode: string | null;
  readonly errorDetail: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly retryable: boolean;
}

export interface IntegrationSyncOperationListResult {
  readonly list: readonly IntegrationSyncOperation[];
}

export type IntegrationConflictResolution = 'keep_crm' | 'keep_provider' | 'ignore' | 'unlink';

export interface IntegrationConflict {
  readonly id: string;
  readonly connectionId: string;
  readonly mappingId: string;
  readonly runId: string | null;
  readonly objectType: string;
  readonly externalId: string;
  readonly crmEntityType: string | null;
  readonly crmEntityId: string | null;
  readonly conflictType: 'field_conflict' | 'duplicate' | 'deletion' | 'authorization';
  readonly status: 'open' | 'resolved' | 'ignored';
  readonly localSnapshot: Readonly<Record<string, unknown>> | null;
  readonly remoteSnapshot: Readonly<Record<string, unknown>> | null;
  readonly conflictingFields: Readonly<Record<string, { readonly local: unknown; readonly remote: unknown }>>;
  readonly policy: string;
  readonly resolution: string | null;
  readonly resolvedBy: string | null;
  readonly resolvedAt: string | null;
  readonly createdAt: string;
  /** The field authority rule that applies to each conflicting field. */
  readonly fieldAuthority: Readonly<Record<string, string>>;
  /** True when the record changed on either side since the conflict was detected. */
  readonly stale: boolean;
  readonly staleSide: 'local' | 'remote' | null;
  readonly resolutions: readonly {
    readonly value: IntegrationConflictResolution;
    readonly label: string;
    readonly enabled: boolean;
    readonly reason: string | null;
  }[];
}

export interface IntegrationConflictListResult {
  readonly list: readonly IntegrationConflict[];
}

export interface IntegrationWebhookDelivery {
  readonly id: string;
  readonly deliveryId: string;
  readonly status: string;
  readonly signatureValid: boolean;
  readonly eventType: string | null;
  readonly externalId: string | null;
  readonly receivedAt: string;
}

export interface AdvancedIntegrationsCapabilitiesView {
  readonly capabilities: readonly {
    readonly key: string;
    readonly label: string;
    readonly description: string;
    readonly granted: boolean;
  }[];
}

/**
 * Phase 19-CHAT.2 — the Chat workspace contract the SPA renders
 * (PLAN_Phase_19_CRM_Chat.md §8, §13). The server decides every field: the shell shows what the
 * caller may do and why the workspace is not ready, instead of inferring it from hidden controls.
 */
export type CRMChatAssistantState =
  | 'not-configured'
  | 'unresolvable'
  | 'not-found'
  | 'not-published'
  | 'execution-disabled'
  | 'execution-paused'
  | 'memory-disabled'
  | 'agent-memory-off'
  | 'ready';

export interface CRMChatAssistantReadiness {
  readonly state: CRMChatAssistantState;
  readonly reason: string;
  readonly configuredKey: string;
  readonly agentId: string | null;
  readonly name: string | null;
  readonly version: number | null;
  readonly tools: readonly string[];
  readonly memoryMessages: number;
}

export interface CRMChatFeaturesView {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly effective: boolean;
  readonly defaultEnabled: boolean;
  readonly settingsPath: string;
}

export interface CRMChatLimits {
  readonly maxMessageChars: number;
  readonly maxContextRefs: number;
  readonly maxActiveTurnsPerUser: number;
  readonly maxConversationsPerUser: number;
  readonly turnTimeoutSeconds: number;
  readonly heartbeatSeconds: number;
}

export interface CRMChatCapabilitiesView {
  readonly module: {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly contractVersion: string;
    readonly apiPrefix: string;
    readonly frontendRoute: string;
    readonly implementedPhases: readonly string[];
  };
  readonly workspace: { readonly enabled: boolean; readonly permitted: boolean };
  readonly capabilities: readonly {
    readonly key: string;
    readonly label: string;
    readonly description: string;
    readonly granted: boolean;
  }[];
  readonly features: readonly CRMChatFeaturesView[];
  readonly assistant: CRMChatAssistantReadiness;
  readonly limits: CRMChatLimits;
  readonly actions: {
    readonly canStartTurn: boolean;
    readonly canConfirmWrite: boolean;
    readonly reason: string | null;
  };
}

/** 19-CHAT.4 — a conversation the caller owns (contract §7.6). */
export interface CRMChatConversationView {
  readonly id: string;
  readonly title: string | null;
  readonly agentId: string;
  readonly agentName: string;
  readonly status: 'active' | 'archived';
  readonly messageCount: number;
  readonly lastMessageAt: string;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

export interface CRMChatConversationList {
  readonly list: readonly CRMChatConversationView[];
  readonly total: number;
  readonly offset: number;
  readonly count: number;
}

/** Plain text only (contract D11): no markdown, no HTML from the model. */
export interface CRMChatMessageView {
  readonly id: string;
  readonly sequence: number;
  readonly role: 'user' | 'assistant' | 'system';
  readonly content: string;
  readonly contentFormat: 'plain';
  readonly redaction: 'none' | 'summary' | 'hashed';
  readonly turnId: string | null;
  readonly citations: readonly unknown[];
  readonly createdAt: string;
  readonly completedAt: string | null;
}

export interface CRMChatMessagePage {
  readonly list: readonly CRMChatMessageView[];
  readonly nextBefore: number | null;
  readonly hasMore: boolean;
}

export interface CRMChatConversationDetail {
  readonly conversation: CRMChatConversationView;
  readonly messages: CRMChatMessagePage;
}

/**
 * Phase 19-CHAT.14 — a saved prompt template. The body is **data**: the SPA puts it in the
 * composer and submits it like any other message. It can never select a tool, an entity or a
 * permission, so the SPA treats it as plain text everywhere.
 */
export interface CRMChatPromptView {
  readonly id: string;
  readonly name: string;
  readonly promptTemplate: string;
  readonly description: string | null;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly modifiedAt: string;
}

/** Phase 19-CHAT.14 — the caller's rating of one answer. */
export interface CRMChatFeedbackView {
  readonly id: string;
  readonly messageId: string;
  readonly conversationId: string;
  readonly rating: 'up' | 'down';
  readonly category: string | null;
  readonly comment: string | null;
  readonly createdAt: string;
  readonly modifiedAt: string;
}

/**
 * Phase 19-CHAT.12 — an action proposal, as the SPA may show it.
 *
 * `actionable` is the only field the UI may key the confirm/reject controls on: it already
 * accounts for the decision state and the expiry, so the SPA does not re-derive them.
 */
export interface CRMChatActionView {
  readonly id: string;
  readonly runId: string;
  readonly agentName: string;
  readonly agentVersion: number;
  readonly toolKey: string | null;
  readonly actionClass: string;
  readonly riskLevel: string;
  readonly summary: string;
  readonly proposal: unknown;
  readonly targets: unknown;
  readonly status: string;
  readonly decidedByUserId: string | null;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
  readonly actionable: boolean;
  readonly expiresAt: string;
  readonly createdAt: string;
}

/** Phase 19-CHAT.11 — one curated cross-module path. */
export interface CRMChatCrossModuleScenario {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly rootEntity: string;
}

/** Phase 19-CHAT.17 — the usage of one turn. */
export interface CRMChatUsageSummary {
  readonly turnId: string;
  readonly runId: string;
  readonly status: string;
  readonly steps: number;
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
  readonly costLabel: 'estimate' | 'none';
}

/** Phase 19-CHAT.5 — turn submission result (contract §8.2). */
export interface CRMChatTurnResult {
  readonly turnId: string;
  readonly runId: string;
  readonly status: string;
  readonly conversationId: string | null;
}

/** Phase 19-CHAT.5 — turn status view. */
export interface CRMChatTurnStatus {
  readonly turnId: string;
  readonly runId: string;
  readonly status: string;
  readonly conversationId: string | null;
  readonly result: unknown;
  readonly failureMessage: string | null;
  readonly cancelRequested: boolean;
}

/** Phase 19-CHAT.6 — SSE stream event type. */
export type CRMChatStreamEventType =
  | 'turn.started'
  | 'tool.started'
  | 'tool.completed'
  | 'citation.added'
  | 'action.proposed'
  | 'approval.required'
  | 'assistant.message'
  | 'usage.summary'
  | 'turn.completed'
  | 'turn.failed'
  | 'turn.cancelled'
  | 'heartbeat';

/** Phase 19-CHAT.6 — parsed SSE event from the stream. */
export interface CRMChatStreamEvent {
  readonly id: string;
  readonly event: CRMChatStreamEventType;
  readonly data: Record<string, unknown>;
}

/**
 * Phase 19-CHAT.6 — citation rendered in a message.
 *
 * This is the server-materialised view (`CRMChatCitationView`): the label and route are produced
 * server-side after an ACL re-read, so the SPA renders exactly what it is given and never composes a
 * route of its own. `entity`/`recordId` are null for a citation that is not a CRM record, such as a
 * handbook page cited by `docs_read_page`.
 */
export interface CRMChatCitation {
  readonly id: string;
  readonly messageId: string;
  readonly sourceType: 'crm_record' | 'query_result' | 'report' | 'help_document' | 'approved_external_source';
  readonly entity: string | null;
  readonly recordId: string | null;
  readonly label: string;
  readonly route: string;
  readonly ordinal: number;
  readonly recheckedAt: string;
}

/** What `POST action/citations/reauthorize` answers for one citation. */
export interface CRMChatReauthorizedCitation {
  readonly accessible: boolean;
  readonly label: string | null;
  readonly route: string | null;
  readonly reason: string | null;
}

export interface CRMChatHealthView {
  readonly module: {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly minPlatformVersion: string;
    readonly loadOrder: number;
    readonly apiPrefix: string;
    readonly frontendRoute: string;
    readonly implementedPhases: readonly string[];
    readonly dependsOn: readonly string[];
  };
  readonly ok: boolean;
  readonly workspace: { readonly enabled: boolean };
  readonly assistant: CRMChatAssistantReadiness;
  readonly dependencies: readonly {
    readonly id: string;
    readonly label: string;
    readonly present: boolean;
    readonly evidence: readonly { readonly kind: string; readonly value: string; readonly present: boolean }[];
    readonly missing: readonly string[];
  }[];
  readonly optionalIntegrations: readonly {
    readonly id: string;
    readonly label: string;
    readonly provides: string;
    readonly present: boolean;
    readonly status: string;
  }[];
  readonly features: readonly CRMChatFeaturesView[];
  readonly structures: readonly { readonly name: string; readonly present: boolean }[];
  readonly settings: { readonly version: number; readonly updatedAt: string | null; readonly warnings: readonly string[] };
  readonly checks: readonly { readonly name: string; readonly ok: boolean; readonly detail: string }[];
}

export interface CRMChatSettingsView {
  readonly settings: Record<string, unknown>;
  readonly version: number;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
  readonly features: Record<string, boolean>;
  readonly effectiveFeatures: Record<string, boolean>;
}

/**
 * Phase 21.5 — the in-app handbook (PLAN_Phase_21_Documentation.md §8.2, §9.1).
 *
 * The block contract is imported from `@carocrm/docs` rather than copied: the API serialises the engine's
 * `DocBlock` tree and the SPA renders it, so a type duplicated here would be a second definition of the
 * product's content model, free to drift. The tree/page/search views below are the HTTP shapes, which the
 * engine does not own.
 */
export type { DocBlock, DocCalloutVariant, DocInline, DocPage, DocPageMeta, DocSearchHit, DocSection, DocTocEntry } from '@carocrm/docs';

export interface DocsTreeView {
  readonly enabled: boolean;
  readonly externalUrl: string | null;
  readonly locale: string;
  readonly fallbackLocale: string;
  readonly hash: string;
  readonly sections: readonly DocSection[];
  /** Only an administrator receives this; it drives the `Docs` settings tab (§12). */
  readonly diagnostics?: DocsDiagnostics;
}

export interface DocsDiagnostics {
  readonly locales: readonly {
    readonly locale: string;
    readonly pages: number;
    readonly translated: number;
    readonly hash: string;
    readonly warnings: readonly { readonly code: string; readonly message: string; readonly key: string | null }[];
  }[];
  readonly coverage: number;
}

export interface DocsPageView {
  readonly page: DocPage;
}

export interface DocsSearchView {
  readonly query: string;
  readonly locale: string;
  readonly total: number;
  readonly hits: readonly DocSearchHit[];
}

/** The `docs` settings document, read through the settings-document registry (§6.1). */
export interface DocsSettingsView {
  readonly enabled: boolean;
  readonly showInSidebar: boolean;
  readonly showHelpMenu: boolean;
  readonly externalUrl: string | null;
  readonly landingPage: string | null;
  readonly supportEmail: string | null;
}


// ---------------------------------------------------------------------------
// Phase 19-ES.1 — the ESignature control plane.
// ---------------------------------------------------------------------------

/** One module right with its label and whether the caller holds it. */
export interface ESignatureCapabilityEntry {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly granted: boolean;
}

/** The gate that stands in front of every provider operation, reported rather than enforced twice. */
export interface ESignatureGateState {
  readonly ready: boolean;
  readonly moduleEnabled: boolean;
  readonly connectionsEnabled: boolean;
  readonly encryptionConfigured: boolean;
  readonly enabledConnections: number;
  readonly reason: string;
  readonly detail: string;
}

/** `GET /ESignature/action/capabilities`. */
export interface ESignatureCapabilitiesView {
  readonly capabilities: readonly ESignatureCapabilityEntry[];
  readonly provider: ESignatureGateState;
}

export interface ESignatureHealthFeature {
  readonly key: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly implemented: boolean;
  readonly effective: boolean;
  readonly settingsPath: string;
  readonly requires: readonly string[];
  readonly pendingPhase: string | null;
}

/** `GET /ESignature/action/health`: what the module needs, what is switched on, and why the gate is closed. */
export interface ESignatureHealthView {
  readonly module: {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly loadOrder: number;
    readonly apiPrefix: string;
    readonly webhookPrefix: string;
    readonly frontendRoute: string;
    readonly providerKeys: readonly string[];
    readonly implementedPhases: readonly string[];
  };
  readonly ok: boolean;
  readonly dependencies: readonly { id: string; label: string; present: boolean; missing: readonly string[] }[];
  readonly optionalIntegrations: readonly { id: string; label: string; provides: string; status: string }[];
  readonly features: readonly ESignatureHealthFeature[];
  readonly providerCapabilities: Readonly<Record<string, boolean>>;
  /** Which adapter is bound in this build, and in which mode: `live`, `fake` or absent. */
  readonly providerAdapters: readonly {
    readonly providerKey: string;
    readonly mode: string;
    readonly adapterVersion: string;
    readonly providerApiVersion: string;
  }[];
  readonly structures: readonly { name: string; present: boolean }[];
  readonly settings: {
    readonly key: string;
    readonly version: number;
    readonly updatedAt: string | null;
    readonly updatedBy: string | null;
    readonly warnings: readonly { code: string; message: string }[];
  };
  readonly gate: ESignatureGateState;
  readonly checks: readonly { name: string; ok: boolean; detail: string }[];
}

/** The module's own navigation answer (`GET /ESignature/action/nav`), the page's quiet source of truth. */
export interface ESignatureNavView {
  readonly visible: boolean;
  readonly admin: boolean;
  readonly enabled: boolean;
  readonly ready: boolean;
  readonly reason: string;
}

/** `GET /ESignature/action/settings`: the versioned document plus the effective feature answer. */
export interface ESignatureSettingsView {
  readonly settings: Record<string, unknown>;
  readonly version: number;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly defaults: Record<string, unknown>;
  readonly warnings: readonly SettingsDocumentWarning[];
  readonly pendingFeatures: readonly { key: string; phase: string }[];
  readonly effective: Readonly<Record<string, boolean>>;
  readonly integrationKeyEnvVars: readonly string[];
}

// Phase 19-ES.4 — the provider connections. The view is the server's redacted answer: a credential is
// reported as a kind, a state and an expiry, never as a value (plan §8.1, §12.13).
export interface ESignatureCredentialView {
  readonly kind: string;
  readonly label: string;
  readonly state: 'active' | 'revoked';
  readonly expiresAt: string | null;
  readonly rotatedAt: string | null;
}

export interface ESignatureConnectionView {
  readonly id: string;
  readonly name: string;
  readonly providerKey: string;
  readonly environment: 'demo' | 'production';
  readonly status: 'not_connected' | 'connected' | 'reauthorization_required' | 'disabled' | 'error';
  readonly isActive: boolean;
  readonly oauthClientId: string | null;
  readonly redirectUri: string | null;
  readonly accountId: string | null;
  readonly accountName: string | null;
  readonly baseUri: string | null;
  readonly grantedScopes: readonly string[];
  readonly consentStatus: string;
  readonly lastAuthAt: string | null;
  readonly lastSuccessfulApiAt: string | null;
  readonly lastWebhookAt: string | null;
  readonly lastErrorAt: string | null;
  readonly lastErrorCode: string | null;
  readonly pendingAuthorization: boolean;
  readonly credentials: readonly ESignatureCredentialView[];
  readonly hasClientSecret: boolean;
  readonly hasRefreshToken: boolean;
  readonly accessTokenExpiresAt: string | null;
  readonly adapterMode: 'live' | 'fake' | 'disabled' | 'none';
  /** The catalog's display name for the provider, so the UI never hard-codes a vendor. */
  readonly providerLabel: string;
  /** `declared` means the provider is cataloged but its integration is not installed here. */
  readonly providerStatus: 'available' | 'declared' | 'unknown';
  /** An API-key provider stores `api_key`; an OAuth provider stores client/refresh credentials. */
  readonly authStyle: 'oauth2_authorization_code' | 'api_key' | null;
  readonly hasApiKey: boolean;
  readonly webhookSecretKind: 'webhook_secret' | 'api_key' | null;
  readonly createdAt: string;
  readonly modifiedAt: string;
}

/**
 * One entry of `GET /ESignature/action/provider-catalog`.
 * A declared provider appears in the picker but cannot be connected in this build.
 */
export interface ESignatureProviderCatalogEntry {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly authStyle: 'oauth2_authorization_code' | 'api_key';
  readonly integrationStatus: 'available' | 'declared';
  /** `direct` providers create and send in one call; there is no provider draft step. */
  readonly envelopeDrafting: 'draft' | 'direct';
  readonly capabilities: Readonly<Record<string, boolean>>;
  readonly documentLimits: { readonly maxDocumentBytes: number; readonly supportedExtensions: readonly string[] } | null;
  readonly oauthClientIdEnvVars: readonly string[];
  readonly oauthClientIdSettingsPath: string | null;
  readonly documentationUrl: string;
}

export interface ESignatureProviderCatalogView {
  readonly providers: readonly ESignatureProviderCatalogEntry[];
}

/** `POST /ESignature/connections/:id/authorize`. The URL is the only place the state appears. */
export interface ESignatureAuthorizationStart {
  readonly connectionId: string;
  readonly environment: 'demo' | 'production';
  readonly authorizationUrl: string;
  readonly expiresAt: string;
  readonly scopes: readonly string[];
}

/** `POST /ESignature/connections/:id/test`. */
export interface ESignatureConnectionTest {
  readonly connectionId: string;
  readonly environment: 'demo' | 'production';
  readonly reachable: boolean;
  readonly checkedAt: string;
  readonly detailCode: string;
  readonly adapterMode: 'live' | 'fake' | 'disabled';
}

// Phase 19-ES.6 — the signature request draft surface. `source.accessible === false` means the linked
// CRM record exists but its own ACL hides it; the server never sends that name, so neither may the UI.
export interface ESignatureRequestSource {
  readonly entityType: string;
  readonly recordId: string;
  readonly label: string | null;
  readonly accessible: boolean;
  readonly missing: boolean;
}

export interface ESignatureRequestRecipient {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly recipientType: 'signer' | 'carbon_copy';
  readonly roleName: string | null;
  readonly routingOrder: number;
  readonly status: string;
  readonly crmContactId: string | null;
  readonly authenticationMethod: string | null;
  readonly declineReasonSafe: string | null;
}

export interface ESignatureRequestDocument {
  readonly id: string;
  readonly artifactKind: 'source_snapshot' | 'provider_signed_document' | 'completion_evidence' | 'supporting_document';
  readonly displayName: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly contentHashSha256: string;
  readonly documentOrder: number;
  readonly providerDocumentId: string | null;
  readonly createdAt: string;
}

export interface ESignatureRequestView {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: string;
  readonly providerKey: string;
  readonly connectionId: string | null;
  readonly providerEnvelopeId: string | null;
  readonly providerStatusRaw: string | null;
  /** A `direct` provider sends at creation time, so the draft step is skipped. */
  readonly providerDrafting: 'draft' | 'direct';
  readonly source: ESignatureRequestSource | null;
  readonly subject: string | null;
  readonly message: string | null;
  readonly emailBlurb: string | null;
  readonly expiresAt: string | null;
  readonly approvalRequired: boolean;
  readonly approvalStatus: string;
  readonly approvalReason: string | null;
  readonly approvalRequestedAt: string | null;
  readonly approvalRequestedById: string | null;
  readonly approvalDecidedAt: string | null;
  readonly approvalDecidedById: string | null;
  readonly approvalReviewedVersion: number | null;
  readonly approvalReviewedDigest: string | null;
  readonly createdById: string | null;
  readonly assignedUserId: string | null;
  readonly teamIds: readonly string[];
  readonly preparedAt: string | null;
  readonly sentAt: string | null;
  readonly completedAt: string | null;
  readonly declinedAt: string | null;
  readonly voidedAt: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly modifiedAt: string;
  readonly editable: boolean;
  readonly recipients: readonly ESignatureRequestRecipient[];
  readonly documents: readonly ESignatureRequestDocument[];
}

export interface ESignatureRequestListRow {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly source: ESignatureRequestSource | null;
  readonly assignedUserId: string | null;
  readonly createdById: string | null;
  readonly approvalStatus: string;
  readonly sentAt: string | null;
  readonly modifiedAt: string;
  readonly progress: { readonly total: number; readonly outstanding: number; readonly completed: number; readonly declined: number; readonly signers: number };
}

export interface ESignatureRequestList {
  readonly list: readonly ESignatureRequestListRow[];
  readonly total: number;
}

/** Phase 19-ES.19 — one curated operational aggregate. `data` is shaped by `key`. */
export interface ESignatureReportWindow {
  readonly days: number;
  readonly from: string | null;
  readonly to: string;
}

export interface ESignatureReportSection {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly generatedAt: string;
  readonly window: ESignatureReportWindow;
  readonly data: Record<string, unknown>;
}

export interface ESignatureReportOverview {
  readonly generatedAt: string;
  readonly window: ESignatureReportWindow;
  readonly sections: readonly ESignatureReportSection[];
}

/** Phase 19-ES.20 — the recovery workbench. All fields are redacted diagnostics, never a secret. */
export interface ESignatureOperationCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface ESignatureConnectionHealth {
  readonly id: string;
  readonly name: string;
  readonly providerKey: string;
  readonly environment: string;
  readonly status: string;
  readonly isActive: boolean;
  readonly accountName: string | null;
  readonly adapterMode: string;
  readonly consentStatus: string;
  readonly pendingAuthorization: boolean;
  readonly token: {
    readonly state: 'missing' | 'valid' | 'expiring' | 'expired' | 'reauthorization_required';
    readonly expiresAt: string | null;
    readonly hasRefreshToken: boolean;
    readonly hasClientSecret: boolean;
  };
  readonly webhook: {
    readonly configured: boolean;
    readonly lastReceivedAt: string | null;
    readonly pending: number;
    readonly retryable: number;
    readonly deadLetter: number;
    readonly invalid: number;
  };
  readonly requests: Readonly<Record<string, number>>;
  readonly lastSuccessfulApiAt: string | null;
  readonly lastErrorAt: string | null;
  readonly lastErrorCode: string | null;
  readonly issues: readonly string[];
  readonly health: 'ok' | 'attention' | 'blocked';
}

export interface ESignatureWebhookDelivery {
  readonly id: string;
  readonly connectionId: string | null;
  readonly providerEnvelopeId: string | null;
  readonly state: string;
  readonly signatureStatus: string;
  readonly receivedAt: string;
  readonly processedAt: string | null;
  readonly attemptCount: number;
  readonly lastErrorSafe: string | null;
  readonly contentLength: number;
  readonly correlationId: string | null;
  readonly retryAllowed: boolean;
}

export interface ESignatureWebhookDiagnostics {
  readonly total: number;
  readonly countsByState: Readonly<Record<string, number>>;
  readonly signatureStatus: { readonly verified: number; readonly invalid: number; readonly notRequired: number };
  readonly lastReceivedAt: string | null;
  readonly oldestPendingAt: string | null;
  readonly oldestPendingState: 'received' | 'retryable' | null;
  readonly pendingLagMinutes: number | null;
  readonly deliveries: readonly ESignatureWebhookDelivery[];
}

export interface ESignatureRecoveryRequest {
  readonly id: string;
  readonly status: string;
  readonly connectionId: string | null;
  readonly providerEnvelopeId: string | null;
  readonly createdAt: string;
  readonly sentAt: string | null;
  readonly modifiedAt: string;
  readonly lastProviderSyncAt: string | null;
  readonly expiresAt: string | null;
  readonly failureCategory: string | null;
  readonly failureCode: string | null;
  readonly failureMessageSafe: string | null;
  readonly ageHours: number;
  readonly reconcileAllowed: boolean;
}

export interface ESignatureRecoveryList {
  readonly items: readonly ESignatureRecoveryRequest[];
  readonly count: number;
}

export interface ESignatureFailedJob {
  readonly id: string;
  readonly job: string;
  readonly status: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
  readonly targets: { readonly requestId: string | null; readonly inboxId: string | null };
}

export interface ESignatureOperationsOverview {
  readonly generatedAt: string;
  readonly moduleEnabled: boolean;
  readonly webhooksEnabled: boolean;
  readonly requestAccess: 'all' | 'team' | 'own' | 'none';
  readonly connections: readonly ESignatureConnectionHealth[];
  readonly webhook: ESignatureWebhookDiagnostics;
  readonly worklists: {
    readonly failed: ESignatureRecoveryList;
    readonly stuck: ESignatureRecoveryList;
    readonly sendUnknown: ESignatureRecoveryList;
    readonly reconciliation: ESignatureRecoveryList;
  };
  readonly failedJobs: { readonly items: readonly ESignatureFailedJob[]; readonly count: number };
  readonly checks: readonly ESignatureOperationCheck[];
  readonly actions: { readonly canRetryWebhook: boolean; readonly canReconcile: boolean };
}

/** Phase 19-ES.18 — the capability answer for one CRM record's detail page. */
export interface ESignatureRecordEntry {
  readonly available: boolean;
  readonly reason: 'available' | 'module_disabled' | 'no_permission' | 'unsupported_entity' | 'record_missing' | 'record_restricted';
  readonly entityType: string;
  readonly recordId: string;
  readonly canPrepare: boolean;
  readonly requests: readonly {
    readonly id: string;
    readonly name: string;
    readonly status: string;
    readonly approvalStatus: string;
    readonly modifiedAt: string;
  }[];
}

/** Phase 19-ES.13 — one row of the request's activity timeline. Never a raw provider payload. */
export interface ESignatureTimelineEntry {
  readonly id: string;
  readonly kind: 'provider' | 'audit';
  readonly at: string;
  readonly type: string;
  readonly providerTypeRaw: string | null;
  readonly recipientId: string | null;
  readonly outcome: string;
  readonly reasonSafe: string | null;
  readonly detail: Readonly<Record<string, unknown>>;
}

/** Phase 19-ES.14 — the one-time signing URL; it is never stored or logged. */
export interface ESignatureEmbeddedView {
  readonly url: string;
  readonly expiresAt: string | null;
}

/** Phase 19-ES.15 — what a completed-artifact retrieval stored. */
export interface ESignatureArtifactRetrieval {
  readonly artifacts: readonly ESignatureRequestDocument[];
  readonly created: number;
}

// Phase 19-ES.7 — the template catalog and the mappings built from it.
export interface ESignatureTemplateSummary {
  readonly templateId: string;
  readonly name: string;
  readonly description: string | null;
  readonly shared: boolean;
  readonly status: string | null;
}

export interface ESignatureTemplateRole {
  readonly roleName: string;
  readonly recipientType: 'signer' | 'carbon_copy' | 'other';
  readonly routingOrder: number | null;
  readonly required: boolean;
}

export interface ESignatureTemplateField {
  readonly tabLabel: string;
  readonly roleName: string | null;
  readonly documentId: string | null;
  readonly fieldType: string | null;
  readonly required: boolean;
}

export interface ESignatureTemplateDetail extends ESignatureTemplateSummary {
  readonly connectionId: string;
  readonly environment: string;
  readonly roles: readonly ESignatureTemplateRole[];
  readonly fields: readonly ESignatureTemplateField[];
}

export interface ESignatureTemplateCatalog {
  readonly connectionId: string;
  readonly environment: string;
  readonly refreshedAt: string;
  readonly templates: readonly ESignatureTemplateSummary[];
  readonly mappings: readonly { id: string; name: string; providerTemplateId: string; presentInCatalog: boolean; catalogName: string | null }[];
}

export interface ESignatureRoleMapping {
  readonly roleName: string;
  readonly recipientType: 'signer' | 'carbon_copy';
  readonly routingOrder: number;
  readonly source: 'crmField' | 'manual';
  readonly crmField: string | null;
}

export interface ESignatureFieldMapping {
  readonly tabName: string;
  readonly crmField: string;
  readonly required: boolean;
}

export interface ESignatureTemplateMapping {
  readonly id: string;
  readonly name: string;
  readonly mappingType: 'workflow' | 'document_type' | 'process';
  readonly connectionId: string;
  readonly providerTemplateId: string;
  readonly providerTemplateName: string | null;
  readonly supportedSourceEntities: readonly string[];
  readonly roleMappings: readonly ESignatureRoleMapping[];
  readonly fieldMappings: readonly ESignatureFieldMapping[];
  readonly defaultSubject: string | null;
  readonly defaultMessage: string | null;
  readonly isActive: boolean;
  readonly version: number;
  readonly createdAt: string;
  readonly modifiedAt: string;
}

// Phase 19-ES.8 — the send preview. `problems` is what blocks preparation; `digest` is the identity of
// exactly these bytes, recipients and policy.
export interface ESignaturePreviewProblem {
  readonly code: string;
  readonly message: string;
  readonly where: string;
}

export interface ESignatureSendPreview {
  readonly requestId: string;
  readonly requestVersion: number;
  readonly requestStatus: string;
  readonly data: {
    readonly templateId: string | null;
    readonly subject: string | null;
    readonly message: string | null;
    readonly environment: string;
    readonly accountId: string | null;
    readonly documents: readonly { readonly displayName: string; readonly contentHashSha256: string; readonly documentOrder: number }[];
    readonly recipients: readonly { readonly name: string; readonly email: string; readonly recipientType: string; readonly routingOrder: number; readonly roleName: string | null }[];
    readonly templateMappingId?: string | null | undefined;
    readonly templateMappingVersion?: number | null | undefined;
  } | null;
  readonly digest: string | null;
  readonly problems: readonly ESignaturePreviewProblem[];
  readonly ready: boolean;
  readonly approvalRequired: boolean;
  readonly approvalReasons: readonly { readonly code: string; readonly label: string; readonly ruleLabel: string | null }[];
  readonly approvedForThisDigest: boolean;
  readonly storedDigest: string | null;
  readonly staleStoredPreview: boolean;
}
