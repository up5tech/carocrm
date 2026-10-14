import type { EntityDefinition , FieldDefinition, RelationDefinition } from '../schemas/index.js';

export class MetadataRegistry {
  private entities = new Map<string, EntityDefinition>();
  private fields = new Map<string, Map<string, FieldDefinition>>();
  private relations = new Map<string, Map<string, RelationDefinition>>();
  private layouts = new Map<string, unknown>();
  private acl = new Map<string, unknown>();
  private permissions = new Map<string, unknown>();
  private jobs = new Map<string, unknown>();
  private routes = new Map<string, unknown>();
  private version = 0;

  registerEntity(definition: EntityDefinition): void {
    this.entities.set(definition.name, definition);
    this.fields.set(definition.name, new Map(Object.entries(definition.fields)));
    this.relations.set(definition.name, new Map(Object.entries(definition.relations)));
    this.version++;
  }

  getEntity(name: string): EntityDefinition | undefined {
    return this.entities.get(name);
  }

  getEntities(): string[] {
    return Array.from(this.entities.keys()).sort();
  }

  getField(entity: string, field: string): FieldDefinition | undefined {
    return this.fields.get(entity)?.get(field);
  }

  getFields(entity: string): Record<string, FieldDefinition> {
    const map = this.fields.get(entity);
    if (!map) return {};
    return Object.fromEntries(map);
  }

  getRelation(entity: string, relation: string): RelationDefinition | undefined {
    return this.relations.get(entity)?.get(relation);
  }

  getRelations(entity: string): Record<string, RelationDefinition> {
    const map = this.relations.get(entity);
    if (!map) return {};
    return Object.fromEntries(map);
  }

  getLayout(entity: string, type: string): unknown {
    return this.layouts.get(`${entity}:${type}`);
  }

  setLayout(entity: string, type: string, layout: unknown): void {
    this.layouts.set(`${entity}:${type}`, layout);
    this.version++;
  }

  /** Per-view panel layouts persisted on the entity definition (PLAN §8). */
  getEntityLayouts(entity: string): Record<string, unknown[]> {
    const def = this.entities.get(entity);
    const layouts = def?.layouts as Record<string, unknown[]> | undefined;
    return layouts ?? {};
  }

  setEntityLayouts(entity: string, layouts: Record<string, unknown[]>): void {
    const def = this.entities.get(entity);
    if (!def) return;
    (def as { layouts: Record<string, unknown[]> }).layouts = layouts;
    this.version++;
  }

  /** Index definitions persisted on the entity definition (PLAN §8). */
  getEntityIndexes(entity: string): unknown[] {
    const def = this.entities.get(entity);
    return (def?.indexes as unknown[] | undefined) ?? [];
  }

  setEntityIndexes(entity: string, indexes: unknown[]): void {
    const def = this.entities.get(entity);
    if (!def) return;
    (def as { indexes: unknown[] }).indexes = indexes;
    this.version++;
  }

  getAcl(entity: string): unknown {
    return this.acl.get(entity);
  }

  setAcl(entity: string, acl: unknown): void {
    this.acl.set(entity, acl);
    this.version++;
  }

  getPermission(name: string): unknown {
    return this.permissions.get(name);
  }

  setPermission(name: string, permission: unknown): void {
    this.permissions.set(name, permission);
    this.version++;
  }

  getJob(name: string): unknown {
    return this.jobs.get(name);
  }

  setJob(name: string, job: unknown): void {
    this.jobs.set(name, job);
    this.version++;
  }

  getRoute(path: string): unknown {
    return this.routes.get(path);
  }

  setRoute(path: string, route: unknown): void {
    this.routes.set(path, route);
    this.version++;
  }

  getMetadata(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [name, def] of this.entities) {
      result[name] = {
        name: def.name,
        label: def.label,
        icon: def.icon,
        isEntity: def.isEntity,
        fields: this.getFields(name),
        relations: this.getRelations(name),
        indexes: def.indexes ?? [],
        layouts: def.layouts ?? {},
        record: def.record,
        client: def.client,
        acl: def.acl ?? this.getAcl(name),
        dynamicLogic: def.dynamicLogic,
      };
    }
    return result;
  }

  getMetadataVersion(): number {
    return this.version;
  }

  invalidate(): void {
    this.version++;
  }

  clear(): void {
    this.entities.clear();
    this.fields.clear();
    this.relations.clear();
    this.layouts.clear();
    this.acl.clear();
    this.permissions.clear();
    this.jobs.clear();
    this.routes.clear();
    this.version = 0;
  }

  hasEntity(name: string): boolean {
    return this.entities.has(name);
  }

  isEntityEnabled(name: string): boolean {
    const def = this.entities.get(name);
    return def ? def.isEntity : false;
  }

  getEnabledEntities(): string[] {
    return Array.from(this.entities.entries())
      .filter(([, def]) => def.isEntity)
      .map(([name]) => name)
      .sort();
  }
}

export const METADATA_REGISTRY = Symbol('METADATA_REGISTRY');