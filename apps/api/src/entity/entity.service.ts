import {
  ConcurrencyConflictError,
  NotFoundError,
  RecordNotFoundError,
  ValidationError,
} from '@carocrm/core/errors/index.js';
import { EntityManager } from '@carocrm/entity-engine/entity-manager/index.js';
import type { EntityRecord } from '@carocrm/entity-engine/types/index.js';
import type { FieldDefinition } from '@carocrm/metadata/schemas/index.js';
import type { TranslatedQuery } from '@carocrm/query-engine/index.js';
import { parseQueryRequest } from '@carocrm/query-engine/index.js';
import { Inject, Injectable } from '@nestjs/common';

import type { AclPredicate } from '../acl/acl-api.service.js';
import { AclApiService } from '../acl/acl-api.service.js';
import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import { HookRegistry } from '../hooks/hook.registry.js';
import { RecordLogicService } from '../logic/record-logic.service.js';
import type { MetadataStoreService } from '../metadata/metadata-store.service.js';
import { METADATA_STORE } from '../metadata/metadata-store.service.js';
import type { PostgresRecordStore, StoreFindAnyOf, StoreReportAggregateResult, StoreReportRelation } from './entity-record.store.js';
import { ENTITY_STORE } from './entity-record.store.js';

/** PLAN §16.2 list envelope always carries `total`; `?total=false` opts out (cheap lists). */
function wantsTotal(query: ListQuery): boolean {
  const value = query.total;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return !(value.toLowerCase() === 'false' || value === '0');
  return true;
}

export interface ListQuery {
  where?: unknown;
  select?: unknown;
  orderBy?: unknown;
  order?: unknown;
  offset?: unknown;
  maxSize?: unknown;
  limit?: unknown;
  total?: unknown;
}

export interface EntityAggregateQuery {
  where?: unknown;
  dimensions: { field: string; fieldType: string; grain?: 'day' | 'month' | 'year'; relation?: StoreReportRelation }[];
  metrics: { name: string; operation: 'count' | 'sum' | 'avg' | 'min' | 'max'; field?: string; fieldType?: string; relation?: StoreReportRelation }[];
  maxGroups: number;
}

export interface ListEnvelope {
  readonly list: Record<string, unknown>[];
  readonly total?: number;
  readonly offset: number;
  readonly count: number;
}

export interface RecordMutation {
  readonly entity: string;
  readonly id: string;
}

const LINK_SINGLE_TYPES: ReadonlySet<string> = new Set(['link', 'linkOne', 'foreign']);
const LINK_MULTIPLE_TYPES: ReadonlySet<string> = new Set(['linkMultiple', 'attachmentMultiple']);
/**
 * Link targets that live in the identity tables rather than `entity_records`. Their read
 * endpoints are administrator-only, so label resolution mirrors that gate instead of the
 * metadata ACL (which has no definition for them).
 */
const IDENTITY_LINK_TARGETS: ReadonlySet<string> = new Set(['User', 'Team']);
const PHYSICAL_RESIDENT: ReadonlySet<string> = new Set([
  'id',
  'name',
  'createdAt',
  'modifiedAt',
  'assignedUserId',
  'createdById',
  'modifiedById',
  'deletedAt',
  'deleted',
  'teams',
  'version',
]);
const IMMUTABLE_INPUT: ReadonlySet<string> = new Set(['entityType', 'entity_type', 'createdById', 'modifiedById', 'deletedAt', 'deleted']);

@Injectable()
export class EntityCrudService {
  constructor(
    @Inject(ENTITY_STORE) private readonly store: PostgresRecordStore,
    @Inject(METADATA_STORE) private readonly metadata: MetadataStoreService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(HookRegistry) private readonly hooks: HookRegistry,
    @Inject(RecordLogicService) private readonly logic: RecordLogicService,
  ) {}

  // -------------------------------------------------------------------------
  // reads
  // -------------------------------------------------------------------------

