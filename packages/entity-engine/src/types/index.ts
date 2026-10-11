export interface EntityRecord {
  id: string;
  entityType: string;
  createdAt: Date;
  modifiedAt: Date;
  createdById?: string | undefined;
  modifiedById?: string | undefined;
  assignedUserId?: string | undefined;
  deletedAt?: Date | undefined;
  version: number;
  data: Record<string, unknown>;
}

export interface CreateRecordOptions {
  entity: string;
  data: Record<string, unknown>;
  relations?: Record<string, string | string[]>;
  userId?: string | undefined;
}

export interface UpdateRecordOptions {
  entity: string;
  id: string;
  data: Record<string, unknown>;
  relations?: Record<string, string | string[] | null>;
  userId?: string | undefined;
  expectedVersion?: number | undefined;
}

export interface DeleteRecordOptions {
  entity: string;
  id: string;
  userId?: string | undefined;
  softDelete?: boolean | undefined;
}

export interface GetRecordOptions {
  entity: string;
  id: string;
  select?: string[];
}

export interface ListRecordsOptions {
  entity: string;
  where?: Record<string, unknown>;
  orderBy?: Array<{ field: string; direction: 'asc' | 'desc' }>;
  offset?: number | undefined;
  limit?: number | undefined;
  select?: string[];
  includeDeleted?: boolean | undefined;
}

export interface BulkUpdateOptions {
  entity: string;
  where: Record<string, unknown>;
  data: Record<string, unknown>;
  userId?: string | undefined;
}

export interface BulkDeleteOptions {
  entity: string;
  where: Record<string, unknown>;
  userId?: string | undefined;
}

export interface EntityQuery {
  where?: Record<string, unknown>;
  select?: string[];
  orderBy?: Array<{ field: string; direction: 'asc' | 'desc' }>;
  offset?: number | undefined;
  limit?: number | undefined;
  includeDeleted?: boolean | undefined;
}

export interface CreateResult {
  id: string;
  entity: string;
  createdAt: Date;
}

export interface UpdateResult {
  id: string;
  modifiedAt: Date;
  version: number;
}

export interface DeleteResult {
  id: string;
  deleted: boolean;
  deletedAt?: Date | undefined;
}

export interface ListResult<T> {
  list: T[];
  total: number;
  offset: number;
  count: number;
}

/**
 * Hook phases (PLAN §23.1). The list is data, not a closed enum: `HookPhase` is any string, so a
 * module can add a phase as the product needs one, while `HOOK_PHASES` stays the recommended set
 * that the kernel dispatches for entity writes.
 */
export const HOOK_PHASES = [
  'beforeValidate',
  'beforeCreate',
  'beforeUpdate',
  'beforeDelete',
  'beforeSave',
  'afterCreate',
  'whenCreated',
  'whenUpdated',
  'whenDeleted',
  'afterSave',
] as const;

export type KnownHookPhase = (typeof HOOK_PHASES)[number];

export type HookPhase = string;

export interface HookContext {
  entity: string;
  phase: HookPhase;
  record?: EntityRecord | undefined;
  /** State before the mutation, for update/delete phases. */
  previous?: Record<string, unknown> | undefined;
  data?: Record<string, unknown> | undefined;
  userId?: string | undefined;
  operation: 'create' | 'update' | 'delete';
}

export type HookHandler = (context: HookContext) => Promise<void> | void;

/** A handler bound to a phase; what a hook registry hands to the entity manager. */
export interface HookBinding {
  phase: HookPhase;
  handler: HookHandler;
}

export interface TransactionClient {
  commit(): Promise<void>;
  rollback(): Promise<void>;
  getRunner(): unknown;
}