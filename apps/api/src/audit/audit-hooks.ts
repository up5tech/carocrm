/**
 * Audit seam for the generic entity flow (docs/module-guide.md).
 *
 * The entity module owns `KERNEL_HOOKS_TOKEN` (an `AfterSaveHook[]` value)
 * and invokes every hook inside the mutation transaction after insert or
 * update. Because the entity module is built concurrently, this file does
 * NOT import or re-declare anything from it; instead it exposes a
 * structurally-typed local contract (`AuditHookArgs`, which is assignable
 * to/from the guide's `AfterSaveHook`) plus:
 *
 *   - `registerAuditHook(hooks, auditService)` — pushes an audit hook onto
 *     the integrator's hooks array (call from a factory provider or at
 *     bootstrap: `registerAuditHook(app.get(KERNEL_HOOKS_TOKEN), app.get(AuditHookService))`).
 *   - `AuditSinkService.recordChanges(...)` — the diffing/log writer, also
 *     usable directly (tests, custom flows).
 *
 * Field-audit policy: the integrator supplies an entity-metadata lookup via
 * `AUDIT_METADATA_LOOKUP` returning the per-field definitions
 * (`Record<string, { audited?: boolean }>`). When a lookup returns
 * `undefined` (entity unknown) every differing attrs key is audited;
 * otherwise only fields flagged `audited: true`. The physical
 * `assignedUserId` column is always audited.
 */
import { generateId } from '@carocrm/core/utils/id.js';
import { Inject, Injectable } from '@nestjs/common';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import type { Db, DbTx } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { AfterSaveHookArgs } from '../entity/hooks.js';

/** Lookup of an entity's field definitions; `undefined` when the entity is unknown. */
export type AuditEntityMetadataLookup = (entity: string) => Record<string, { audited?: boolean | undefined }> | undefined;
export const AUDIT_METADATA_LOOKUP = Symbol('AUDIT_METADATA_LOOKUP');

/** Minimum record shape the audit sink understands (subset of EntityRecord). */
export interface AuditableRecord {
  id: string;
  attrs?: Record<string, unknown> | undefined;
  data?: Record<string, unknown> | undefined;
  assignedUserId?: string | null | undefined;
}

/** The entity kernel's AfterSaveHook contract (single source of truth). */
export type AuditHookArgs = AfterSaveHookArgs;

export type AfterSaveHookLike = (args: AuditHookArgs) => Promise<void>;

export interface AuditHookHandler {
  handle(args: AuditHookArgs): Promise<void>;
}

/**
 * Push the audit hook onto the kernel's hook array. Returns the registered
 * function so callers can remove it later if needed.
 */
export function registerAuditHook(hooks: AfterSaveHookLike[], auditService: AuditHookHandler): AfterSaveHookLike {
  const hook: AfterSaveHookLike = (args) => auditService.handle(args);
  hooks.push(hook);
  return hook;
}

export interface RecordChangesArgs {
  entityType: string;
  record: AuditableRecord;
  previous?: Record<string, unknown> | undefined;
  userId?: string | undefined;
  tx?: Db | DbTx | undefined;
}

export interface RecordDeleteArgs {
  entityType: string;
  recordId: string;
  userId?: string | undefined;
  tx?: Db | DbTx | undefined;
}

const REDACTED = '[REDACTED]';
const SENSITIVE_FIELD = /(?:password|secret|token|apikey)/i;
const PHYSICAL_AUDITED_FIELDS: readonly string[] = ['assignedUserId'];

interface AuditLogRow {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

function sameValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): string => JSON.stringify(v === undefined ? null : v) ?? 'null';
  return norm(a) === norm(b);
}

/**
 * Flatten a previous-state source into the audited attribute view.
 * Accepts either a plain attrs map or a record-like object carrying `attrs`.
 */
function attrsView(source: Record<string, unknown>): Record<string, unknown> {
  const nested = source['attrs'];
  const view: Record<string, unknown> =
    typeof nested === 'object' && nested !== null ? { ...(nested as Record<string, unknown>) } : { ...source };
  if ('assignedUserId' in source) {
    const assigned = source['assignedUserId'];
    view['assignedUserId'] = typeof assigned === 'string' ? assigned : null;
  }
  return view;
}

