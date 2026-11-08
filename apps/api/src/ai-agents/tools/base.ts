/**
 * Shared dependencies and field-validation helpers for the AI tool handlers (19-AI.25 split).
 */

import { ValidationError } from '@carocrm/core/errors/index.js';

import type { DocsService } from '../../docs/docs.service.js';
import type { EntityCrudService } from '../../entity/entity.service.js';
import type { MetadataStoreService } from '../../metadata/metadata-store.service.js';
import type { StreamService } from '../../stream/stream.service.js';
import type { AIAgentActorDirectoryService } from '../ai-agent-directory.service.js';
import type { AIAgentsSettingsService } from '../ai-agents-settings.service.js';
import { ACTIVITY_ENTITIES, READABLE_ENTITIES } from './schemas.js';

export class AIToolHandlerBase {
  constructor(
    protected readonly entities: EntityCrudService,
    protected readonly metadata: MetadataStoreService,
    protected readonly settings: AIAgentsSettingsService,
    protected readonly docs: DocsService,
    protected readonly actors: AIAgentActorDirectoryService,
    protected readonly stream: StreamService,
  ) {}

  protected assertReadableEntity(entity: string): void {
    if (!READABLE_ENTITIES.includes(entity as (typeof READABLE_ENTITIES)[number])) {
      throw new ValidationError(`Entity "${entity}" is not available to an agent.`);
    }
    if (!this.metadata.registry.hasEntity(entity)) {
      throw new ValidationError(`Entity "${entity}" is not registered in this deployment.`);
    }
  }

  protected assertField(entity: string, field: string): void {
    if (['createdById', 'modifiedById', 'deletedAt', 'deleted', 'teams'].includes(field)) {
      throw new ValidationError(`Field "${field}" is not readable through an agent.`);
    }
    const fields = this.metadata.registry.getFields(entity);
    if (fields[field] === undefined) {
      throw new ValidationError(`Unknown field "${field}" on "${entity}".`);
    }
  }

  protected assertActivityEntity(entity: string): void {
    if (!ACTIVITY_ENTITIES.includes(entity as (typeof ACTIVITY_ENTITIES)[number])) {
      throw new ValidationError(`"${entity}" is not an activity entity.`, { supported: [...ACTIVITY_ENTITIES] });
    }
    if (!this.metadata.registry.hasEntity(entity)) {
      throw new ValidationError(`Entity "${entity}" is not registered in this deployment.`);
    }
  }

  /** The metadata type of a field, asserting it exists. */
  protected fieldType(entity: string, field: string): string {
    const definition = this.metadata.registry.getField(entity, field);
    if (definition === undefined) {
      throw new ValidationError(`Unknown field "${field}" on "${entity}".`);
    }
    return definition.type;
  }

  /** A period can only be applied to a date; the candidate fields are listed so the model can retry. */
  protected assertDateField(entity: string, field: string): void {
    const type = this.fieldType(entity, field);
    if (type !== 'date' && type !== 'datetime') {
      throw new ValidationError(`Field "${field}" on "${entity}" is not a date field.`, {
        dateFields: this.dateFieldsOf(entity),
      });
    }
  }

  protected dateFieldsOf(entity: string): string[] {
    const fields = this.metadata.registry.getFields(entity);
    return Object.entries(fields)
      .filter(([name, definition]) => (definition.type === 'date' || definition.type === 'datetime') && name !== 'deletedAt')
      .map(([name]) => name)
      .slice(0, 8);
  }

  /**
   * Display labels for a grouping key.
   *
   * Grouping by `assignedUserId` is the most useful aggregate in a CRM and the least readable: the
   * keys are ids. One bounded query turns them into names, so the answer can say "Linh: 1.2B"
   * instead of "u_9f3a1c: 1200000".
   */
  protected async groupLabels(
    entity: string,
    field: string | undefined,
    keys: readonly string[],
  ): Promise<Record<string, string>> {
    if (field === undefined) return {};
    const definition = this.metadata.registry.getField(entity, field);
    if (definition?.type !== 'link' || definition.entityKey !== 'User') return {};
    const ids = keys.filter((key) => key !== '');
    if (ids.length === 0) return {};
    return this.actors.displayNames(ids);
  }
}
