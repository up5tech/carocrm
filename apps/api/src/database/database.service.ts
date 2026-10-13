import { Inject, Injectable } from '@nestjs/common';
import type { Generated, Transaction as KyselyTransaction } from 'kysely';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import type { AppConfig } from '../config.js';
import { CONFIG_TOKEN } from '../config.js';

export interface UsersTable {
  id: string;
  user_name: string;
  account_name: string | null;
  first_name: string | null;
  last_name: string | null;
  email_address: string | null;
  is_admin: boolean;
  is_active: boolean;
  portal_types: unknown;
  type: 'admin' | 'regular' | 'api' | 'portal' | 'system';
  auth_method: string;
  password: string | null;
  assigned_role_ids: unknown;
  /** Phase 18: the portal this user belongs to (portal users only, PLAN §37). */
  portal_id: string | null;
  /** Phase 18: the Contact record this portal user is (PLAN §37 contact/account relation). */
  contact_id: string | null;
  /** Phase 18: portal roles assigned directly to this user (on top of the portal's roles). */
  portal_role_ids: unknown;
  title: string | null;
  phone: string | null;
  is_deleted: boolean;
  created_at: Date;
  modified_at: Date;
  created_by_id: string | null;
  modified_by_id: string | null;
}

export interface UserSessionsTable {
  id: string;
  user_id: string;
  api_token: string | null;
  refresh_token: string | null;
  revoked_at: Date | null;
  is_admin: boolean;
  created_at: Date;
  modified_at: Date;
  last_access_at: Date | null;
  expired_at: Date | null;
}

export interface ApiUsersTable {
  id: string;
  user_name: string;
  is_active: boolean;
  assigned_role_ids: unknown;
  created_at: Date;
  modified_at: Date;
}

