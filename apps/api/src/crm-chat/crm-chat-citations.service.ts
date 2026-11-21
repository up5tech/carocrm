import { Inject, Injectable } from '@nestjs/common';

import { HELP_DOCUMENT_REF_KIND } from '../ai-agents/ai-agent-tools.js';
import { decodeWebSourceRef, WEB_SEARCH_REF_KIND } from '../ai-agents/ai-web-search.js';
import type { AIAgentMessagesTable, CRMChatCitationsTable } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import { DocsService } from '../docs/docs.service.js';
import type { EntityCrudService } from '../entity/entity.service.js';
import { EntityCrudService as EntityService } from '../entity/entity.service.js';

/**
 * Phase 19-CHAT.8 — citation materialisation (plans/PLAN_Phase_19_CRM_Chat.md §7.4, §17 `19-CHAT.8`;
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
 * ## Handbook citations
 *
 * A `help_document:<section>/<slug>` reference is the one citation whose target is not a record. The
 * page is re-read through `DocsService`, so audience filtering and the page's `requires` gate apply
 * exactly as they do on the `/docs` screen; a page the caller cannot read yields no citation.
 *
 * Phase 25.8 adds `web_source:<payload>`: an external page found by the `web_search` tool. Nothing in
 * the installation can re-read it, so the tool records the title, URL and retrieval instant in the
 * reference itself and this service materialises one `approved_external_source` citation per hit. The
 * URL is validated against http(s) on the way in, so a result can never smuggle `javascript:` into a
 * rendered link. A web citation is not ACL-checked on read — it belongs to no record — but it is
 * ordered with the rest and re-authorized through the same endpoint, where the URL is re-validated.
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
  /**
   * 25.8 — the instant the external page was retrieved. An external citation cannot be re-read, so
   * this is the retrieval that the answer rests on; for every other source type it equals
   * `recheckedAt` and means the same thing as before.
   */
  readonly retrievedAt: string;
}

/** The columns a citation materialiser fills; `retrieved_at` is only set for an external source. */
type CitationTarget = Pick<
  CRMChatCitationsTable,
  'source_type' | 'entity' | 'record_id' | 'label' | 'route' | 'retrieved_at'
>;

/** An external route is a URL and needs more room than a built-in `/entity/...` path. */
const MAX_EXTERNAL_ROUTE_CHARS = 1_000;

