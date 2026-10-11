import { generateId } from '@carocrm/core/utils/id.js';
import { Inject, Injectable } from '@nestjs/common';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import type { Db, DbTx } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { AfterSaveHook, AfterSaveHookArgs } from '../entity/hooks.js';

/** Per-field definitions an entity exposes to the stream policy lookup. */
export type StreamFieldDefinitions = Record<string, { audited?: boolean | undefined } | undefined>;

/** Returns the field definitions of an entity, or `undefined` when unknown. */
export type StreamEntityMetadataLookup = (entity: string) => StreamFieldDefinitions | undefined;

export const STREAM_METADATA_LOOKUP = Symbol('STREAM_METADATA_LOOKUP');

export interface StreamUpdateHookLike {
  (args: AfterSaveHookArgs): Promise<void>;
}

export function registerStreamUpdateHook(hooks: StreamUpdateHookLike[], service: StreamUpdateHookService): StreamUpdateHookLike {
  const hook: StreamUpdateHookLike = (args) => service.handle(args);
  hooks.push(hook);
  return hook;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date || b instanceof Date) {
    const left = a instanceof Date ? a.getTime() : Number.NaN;
    const right = b instanceof Date ? b.getTime() : Number.NaN;
    return left === right;
  }
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every((key) => sameValue(left[key], right[key]));
  }
  return false;
}

/** Bookkeeping columns are audited but must never clutter the stream. */
const STREAM_IGNORED_FIELDS = new Set(['createdAt', 'modifiedAt', 'deletedAt', 'id', 'version']);

/**
 * Turns configured field changes into `Update` stream items (PLAN §26 "record updates
 * where configured"). EspoCRM drives this from the per-field `audited` option — the same
 * flag feeds the audit log — and always reports the assignee, so both are honoured here.
 */
@Injectable()
export class StreamUpdateHookService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(STREAM_METADATA_LOOKUP) private readonly lookup: StreamEntityMetadataLookup,
  ) {}

  async handle(args: AfterSaveHookArgs): Promise<void> {
    const previous = args.previous;
    if (!previous) return; // creations are not "updates"
    const fields = this.lookup(args.entityType);
    if (!fields) return;
    const watched = Object.entries(args.record.data).filter(
      ([name]) => !STREAM_IGNORED_FIELDS.has(name) && fields[name]?.audited === true,
    );

    const attributes: Array<{ name: string; value: unknown }> = [];
    for (const [name, value] of watched) {
      // an absent key and an explicit null are the same state for a record field
      if (sameValue(previous[name] ?? null, value ?? null)) continue;
      attributes.push({ name, value: value instanceof Date ? value.toISOString() : (value ?? null) });
    }
    if (!sameValue(previous['assignedUserId'] ?? null, args.record.assignedUserId ?? null)) {
      attributes.push({ name: 'assignedUserId', value: args.record.assignedUserId ?? null });
    }
    if (attributes.length === 0) return;

    const actorId = args.userId ?? this.scope.userId ?? null;
    const now = new Date();
    const executor: Db | DbTx = args.tx ?? this.database.db;
    await executor
      .insertInto('stream_items')
      .values({
        id: generateId(),
        entity_type: args.entityType,
        entity_id: args.record.id,
        type: 'Update',
        data: { type: 'Updated', attributes },
        post: null,
        created_by_id: actorId,
        created_at: now,
        modified_at: now,
        is_deleted: false,
      })
      .execute();
  }
}

export type { AfterSaveHook };
