import { describe, expect, it } from 'vitest';

import { EntityDefinitionSchema } from '../schemas/index.js';
import { MetadataRegistry } from './index.js';

/**
 * The registry's bulk document (`GET /api/v1/Metadata`).
 *
 * It is built from an explicit list of sections rather than by spreading the definition, so a
 * section missing from that list reaches the API but never the SPA: the record page reads the whole
 * document in one call, and a page asking for `detailTabs` would silently render the default. The
 * cases below pin the sections that exist for that reason.
 */
describe('MetadataRegistry.getMetadata', () => {
  const definition = EntityDefinitionSchema.parse({
    name: 'Account',
    label: 'Account',
    fields: { name: { type: 'varchar' } },
    relations: { contacts: { type: 'oneToMany', target: 'Contact' } },
    detailTabs: { mode: 'tabs', tabs: [{ id: 'people', label: 'People', order: 0, relations: ['contacts'] }] },
  });

  it('serves the relation-tab arrangement of an entity', () => {
    const registry = new MetadataRegistry();
    registry.registerEntity(definition);

    const metadata = registry.getMetadata() as Record<string, { detailTabs?: unknown }>;
    expect(metadata['Account']?.detailTabs).toEqual({
      mode: 'tabs',
      tabs: [{ id: 'people', label: 'People', order: 0, relations: ['contacts'] }],
    });
  });

  it('leaves the section out when the entity has never been arranged', () => {
    const registry = new MetadataRegistry();
    registry.registerEntity(
      EntityDefinitionSchema.parse({ name: 'Contact', label: 'Contact', fields: { name: { type: 'varchar' } }, relations: {} }),
    );

    const metadata = registry.getMetadata() as Record<string, { detailTabs?: unknown }>;
    expect(metadata['Contact']?.detailTabs).toBeUndefined();
  });
});