  async list(entity: string, query: ListQuery = {}): Promise<ListEnvelope> {
    this.assertEntity(entity);
    await this.acl.assertAccess(entity, 'read');
    const translated = this.translate(entity, query);
    const acl = await this.acl.recordPredicate(entity, 'read');
    const countTotal = wantsTotal(query);
    const result = await this.store.findMany(entity, { translated, acl, countTotal });
    const list = await this.serializeMany(entity, result.list, translated.select);
    return {
      list,
      offset: result.offset,
      count: result.count,
      ...(countTotal ? { total: result.total } : {}),
    };
  }

  /** Aggregate through the same validated Query Engine and record ACL predicate as list reads. */
  async aggregate(entity: string, query: EntityAggregateQuery): Promise<StoreReportAggregateResult> {
    this.assertEntity(entity);
    await this.acl.assertAccess(entity, 'read');
    const translated = this.translate(entity, { where: query.where });
    const acl = await this.acl.recordPredicate(entity, 'read');
    return this.store.aggregateReport(entity, {
      translated,
      acl,
      dimensions: query.dimensions,
      metrics: query.metrics,
      maxGroups: query.maxGroups,
    });
  }

  async get(entity: string, id: string, select?: string): Promise<Record<string, unknown>> {
    this.assertEntity(entity);
    await this.acl.assertAccess(entity, 'read');
    const record = await this.loadScoped(entity, 'read', id);
    const projection = select !== undefined ? this.translate(entity, { select }).select : undefined;
    const dto = await this.serialize(entity, record, projection);
    await this.attachLinkLabels([dto], this.linkTargetsOf(entity));
    return dto;
  }

