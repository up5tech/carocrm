import { Inject, Injectable } from '@nestjs/common';

import { summaryFieldNames } from '../ai-agents/runs/shared.js';
import { READABLE_ENTITIES } from '../ai-agents/tools/schemas.js';
import { EntityCrudService } from '../entity/entity.service.js';
import { METADATA_STORE, type MetadataStoreService } from '../metadata/metadata-store.service.js';

/**
 * Phase 25.9 — the page context: the record the user was looking at when they wrote the message
 * (`plans/PLAN_Phase_25_AI_Capability_Parity.md` §15).
 *
 * Twenty's chatbot understands "this company" and "this opportunity" because the page it was opened
 * from is part of the question. CaroCRM had actor context only. This service is the server half of
 * that feature: the client sends **identifiers** (`{ entity, id }`) and never model text, and the
 * server decides what the model may see.
 *
 * Two rules hold here, and they are the whole point of the feature:
 *
 * 1. **The client never sends content.** It sends the entity type and the record id. Everything the
 *    model reads about that record is read by the server, under the requesting principal, through
 *    the Entity Engine — the same path `crm_read_record` uses.
 * 2. **An unreadable record is dropped, not refused.** A user who lost access to the record they are
 *    looking at still gets an answer; the answer simply does not contain that record, and the caller
 *    is told the context was dropped. The turn itself is never failed for a page the user cannot
 *    read — that would turn a visibility change into a broken chat.
 *
 * The resolution reads a *bounded summary* (the same field set the run prompt uses), so a wide
 * record cannot inflate the prompt, and the label the UI shows is the record's own name — never a
 * client-supplied string.
 */

/** The identifiers the client may send. A reference, never data. */
export interface CRMChatPageContextRef {
  readonly entity: string;
  readonly id: string;
}

/** Why a page context was not used. Both reasons are the same to the caller: no context. */
export type CRMChatPageContextDropReason = 'not_accessible' | 'not_readable_entity';

export interface CRMChatPageContextView {
  /**
   * `applied` — the caller may read the record and it was resolved into the turn.
   * `dropped` — it was not, and the turn continues without it.
   */
  readonly status: 'applied' | 'dropped';
  readonly entity: string;
  readonly id: string;
  /** The record's own name, when the caller may read it. `null` when the context was dropped. */
  readonly label: string | null;
  readonly reason: CRMChatPageContextDropReason | null;
}

/** `crm_read_record` semantics: the same allowlist the read tool uses, so the context can never
 * widen what the assistant may read. */
const READABLE_ENTITY_SET: ReadonlySet<string> = new Set<string>(READABLE_ENTITIES);

/** A label is a display string, not a payload. */
const MAX_LABEL_CHARS = 200;

@Injectable()
export class CRMChatPageContextService {
  constructor(
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(METADATA_STORE) private readonly metadata: MetadataStoreService,
  ) {}

  /**
   * Resolve the page context under the caller's own scope.
   *
   * `entities.get` applies the Entity Engine ACL — entity access *and* record-level scope — so a
   * record the caller may not read fails here and is reported as dropped. The failure is deliberately
   * indistinguishable from "this record does not exist": the endpoint must not become an existence
   * oracle for records the caller cannot see.
   */
  async resolve(ref: CRMChatPageContextRef): Promise<CRMChatPageContextView> {
    const entity = ref.entity.trim();
    const id = ref.id.trim();

    if (!READABLE_ENTITY_SET.has(entity)) {
      return { status: 'dropped', entity, id, label: null, reason: 'not_readable_entity' };
    }

    try {
      // The same bounded field set the run prompt uses. An entity without a single summary field
      // is read whole — the label is the only thing taken from it.
      const fields = summaryFieldNames(this.metadata, entity);
      const record = await this.entities.get(entity, id, fields.length === 0 ? undefined : fields.join(','));
      return { status: 'applied', entity, id, label: recordLabel(record), reason: null };
    } catch {
      // Unreadable, out of scope, deleted or absent: all of them are "no context", never an error
      // that names the record.
      return { status: 'dropped', entity, id, label: null, reason: 'not_accessible' };
    }
  }
}

/** The record's own name, bounded. A record without a usable name simply has no label. */
function recordLabel(record: Record<string, unknown>): string | null {
  const name = record['name'];
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (trimmed === '') return null;
  return trimmed.length > MAX_LABEL_CHARS ? trimmed.slice(0, MAX_LABEL_CHARS) : trimmed;
}
