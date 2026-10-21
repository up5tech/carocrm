import { Inject, Injectable } from '@nestjs/common';

import type { AIAgentMessagesTable, CRMChatCitationsTable } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { EntityCrudService } from '../entity/entity.service.js';
import { EntityCrudService as EntityService } from '../entity/entity.service.js';

/**
 * Phase 19-CHAT.8 — citation materialisation (PLAN_Phase_19_CRM_Chat.md §7.4, §17 `19-CHAT.8`;
 * contract §10, §11).
 *
 * ## Where a citation comes from
 *
 * The AIAgents runtime records, for every tool call that resolved a record, a `result_ref` of the
 * form `Entity:id`. When the run finishes, those references become the answer's `sources`, and the
 * runtime writes them onto the assistant message as `content_meta.refs`. That is the **only**
 * source of a citation — the model never writes a label, a route or a target.
 *
 * ## Why Chat re-reads the record
 *
 * A `result_ref` says what the runtime saw *at the time of the tool call*. It says nothing about
 * whether the caller may still read that record now. So Chat re-reads every referenced record
 * through the Entity Engine — the same ACL the caller would meet on a direct read — and only then
 * builds the label and the route. A record the caller may no longer read produces **no citation**;
 * it is not rendered with a stale label and it is not rendered as "forbidden", because the latter
 * would disclose that the record exists.
 *
 * The label and the route are produced here, server-side, from the re-read record. Nothing from the
 * model reaches the rendered citation.
 *
 * ## Why citations are materialised on read
 *
 * The citation row is written the first time the answer is read, not when the run finishes. That
 * keeps the ACL re-check and the row in one place: the row can never describe a record the caller
 * was not allowed to see at the moment the citation was shown. Re-reading a message re-checks
 * nothing that was already materialised, because the `rechecked_at` stamp says when it was checked.
 */
export interface CRMChatCitationView {
  readonly id: string;
  readonly messageId: string;
  readonly sourceType: string;
  readonly entity: string | null;
  readonly recordId: string | null;
  readonly label: string;
  readonly route: string;
  readonly ordinal: number;
  /** When the record was last read under the caller's ACL. */
  readonly recheckedAt: string;
}

@Injectable()
export class CRMChatCitationService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(EntityService) private readonly entities: EntityCrudService,
  ) {}

  /**
   * The citations of one message, materialised on first read.
   *
   * Returns an empty list for a message with no references, for a message that is not the caller's
   * (the caller never gets that far — the conversation service checks ownership first), and for a
   * message whose records are no longer readable.
   */
  async forMessage(message: AIAgentMessagesTable): Promise<CRMChatCitationView[]> {
    const stored = await this.database.db
      .selectFrom('crm_chat_citations')
      .selectAll()
      .where('message_id', '=', message.id)
      .orderBy('ordinal', 'asc')
      .execute();
    if (stored.length > 0) return stored.map((row) => this.toView(row));

    const references = readReferences(message.content_meta);
    if (references.length === 0) return [];

    const rows: CRMChatCitationsTable[] = [];
    let ordinal = 0;
    for (const reference of references) {
      const record = await this.entities.get(reference.entity, reference.id).catch(() => null);
      // A record the caller may not read produces no citation at all.
      if (record === null) continue;
      rows.push({
        id: `${message.id}:${String(ordinal)}`,
        message_id: message.id,
        conversation_id: message.conversation_id,
        source_type: 'crm_record',
        entity: reference.entity,
        record_id: reference.id,
        label: displayLabel(reference.entity, record),
        route: buildRoute(reference.entity, reference.id),
        ordinal,
        rechecked_at: new Date(),
        created_at: new Date(),
      });
      ordinal += 1;
    }
    if (rows.length === 0) return [];

    // The `(message_id, ordinal)` key makes a concurrent materialisation idempotent: the loser of
    // the race keeps the winner's rows instead of failing the read.
    await this.database.db
      .insertInto('crm_chat_citations')
      .values(rows)
      .onConflict((oc) => oc.columns(['message_id', 'ordinal']).doNothing())
      .execute();

    const persisted = await this.database.db
      .selectFrom('crm_chat_citations')
      .selectAll()
      .where('message_id', '=', message.id)
      .orderBy('ordinal', 'asc')
      .execute();
    return persisted.map((row) => this.toView(row));
  }

  /**
   * Re-check a set of citations and report which are still accessible.
   *
   * A citation whose record is no longer readable is reported as inaccessible, and the SPA drops
   * it rather than rendering a label the caller can no longer verify.
   */
  async reauthorize(
    citations: readonly { entity: string | null; recordId: string | null; label: string }[],
  ): Promise<readonly { accessible: boolean; label: string | null; route: string | null; reason: string | null }[]> {
    const out: { accessible: boolean; label: string | null; route: string | null; reason: string | null }[] = [];
    for (const citation of citations) {
      if (citation.entity === null || citation.recordId === null) {
        out.push({ accessible: true, label: citation.label, route: null, reason: null });
        continue;
      }
      const record = await this.entities.get(citation.entity, citation.recordId).catch(() => null);
      if (record === null) {
        out.push({
          accessible: false,
          label: null,
          route: null,
          reason: 'The cited record is no longer available to you.',
        });
        continue;
      }
      out.push({
        accessible: true,
        label: displayLabel(citation.entity, record),
        route: buildRoute(citation.entity, citation.recordId),
        reason: null,
      });
    }
    return out;
  }

  private toView(row: CRMChatCitationsTable): CRMChatCitationView {
    return {
      id: row.id,
      messageId: row.message_id,
      sourceType: row.source_type,
      entity: row.entity,
      recordId: row.record_id,
      label: row.label,
      route: row.route,
      ordinal: row.ordinal,
      recheckedAt: row.rechecked_at.toISOString(),
    };
  }
}

/** The record references the runtime wrote onto the assistant message. */
interface RecordReference {
  readonly entity: string;
  readonly id: string;
}

function readReferences(contentMeta: unknown): readonly RecordReference[] {
  if (typeof contentMeta !== 'object' || contentMeta === null) return [];
  const refs = (contentMeta as { refs?: unknown }).refs;
  if (!Array.isArray(refs)) return [];
  const out: RecordReference[] = [];
  for (const entry of refs) {
    if (typeof entry !== 'object' || entry === null) continue;
    const entity = (entry as { entity?: unknown }).entity;
    const id = (entry as { id?: unknown }).id;
    if (typeof entity !== 'string' || entity === '') continue;
    if (typeof id !== 'string' || id === '') continue;
    out.push({ entity, id });
  }
  return out;
}

/** A readable label for a record, taken from the re-read record itself. */
function displayLabel(entity: string, record: Record<string, unknown>): string {
  const name = record['name'];
  if (typeof name === 'string' && name.trim() !== '') return name.trim().slice(0, 200);
  const first = record['firstName'];
  const last = record['lastName'];
  const composed = [first, last].filter((part) => typeof part === 'string' && part !== '').join(' ');
  if (composed.trim() !== '') return composed.trim().slice(0, 200);
  return `${entity} #${String(record['id'] ?? '')}`.slice(0, 200);
}

/** The route is built server-side from the entity and id, never taken from a client or a model. */
function buildRoute(entity: string, id: string): string {
  return `/entity/${encodeURIComponent(entity)}/${encodeURIComponent(id)}`;
}
