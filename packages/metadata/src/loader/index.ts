import { log } from '@carocrm/core/logger/index.js';

import type { MetadataSource } from '../merger/index.js';
import { MetadataMerger } from '../merger/index.js';
import { MetadataRegistry } from '../registry/index.js';
import type { EntityDefinition } from '../schemas/index.js';
import {  } from '../schemas/index.js';

export interface MetadataLoaderOptions {
  sources?: MetadataSource[];
  cacheEnabled?: boolean;
}

export class MetadataLoader {
  private merger = new MetadataMerger();

  constructor(
    private registry: MetadataRegistry,
    private options: MetadataLoaderOptions = {},
  ) {}

  async load(): Promise<void> {
    const sources = this.options.sources ?? [];
    const entities = this.merger.merge(sources);

    this.registry.clear();
    for (const entity of entities) {
      this.registry.registerEntity(entity);
    }

    for (const source of sources) {
      if (source.layouts) {
        for (const [entity, layouts] of Object.entries(source.layouts)) {
          for (const [type, layout] of Object.entries(layouts)) {
            this.registry.setLayout(entity, type, layout);
          }
        }
      }
      if (source.acl) {
        for (const [entity, acl] of Object.entries(source.acl)) {
          this.registry.setAcl(entity, acl);
        }
      }
      if (source.permissions) {
        for (const [name, permission] of Object.entries(source.permissions)) {
          this.registry.setPermission(name, permission);
        }
      }
      if (source.jobs) {
        for (const [name, job] of Object.entries(source.jobs)) {
          this.registry.setJob(name, job);
        }
      }
      if (source.routes) {
        for (const [path, route] of Object.entries(source.routes)) {
          this.registry.setRoute(path, route);
        }
      }
    }

    log.info({ entityCount: entities.length, version: this.registry.getMetadataVersion() }, 'Metadata loaded');
  }

  registerSource(source: MetadataSource): void {
    this.options.sources = [...(this.options.sources ?? []), source];
  }

  getEntities(): string[] {
    return this.registry.getEntities();
  }

  getEntity(name: string): EntityDefinition | undefined {
    return this.registry.getEntity(name);
  }
}

export const METADATA_LOADER = Symbol('METADATA_LOADER');