import type { EntityDefinition, FieldDefinition, IndexDefinition,RelationDefinition } from '../schemas/index.js';

export interface MetadataSource {
  entities?: Record<string, Partial<EntityDefinition>>;
  layouts?: Record<string, Record<string, unknown>>;
  acl?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  jobs?: Record<string, unknown>;
  routes?: Record<string, unknown>;
}

export class MetadataMerger {
  merge(sources: MetadataSource[]): EntityDefinition[] {
    const mergedEntities = new Map<string, Partial<EntityDefinition>>();

    for (const source of sources) {
      if (!source.entities) continue;

      for (const [name, definition] of Object.entries(source.entities)) {
        const existing = mergedEntities.get(name);
        if (existing) {
          mergedEntities.set(name, this.mergeEntity(existing, definition));
        } else {
          mergedEntities.set(name, { ...definition });
        }
      }
    }

    return Array.from(mergedEntities.values()) as EntityDefinition[];
  }

  private mergeEntity(
    base: Partial<EntityDefinition>,
    override: Partial<EntityDefinition>,
  ): Partial<EntityDefinition> {
    const result: Partial<EntityDefinition> = { ...base };

    for (const key of Object.keys(override) as (keyof Partial<EntityDefinition>)[]) {
      const value = override[key];
      if (value === undefined) continue;

      if (key === 'fields') {
        result.fields = {
          ...(base.fields as Record<string, FieldDefinition>),
          ...(value as Record<string, FieldDefinition>),
        };
      } else if (key === 'relations') {
        result.relations = {
          ...(base.relations as Record<string, RelationDefinition>),
          ...(value as Record<string, RelationDefinition>),
        };
      } else if (key === 'indexes') {
        result.indexes = [...(base.indexes ?? []), ...(value as IndexDefinition[])];
      } else {
        (result as Record<string, unknown>)[key] = value;
      }
    }

    return result;
  }
}