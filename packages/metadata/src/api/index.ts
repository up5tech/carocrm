import { MetadataCache } from '../cache/index.js';
import { MetadataLoader } from '../loader/index.js';
import type { MetadataSource } from '../merger/index.js';
import { MetadataRegistry } from '../registry/index.js';
import type { MetadataManifest } from '../schemas/index.js';

export class MetadataService {
  private loader: MetadataLoader;
  private cache: MetadataCache;

  constructor(private registry: MetadataRegistry) {
    this.loader = new MetadataLoader(registry);
    this.cache = new MetadataCache(registry);
  }

  registerSource(source: MetadataSource): void {
    this.loader.registerSource(source);
  }

  async reload(): Promise<void> {
    await this.loader.load();
    this.cache.invalidate();
  }

  getMetadata(): Record<string, unknown> {
    return this.registry.getMetadata();
  }

  getMetadataVersion(): number {
    return this.registry.getMetadataVersion();
  }

  getEntity(name: string) {
    return this.registry.getEntity(name);
  }

  getEntities(): string[] {
    return this.registry.getEntities();
  }

  getEnabledEntities(): string[] {
    return this.registry.getEnabledEntities();
  }

  getField(entity: string, field: string) {
    return this.registry.getField(entity, field);
  }

  getFields(entity: string) {
    return this.registry.getFields(entity);
  }

  getRelation(entity: string, relation: string) {
    return this.registry.getRelation(entity, relation);
  }

  getRelations(entity: string) {
    return this.registry.getRelations(entity);
  }

  getLayout(entity: string, type: string) {
    return this.registry.getLayout(entity, type);
  }

  getAcl(entity: string) {
    return this.registry.getAcl(entity);
  }

  hasEntity(name: string): boolean {
    return this.registry.hasEntity(name);
  }

  isEntityEnabled(name: string): boolean {
    return this.registry.isEntityEnabled(name);
  }

  validateManifest(manifest: MetadataManifest): { valid: boolean; errors?: string[] } {
    const errors: string[] = [];
    if (!manifest.id) errors.push('Missing manifest id');
    if (!manifest.version) errors.push('Missing manifest version');
    if (!manifest.name) errors.push('Missing manifest name');
    if (errors.length === 0) return { valid: true };
    return { valid: false, errors };
  }
}

export const METADATA_SERVICE = Symbol('METADATA_SERVICE');