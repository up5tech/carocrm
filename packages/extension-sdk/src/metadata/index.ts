import type { MetadataSource } from '@carocrm/metadata/merger/index.js';
import type { EntityDefinition } from '@carocrm/metadata/schemas/index.js';
import { FieldDefinitionSchema, IndexDefinitionSchema, RelationDefinitionSchema } from '@carocrm/metadata/schemas/index.js';
import type { z } from 'zod';

import { ExtensionError } from '../errors/index.js';
import { isRecord } from '../types/index.js';

/**
 * Metadata contribution from extension packages (PLAN §12.1, §39).
 *
 * An extension ships JSON documents that describe entities, fields, layouts and ACL. They are
 * validated here with the same schemas the kernel uses, so an extension cannot install metadata
 * that the rest of the platform would refuse later.
 * Merge rules (deliberately identical to the kernel's admin patch merge in
 * `apps/api/src/metadata/metadata-store.service.ts`):
 *   - `fields` / `relations`: merged key by key, so several extensions can extend one entity;
 *   - `indexes`: concatenated — index declarations are additive metadata;
 *   - `layouts`: merged per view;
 *   - `record` / `client`: merged key by key;
 *   - `dynamicLogic`: replaced by the higher-priority package (rules are a closed list).
 */

export interface ExtensionMetadataSection {
  readonly entities?: Record<string, unknown> | undefined;
  readonly layouts?: Record<string, unknown> | undefined;
  readonly acl?: Record<string, unknown> | undefined;
  readonly permissions?: Record<string, unknown> | undefined;
  readonly jobs?: Record<string, unknown> | undefined;
  readonly routes?: Record<string, unknown> | undefined;
}

/**
 * Validates one metadata document and returns it as a {@link MetadataSource}.
 *
 * An extension may contribute a **partial** entity — a few fields on a core entity, or a whole new
 * one — so each contribution is validated piece by piece (`FieldDefinitionSchema`,
 * `RelationDefinitionSchema`, `IndexDefinitionSchema`) rather than as a complete
 * `EntityDefinitionSchema`. The merged result is validated by the kernel when metadata is loaded,
 * which is the real gate: an extension cannot ship metadata the platform would refuse.
 */
export function readMetadataDocument(value: unknown, context: Record<string, unknown>): MetadataSource {
  if (!isRecord(value)) {
    throw new ExtensionError('EXTENSION_METADATA_INVALID', `Extension metadata${describe(context)} must be a JSON object.`, context);
  }
  if (value['entities'] !== undefined && !isRecord(value['entities'])) {
    throw new ExtensionError('EXTENSION_METADATA_INVALID', `Extension metadata${describe(context)} has an "entities" section that is not an object.`, context);
  }

  const entities: Record<string, Partial<EntityDefinition>> = {};
  for (const [name, definition] of Object.entries(isRecord(value['entities']) ? value['entities'] : {})) {
    entities[name] = validateEntity(name, definition, context);
  }

  const source: MetadataSource = {
    entities,
    ...(isRecord(value['layouts']) ? { layouts: value['layouts'] as Record<string, Record<string, unknown>> } : {}),
    ...(isRecord(value['acl']) ? { acl: value['acl'] } : {}),
    ...(isRecord(value['permissions']) ? { permissions: value['permissions'] } : {}),
    ...(isRecord(value['jobs']) ? { jobs: value['jobs'] } : {}),
    ...(isRecord(value['routes']) ? { routes: value['routes'] } : {}),
  };
  return source;
}

