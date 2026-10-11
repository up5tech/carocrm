import { Inject, Injectable } from '@nestjs/common';
import type { Transaction as KyselyTransaction } from 'kysely';
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
  audit_log: AuditLogTable;
  stream_items: StreamItemsTable;
  stream_mentions: StreamMentionsTable;
  stream_followers: StreamFollowersTable;
  stream_attachments: StreamAttachmentsTable;
  notifications: NotificationsTable;
  outbox_events: OutboxEventsTable;
  jobs: JobsTable;
  scheduled_jobs: ScheduledJobsTable;
  schema_changes: SchemaChangesTable;
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
