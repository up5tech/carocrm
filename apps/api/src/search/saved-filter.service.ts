import { AuthorizationDeniedError, NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { generateId } from '@carocrm/core/utils/id.js';
import { Inject, Injectable } from '@nestjs/common';

import { AclApiService } from '../acl/acl-api.service.js';
import { patchOf } from '../common/patch-schema.js';
import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import type { Database } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { ListQuery } from '../entity/entity.service.js';
import { EntityCrudService } from '../entity/entity.service.js';
import type { MetadataStoreService } from '../metadata/metadata-store.service.js';
import { METADATA_STORE } from '../metadata/metadata-store.service.js';
import { safeJson } from './csv.js';
import { ENTITY_NAME, MAX_FILTERS_LIMIT, SavedFilterInputSchema } from './portal-shapes.js';

type FilterRow = Database['saved_filters'] & { id: string };
function view(row: FilterRow): Record<string, unknown> {
  return { id: row.id, name: row.name, entityType: row.entity_type, userId: row.user_id,
    criteria: typeof row.criteria === 'string' ? safeJson(row.criteria) : (row.criteria ?? {}),
    visibility: row.visibility, isShared: row.is_shared,
    createdAt: row.created_at.toISOString(), modifiedAt: row.modified_at.toISOString() };
}
@Injectable()
export class SavedFilterService {
  constructor(@Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(METADATA_STORE) private readonly metadata: MetadataStoreService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope) {}
  assertEntity(entity: string): void {
    this.metadata.ensureLoaded();
    if (!ENTITY_NAME.test(entity) || !this.metadata.registry.hasEntity(entity)) throw new NotFoundError(`Entity "${entity}" does not exist.`);
  }
  canSee(row: { user_id: string | null; visibility: string; is_shared: boolean }): boolean {
    // Phase 18: a portal user only ever sees its own rows — shared internal filters are not
    // part of the portal surface (PLAN §37).
    if (this.scope.userType === 'portal') return row.user_id !== null && row.user_id === this.scope.userId;
    if (this.scope.isAdmin) return true;
    if (row.user_id !== null && row.user_id === this.scope.userId) return true;
    return row.is_shared || row.visibility === 'shared';
  }
  async row(id: string): Promise<FilterRow> {
    const found = await this.database.db.selectFrom('saved_filters').selectAll().where('id', '=', id).executeTakeFirst();
    if (!found) throw new NotFoundError(`Saved filter "${id}" does not exist.`);
    return found as FilterRow;
  }
  async list(entityType?: string): Promise<Record<string, unknown>[]> {
    let q = this.database.db.selectFrom('saved_filters').selectAll().orderBy('name', 'asc').limit(MAX_FILTERS_LIMIT);
    if (entityType) q = q.where('entity_type', '=', entityType);
    return (await q.execute()).filter((r) => this.canSee(r)).map(view);
  }
  async get(id: string): Promise<Record<string, unknown>> {
    const row = await this.row(id);
    if (!this.canSee(row)) throw new NotFoundError(`Saved filter "${id}" does not exist.`);
    return view(row);
  }
  async create(body: unknown): Promise<Record<string, unknown>> {
    const p = SavedFilterInputSchema.safeParse(body ?? {});
    if (!p.success) throw new ValidationError('Invalid saved filter.', { issues: p.error.issues.map((i) => i.message) });
    this.assertEntity(p.data.entityType);
    await this.acl.assertAccess(p.data.entityType, 'read');
    const id = generateId();
    const now = new Date();
    await this.database.db.insertInto('saved_filters').values({ id, name: p.data.name, entity_type: p.data.entityType,
      user_id: this.scope.userId ?? null, criteria: JSON.stringify(p.data.criteria ?? {}),
      visibility: p.data.visibility, is_shared: p.data.visibility === 'shared', created_at: now, modified_at: now }).execute();
    return view(await this.row(id));
  }
  async update(id: string, body: unknown): Promise<Record<string, unknown>> {
    const row = await this.row(id);
    if (!this.scope.isAdmin && row.user_id !== this.scope.userId) throw new AuthorizationDeniedError('Only the filter owner or an administrator may update it.');
    const p = patchOf(SavedFilterInputSchema).safeParse(body ?? {});
    if (!p.success) throw new ValidationError('Invalid saved filter.', { issues: p.error.issues.map((i) => i.message) });
    if (p.data.entityType) this.assertEntity(p.data.entityType);
    await this.database.db.updateTable('saved_filters').set({
      ...(p.data.name !== undefined ? { name: p.data.name } : {}),
      ...(p.data.entityType !== undefined ? { entity_type: p.data.entityType } : {}),
      ...(p.data.criteria !== undefined ? { criteria: JSON.stringify(p.data.criteria) } : {}),
      ...(p.data.visibility !== undefined ? { visibility: p.data.visibility, is_shared: p.data.visibility === 'shared' } : {}),
      modified_at: new Date() }).where('id', '=', id).execute();
    return view(await this.row(id));
  }
  async remove(id: string): Promise<{ id: string; deleted: boolean }> {
    const row = await this.row(id);
    if (!this.scope.isAdmin && row.user_id !== this.scope.userId) throw new AuthorizationDeniedError('Only the filter owner or an administrator may delete it.');
    await this.database.db.deleteFrom('saved_filters').where('id', '=', id).execute();
    return { id, deleted: true };
  }
  async run(id: string, query: ListQuery = {}): Promise<{ filter: Record<string, unknown>; result: unknown }> {
    const row = await this.row(id);
    if (!this.canSee(row)) throw new NotFoundError(`Saved filter "${id}" does not exist.`);
    this.assertEntity(row.entity_type);
    const criteria = typeof row.criteria === 'string' ? safeJson(row.criteria) : (row.criteria ?? {});
    const merged: ListQuery = { ...query };
    if (query.where === undefined) merged.where = criteria as ListQuery['where'];
    else merged.where = [{ and: [criteria, query.where] }];
    return { filter: view(row), result: await this.entities.list(row.entity_type, merged) };
  }
}
