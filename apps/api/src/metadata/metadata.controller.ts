import { randomUUID } from 'node:crypto';

import { AuthorizationDeniedError, NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import type { EntityDefinition } from '@carocrm/metadata/schemas/index.js';
import { EntityDefinitionSchema } from '@carocrm/metadata/schemas/index.js';
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import { FormulaService } from '../logic/formula.service.js';
import type { MetadataStoreService } from "./metadata-store.service.js";
import { METADATA_STORE } from "./metadata-store.service.js";

/**
 * Metadata API (PLAN §16.1). Mounted on the static `Metadata` prefix, so it must be
 * registered before the parametrised generic record controller.
 */
@Controller('api/v1/Metadata')
export class MetadataController {
  constructor(
    @Inject(METADATA_STORE) private readonly store: MetadataStoreService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(FormulaService) private readonly formulas: FormulaService,
  ) {}

  @Get()
  all(@Res({ passthrough: true }) reply: FastifyReply): Record<string, unknown> {
    reply.header('X-Metadata-Version', String(this.store.version()));
    return this.store.getMetadata();
  }

  @Get(':entity')
  one(@Param('entity') entity: string, @Res({ passthrough: true }) reply: FastifyReply): unknown {
    reply.header('X-Metadata-Version', String(this.store.version()));
    const definition = this.definition(entity);
    return definition;
  }

  /**
   * Admin-only metadata patch: merged into the existing definition (EspoCRM fieldManager style).
   * Creating a brand-new entity uses the same route: when the entity is unknown the patch must
   * carry `label` and `fields`, matching PLAN §19.1 "Create custom entities".
   */
  @HttpCode(200)
  @Post(':entity')
  async patch(@Param('entity') entity: string, @Body() body: unknown): Promise<unknown> {
    this.requireAdmin();
    const patch = asObject(body);
    delete patch['name'];

    if (!this.store.registry.hasEntity(entity)) {
      return this.createEntity(entity, patch);
    }
    return this.applyPatch(entity, patch);
  }

  private async createEntity(entity: string, patch: Record<string, unknown>): Promise<unknown> {
    if (!/^[A-Z][A-Za-z0-9]{1,49}$/.test(entity)) {
      throw new ValidationError('Entity name must be PascalCase, 2-50 characters.', { entity });
    }
    const label = typeof patch['label'] === 'string' ? patch['label'] : undefined;
    if (!label) throw new ValidationError('Creating an entity requires a "label".', { entity });

    const definition: Record<string, unknown> = {
      name: entity,
      label,
      isEntity: true,
      fields: {
        id: { type: 'varchar' },
        name: { type: 'varchar', required: true, maxLength: 255, inList: true, inDetail: true, inEdit: true, sortable: true },
        description: { type: 'text', inDetail: true, inEdit: true },
        createdAt: { type: 'datetime', audited: true },
        modifiedAt: { type: 'datetime', audited: true },
        createdById: { type: 'link', entityKey: 'User' },
        modifiedById: { type: 'link', entityKey: 'User' },
        assignedUserId: { type: 'link', entityKey: 'User', inList: true, inDetail: true, inEdit: true },
        teams: { type: 'linkMultiple', entityKey: 'Team' },
        deletedAt: { type: 'datetime' },
        ...isRecord(patch['fields']) ? patch['fields'] : {},
      },
      relations: isRecord(patch['relations']) ? patch['relations'] : {},
      indexes: [],
      record: { displayField: 'name', removable: true, ...(isRecord(patch['record']) ? patch['record'] : {}) },
      client: { ...(isRecord(patch['client']) ? patch['client'] : {}) },
      ...(isRecord(patch['dynamicLogic']) || Array.isArray(patch['dynamicLogic']) ? { dynamicLogic: patch['dynamicLogic'] } : {}),
    };

    const parsed = EntityDefinitionSchema.safeParse(definition);
    if (!parsed.success) {
      throw new ValidationError(`Invalid entity definition for "${entity}".`, {
        issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      });
    }
    this.formulas.validateDefinition(parsed.data as EntityDefinition);

    await this.store.persistEntityOverride(entity, definition);
    this.store.registry.registerEntity(parsed.data as EntityDefinition);
    this.store.cache.invalidate();

    await this.database.db
      .insertInto('schema_changes')
      .values({
        id: randomUUID(),
        operation: 'entity.create',
        entity_type: entity,
        field_name: null,
        payload: JSON.stringify(definition),
        status: 'applied',
        error: null,
        created_at: new Date(),
        applied_at: new Date(),
      })
      .execute();

    return this.store.registry.getEntity(entity);
  }

  /** Disables a field by re-typing it as `disabled` (kept in metadata, hidden from UI/API). */
  @Delete(':entity/Field/:field')
  async disableField(@Param('entity') entity: string, @Param('field') field: string): Promise<unknown> {
    this.requireAdmin();
    const definition = this.definition(entity);
    if (!definition.fields[field]) {
      throw new NotFoundError(`Field "${field}" does not exist in "${entity}".`);
    }
    return this.applyPatch(entity, { fields: { [field]: { type: 'disabled' } } }, field);
  }

  private async applyPatch(entity: string, patch: Record<string, unknown>, fieldName?: string): Promise<unknown> {
    const existing = this.definition(entity);
    const merged = mergeDefinition(entity, existing, patch);

    const parsed = EntityDefinitionSchema.safeParse(merged);
    if (!parsed.success) {
      throw new ValidationError(`Invalid metadata patch for "${entity}".`, {
        issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      });
    }
    const definition = parsed.data as EntityDefinition;
    this.formulas.validateDefinition(definition);

    await this.store.persistEntityOverride(entity, patch);
    this.store.registry.registerEntity(definition);
    this.store.cache.invalidate();

    await this.database.db
      .insertInto('schema_changes')
      .values({
        id: randomUUID(),
        operation: fieldName ? 'field.disable' : 'entity.update',
        entity_type: entity,
        field_name: fieldName ?? null,
        payload: JSON.stringify(patch),
        status: 'applied',
        error: null,
        created_at: new Date(),
        applied_at: new Date(),
      })
      .execute();

    return this.store.registry.getEntity(entity);
  }

  private definition(entity: string): EntityDefinition {
    this.store.ensureLoaded();
    const definition = this.store.registry.getEntity(entity);
    if (!definition) throw new NotFoundError(`Entity "${entity}" does not exist in metadata.`);
    return definition;
  }

  private requireAdmin(): void {
    if (!this.scope.isAdmin) {
      throw new AuthorizationDeniedError('Administrator access is required to change metadata.');
    }
  }
}

function mergeDefinition(entity: string, base: EntityDefinition, patch: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    ...base,
    ...patch,
    name: entity,
  };
  if (base.fields && isRecord(patch['fields'])) {
    merged['fields'] = { ...base.fields, ...patch['fields'] };
  }
  if (base.relations && isRecord(patch['relations'])) {
    merged['relations'] = { ...base.relations, ...patch['relations'] };
  }
  if (base.record && isRecord(patch['record'])) {
    merged['record'] = { ...base.record, ...patch['record'] };
  }
  return merged;
}

function asObject(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) throw new ValidationError('Request body must be a JSON object.');
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