/** Audited view of an entity record (attrs JSONB + physical assignedUserId). */
function recordView(record: AuditableRecord): Record<string, unknown> {
  const view: Record<string, unknown> = { ...(record.attrs ?? record.data ?? {}) };
  if (record.assignedUserId !== undefined) {
    view['assignedUserId'] = record.assignedUserId;
  }
  return view;
}

@Injectable()
export class AuditSinkService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(AUDIT_METADATA_LOOKUP) private readonly metadataLookup: AuditEntityMetadataLookup,
  ) {}

  /**
   * Write audit rows for a create or update.
   * - create (`previous` omitted): one row, `data = { fields: [...names] }`.
   * - update: one row per changed audited field, `data = { field, oldValue, newValue }`.
   * Sensitive values (password/secret/token/apiKey) are redacted.
   * Returns the number of rows written.
   */
  async recordChanges(args: RecordChangesArgs): Promise<number> {
    const tx = args.tx ?? this.database.db;
    const next = recordView(args.record);
    const username = this.scope.principal?.userName ?? null;
    const userId = args.userId ?? this.scope.userId ?? null;
    const created = new Date();

    interface Pending {
      action: 'create' | 'update';
      data: Record<string, unknown>;
    }
    const pending: Pending[] = [];

    if (args.previous === undefined) {
      const fields = Object.keys(next).filter((field) => this.isAudited(args.entityType, field));
      if (fields.length > 0) {
        pending.push({ action: 'create', data: { fields } });
      }
    } else {
      const previous = attrsView(args.previous);
      const keys = Array.from(new Set([...Object.keys(previous), ...Object.keys(next)]));
      for (const field of keys) {
        if (sameValue(previous[field], next[field])) continue;
        if (!this.isAudited(args.entityType, field)) continue;
        const row: AuditLogRow = {
          field,
          oldValue: SENSITIVE_FIELD.test(field) ? REDACTED : (previous[field] ?? null),
          newValue: SENSITIVE_FIELD.test(field) ? REDACTED : (next[field] ?? null),
        };
        pending.push({ action: 'update', data: { ...row } });
      }
    }

    if (pending.length === 0) return 0;

    await tx
      .insertInto('audit_log')
      .values(
        pending.map((entry, index) => ({
          id: generateId(),
          entity_type: args.entityType,
          record_id: args.record.id,
          username,
          user_id: userId,
          action: entry.action,
          order: index,
          data: JSON.stringify(entry.data),
          archived: false,
          created_at: created,
        })),
      )
      .execute();
    return pending.length;
  }

  /** Write a single `delete` audit row for a record. */
  async recordDelete(args: RecordDeleteArgs): Promise<void> {
    const tx = args.tx ?? this.database.db;
    await tx
      .insertInto('audit_log')
      .values({
        id: generateId(),
        entity_type: args.entityType,
        record_id: args.recordId,
        username: this.scope.principal?.userName ?? null,
        user_id: args.userId ?? this.scope.userId ?? null,
        action: 'delete',
        order: 0,
        data: JSON.stringify({ deleted: true }),
        archived: false,
        created_at: new Date(),
      })
      .execute();
  }

  private isAudited(entityType: string, field: string): boolean {
    if (PHYSICAL_AUDITED_FIELDS.includes(field)) return true;
    const definitions = this.metadataLookup(entityType);
    if (definitions === undefined) return true;
    return definitions[field]?.audited === true;
  }
}

/**
 * Adapter matching the kernel `AfterSaveHook` contract; register it with
 * `registerAuditHook(kernelHooks, app.get(AuditHookService))`.
 */
@Injectable()
export class AuditHookService implements AuditHookHandler {
  constructor(@Inject(AuditSinkService) private readonly sink: AuditSinkService) {}

  async handle(args: AuditHookArgs): Promise<void> {
    await this.sink.recordChanges({
      entityType: args.entityType,
      record: {
        id: args.record.id,
        data: args.record.data,
        assignedUserId: args.record.assignedUserId ?? null,
      },
      ...(args.previous !== undefined ? { previous: args.previous } : {}),
      ...(args.userId !== undefined ? { userId: args.userId } : {}),
      ...(args.tx !== undefined ? { tx: args.tx } : {}),
    });
  }
}
