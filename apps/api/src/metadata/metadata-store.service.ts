import { ValidationError } from '@carocrm/core/errors/index.js';
import { log } from '@carocrm/core/logger/index.js';
import { MetadataCache } from '@carocrm/metadata/cache/index.js';
import { MetadataRegistry } from '@carocrm/metadata/registry/index.js';
import type { EntityDefinition } from '@carocrm/metadata/schemas/index.js';
import { EntityDefinitionSchema } from '@carocrm/metadata/schemas/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service.js';
import type { ExtensionHost } from '../extensions/extension-host.js';
import { EXTENSION_HOST } from '../extensions/extension-host.js';
import { FormulaService } from '../logic/formula.service.js';

interface AppScopeData {
  entity?: Record<string, unknown>;
}

/**
 * Seam for the navigation group keys an entity's `nav.group` may name
 * (PLAN_Phase_20_Settings_UX.md §4.5). The admin panel owns the menu, so the metadata writer asks
 * for the accepted keys instead of importing the panel — the dependency stays pointing at the
 * kernel. An installation that wires nothing leaves the check open.
 */
export const NAVIGATION_GROUP_KEYS = Symbol('NAVIGATION_GROUP_KEYS');
export type NavigationGroupKeys = ReadonlySet<string>;

@Injectable()
export class MetadataStoreService {
  readonly registry = new MetadataRegistry();
  readonly cache = new MetadataCache(this.registry);
  private loaded = false;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(FormulaService) private readonly formulas: FormulaService,
    @Inject(EXTENSION_HOST) private readonly extensions: ExtensionHost,
  ) {}

  /**
   * Loads metadata in the documented precedence order (PLAN §12.2):
   *
   * ```text
   * core metadata_entries  →  extension packages (module `order`, PLAN §39)  →  admin overrides
   * ```
   *
   * The last layer is `app_settings.entity`, which the Entity Manager writes, so an administrator's
   * change always wins over whatever a package contributed.
   */
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
    const contributed = this.extensions.mergedMetadata();
    for (const [name, data] of Object.entries(contributed.entities ?? {})) {
      byName.set(name, mergeExtensionEntity(byName.get(name), data as Record<string, unknown>));
    }
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
    log.info({ entities: this.registry.getEntities().length, extensions: this.extensions.ids() }, 'metadata loaded');
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

/**
 * Merge for an extension contribution (PLAN §39).
 *
 * Same shape as the admin patch merge, except that `indexes` are **concatenated**: an extension
 * adding an index to a core entity must not silently drop the indexes that entity already declares.
 * Indexes are metadata declarations only — nothing here touches the physical schema (AGENTS.md §3.4).
 */
function mergeExtensionEntity(base: Record<string, unknown> | undefined, contribution: Record<string, unknown>): Record<string, unknown> {
  const merged = mergeEntityData(base, contribution);
  if (base !== undefined && Array.isArray(base['indexes']) && Array.isArray(contribution['indexes'])) {
    merged['indexes'] = [...(base['indexes'] as unknown[]), ...(contribution['indexes'] as unknown[])];
  }
  return merged;
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
