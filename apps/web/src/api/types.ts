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
  label?: string | undefined;
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

export interface EntityDefinition {
  name: string;
  label: string;
  isEntity: boolean;
  fields: Record<string, FieldDefinition>;
  relations: Record<string, RelationDefinition>;
  indexes?: IndexDefinition[] | undefined;
  layouts?: Record<string, LayoutDefinition[]> | undefined;
  acl?: AclDefinition | undefined;
  record?: { displayField?: string | undefined; nameField?: string | undefined } | undefined;
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

export type Metadata = Record<string, EntityDefinition>;

export interface ListResult<T = Record<string, unknown>> {
  list: T[];
  total?: number;
  offset: number;
  count: number;
}

export interface Principal {
  id: string;
  userName: string;
  type: string;
  roles: string[];
  teams: string[];
  /** Phase 7A (PLAN §41.6): the user's locale/timezone, null = instance default. */
  locale: string | null;
  timezone: string | null;
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
