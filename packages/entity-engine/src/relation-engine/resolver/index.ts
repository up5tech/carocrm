import { log } from '@carocrm/core/logger/index.js';
import { generateId } from '@carocrm/core/utils/id.js';

import type { LinkOptions, RelationCount,RelationLink, RelationQueryOptions  } from '../types.js';

export interface RelationStore {
  createLink(options: LinkOptions): Promise<RelationLink>;
  deleteLink(entityTypeA: string, recordIdA: string, relationName: string, recordIdB: string): Promise<boolean>;
  getRelated(options: RelationQueryOptions): Promise<{ list: unknown[]; total: number }>;
  countRelated(entity: string, id: string, relation: string): Promise<RelationCount>;
  replaceLinks(options: LinkOptions & { targetIds: string[] }): Promise<RelationLink[]>;
}

export class InMemoryRelationStore implements RelationStore {
  private links = new Map<string, RelationLink>();

  private key(a: string, b: string, rel: string, c: string): string {
    return `${a}:${b}:${rel}:${c}`;
  }

  async createLink(options: LinkOptions): Promise<RelationLink> {
    const link: RelationLink = {
      id: generateId(),
      entityTypeA: options.entityTypeA,
      recordIdA: options.recordIdA,
      relationName: options.relationName,
      entityTypeB: options.entityTypeB,
      recordIdB: options.recordIdB,
      roleA: options.roleA,
      roleB: options.roleB,
      createdAt: new Date(),
      metadata: options.metadata,
    };
    this.links.set(this.key(options.entityTypeA, options.recordIdA, options.relationName, options.recordIdB), link);
    return link;
  }

  async deleteLink(entityTypeA: string, recordIdA: string, relationName: string, recordIdB: string): Promise<boolean> {
    return this.links.delete(this.key(entityTypeA, recordIdA, relationName, recordIdB));
  }

  async getRelated(options: RelationQueryOptions): Promise<{ list: unknown[]; total: number }> {
    const list: unknown[] = [];
    for (const link of this.links.values()) {
      if (
        link.entityTypeA === options.entity &&
        link.recordIdA === options.id &&
        link.relationName === options.relation
      ) {
        list.push({ id: link.recordIdB, entityType: link.entityTypeB });
      }
    }
    return { list, total: list.length };
  }

  async countRelated(entity: string, id: string, relation: string): Promise<RelationCount> {
    let count = 0;
    for (const link of this.links.values()) {
      if (link.entityTypeA === entity && link.recordIdA === id && link.relationName === relation) {
        count++;
      }
    }
    return { count };
  }

  async replaceLinks(options: LinkOptions & { targetIds: string[] }): Promise<RelationLink[]> {
    const existing: RelationLink[] = [];
    for (const link of this.links.values()) {
      if (
        link.entityTypeA === options.entityTypeA &&
        link.recordIdA === options.recordIdA &&
        link.relationName === options.relationName
      ) {
        existing.push(link);
      }
    }
    for (const link of existing) {
      this.links.delete(this.key(link.entityTypeA, link.recordIdA, link.relationName, link.recordIdB));
    }
    const created: RelationLink[] = [];
    for (const targetId of options.targetIds) {
      const link = await this.createLink({ ...options, recordIdB: targetId });
      created.push(link);
    }
    return created;
  }
}

export class RelationResolver {
  constructor(private store: RelationStore) {}

  async link(options: LinkOptions): Promise<RelationLink> {
    log.debug({ ...options }, 'Linking records');
    return this.store.createLink(options);
  }

  async unlink(entityTypeA: string, recordIdA: string, relationName: string, recordIdB: string): Promise<boolean> {
    log.debug({ entityTypeA, recordIdA, relationName, recordIdB }, 'Unlinking records');
    return this.store.deleteLink(entityTypeA, recordIdA, relationName, recordIdB);
  }

  async getRelated(options: RelationQueryOptions): Promise<{ list: unknown[]; total: number }> {
    return this.store.getRelated(options);
  }

  async count(entity: string, id: string, relation: string): Promise<RelationCount> {
    return this.store.countRelated(entity, id, relation);
  }

  async replace(options: LinkOptions & { targetIds: string[] }): Promise<RelationLink[]> {
    return this.store.replaceLinks(options);
  }
}

export const RELATION_RESOLVER = Symbol('RELATION_RESOLVER');