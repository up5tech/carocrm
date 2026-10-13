import { randomUUID } from 'node:crypto';

import { AuthorizationDeniedError, NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import type { EntityDefinition } from '@carocrm/metadata/schemas/index.js';
import { EntityDefinitionSchema } from '@carocrm/metadata/schemas/index.js';
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import { acceptLanguageLocale, I18nService } from '../i18n/i18n.service.js';
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
    @Inject(I18nService) private readonly i18n: I18nService,
  ) {}

  @Get()
  async all(@Res({ passthrough: true }) reply: FastifyReply): Promise<unknown> {
    reply.header('X-Metadata-Version', String(this.store.version()));
    return this.translated(this.store.getMetadata() as Record<string, unknown>);
  }

  @Get(':entity')
  async one(@Param('entity') entity: string, @Res({ passthrough: true }) reply: FastifyReply): Promise<unknown> {
    reply.header('X-Metadata-Version', String(this.store.version()));
    const definition = this.definition(entity) as unknown as Record<string, unknown>;
    return this.elementTranslation(entity, definition);
  }

  /**
   * Labels resolve per request locale (PLAN §41.7): entity labels, field labels and layout
   * panel labels come from the `crm.<entity>.…` catalog keys when translated; the literal
   * metadata label stays the fallback. Response shape and metadata version are unchanged.
   */
  private async translated(metadata: Record<string, unknown>): Promise<unknown> {
    const locale = await this.localeForRequest();
    return this.i18n.translateMetadata(metadata, locale);
  }

  private async elementTranslation(entity: string, definition: Record<string, unknown>): Promise<unknown> {
    const locale = await this.localeForRequest();
    return this.i18n.translateMetadata({ [entity]: definition }, locale)[entity];
  }

  private async localeForRequest(): Promise<string> {
    if (this.scope.locale) return this.scope.locale;
    const settings = await this.i18n.settings();
    return acceptLanguageLocale(this.scope.acceptLanguage, settings.enabledLocales) ?? settings.defaultLocale;
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
      indexes: Array.isArray(patch['indexes']) ? patch['indexes'] : [],
      layouts: isRecord(patch['layouts']) ? patch['layouts'] : {},
      ...(isRecord(patch['acl']) ? { acl: patch['acl'] } : {}),
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
    if (Array.isArray(patch['indexes'])) {
      this.validateIndexes(definition, patch['indexes']);
    }
    if (isRecord(patch['layouts'])) {
      this.validateLayouts(definition, patch['layouts']);
    }
    this.formulas.validateDefinition(definition);

    await this.store.persistEntityOverride(entity, patch);
    this.store.registry.registerEntity(definition);
    this.store.cache.invalidate();

    await this.database.db
      .insertInto('schema_changes')
      .values({
        id: randomUUID(),
        operation: schemaChangeOperation(patch, fieldName),
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

  /**
   * Index configuration is declarative metadata (PLAN §8): it names the columns an index should cover
   * so a reviewed migration can create the physical index. This validates the declaration only — it
   * never touches the database schema (AGENTS.md §3.4). Field names must be allow-listed against the
   * entity's own fields, and reserved bookkeeping columns are rejected.
   */
  private validateIndexes(definition: EntityDefinition, indexes: unknown): void {
    const reserved = new Set(['id', 'createdAt', 'modifiedAt', 'createdById', 'modifiedById', 'deletedAt', 'version']);
    const allowed = new Set(Object.keys(definition.fields));
    const list = indexes as { name?: unknown; fields?: unknown }[];
    const seen = new Set<string>();
    for (const index of list) {
      const name = typeof index?.name === 'string' ? index.name : '';
      if (name === '') throw new ValidationError('Every index needs a name.', { entity: definition.name });
      if (seen.has(name)) throw new ValidationError(`Duplicate index name "${name}".`, { entity: definition.name });
      seen.add(name);
      const fields = Array.isArray(index.fields) ? index.fields : [];
      if (fields.length === 0) throw new ValidationError(`Index "${name}" must cover at least one field.`, { entity: definition.name });
      for (const field of fields) {
        if (typeof field !== 'string' || reserved.has(field)) {
          throw new ValidationError(`Index "${name}" cannot reference reserved column "${String(field)}".`, { entity: definition.name });
        }
        if (!allowed.has(field)) {
          throw new ValidationError(`Index "${name}" references unknown field "${field}".`, { entity: definition.name });
        }
      }
    }
  }

  /**
   * Layout configuration is declarative metadata (PLAN §8). This validates the declaration only and
   * never touches the database schema (AGENTS.md §3.4). Every panel's member field must be an
   * enabled (non-disabled) field of the entity, so a layout can never reference a hidden or
   * reserved bookkeeping column. A view with no panels is allowed (it just falls back to flat order).
   */
  private validateLayouts(definition: EntityDefinition, layouts: unknown): void {
    const viewTypes = new Set(['list', 'detail', 'edit', 'filter', 'search', 'massUpdate']);
    const allowed = new Set(Object.keys(definition.fields));
    for (const [view, groups] of Object.entries(layouts as Record<string, unknown>)) {
      if (!viewTypes.has(view)) {
        throw new ValidationError(`Layout view "${view}" is not supported.`, { entity: definition.name });
      }
      if (!Array.isArray(groups)) {
        throw new ValidationError(`Layout for "${view}" must be a list of panels.`, { entity: definition.name });
      }
      for (const group of groups) {
        const panels = (group as { panels?: unknown }).panels;
        if (!Array.isArray(panels)) {
          throw new ValidationError(`Layout "${view}" is missing its panels.`, { entity: definition.name });
        }
        for (const panel of panels) {
          const name = typeof panel?.name === 'string' ? panel.name : '';
          if (name === '') {
            throw new ValidationError(`Layout "${view}" has a panel without a name.`, { entity: definition.name });
          }
          const fields = Array.isArray(panel.fields) ? panel.fields : [];
          for (const field of fields) {
            if (typeof field !== 'string') {
              throw new ValidationError(`Panel "${name}" lists a non-string field.`, { entity: definition.name });
            }
            if (!allowed.has(field)) {
              throw new ValidationError(`Panel "${name}" references unknown field "${field}".`, { entity: definition.name });
            }
            if (definition.fields[field]?.type === 'disabled') {
              throw new ValidationError(`Panel "${name}" references disabled field "${field}".`, { entity: definition.name });
            }
          }
        }
      }
    }
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
  // indexes/layouts/acl are whole-scope objects in the patch: replace rather than shallow-merge so a
  // removed entry actually disappears (metadata-scoped, never physical DDL — AGENTS.md §3.4).
  if (Array.isArray(patch['indexes'])) {
    merged['indexes'] = patch['indexes'];
  }
  if (isRecord(patch['layouts'])) {
    merged['layouts'] = { ...base.layouts, ...patch['layouts'] };
  }
  if (isRecord(patch['acl'])) {
    merged['acl'] = { ...base.acl, ...patch['acl'] };
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

/** Picks the `schema_changes.operation` label from what the patch actually changed (PLAN §8). */
function schemaChangeOperation(patch: Record<string, unknown>, fieldName?: string): string {
  if (fieldName) return 'field.disable';
  if (Array.isArray(patch['indexes'])) return 'entity.index.update';
  if (isRecord(patch['layouts'])) return 'entity.layout.update';
  if (isRecord(patch['acl'])) return 'entity.acl.update';
  return 'entity.update';
}