function validateEntity(name: string, definition: unknown, context: Record<string, unknown>): Partial<EntityDefinition> {
  if (!isRecord(definition)) {
    throw new ExtensionError('EXTENSION_METADATA_INVALID', `Entity "${name}"${describe(context)} must be a JSON object.`, { ...context, entity: name });
  }
  const issues: string[] = [];
  const result: Record<string, unknown> = { ...definition };

  if (definition['fields'] !== undefined) {
    if (!isRecord(definition['fields'])) issues.push('fields: must be an object');
    else {
      const fields: Record<string, unknown> = {};
      for (const [field, definitionValue] of Object.entries(definition['fields'])) {
        const parsed = FieldDefinitionSchema.safeParse(definitionValue);
        if (parsed.success) fields[field] = parsed.data;
        else issues.push(`fields.${field}: ${issuesOf(parsed.error)}`);
      }
      result['fields'] = fields;
    }
  }

  if (definition['relations'] !== undefined) {
    if (!isRecord(definition['relations'])) issues.push('relations: must be an object');
    else {
      const relations: Record<string, unknown> = {};
      for (const [relation, definitionValue] of Object.entries(definition['relations'])) {
        const parsed = RelationDefinitionSchema.safeParse(definitionValue);
        if (parsed.success) relations[relation] = parsed.data;
        else issues.push(`relations.${relation}: ${issuesOf(parsed.error)}`);
      }
      result['relations'] = relations;
    }
  }

  if (definition['indexes'] !== undefined) {
    if (!Array.isArray(definition['indexes'])) issues.push('indexes: must be an array');
    else {
      const indexes: unknown[] = [];
      for (const [index, definitionValue] of (definition['indexes'] as unknown[]).entries()) {
        const parsed = IndexDefinitionSchema.safeParse(definitionValue);
        if (parsed.success) indexes.push(parsed.data);
        else issues.push(`indexes[${String(index)}]: ${issuesOf(parsed.error)}`);
      }
      result['indexes'] = indexes;
    }
  }

  if (issues.length > 0) {
    throw new ExtensionError(
      'EXTENSION_METADATA_INVALID',
      `Entity "${name}"${describe(context)} is not a valid entity contribution: ${issues.join('; ')}`,
      { ...context, entity: name, issues },
    );
  }
  return result as Partial<EntityDefinition>;
}

function issuesOf(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join(', ');
}

/** Merges metadata sources in load order: later sources override earlier ones. */
export function mergeMetadataSources(sources: readonly MetadataSource[]): MetadataSource {
  const merged: Required<Pick<MetadataSource, 'entities'>> = { entities: {} };
  const layouts: Record<string, Record<string, unknown>> = {};
  const acl: Record<string, unknown> = {};
  const permissions: Record<string, unknown> = {};
  const jobs: Record<string, unknown> = {};
  const routes: Record<string, unknown> = {};

  for (const source of sources) {
    for (const [name, definition] of Object.entries(source.entities ?? {})) {
      const base = merged.entities[name];
      merged.entities[name] = base === undefined ? { ...definition } : mergeEntity(base, definition);
    }
    for (const [entity, views] of Object.entries(source.layouts ?? {})) {
      layouts[entity] = { ...(layouts[entity] ?? {}), ...views };
    }
    Object.assign(acl, source.acl ?? {});
    Object.assign(permissions, source.permissions ?? {});
    Object.assign(jobs, source.jobs ?? {});
    Object.assign(routes, source.routes ?? {});
  }

  return {
    entities: merged.entities,
    ...(Object.keys(layouts).length === 0 ? {} : { layouts }),
    ...(Object.keys(acl).length === 0 ? {} : { acl }),
    ...(Object.keys(permissions).length === 0 ? {} : { permissions }),
    ...(Object.keys(jobs).length === 0 ? {} : { jobs }),
    ...(Object.keys(routes).length === 0 ? {} : { routes }),
  };
}

function mergeEntity(base: Partial<EntityDefinition>, override: Partial<EntityDefinition>): Partial<EntityDefinition> {
  const result: Partial<EntityDefinition> = { ...base, ...override };
  if (isRecord(base['fields']) && isRecord(override['fields'])) {
    result.fields = { ...(base.fields ?? {}), ...(override.fields ?? {}) };
  }
  if (isRecord(base['relations']) && isRecord(override['relations'])) {
    result.relations = { ...(base.relations ?? {}), ...(override.relations ?? {}) };
  }
  if (Array.isArray(base['indexes']) && Array.isArray(override['indexes'])) {
    result.indexes = [...(base.indexes ?? []), ...(override['indexes'] ?? [])];
  }
  if (isRecord(base['layouts']) && isRecord(override['layouts'])) {
    result.layouts = { ...(base.layouts ?? {}), ...(override.layouts ?? {}) };
  }
  if (isRecord(base['record']) && isRecord(override['record'])) {
    result.record = { ...(base.record ?? {}), ...(override['record'] ?? {}) };
  }
  if (isRecord(base['client']) && isRecord(override['client'])) {
    result.client = { ...(base.client ?? {}), ...(override['client'] ?? {}) };
  }
  return result;
}

function describe(context: Record<string, unknown>): string {
  const id = typeof context['id'] === 'string' ? context['id'] : undefined;
  return id === undefined ? '' : ` from extension "${id}"`;
}