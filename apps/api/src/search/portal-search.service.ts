/**
 * Phase 12 service (part 1): global search + entity search (PLAN §30).
 *
 * Reads go through the generic `EntityCrudService`, so entity/record/field ACL, audit/stream
 * hooks and dynamic logic apply exactly as on any list. Search lets the query engine validate every
 * field/operator, then ORs an exact id match with substring `like` on `name` and the contact keys —
 * precisely the expressions migration 009 gives a trigram index, which is what keeps 100k+ record
 * tables index-driven (one unindexed key in a disjunction would force a seq scan). Widening the
 * searched field set requires adding that key to SEARCH_INDEXED_ATTRS and indexing it.
 */
import { NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { AclApiService } from '../acl/acl-api.service.js';
import type { ListQuery } from '../entity/entity.service.js';
import { EntityCrudService } from '../entity/entity.service.js';
import type { MetadataStoreService } from '../metadata/metadata-store.service.js';
import { METADATA_STORE } from '../metadata/metadata-store.service.js';
import type { SearchHit } from './portal-shapes.js';
import { ENTITY_NAME, MAX_GLOBAL_ENTITIES, MAX_PER_ENTITY, MAX_SEARCH_TEXT, SEARCH_INDEXED_ATTRS, TEXTISH_TYPES } from './portal-shapes.js';

function parsePositiveInt(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

@Injectable()
export class PortalSearchService {
  constructor(
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(METADATA_STORE) private readonly metadata: MetadataStoreService,
    @Inject(AclApiService) private readonly acl: AclApiService,
  ) {}

  requireText(text: string | undefined): string {
    const cleaned = (text ?? '').trim();
    if (cleaned === '') throw new ValidationError('A search query "q" is required.');
    if (cleaned.length > MAX_SEARCH_TEXT) {
      throw new ValidationError(`Search query must be at most ${String(MAX_SEARCH_TEXT)} characters.`);
    }
    return cleaned;
  }

  assertEntity(entity: string): void {
    this.metadata.ensureLoaded();
    if (!ENTITY_NAME.test(entity) || !this.metadata.registry.hasEntity(entity)) {
      throw new NotFoundError(`Entity "${entity}" does not exist.`);
    }
  }

  /** Entities the caller may read, in metadata order (admin sees all enabled entities). */
  readableEntities(requested?: string[]): string[] {
    const names = requested && requested.length > 0 ? requested : this.metadata.registry.getEnabledEntities();
    return [...new Set(names)].slice(0, MAX_GLOBAL_ENTITIES);
  }

  /**
   * Fields the substring OR covers: `name` plus the contact keys that have a trigram index (009).
   * A disjunction with even one unindexed key makes PostgreSQL seq-scan the whole table, so the
   * set is deliberately narrow and index-backed; wider coverage needs an index per key.
   */
  searchableFields(entity: string): string[] {
    const fields = this.metadata.registry.getFields(entity);
    const out: string[] = [];
    if (fields['name'] !== undefined) out.push('name');
    for (const key of SEARCH_INDEXED_ATTRS) {
      const def = fields[key];
      if (def !== undefined && TEXTISH_TYPES.has(def.type)) out.push(key);
    }
    return out;
  }

  /** One OR group across the entity: exact id, then substring on every text-ish field. */
  textWhere(entity: string, text: string): Record<string, unknown>[] {
    return [{
      or: [
        // Id is a btree-only column: match it whole instead of substring, which stays index-usable.
        { field: 'id', operator: 'equals', value: text },
        ...this.searchableFields(entity).map((field) => ({ field, operator: 'like', value: text })),
      ],
    }];
  }

  async globalSearch(input: { q?: string | undefined; entities?: string | undefined; limit?: string | undefined; offset?: string | undefined }): Promise<{
    query: string;
    total: number;
    offset: number;
    count: number;
    list: SearchHit[];
  }> {
    const q = this.requireText(input.q);
    const requested =
      input.entities
        ?.split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '') ?? [];
    for (const entity of requested) this.assertEntity(entity);
    const entities = this.readableEntities(requested.length > 0 ? requested : undefined);
    const perEntity = parsePositiveInt(input.limit, 5, 1, MAX_PER_ENTITY);
    const offset = parsePositiveInt(input.offset, 0, 0, 100_000);

    const hits: SearchHit[] = [];
    for (const entity of entities) {
      // Skip unreadable entities silently: global search must not leak which entities exist.
      if ((await this.acl.canUser(entity, 'read')) === 'no') continue;
      try {
        const result = await this.entities.list(entity, { where: this.textWhere(entity, q), maxSize: perEntity, total: false });
        for (const record of result.list) hits.push({ entityType: entity, record });
      } catch {
        // Unknown entity or no searchable fields — skip rather than fail the whole search.
        continue;
      }
      if (hits.length >= MAX_PER_ENTITY * 4) break;
    }
    const page = hits.slice(offset, offset + perEntity * 2);
    return { query: q, total: hits.length, offset, count: page.length, list: page };
  }

  async entitySearch(
    entity: string,
    input: { q?: string | undefined; where?: unknown; orderBy?: string | undefined; maxSize?: unknown; offset?: unknown },
  ): Promise<{ list: Record<string, unknown>[]; total?: number; offset: number; count: number }> {
    this.assertEntity(entity);
    const q = input.q !== undefined ? this.requireText(String(input.q)) : undefined;
    const query: ListQuery = {
      ...(input.where !== undefined ? { where: input.where } : {}),
      ...(input.orderBy !== undefined ? { orderBy: input.orderBy } : {}),
      ...(input.maxSize !== undefined ? { maxSize: input.maxSize } : {}),
      ...(input.offset !== undefined ? { offset: input.offset } : {}),
    };
    if (q !== undefined) {
      const extra = this.textWhere(entity, q);
      const existing = query.where;
      query.where = existing === undefined ? extra : [{ and: [existing, { or: extra[0] }] }];
    }
    return this.entities.list(entity, query);
  }
}
