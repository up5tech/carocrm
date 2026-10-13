import { ConcurrencyConflictError, RecordNotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { parseDate } from '@carocrm/core/utils/date.js';
import { generateId } from '@carocrm/core/utils/id.js';
import type { FieldDefinition, RelationDefinition } from '@carocrm/metadata/schemas/index.js';

import type {
  CreateRecordOptions,
  CreateResult,
  DeleteRecordOptions,
  DeleteResult,
  EntityQuery,
  EntityRecord,
  GetRecordOptions,
  HookBinding,
  HookContext,
  HookHandler,
  HookPhase,
  ListResult,
  UpdateRecordOptions,
  UpdateResult,
} from '../types/index.js';
import { RecordValidator } from '../validation/index.js';

/** Field types whose value is not shape-checked here; a link's target is validated by the API layer. */
const NON_VALUE_TYPES: readonly string[] = [
  'link',
  'linkOne',
  'linkMultiple',
  'linkParent',
  'foreign',
  'file',
  'image',
  'attachmentMultiple',
  'formula',
  'generated',
  'aggregationCount',
];

export interface EntityMetadataPort {
  getField(entity: string, field: string): FieldDefinition | undefined;
  getFields(entity: string): Record<string, FieldDefinition>;
  getRelation(entity: string, relation: string): RelationDefinition | undefined;
  hasEntity(entity: string): boolean;
}

export interface RecordStorePort {
  insert(record: EntityRecord): Promise<void>;
  findById(entity: string, id: string): Promise<EntityRecord | undefined>;
  update(record: EntityRecord, expectedVersion: number): Promise<boolean>;
  markDeleted(entity: string, id: string, deletedAt: Date): Promise<boolean>;
  findMany(entity: string, query: EntityQuery): Promise<ListResult<EntityRecord>>;
  linkRecord(options: {
    entityTypeA: string;
    recordIdA: string;
    relationName: string;
    entityTypeB: string;
    recordIdB: string;
  }): Promise<void>;
  unlinkRecord(options: {
    entityTypeA: string;
    recordIdA: string;
    relationName: string;
    recordIdB: string;
  }): Promise<void>;
  replaceLinks(options: {
    entityTypeA: string;
    recordIdA: string;
    relationName: string;
    entityTypeB: string;
    recordIdsB: string[];
  }): Promise<void>;
}

export class EntityManager {
  private hooks = new Map<HookPhase, HookHandler[]>();

  constructor(
    private readonly store: RecordStorePort,
    private readonly metadata: EntityMetadataPort,
    hooks: Iterable<HookBinding> = [],
  ) {
    for (const binding of hooks) this.addHook(binding.phase, binding.handler);
  }

  addHook(phase: HookPhase, handler: HookHandler): void {
    const list = this.hooks.get(phase) ?? [];
    list.push(handler);
    this.hooks.set(phase, list);
  }

  private async runHooks(phase: HookPhase, context: HookContext): Promise<void> {
    for (const handler of this.hooks.get(phase) ?? []) {
      await handler(context);
    }
  }

  private context(
    phase: HookPhase,
    entity: string,
    operation: HookContext['operation'],
    extras: Partial<HookContext>,
  ): HookContext {
    const ctx: HookContext = { entity, operation, phase };
    if (extras.record !== undefined) ctx.record = extras.record;
    if (extras.previous !== undefined) ctx.previous = extras.previous;
    if (extras.data !== undefined) ctx.data = extras.data;
    if (extras.userId !== undefined) ctx.userId = extras.userId;
    return ctx;
  }

  async create(options: CreateRecordOptions): Promise<EntityRecord> {
    if (!this.metadata.hasEntity(options.entity)) {
      throw new ValidationError(`Unknown entity "${options.entity}".`);
    }
    const data = { ...options.data };
    await this.runHooks('beforeValidate', this.context('beforeValidate', options.entity, 'create', { data, userId: options.userId }));
    this.applyDefaults(options.entity, data);
    this.validate(options.entity, data);

    const now = new Date();
    const id = typeof data.id === 'string' && data.id.length > 0 ? data.id : generateId();
    const record: EntityRecord = {
      id,
      entityType: options.entity,
      createdAt: parseDate(data.createdAt as string) ?? now,
      modifiedAt: parseDate(data.modifiedAt as string) ?? now,
      version: 1,
      data,
    };
    if (options.userId !== undefined) {
      record.createdById = options.userId;
      record.modifiedById = options.userId;
    }
    if (typeof data.assignedUserId === 'string') record.assignedUserId = data.assignedUserId;

    await this.runHooks('beforeCreate', this.context('beforeCreate', options.entity, 'create', { data, userId: options.userId }));
    await this.runHooks('beforeSave', this.context('beforeSave', options.entity, 'create', { data, userId: options.userId }));

    await this.store.insert(record);
    await this.applyRelations(options.entity, id, options.relations);

    await this.runHooks('afterCreate', this.context('afterCreate', options.entity, 'create', { record, userId: options.userId }));
    await this.runHooks('whenCreated', this.context('whenCreated', options.entity, 'create', { record, userId: options.userId }));
    await this.runHooks('afterSave', this.context('afterSave', options.entity, 'create', { record, userId: options.userId }));
    return record;
  }

  async get(options: GetRecordOptions): Promise<EntityRecord> {
    const record = await this.store.findById(options.entity, options.id);
    if (!record) {
      throw new RecordNotFoundError(options.entity, options.id);
    }
    return record;
  }

  async find(options: GetRecordOptions): Promise<EntityRecord | undefined> {
    return this.store.findById(options.entity, options.id);
  }

  async list(entity: string, query: EntityQuery): Promise<ListResult<EntityRecord>> {
    return this.store.findMany(entity, query);
  }

  async update(options: UpdateRecordOptions): Promise<EntityRecord> {
    const existing = await this.store.findById(options.entity, options.id);
    if (!existing) {
      throw new RecordNotFoundError(options.entity, options.id);
    }
    if (options.expectedVersion !== undefined && options.expectedVersion !== existing.version) {
      throw new ConcurrencyConflictError(options.entity, options.id);
    }

    const data: Record<string, unknown> = { ...existing.data, ...options.data };
    await this.runHooks('beforeValidate', this.context('beforeValidate', options.entity, 'update', { record: existing, previous: existing.data, data, userId: options.userId }));
    this.validate(options.entity, data);

    const record: EntityRecord = {
      ...existing,
      modifiedAt: new Date(),
      version: existing.version + 1,
      data,
    };
    if (options.userId !== undefined) record.modifiedById = options.userId;
    if ('assignedUserId' in options.data) {
      const assigned = options.data.assignedUserId;
      if (typeof assigned === 'string') record.assignedUserId = assigned;
      else record.assignedUserId = undefined;
    }

    await this.runHooks('beforeUpdate', this.context('beforeUpdate', options.entity, 'update', { record: existing, previous: existing.data, data, userId: options.userId }));
    await this.runHooks('beforeSave', this.context('beforeSave', options.entity, 'update', { record: existing, previous: existing.data, data, userId: options.userId }));

    const updated = await this.store.update(record, existing.version);
    if (!updated) {
      throw new ConcurrencyConflictError(options.entity, options.id);
    }
    if (options.relations) {
      await this.applyRelations(options.entity, options.id, options.relations);
    }

    await this.runHooks('whenUpdated', this.context('whenUpdated', options.entity, 'update', { record, previous: existing.data, userId: options.userId }));
    await this.runHooks('afterSave', this.context('afterSave', options.entity, 'update', { record, previous: existing.data, userId: options.userId }));
    return record;
  }

  async delete(options: DeleteRecordOptions): Promise<void> {
    const existing = await this.store.findById(options.entity, options.id);
    if (!existing) {
      throw new RecordNotFoundError(options.entity, options.id);
    }
    await this.runHooks('beforeDelete', this.context('beforeDelete', options.entity, 'delete', { record: existing, userId: options.userId }));
    const removed = await this.store.markDeleted(options.entity, options.id, new Date());
    if (!removed) {
      throw new RecordNotFoundError(options.entity, options.id);
    }
    await this.runHooks('whenDeleted', this.context('whenDeleted', options.entity, 'delete', { record: existing, userId: options.userId }));
  }

  private applyDefaults(entity: string, data: Record<string, unknown>): void {
    for (const [name, def] of Object.entries(this.metadata.getFields(entity))) {
      if (data[name] === undefined && def.defaultValue !== undefined) {
        data[name] = def.defaultValue;
      }
    }
  }

  private validate(entity: string, data: Record<string, unknown>): void {
    const fields = this.metadata.getFields(entity);
    const validator = new RecordValidator(fields);
    const errors: Record<string, string> = {};
    for (const [field, def] of Object.entries(fields)) {
      if (NON_VALUE_TYPES.includes(def.type)) {
        // The value shape of a link is checked by the API layer, but `required` still means the
        // record cannot exist without it (Phase 19: a Project without a board, a Task without a
        // project).
        if (def.required && (data[field] === undefined || data[field] === null || data[field] === '')) {
          errors[field] = 'Field is required.';
        }
        continue;
      }
      const result = validator.validateField(field, data[field]);
      if (!result.valid && result.errors) {
        errors[field] = Object.values(result.errors)[0] ?? 'Invalid value.';
      }
    }
    if (Object.keys(errors).length > 0) {
      throw new ValidationError('Record validation failed.', errors);
    }
  }

  private async applyRelations(
    entity: string,
    id: string,
    relations: Record<string, string | string[] | null | undefined> | undefined,
  ): Promise<void> {
    if (!relations) return;
    for (const [name, value] of Object.entries(relations)) {
      const def = this.metadata.getRelation(entity, name);
      if (!def) {
        throw new ValidationError(`Unknown relation "${name}" for entity "${entity}".`);
      }
      if (value === null) {
        await this.store.replaceLinks({
          entityTypeA: entity,
          recordIdA: id,
          relationName: name,
          entityTypeB: def.target ?? '',
          recordIdsB: [],
        });
        continue;
      }
      const targets = (Array.isArray(value) ? value : [value]).filter((t): t is string => typeof t === 'string');
      if (def.type === 'manyToMany' || def.type === 'oneToMany') {
        await this.store.replaceLinks({
          entityTypeA: entity,
          recordIdA: id,
          relationName: name,
          entityTypeB: def.target ?? '',
          recordIdsB: targets,
        });
      } else {
        for (const targetId of targets) {
          await this.store.linkRecord({
            entityTypeA: entity,
            recordIdA: id,
            relationName: name,
            entityTypeB: def.target ?? '',
            recordIdB: targetId,
          });
        }
      }
    }
  }

  async bulkUpdate(options: { entity: string; ids: string[]; data: Record<string, unknown>; userId?: string }): Promise<UpdateResult[]> {
    const results: UpdateResult[] = [];
    for (const id of options.ids) {
      const record = await this.update({ entity: options.entity, id, data: options.data, userId: options.userId });
      results.push({ id: record.id, modifiedAt: record.modifiedAt, version: record.version });
    }
    return results;
  }

  async bulkDelete(options: { entity: string; ids: string[]; userId?: string }): Promise<DeleteResult[]> {
    const results: DeleteResult[] = [];
    for (const id of options.ids) {
      await this.delete({ entity: options.entity, id, userId: options.userId });
      results.push({ id, deleted: true, deletedAt: new Date() });
    }
    return results;
  }

  async createResult(options: CreateRecordOptions): Promise<CreateResult> {
    const record = await this.create(options);
    return { id: record.id, entity: record.entityType, createdAt: record.createdAt };
  }
}

export const ENTITY_MANAGER = Symbol('ENTITY_MANAGER');