  /**
   * Related records of a parent, resolved through metadata relations.
   * Children are matched by their link attribute (single or multiple) **or** by explicit
   * `entity_links` rows written through the link endpoints.
   *
   * The two sources are one predicate, not two reads stitched together: `offset`, `maxSize` and
   * `total` then describe the relation itself, so page 2 of a panel is page 2 of the relation and
   * a record reachable both ways is listed (and counted) once.
   */
  async related(entity: string, id: string, relationName: string, query: ListQuery = {}): Promise<ListEnvelope> {
    this.assertEntity(entity);
    await this.acl.assertAccess(entity, 'read');
    await this.loadScoped(entity, 'read', id);

    const relation = this.metadata.registry.getRelation(entity, relationName);
    if (!relation?.target) {
      throw new ValidationError(`Unknown relation "${relationName}" for entity "${entity}".`, { entity, relation: relationName });
    }
    const target = relation.target;
    this.assertEntity(target);
    await this.acl.assertAccess(target, 'read');
    const translated = this.translate(target, query);
    const acl = await this.acl.recordPredicate(target, 'read');

    const attrMatch = this.attrMatchFor(entity, target, relationName, relation.mappedBy);
    const linkedIds = await this.store.linkedRecordIds(entity, id, relationName, target);
    const anyOf: StoreFindAnyOf = {
      ...(attrMatch === undefined
        ? {}
        : attrMatch.multiple
          ? { attrsContains: [{ field: attrMatch.field, value: id }] }
          : { attrsEquals: [{ field: attrMatch.field, value: id }] }),
      ids: linkedIds,
    };

    const countTotal = wantsTotal(query);
    const result = await this.store.findMany(target, { translated, acl, anyOf, countTotal });
    const list = await this.serializeMany(target, result.list, translated.select);
    return {
      list,
      offset: result.offset,
      count: list.length,
      ...(countTotal ? { total: result.total } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // writes
  // -------------------------------------------------------------------------

  async create(entity: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.assertEntity(entity);
    await this.acl.assertAccess(entity, 'create');
    // record scoping is driven by the read level ( EspoCRM: create "yes" + read "own")
    const scopeLevel = await this.acl.canUser(entity, 'read');
    const data = await this.prepareWrite(entity, body, scopeLevel);
    const withLogic = this.logic.apply({ entity, data, supplied: data });

    const record = await this.em.create({
      entity,
      data: this.withName(entity, withLogic),
      ...(this.scope.userId !== undefined ? { userId: this.scope.userId } : {}),
    });
    return this.serialize(entity, record);
  }

  async update(entity: string, id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.assertEntity(entity);
    await this.acl.assertAccess(entity, 'edit');
    const existing = await this.loadScoped(entity, 'edit', id);
    const scopeLevel = await this.acl.canUser(entity, 'edit');
    const data = await this.prepareWrite(entity, body, scopeLevel, existing);

    const expectedVersion = readVersion(body['version']);
    if (expectedVersion !== undefined && expectedVersion !== existing.version) {
      throw new ConcurrencyConflictError(entity, id);
    }

    // Dynamic logic and formulas are evaluated against the record as it would be stored.
    const withLogic = this.logic.apply({ entity, data: { ...existing.data, ...data }, supplied: data, previous: existing.data });

    const record = await this.em.update({
      entity,
      id,
      data: this.withName(entity, withLogic, existing),
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
      ...(this.scope.userId !== undefined ? { userId: this.scope.userId } : {}),
    });
    return this.serialize(entity, record);
  }

  async remove(entity: string, id: string): Promise<{ status: boolean }> {
    this.assertEntity(entity);
    await this.acl.assertAccess(entity, 'delete');
    await this.loadScoped(entity, 'delete', id);

    const definition = this.metadata.registry.getEntity(entity);
    if (definition && definition.record.removable === false) {
      throw new ValidationError(`Records of "${entity}" cannot be deleted.`, { entity, id });
    }

    await this.em.delete({
      entity,
      id,
      softDelete: true,
      ...(this.scope.userId !== undefined ? { userId: this.scope.userId } : {}),
    });
    return { status: true };
  }

  async restore(entity: string, id: string): Promise<Record<string, unknown>> {
    this.assertEntity(entity);
    await this.acl.assertAccess(entity, 'delete');
    const predicate = await this.acl.recordPredicate(entity, 'delete');
    const record = await this.store.findByIdIncludingDeleted(entity, id);
    if (!record) throw new RecordNotFoundError(entity, id);
    if (!(await this.matchesPredicate('delete', predicate, record))) throw new RecordNotFoundError(entity, id);

    const restored = await this.store.restore(entity, id);
    if (!restored) throw new RecordNotFoundError(entity, id);
    const fresh = await this.store.findById(entity, id);
    if (!fresh) throw new RecordNotFoundError(entity, id);
    return this.serialize(entity, fresh);
  }

  async massUpdate(entity: string, ids: readonly string[], data: Record<string, unknown>): Promise<{ count: number; ids: string[] }> {
    this.assertEntity(entity);
    await this.acl.assertAccess(entity, 'edit');
    await this.acl.assertFieldWrites(entity, data);
    const updated: string[] = [];
    for (const id of ids) {
      try {
        await this.update(entity, id, data);
        updated.push(id);
      } catch (error) {
        if (error instanceof RecordNotFoundError) continue;
        throw error;
      }
    }
    return { count: updated.length, ids: updated };
  }

  async massDelete(entity: string, ids: readonly string[]): Promise<{ count: number; ids: string[] }> {
    this.assertEntity(entity);
    await this.acl.assertAccess(entity, 'delete');
    const removed: string[] = [];
    for (const id of ids) {
      try {
        await this.remove(entity, id);
        removed.push(id);
      } catch (error) {
        if (error instanceof RecordNotFoundError) continue;
        throw error;
      }
    }
    return { count: removed.length, ids: removed };
  }

  /** Explicit relation link (PUT /:entity/:id/:relation/:relatedId). */
  async link(entity: string, id: string, relationName: string, relatedId: string): Promise<{ status: boolean }> {
    const { target } = await this.assertRelationWrite(entity, id, relationName);
    const related = await this.store.findById(target, relatedId);
    if (!related) throw new RecordNotFoundError(target, relatedId);

    await this.store.linkRecord({
      entityTypeA: entity,
      recordIdA: id,
      relationName,
      entityTypeB: target,
      recordIdB: relatedId,
    });
    await this.syncAttrLink(entity, id, target, related, false);
    return { status: true };
  }

  async unlink(entity: string, id: string, relationName: string, relatedId: string): Promise<{ status: boolean }> {
    const { target } = await this.assertRelationWrite(entity, id, relationName);
    await this.store.unlinkRecord({ entityTypeA: entity, recordIdA: id, relationName, recordIdB: relatedId });
    const related = await this.store.findById(target, relatedId);
    if (related) await this.syncAttrLink(entity, id, target, related, true);
    return { status: true };
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /**
   * Built per mutation on purpose: the hook registry can gain a handler between two requests, and a
   * cached manager would keep serving the snapshot it was created with.
   */
  private get em(): EntityManager {
    return new EntityManager(this.store, this.metadata.registry, this.hooks.bindings());
  }

  private assertEntity(entity: string): void {
    this.metadata.ensureLoaded();
    if (!/^[A-Z][A-Za-z0-9]{1,49}$/.test(entity) || !this.metadata.registry.hasEntity(entity)) {
      throw new NotFoundError(`Entity "${entity}" does not exist.`);
    }
  }

  private translate(entity: string, query: ListQuery): TranslatedQuery {
    return parseQueryRequest(
      {
        entity,
        ...(query.where !== undefined ? { where: query.where } : {}),
        ...(query.select !== undefined ? { select: query.select } : {}),
        ...(query.orderBy !== undefined ? { orderBy: query.orderBy } : {}),
        ...(query.order !== undefined ? { order: query.order } : {}),
        ...(query.offset !== undefined ? { offset: query.offset } : {}),
        ...(query.maxSize !== undefined ? { maxSize: query.maxSize } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
      },
      this.metadata.registry,
    );
  }

  /** Loads a record and enforces the record-scope predicate (out of scope -> 404). */
  private async loadScoped(entity: string, action: 'read' | 'edit' | 'delete', id: string): Promise<EntityRecord> {
    const predicate = await this.acl.recordPredicate(entity, action);
    const record = await this.store.findById(entity, id);
    if (!record) throw new RecordNotFoundError(entity, id);
    if (!(await this.matchesPredicate(action, predicate, record))) throw new RecordNotFoundError(entity, id);
    return record;
  }

  private async matchesPredicate(action: 'read' | 'edit' | 'delete', predicate: AclPredicate, record: EntityRecord): Promise<boolean> {
    if (predicate.kind === 'allowAll') return true;
    if (predicate.kind === 'denyAll') return false;
    // Phase 18: portal visibility is decided from the loaded record, never from the generic
    // own/team evaluator, so list and by-id reads agree.
    if (predicate.kind === 'portal') {
      return this.acl.portalRecordVisible(record.entityType, record.id, record.data);
    }
    // Phase 19: project membership and role, decided by the same rule as the list SQL.
    if (predicate.kind === 'projectScoped') {
      return this.acl.projectScopedAllows(predicate, record.id, record.data);
    }
    return (await this.acl.canAccessRecord(record.entityType, action, record.data)).allowed === true;
  }

  private async assertRelationWrite(entity: string, id: string, relationName: string): Promise<{ target: string }> {
    this.assertEntity(entity);
    await this.acl.assertAccess(entity, 'edit');
    await this.loadScoped(entity, 'edit', id);
    const relation = this.metadata.registry.getRelation(entity, relationName);
    if (!relation?.target) {
      throw new ValidationError(`Unknown relation "${relationName}" for entity "${entity}".`, { entity, relation: relationName });
    }
    this.assertEntity(relation.target);
    await this.acl.assertAccess(relation.target, 'edit');
    return { target: relation.target };
  }

  /**
   * Normalises an incoming payload: drops immutable/system keys, enforces field
   * level ACL, keeps own/team scoping honest and validates link targets.
   */
  private async prepareWrite(
    entity: string,
    body: Record<string, unknown>,
    scopeLevel: string,
    existing?: EntityRecord,
  ): Promise<Record<string, unknown>> {
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (IMMUTABLE_INPUT.has(key)) continue;
      data[key] = value;
    }
    await this.acl.assertFieldWrites(entity, data);

    const fields = this.metadata.registry.getFields(entity);
    for (const key of Object.keys(data)) {
      if (key === 'id') continue;
      if (fields[key]) continue;
      if (PHYSICAL_RESIDENT.has(key)) continue;
      delete data[key];
    }

    for (const key of ['createdAt', 'modifiedAt']) {
      const value = data[key];
      if (value === undefined) continue;
      const parsed = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : undefined;
      if (parsed && !Number.isNaN(parsed.getTime())) data[key] = parsed;
      else delete data[key];
    }
    for (const [name, def] of Object.entries(fields)) {
      if (def.type !== 'date' && def.type !== 'datetime') continue;
      const value = data[name];
      if (typeof value !== 'string') continue;
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) data[name] = parsed;
    }

    if (scopeLevel === 'own' || scopeLevel === 'team') {
      const userId = this.scope.userId;
      const assigned = typeof data['assignedUserId'] === 'string' ? data['assignedUserId'] : undefined;
      if (assigned && assigned !== userId && (existing?.assignedUserId === undefined || assigned !== existing.assignedUserId)) {
        throw new ValidationError('Records of this entity can only be assigned to yourself.', { entity, field: 'assignedUserId' });
      }
      if (existing && assigned === undefined && existing.assignedUserId === userId) data['assignedUserId'] = userId;
      if (!existing) data['assignedUserId'] = assigned ?? userId ?? null;
      if (data['teams'] === undefined && scopeLevel === 'team') data['teams'] = this.scope.teamIds();
    }

    await this.validateLinks(entity, data);
    return data;
  }

  private async validateLinks(entity: string, data: Record<string, unknown>): Promise<void> {
    for (const [name, def] of Object.entries(this.metadata.registry.getFields(entity))) {
      if (!isLinkField(def)) continue;
      if (PHYSICAL_RESIDENT.has(name)) continue;
      const targetEntity = def.entityKey;
      if (!targetEntity || !this.metadata.registry.hasEntity(targetEntity)) continue;
      const value = data[name];
      if (value === undefined || value === null || value === '') continue;

      const ids = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [String(value)];
      for (const id of ids) {
        if (id === '') continue;
        const found = await this.store.findById(targetEntity, id);
        if (!found) {
          throw new ValidationError(`Linked record "${id}" of entity "${targetEntity}" does not exist.`, { entity, field: name, id });
        }
      }
    }
  }

  /** `name` mirrors the metadata display field, falling back to the supplied name. */
  private withName(entity: string, data: Record<string, unknown>, existing?: EntityRecord): Record<string, unknown> {
    const displayField = this.metadata.registry.getEntity(entity)?.record.displayField;
    const candidate = displayField ? data[displayField] : undefined;
    if (typeof candidate === 'string' && candidate !== '') return { ...data, name: candidate };
    if (data['name'] === undefined && existing) {
      const previous = existing.data['name'];
      if (typeof previous === 'string') return { ...data, name: previous };
    }
    return data;
  }

  /** Keeps the child's link attribute in sync with explicit `entity_links` rows. */
  private async syncAttrLink(
    parentEntity: string,
    parentId: string,
    childEntity: string,
    child: EntityRecord,
    remove: boolean,
  ): Promise<void> {
    const match = this.attrMatchFor(parentEntity, childEntity, '', undefined);
    if (!match || match.multiple) return;
    const current = child.data[match.field];
    if (!remove && current === parentId) return;
    if (remove && current !== parentId) return;

    const data: Record<string, unknown> = { [match.field]: remove ? null : parentId };
    await this.em.update({
      entity: childEntity,
      id: child.id,
      data,
      expectedVersion: child.version,
      ...(this.scope.userId !== undefined ? { userId: this.scope.userId } : {}),
    });
  }

  /**
   * Finds the target-side attribute that stores the parent id: prefers the field
   * named after `mappedBy`/the relation, otherwise any link field pointing back at
   * the parent entity.
   */
  private attrMatchFor(parentEntity: string, targetEntity: string, relationName: string, mappedBy?: string): { field: string; multiple: boolean } | undefined {
    const fields = this.metadata.registry.getFields(targetEntity);
    const candidates = [
      mappedBy ? `${mappedBy}Id` : undefined,
      mappedBy,
      relationName ? `${relationName.replace(/ies$/, 'y').replace(/s$/, '')}Id` : undefined,
    ].filter((name): name is string => typeof name === 'string' && name !== '');

    for (const name of candidates) {
      const def = fields[name];
      if (def && isLinkField(def) && def.entityKey === parentEntity) {
        return { field: name, multiple: LINK_MULTIPLE_TYPES.has(def.type) };
      }
    }
    for (const [name, def] of Object.entries(fields)) {
      if (PHYSICAL_RESIDENT.has(name)) continue;
      if (isLinkField(def) && def.entityKey === parentEntity) {
        return { field: name, multiple: LINK_MULTIPLE_TYPES.has(def.type) };
      }
    }
    return undefined;
  }

  private async serialize(
    entity: string,
    record: EntityRecord,
    select?: readonly string[] | undefined,
  ): Promise<Record<string, unknown>> {
    const dto: Record<string, unknown> = { ...record.data };
    dto['id'] = record.id;
    dto['createdAt'] = toIso(record.data['createdAt'] ?? record.createdAt);
    dto['modifiedAt'] = toIso(record.data['modifiedAt'] ?? record.modifiedAt);
    if (record.deletedAt) dto['deletedAt'] = record.deletedAt.toISOString();
    dto['assignedUserId'] = record.assignedUserId ?? null;
    dto['createdById'] = record.createdById ?? null;
    dto['modifiedById'] = record.modifiedById ?? null;
    dto['teams'] = Array.isArray(record.data['teams']) ? record.data['teams'] : [];
    dto['name'] = typeof record.data['name'] === 'string' ? record.data['name'] : null;
    dto['version'] = record.version;

    if (select && select.length > 0) {
      const allowed = new Set(select);
      for (const key of Object.keys(dto)) {
        if (key === 'id' || key === 'name') continue;
        if (!allowed.has(key)) delete dto[key];
      }
    }
    return this.acl.stripRestricted(entity, dto);
  }

  private async serializeMany(
    entity: string,
    records: readonly EntityRecord[],
    select?: readonly string[] | undefined,
  ): Promise<Record<string, unknown>[]> {
    const dtos = await Promise.all(records.map((record) => this.serialize(entity, record, select)));
    await this.attachLinkLabels(dtos, this.linkTargetsOf(entity));
    return dtos;
  }

  /** Link fields of an entity and the entity each points at, as `attachLinkLabels` expects. */
  private linkTargetsOf(entity: string): Record<string, string> {
    const links: Record<string, string> = {};
    for (const [name, def] of Object.entries(this.metadata.registry.getFields(entity))) {
      if (!isLinkField(def)) continue;
      const target = def.entityKey;
      if (!target || !this.isLabelTarget(target)) continue;
      links[name] = target;
    }
    return links;
  }

  private isLabelTarget(target: string): boolean {
    return this.metadata.registry.hasEntity(target) || IDENTITY_LINK_TARGETS.has(target);
  }

  /**
   * Adds `_linkLabels` (row key → target id → display label) to a batch of response rows.
   *
   * `links` maps a row key to the entity its ids reference, so both generic record pages and
   * module-specific panels (workload, lifecycle history) can resolve their link columns the same
   * way. Labels are resolved once per target entity for the whole batch, under that entity's read
   * ACL: a target the caller cannot read (or that no longer exists) has no entry, and the client
   * shows the id it already has. The map is present whenever a linked key appears in the rows,
   * even if empty, so clients can treat it as authoritative instead of fetching each record.
   */
  async attachLinkLabels<T extends object>(rows: readonly T[], links: Readonly<Record<string, string>>): Promise<void> {
    if (rows.length === 0) return;
    const entries = Object.entries(links).filter(
      ([name, target]) => this.isLabelTarget(target) && rows.some((row) => name in row),
    );
    if (entries.length === 0) return;

    const idsByTarget = new Map<string, Set<string>>();
    for (const [name, target] of entries) {
      for (const row of rows) {
        for (const id of linkIds((row as Record<string, unknown>)[name])) {
          const ids = idsByTarget.get(target) ?? new Set<string>();
          ids.add(id);
          idsByTarget.set(target, ids);
        }
      }
    }

    const labelsByTarget = new Map<string, Map<string, string>>();
    for (const [target, ids] of idsByTarget) {
      if (ids.size === 0) continue;
      const labels = await this.linkLabelsFor(target, ids);
      if (labels.size > 0) labelsByTarget.set(target, labels);
    }

    for (const row of rows) {
      const dto = row as Record<string, unknown>;
      const labels: Record<string, Record<string, string>> = {};
      for (const [name, target] of entries) {
        const targetLabels = labelsByTarget.get(target);
        if (targetLabels === undefined) continue;
        const fieldLabels: Record<string, string> = {};
        for (const id of linkIds(dto[name])) {
          const label = targetLabels.get(id);
          if (label !== undefined) fieldLabels[id] = label;
        }
        labels[name] = fieldLabels;
      }
      dto['_linkLabels'] = labels;
    }
  }

  private async linkLabelsFor(target: string, ids: ReadonlySet<string>): Promise<Map<string, string>> {
    if (IDENTITY_LINK_TARGETS.has(target)) return this.identityLabels(target, ids);
    try {
      await this.acl.assertAccess(target, 'read');
    } catch {
      return new Map();
    }
    const acl = await this.acl.recordPredicate(target, 'read');
    const found = await this.store.findMany(target, {
      anyOf: { ids: [...ids] },
      acl,
      countTotal: false,
      limit: ids.size,
    });
    const fields = this.metadata.registry.getFields(target);
    const displayField = this.metadata.registry.getEntity(target)?.record.displayField;
    const visible = new Set(await this.acl.visibleFields(target));
    const readable = (field: string): boolean => !(field in fields) || visible.has(field);
    const labels = new Map<string, string>();
    for (const record of found.list) {
      const display = displayField !== undefined && readable(displayField) ? record.data[displayField] : undefined;
      if (typeof display === 'string' && display !== '') {
        labels.set(record.id, display);
        continue;
      }
      const name = record.data['name'];
      if (typeof name === 'string' && name !== '' && readable('name')) labels.set(record.id, name);
    }
    return labels;
  }

  /**
   * Labels for the identity tables. `GET /User/:id` and `GET /Team/:id` are administrator-only,
   * so a non-admin page keeps the raw id it saw when the client fetched those endpoints itself.
   */
  private async identityLabels(target: string, ids: ReadonlySet<string>): Promise<Map<string, string>> {
    const labels = new Map<string, string>();
    if (!this.scope.isAdmin || ids.size === 0) return labels;
    if (target === 'User') {
      const rows = await this.database.db
        .selectFrom('users')
        .select(['id', 'first_name', 'last_name', 'user_name'])
        .where('id', 'in', [...ids])
        .where('is_deleted', '=', false)
        .execute();
      for (const row of rows) {
        const name = [row.first_name, row.last_name].filter(Boolean).join(' ') || row.user_name;
        labels.set(row.id, name);
      }
    } else if (target === 'Team') {
      const rows = await this.database.db
        .selectFrom('teams')
        .select(['id', 'name'])
        .where('id', 'in', [...ids])
        .where('is_deleted', '=', false)
        .execute();
      for (const row of rows) labels.set(row.id, row.name);
    }
    return labels;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function isLinkField(def: FieldDefinition): boolean {
  return LINK_SINGLE_TYPES.has(def.type) || LINK_MULTIPLE_TYPES.has(def.type);
}

function linkIds(value: unknown): string[] {
  const source = Array.isArray(value) ? value : [value];
  return source.filter((item): item is string => typeof item === 'string' && item !== '');
}

function readVersion(value: unknown): number | undefined {  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(String(value));
  return Number.isFinite(parsed) ? Math.floor(parsed) : undefined;
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return new Date().toISOString();
}