@Injectable()
export class CRMChatCitationService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(EntityService) private readonly entities: EntityCrudService,
    @Inject(DocsService) private readonly docs: DocsService,
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
      for (const built of await this.buildReference(reference)) {
        rows.push({
          id: `${message.id}:${String(ordinal)}`,
          message_id: message.id,
          conversation_id: message.conversation_id,
          ordinal,
          rechecked_at: new Date(),
          created_at: new Date(),
          ...built,
        });
        ordinal += 1;
      }
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
   * Phase 19-CHAT.28 — citations for a whole page of messages in a bounded number of reads.
   *
   * `forMessage` re-reads one message at a time; a 30-message page would cost one citation query and
   * one Entity Engine read per message. This batch does instead:
   *
   *  1. one `crm_chat_citations` query for every message on the page;
   *  2. one `EntityCrudService.list` per *distinct entity* for every record reference still needing
   *     materialisation (the `id in (…)` criterion keeps it a single store query, ACL predicate
   *     included); handbook references go through `DocsService` once each, bounded by the page's
   *     reference count;
   *  3. one multi-row `INSERT … ON CONFLICT DO NOTHING` for everything materialised;
   *  4. one final `crm_chat_citations` query for the messages that were materialised, so a
   *     concurrent winner's rows are what the caller sees — the same honesty `forMessage` keeps.
   *
   * Entity reads are batched by entity type, never by record: the statement count grows with the
   * number of *kinds* of thing cited, not with the number of messages or references.
   */
  async forMessages(messages: readonly AIAgentMessagesTable[]): Promise<Map<string, CRMChatCitationView[]>> {
    const out = new Map<string, CRMChatCitationView[]>();
    if (messages.length === 0) return out;

    const messageIds = messages.map((message) => message.id);
    const stored = await this.database.db
      .selectFrom('crm_chat_citations')
      .selectAll()
      .where('message_id', 'in', messageIds)
      .orderBy('ordinal', 'asc')
      .execute();
    const storedByMessage = new Map<string, CRMChatCitationsTable[]>();
    for (const row of stored) {
      const list = storedByMessage.get(row.message_id) ?? [];
      list.push(row);
      storedByMessage.set(row.message_id, list);
    }

    const pending = messages.filter((message) => !storedByMessage.has(message.id));
    const refsByMessage = new Map<string, readonly MessageReference[]>();
    const recordIdsByEntity = new Map<string, Set<string>>();
    for (const message of pending) {
      const references = readReferences(message.content_meta);
      refsByMessage.set(message.id, references);
      for (const reference of references) {
        if (reference.kind !== 'record') continue;
        const ids = recordIdsByEntity.get(reference.entity) ?? new Set<string>();
        ids.add(reference.id);
        recordIdsByEntity.set(reference.entity, ids);
      }
    }

    // One ACL-scoped read per entity type covers every record reference on the page. An entity the
    // caller cannot read at all yields no records — the same "revoked → hidden" rule as `get`.
    const records = new Map<string, Record<string, unknown>>();
    for (const [entity, ids] of recordIdsByEntity) {
      try {
        const page = await this.entities.list(entity, {
          where: { type: 'criterion', field: 'id', operator: 'in', value: [...ids] },
          maxSize: ids.size,
          total: false,
        });
        for (const record of page.list) {
          const id = record['id'];
          if (typeof id === 'string') records.set(`${entity}:${id}`, record);
        }
      } catch {
        // Unknown or unreadable entity: every reference to it materialises as no citation.
      }
    }

    const inserts: CRMChatCitationsTable[] = [];
    const materializedMessageIds: string[] = [];
    for (const message of pending) {
      const references = refsByMessage.get(message.id) ?? [];
      if (references.length === 0) {
        out.set(message.id, []);
        continue;
      }
      const rows: CRMChatCitationsTable[] = [];
      let ordinal = 0;
      for (const reference of references) {
        // The batch path shares the per-reference builder except for the record read, which is
        // served from the ACL-checked set above rather than one `get` per reference.
        const built = await this.buildBatchReference(reference, records);
        for (const target of built) {
          rows.push({
            id: `${message.id}:${String(ordinal)}`,
            message_id: message.id,
            conversation_id: message.conversation_id,
            ordinal,
            rechecked_at: new Date(),
            created_at: new Date(),
            ...target,
          });
          ordinal += 1;
        }
      }
      if (rows.length > 0) {
        inserts.push(...rows);
        materializedMessageIds.push(message.id);
      }
      out.set(message.id, []);
    }

    if (inserts.length > 0) {
      await this.database.db
        .insertInto('crm_chat_citations')
        .values(inserts)
        .onConflict((oc) => oc.columns(['message_id', 'ordinal']).doNothing())
        .execute();

      const persisted = await this.database.db
        .selectFrom('crm_chat_citations')
        .selectAll()
        .where('message_id', 'in', materializedMessageIds)
        .orderBy('ordinal', 'asc')
        .execute();
      const persistedByMessage = new Map<string, CRMChatCitationsTable[]>();
      for (const row of persisted) {
        const list = persistedByMessage.get(row.message_id) ?? [];
        list.push(row);
        persistedByMessage.set(row.message_id, list);
      }
      for (const messageId of materializedMessageIds) {
        out.set(messageId, (persistedByMessage.get(messageId) ?? []).map((row) => this.toView(row)));
      }
    }

    for (const [messageId, rows] of storedByMessage) {
      out.set(messageId, rows.map((row) => this.toView(row)));
    }
    return out;
  }

  /** The single-message path: every reference is resolved on its own. */
  private async buildReference(reference: MessageReference): Promise<CitationTarget[]> {
    if (reference.kind === 'web_source') return this.buildWebSources(reference.payload);
    if (reference.kind === 'help_document') {
      const built = await this.buildHelpDocument(reference.key);
      return built === null ? [] : [built];
    }
    const built = await this.buildRecord(reference.entity, reference.id);
    return built === null ? [] : [built];
  }

  /** The batch path: a record reference is answered from the ACL-checked batch read, not a `get`. */
  private async buildBatchReference(
    reference: MessageReference,
    records: ReadonlyMap<string, Record<string, unknown>>,
  ): Promise<CitationTarget[]> {
    if (reference.kind === 'web_source') return this.buildWebSources(reference.payload);
    if (reference.kind === 'help_document') {
      const built = await this.buildHelpDocument(reference.key);
      return built === null ? [] : [built];
    }
    const built = this.buildRecordFrom(records.get(`${reference.entity}:${reference.id}`), reference.entity, reference.id);
    return built === null ? [] : [built];
  }

  /**
   * A record citation from an already ACL-checked batch read, or nothing when the record was not in
   * the readable set — which is exactly the set `entities.list` returned under the caller's rights.
   */
  private buildRecordFrom(
    record: Record<string, unknown> | undefined,
    entity: string,
    id: string,
  ): CitationTarget | null {
    if (record === undefined) return null;
    return {
      source_type: 'crm_record',
      entity,
      record_id: id,
      label: displayLabel(entity, record),
      route: buildRoute(entity, id),
      retrieved_at: null,
    };
  }

  /** A record citation, or nothing when the caller may no longer read the record. */
  private async buildRecord(entity: string, id: string): Promise<CitationTarget | null> {
    const record = await this.entities.get(entity, id).catch(() => null);
    // A record the caller may not read produces no citation at all.
    if (record === null) return null;
    return {
      source_type: 'crm_record',
      entity,
      record_id: id,
      label: displayLabel(entity, record),
      route: buildRoute(entity, id),
      retrieved_at: null,
    };
  }

  /**
   * A handbook citation, or nothing when the page does not exist or the caller's rights no longer reach
   * it. The key comes from the tool's own `result_ref`, never from the model, and the route is rebuilt
   * here from the page the server just re-read.
   */
  private async buildHelpDocument(key: string): Promise<CitationTarget | null> {
    const page = await this.readDocsPage(key);
    if (page === null) return null;
    return {
      source_type: 'help_document',
      entity: null,
      record_id: null,
      label: page.title.slice(0, 200),
      route: `/docs/${page.key}`,
      retrieved_at: null,
    };
  }

  /**
   * Phase 25.8 — the external citations behind one `web_source` reference.
   *
   * The reference carries its own hits, so no network call happens here; the URL and the retrieval
   * instant were validated when the reference was decoded. One reference deliberately yields several
   * citations: a single search returns several sources and the answer may cite any of them.
   */
  private buildWebSources(payload: string): CitationTarget[] {
    return decodeWebSourceRef(payload).map((hit) => ({
      source_type: 'approved_external_source',
      entity: null,
      record_id: null,
      label: hit.title.slice(0, 200),
      route: hit.url,
      retrieved_at: new Date(hit.retrievedAt),
    }));
  }

  /** The page behind a `help_document` reference, re-read under the caller's documentation rights. */
  private async readDocsPage(key: string): Promise<{ title: string; key: string } | null> {
    const [section = '', slug = ''] = key.split('/');
    if (section === '' || slug === '') return null;
    const result = await this.docs.page(section, slug).catch(() => null);
    return result === null || result.kind !== 'page' ? null : result.page;
  }

  /**
   * Re-check a set of citations and report which are still accessible.
   *
   * A citation whose record is no longer readable is reported as inaccessible, and the SPA drops
   * it rather than rendering a label the caller can no longer verify. A handbook citation is
   * re-read through `DocsService`, so a page the caller has lost access to stops linking.
   */
  async reauthorize(
    citations: readonly {
      sourceType: string;
      entity?: string | null | undefined;
      recordId?: string | null | undefined;
      label: string;
      route: string;
    }[],
  ): Promise<readonly { accessible: boolean; label: string | null; route: string | null; reason: string | null }[]> {
    const out: { accessible: boolean; label: string | null; route: string | null; reason: string | null }[] = [];
    for (const citation of citations) {
      if (citation.sourceType === 'help_document') {
        const page = await this.readDocsPage(docKeyOf(citation.route));
        out.push(
          page === null
            ? { accessible: false, label: null, route: null, reason: 'The cited documentation page is no longer available to you.' }
            : { accessible: true, label: page.title.slice(0, 200), route: `/docs/${page.key}`, reason: null },
        );
        continue;
      }
      // 25.8 — an external page has no ACL row to re-read; the URL itself is re-validated, so a
      // citation that somehow arrived with another scheme stops linking instead of becoming a
      // `javascript:` anchor.
      if (citation.sourceType === 'approved_external_source') {
        out.push(
          /^https?:\/\//i.test(citation.route) && citation.route.length <= MAX_EXTERNAL_ROUTE_CHARS
            ? { accessible: true, label: citation.label, route: citation.route, reason: null }
            : { accessible: true, label: citation.label, route: null, reason: null },
        );
        continue;
      }
      if (typeof citation.entity !== 'string' || typeof citation.recordId !== 'string') {
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

  /**
   * The turn's own `sources` list, filtered by the same rule the citations use (G39).
   *
   * `sources` are the raw `result_ref` values the runtime recorded for the successful tool calls, so
   * they are references the answer was built from — not references the reader may still open. Re-reading
   * each one under the caller's *current* rights is the only way this field obeys one rule instead of
   * two: a record that was readable when the answer was given and has since been revoked stops appearing,
   * exactly as its citation would stop being rendered.
   *
   * A reference that names no record — a bare id, or anything that is not `Entity:id` — is kept as it is.
   * There is nothing to look up, so there is nothing to re-authorize, and dropping it would hide a fact
   * the answer already states in its own text.
   */
  async visibleSources(sources: readonly unknown[]): Promise<string[]> {
    const visible: string[] = [];
    for (const entry of sources) {
      if (typeof entry !== 'string' || entry === '') continue;
      const separator = entry.indexOf(':');
      const entity = separator > 0 ? entry.slice(0, separator) : '';
      const id = separator > 0 ? entry.slice(separator + 1) : '';
      // 25.8 — the two reference kinds that are not `Entity:id` are tested first. Both are lowercase,
      // so the `Entity:id` shape guard below would otherwise wave them through unchecked; each is
      // validated on its own terms instead (a page re-read, a payload decoded).
      if (entity === HELP_DOCUMENT_REF_KIND) {
        const page = await this.readDocsPage(id);
        if (page !== null) visible.push(entry);
        continue;
      }
      if (entity === WEB_SEARCH_REF_KIND) {
        if (decodeWebSourceRef(id).length > 0) visible.push(entry);
        continue;
      }
      if (entity === '' || id === '' || !/^[A-Z][A-Za-z0-9_]*$/.test(entity)) {
        visible.push(entry);
        continue;
      }
      const record = await this.entities.get(entity, id).catch(() => null);
      if (record !== null) visible.push(entry);
    }
    return visible;
  }

  /**
   * The runtime's stored `result` with its `sources` re-authorized. Any other shape is returned
   * untouched: this is a projection rule about one field, not a rewrite of the answer.
   */
  async reauthorizedResult(result: unknown): Promise<unknown> {
    if (typeof result !== 'object' || result === null) return result;
    const record = result as Record<string, unknown>;
    if (!Array.isArray(record['sources'])) return result;
    return { ...record, sources: await this.visibleSources(record['sources'] as readonly unknown[]) };
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
      // An external citation was retrieved, not re-checked; when no retrieval was recorded (every
      // other source type), the re-check instant is the honest value for both fields.
      retrievedAt: (row.retrieved_at ?? row.rechecked_at).toISOString(),
    };
  }
}

/** The record and handbook references the runtime wrote onto the assistant message. */
type MessageReference =
  | { readonly kind: 'record'; readonly entity: string; readonly id: string }
  | { readonly kind: 'help_document'; readonly key: string }
  | { readonly kind: 'web_source'; readonly payload: string };

function readReferences(contentMeta: unknown): readonly MessageReference[] {
  if (typeof contentMeta !== 'object' || contentMeta === null) return [];
  const refs = (contentMeta as { refs?: unknown }).refs;
  if (!Array.isArray(refs)) return [];
  const out: MessageReference[] = [];
  for (const entry of refs) {
    if (typeof entry !== 'object' || entry === null) continue;
    const entity = (entry as { entity?: unknown }).entity;
    const id = (entry as { id?: unknown }).id;
    if (typeof entity !== 'string' || entity === '') continue;
    if (typeof id !== 'string' || id === '') continue;
    if (entity === HELP_DOCUMENT_REF_KIND) {
      out.push({ kind: 'help_document', key: id });
      continue;
    }
    // 25.8 — the `id` of a `web_source` reference is its encoded payload, not a record id.
    if (entity === WEB_SEARCH_REF_KIND) {
      out.push({ kind: 'web_source', payload: id });
      continue;
    }
    out.push({ kind: 'record', entity, id });
  }
  return out;
}

/** The key grammar a documentation page uses: `section/slug`, the same key the `/docs` route uses. */
const DOC_KEY_RE = /^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*$/;

/**
 * The handbook key carried by a citation route. A non-record citation must not store `entity` or
 * `record_id`, so the route is the only field that can carry the key — which means it is validated
 * against the key grammar rather than trusted.
 */
function docKeyOf(route: string): string {
  const key = route.replace(/^\/docs\//, '');
  return DOC_KEY_RE.test(key) ? key : '';
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
