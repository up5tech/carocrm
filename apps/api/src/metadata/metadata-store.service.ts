import { ValidationError } from '@carocrm/core/errors/index.js';
import { log } from '@carocrm/core/logger/index.js';
import { MetadataCache } from '@carocrm/metadata/cache/index.js';
import { MetadataRegistry } from '@carocrm/metadata/registry/index.js';
import type { EntityDefinition } from '@carocrm/metadata/schemas/index.js';
import { EntityDefinitionSchema } from '@carocrm/metadata/schemas/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service.js';
import { FormulaService } from '../logic/formula.service.js';

interface AppScopeData {
  entity?: Record<string, unknown>;
}

@Injectable()
export class MetadataStoreService {
  readonly registry = new MetadataRegistry();
  readonly cache = new MetadataCache(this.registry);
  private loaded = false;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(FormulaService) private readonly formulas: FormulaService,
  ) {}

  async load(): Promise<void> {
    this.registry.clear();
    const db = this.database.db;

    const rows = await db
      .selectFrom('metadata_entries')
      .select(['name', 'data'])
      .where('scope', '=', 'entity')
      .execute();

    const appRow = await db.selectFrom('app_settings').select('data').where('name', '=', 'entity').executeTakeFirst();
    const appScope = (appRow?.data ?? {}) as AppScopeData;
    const appEntities = appScope.entity ?? {};

    const byName = new Map<string, Record<string, unknown>>();
    for (const row of rows) byName.set(row.name, row.data as Record<string, unknown>);
    for (const [name, data] of Object.entries(appEntities)) {
      byName.set(name, mergeEntityData(byName.get(name), data as Record<string, unknown>));
    }

    for (const data of byName.values()) {
      const parsed = EntityDefinitionSchema.safeParse(data);
      if (!parsed.success) {
        log.error({ errors: parsed.error.issues, entity: data['name'] }, 'invalid entity metadata');
        throw new ValidationError(`Invalid metadata for entity "${String(data['name'])}".`, {
          issues: parsed.error.issues.map((i) => i.message),
        });
      }
      const definition = parsed.data as EntityDefinition;
      this.formulas.validateDefinition(definition);
      this.registry.registerEntity(definition);
    }

    this.loaded = true;
    this.cache.invalidate();
    log.info({ entities: this.registry.getEntities().length }, 'metadata loaded');
  }

  ensureLoaded(): void {
    if (!this.loaded) {
      throw new ValidationError('Metadata is not loaded yet.');
    }
  }

  async persistEntityOverride(name: string, patch: Record<string, unknown>): Promise<void> {
    const db = this.database.db;
    const row = await db
      .selectFrom('app_settings')
      .select('data')
      .where('name', '=', 'entity')
      .executeTakeFirst();
    const current = (row?.data ?? {}) as AppScopeData;
    const entities = current.entity ?? {};
    entities[name] = mergeEntityData(entities[name] as Record<string, unknown> | undefined, patch);
    await db
      .insertInto('app_settings')
      .values({ name: 'entity', data: JSON.stringify({ ...current, entity: entities }), modified_at: new Date() })
      .onConflict((oc) => oc.column('name').doUpdateSet({ data: JSON.stringify({ ...current, entity: entities }), modified_at: new Date() }))
      .execute();
  }

  getMetadata(): Record<string, unknown> {
    this.ensureLoaded();
    return this.cache.getMetadata() as Record<string, unknown>;
  }

  version(): number {
    return this.registry.getMetadataVersion();
  }
}

function mergeEntityData(base: Record<string, unknown> | undefined, patch: Record<string, unknown>): Record<string, unknown> {
  if (!base) return patch;
  const merged: Record<string, unknown> = { ...base, ...patch };
  if (base.fields && patch.fields) {
    merged.fields = { ...(base.fields as Record<string, unknown>), ...(patch.fields as Record<string, unknown>) };
  }
  if (base.relations && patch.relations) {
    merged.relations = { ...(base.relations as Record<string, unknown>), ...(patch.relations as Record<string, unknown>) };
  }
  // `layouts`, `indexes` and `acl` are whole-section replacements (PLAN §8): a patch that omits them
  // keeps the persisted value, a patch that provides them replaces them outright.
  for (const section of ['layouts', 'indexes', 'acl'] as const) {
    if (patch[section] === undefined && base[section] !== undefined) {
      merged[section] = base[section];
    }
  }
  return merged;
}

export const METADATA_STORE = Symbol('METADATA_STORE');