export interface ApiKeysTable {
  id: string;
  api_user_id: string;
  secret_hash: string;
  last_used_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

export interface RolesTable {
  id: string;
  name: string;
  permissions: unknown;
  field_permissions: unknown;
  entity_type: string;
  is_deleted: boolean;
  created_at: Date;
  modified_at: Date;
}

export interface TeamsTable {
  id: string;
  name: string;
  user_id: unknown;
  role_ids: unknown;
  is_private: boolean;
  is_deleted: boolean;
  created_at: Date;
  modified_at: Date;
}

export interface UsersRolesTable {
  user_id: string;
  role_id: string;
}

export interface UsersTeamsTable {
  user_id: string;
  team_id: string;
}

export interface TeamsRolesTable {
  team_id: string;
  role_id: string;
}

export interface MetadataEntriesTable {
  scope: string;
  name: string;
  data: unknown;
  version: bigint;
  created_at: Date;
  modified_at: Date;
}

export interface AppSettingsTable {
  name: string;
  data: unknown;
  modified_at: Date;
}

export interface EntityRecordsTable {
  id: string;
  entity_type: string;
  name: string | null;
  attrs: unknown;
  assigned_user_id: string | null;
  created_by_id: string | null;
  modified_by_id: string | null;
  team_ids: unknown;
  created_at: Date;
  modified_at: Date;
  deleted_at: Date | null;
  version: number;
}

export interface EntityLinksTable {
  id: string;
  entity_type_a: string;
  record_id_a: string;
  relation_name: string;
  entity_type_b: string;
  record_id_b: string;
  role_a: string | null;
  role_b: string | null;
  attributes: unknown;
  created_at: Date;
}

export interface AttachmentsTable {
  id: string;
  name: string;
  type: string;
  size: bigint;
  mime_type: string;
  storage_key: string;
  checksum: string | null;
  parent_id: string | null;
  parent_type: string | null;
  field: string | null;
  role: string | null;
  created_by_id: string | null;
  created_at: Date;
}

export interface FileUploadsTable {
  id: string;
  created_by_id: string | null;
  name: string;
  mime_type: string;
  total_size: bigint;
  chunk_max_size: number;
  received: bigint;
  part_count: number;
  parts: unknown;
  status: string;
  parent_type: string | null;
  parent_id: string | null;
  field: string | null;
  role: string | null;
  storage_prefix: string;
  expires_at: Date;
  created_at: Date;
  modified_at: Date;
}

export interface AuditLogTable {
  id: string;
  entity_type: string;
  record_id: string;
  username: string | null;
  user_id: string | null;
  action: string;
  order: number;
  data: unknown;
  archived: boolean;
  created_at: Date;
}

export interface StreamItemsTable {
  id: string;
  entity_type: string;
  entity_id: string;
  type: string;
  data: unknown;
  post: string | null;
  created_by_id: string | null;
  created_at: Date;
  modified_at: Date;
  is_deleted: boolean;
}

export interface StreamMentionsTable {
  id: string;
  stream_item_id: string;
  user_id: string;
  char_offset: number | null;
}

export interface StreamFollowersTable {
  id: string;
  entity_type: string;
  entity_id: string;
  user_id: string;
  created_at: Date;
}

export interface StreamAttachmentsTable {
  id: string;
  stream_item_id: string;
  attachment_id: string;
}

export interface NotificationsTable {
  id: string;
  type: string;
  user_id: string;
  data: unknown;
  is_read: boolean;
  created_at: Date;
}

export interface OutboxEventsTable {
  id: string;
  event_type: string;
  payload: unknown;
  status: string;
  attempts: number;
  last_error: string | null;
  available_at: Date;
  created_at: Date;
  processed_at: Date | null;
}

export interface JobsTable {
  id: string;
  job: string;
  status: string;
  scheduling_type: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  target: unknown;
  result: unknown;
  progress: number | null;
  message: string | null;
  last_error: string | null;
  queue_job_id: string | null;
  attempt: number;
  max_attempts: number;
  cancel_requested: boolean;
}

export interface JobLogsTable {
  seq: string;
  job_id: string;
  level: string;
  message: string;
  created_at: Date;
}

export interface ScheduledJobsTable {
  id: string;
  job: string;
  scheduling: string;
  target: unknown;
  enabled: boolean;
  last_run_at: Date | null;
  created_at: Date;
  modified_at: Date;
}

export interface SchemaChangesTable {
  id: string;
  operation: string;
  entity_type: string | null;
  field_name: string | null;
  payload: unknown;
  status: string;
  error: string | null;
  created_at: Date;
  applied_at: Date | null;
}

/** Saved list filter (PLAN §32.2): named where-clause owned by a user, optionally shared. */
export interface SavedFiltersTable {
  id: string;
  name: string;
  entity_type: string;
  user_id: string | null;
  criteria: unknown;
  visibility: string;
  is_shared: boolean;
  created_at: Date;
  modified_at: Date;
}

/** Dashboard shell (PLAN §33): layout owned by a user, optionally shared. */
export interface DashboardsTable {
  id: string;
  name: string;
  user_id: string | null;
  config: unknown;
  layout: unknown;
  is_shared: boolean;
  created_at: Date;
  modified_at: Date;
}

/**
 * Dashlet widget (PLAN §33): one configured view on a dashboard. `config` carries the
 * dashlet kind (list | chart | kpi) plus its entity/filter/metric definition; the API
 * executes it through the Query Engine — never raw SQL from config.
 */
export interface DashletsTable {
  id: string;
  dashboard_id: string;
  name: string;
  kind: string;
  position: number;
  config: unknown;
  created_at: Date;
  modified_at: Date;
}

/** Saved, metadata-validated report definition (PLAN §34 / Phase 17). */
export interface ReportsTable {
  id: string;
  name: string;
  entity_type: string;
  user_id: string;
  definition: unknown;
  visibility: string;
  is_shared: boolean;
  created_at: Date;
  modified_at: Date;
}

export interface ReportSchedulesTable {
  id: string;
  report_id: string;
  owner_user_id: string;
  scheduled_job_id: string;
  cron: string;
  enabled: boolean;
  created_at: Date;
  modified_at: Date;
}

/** One row per recipient of one Email record (PLAN §28.3 delivery status). */
export interface EmailDeliveriesTable {
  id: string;
  email_id: string;
  recipient: string;
  recipient_type: string;
  status: string;
  transport: string | null;
  provider_message_id: string | null;
  error: string | null;
  attempts: number;
  created_at: Date;
  modified_at: Date;
  sent_at: Date | null;
}

export interface EmailAccountsTable {
  id: string;
  name: string;
  email_address: string;
  from_name: string | null;
  smtp_host: string;
  smtp_port: number;
  smtp_security: string;
  smtp_username: string | null;
  /** AES-256-GCM payload from @carocrm/core encryptSecret; never the plaintext password. */
  smtp_password_encrypted: string | null;
  signature: string | null;
  is_active: boolean;
  is_default: boolean;
  is_deleted: boolean;
  created_by_id: string | null;
  created_at: Date;
  modified_at: Date;
}

/**
 * Phase 18 portals (PLAN §37): the external site, its own role space, navigation and
 * dashboards. Portal record visibility itself is not stored here — it is derived from the
 * portal user's Contact/Account through the entity link store by the portal ACL policy.
 */
export interface PortalsTable {
  id: string;
  name: string;
  url_path: string;
  is_active: boolean;
  settings: unknown;
  is_deleted: boolean;
  created_at: Date;
  modified_at: Date;
}

/** Portal role: the ONLY authority a portal user can have (separate from `roles`). */
export interface PortalRolesTable {
  id: string;
  name: string;
  permissions: unknown;
  field_permissions: unknown;
  is_deleted: boolean;
  created_at: Date;
  modified_at: Date;
}

/** Roles every portal user of a portal holds (PLAN §18.2). */
export interface PortalsPortalRolesTable {
  portal_id: string;
  portal_role_id: string;
}

/** One navigation entry of a portal: lists one entity, or points at a fixed route. */
export interface PortalNavItemsTable {
  id: string;
  portal_id: string;
  label: string;
  entity: string | null;
  route: string | null;
  icon: string | null;
  position: number;
  is_active: boolean;
  created_at: Date;
  modified_at: Date;
}

/** A portal dashboard: role-specific, or the portal default when `portal_role_id` is null. */
export interface PortalDashboardsTable {
  id: string;
  portal_id: string;
  portal_role_id: string | null;
  name: string;
  layout: unknown;
  config: unknown;
  is_default: boolean;
  created_at: Date;
  modified_at: Date;
}

/** One dashboard widget; executed through the portal ACL policy, never raw SQL (PLAN §33). */
export interface PortalDashletsTable {
  id: string;
  dashboard_id: string;
  name: string;
  kind: string;
  position: number;
  config: unknown;
  created_at: Date;
  modified_at: Date;
}

/**
 * Phase 15 workflows (PLAN §35). `workflows` is identity and activation; `workflow_versions` holds
 * the immutable/published definitions; runs and steps are the execution history.
 */
export interface WorkflowsTable {
  id: string;
  name: string;
  entity_type: string;
  event_type: string;
  is_active: boolean;
  current_version_id: string | null;
  published_version_id: string | null;
  is_deleted: boolean;
  created_by_id: string | null;
  modified_by_id: string | null;
  created_at: Date;
  modified_at: Date;
}

export interface WorkflowVersionsTable {
  id: string;
  workflow_id: string;
  version: number;
  definition: unknown;
  status: 'draft' | 'published' | 'archived';
  created_by_id: string | null;
  created_at: Date;
  published_at: Date | null;
}

export interface WorkflowRunsTable {
  id: string;
  workflow_id: string;
  version_id: string;
  entity_type: string;
  entity_id: string;
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
  current_node: string | null;
  user_id: string | null;
  error: string | null;
  context: unknown;
  attempt: number;
  started_at: Date;
  finished_at: Date | null;
  created_at: Date;
  modified_at: Date;
}

export interface WorkflowRunStepsTable {
  id: string;
  run_id: string;
  node_id: string;
  node_type: string;
  name: string;
  status: 'running' | 'completed' | 'failed' | 'skipped';
  attempt: number;
  output: unknown;
  error: string | null;
  started_at: Date;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Phase 16 BPM (PLAN §36). Versioned definitions exactly like workflows; an instance is the single
 * token walking the graph, tasks are the human side of it (one row per parked user task, with the
 * resolved assignee and the answer given), and events are the ordered audit trail.
 */
export interface ProcessDefinitionsTable {
  id: string;
  key: string;
  name: string;
  description: string | null;
  entity_type: string;
  is_active: boolean;
  current_version_id: string | null;
  published_version_id: string | null;
  is_deleted: boolean;
  created_by_id: string | null;
  modified_by_id: string | null;
  created_at: Date;
  modified_at: Date;
}

export interface ProcessDefinitionVersionsTable {
  id: string;
  definition_id: string;
  version: number;
  definition: unknown;
  status: 'draft' | 'published' | 'archived';
  created_by_id: string | null;
  created_at: Date;
  published_at: Date | null;
}

export interface ProcessInstancesTable {
  id: string;
  definition_id: string;
  version_id: string;
  entity_type: string;
  entity_id: string;
  status: 'running' | 'waiting' | 'completed' | 'cancelled' | 'failed';
  current_node: string | null;
  context: unknown;
  outcome: string | null;
  error: string | null;
  initiated_by: string | null;
  started_at: Date;
  finished_at: Date | null;
  created_at: Date;
  modified_at: Date;
}

export interface ProcessTasksTable {
  id: string;
  instance_id: string;
  node_id: string;
  name: string;
  status: 'open' | 'overdue' | 'escalated' | 'completed' | 'cancelled';
  assignee_id: string | null;
  assignee_role_id: string | null;
  assignee_spec: unknown;
  due_at: Date | null;
  escalated_at: Date | null;
  outcome: string | null;
  comment: string | null;
  completed_by_id: string | null;
  created_at: Date;
  completed_at: Date | null;
  updated_at: Date;
}

export interface ProcessEventsTable {
  id: string;
  instance_id: string;
  node_id: string | null;
  type: string;
  message: string;
  actor_id: string | null;
  data: unknown;
  /** Ordering column: several events are written in one transaction, where now() is identical. */
  seq: Generated<number>;
  created_at: Date;
}

/**
 * Phase 14 extension installation state (PLAN §38.3). `manifest` keeps the manifest document the
 * package was installed from, so an admin can see what was granted without reading the directory.
 */
export interface InstalledExtensionsTable {
  id: string;
  name: string;
  version: string;
  order_num: number;
  enabled: boolean;
  manifest: unknown;
  installed_at: Date;
  modified_at: Date;
}

/** Per-extension migration ledger; separate from the kernel's `schema_migrations` on purpose. */
export interface ExtensionMigrationsTable {
  extension_id: string;
  name: string;
  applied_at: Date;
}

export interface Database {
  users: UsersTable;
  user_sessions: UserSessionsTable;
  api_users: ApiUsersTable;
  api_keys: ApiKeysTable;
  roles: RolesTable;
  teams: TeamsTable;
  users_roles: UsersRolesTable;
  users_teams: UsersTeamsTable;
  teams_roles: TeamsRolesTable;
  metadata_entries: MetadataEntriesTable;
  app_settings: AppSettingsTable;
  entity_records: EntityRecordsTable;
  entity_links: EntityLinksTable;
  attachments: AttachmentsTable;
  file_uploads: FileUploadsTable;
  email_deliveries: EmailDeliveriesTable;
  email_accounts: EmailAccountsTable;
  audit_log: AuditLogTable;
  stream_items: StreamItemsTable;
  stream_mentions: StreamMentionsTable;
  stream_followers: StreamFollowersTable;
  stream_attachments: StreamAttachmentsTable;
  notifications: NotificationsTable;
  outbox_events: OutboxEventsTable;
  jobs: JobsTable;
  job_logs: JobLogsTable;
  scheduled_jobs: ScheduledJobsTable;
  schema_changes: SchemaChangesTable;
  saved_filters: SavedFiltersTable;
  dashboards: DashboardsTable;
  dashlets: DashletsTable;
  reports: ReportsTable;
  report_schedules: ReportSchedulesTable;
  installed_extensions: InstalledExtensionsTable;
  extension_migrations: ExtensionMigrationsTable;
  workflows: WorkflowsTable;
  workflow_versions: WorkflowVersionsTable;
  workflow_runs: WorkflowRunsTable;
  workflow_run_steps: WorkflowRunStepsTable;
  process_definitions: ProcessDefinitionsTable;
  process_definition_versions: ProcessDefinitionVersionsTable;
  process_instances: ProcessInstancesTable;
  process_tasks: ProcessTasksTable;
  process_events: ProcessEventsTable;
  portals: PortalsTable;
  portal_roles: PortalRolesTable;
  portals_portal_roles: PortalsPortalRolesTable;
  portal_nav_items: PortalNavItemsTable;
  portal_dashboards: PortalDashboardsTable;
  portal_dashlets: PortalDashletsTable;
}

export type Db = Kysely<Database>;
export type DbTx = KyselyTransaction<Database>;

export const DATABASE_TOKEN = Symbol('DATABASE');
export const PG_POOL_TOKEN = Symbol('PG_POOL');

@Injectable()
export class DatabaseService {
  readonly db: Db;
  readonly pool: pg.Pool;

  constructor(@Inject(CONFIG_TOKEN) config: AppConfig) {
    this.pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
    this.db = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: this.pool }),
    });
  }

  async healthy(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    // Kysely's destroy() ends the underlying pg pool.
    await this.db.destroy();
  }
}
