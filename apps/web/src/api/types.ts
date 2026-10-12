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
