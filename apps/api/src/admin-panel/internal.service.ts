import { randomUUID } from 'node:crypto';

import { AuthorizationDeniedError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import { EXTENSION_HOST, type ExtensionHost } from '../extensions/extension-host.js';
import { JobQueueService } from '../jobs/job-queue.service.js';
import type { MetadataStoreService } from '../metadata/metadata-store.service.js';
import { METADATA_STORE } from '../metadata/metadata-store.service.js';
import { SettingsRegistryService } from './settings-registry.service.js';

/** The exact strings the danger-zone forms make the administrator type before the server acts. */
export const METADATA_RESET_CONFIRM = 'RESET METADATA';
export const QUEUE_PURGE_CONFIRM = 'PURGE QUEUE';

/** What the internal tab shows: facts about this instance, and nothing that belongs to a tenant. */
export interface InternalInfoView {
  metadataVersion: number;
  entityCount: number;
  /** Administrator-written per-entity overrides (`app_settings.entity`) the danger zone would clear. */
  overrideCount: number;
  jobQueue: { name: string; counts: Record<string, number> | null };
  extensions: readonly string[];
  nodeVersion: string;
  uptimeSeconds: number;
}

/**
 * The `internal` tab's backend (PLAN_Phase_20_Settings_UX.md §4.3 row 8).
 *
 * Reads are administrator-only facts. The two writes are the guarded danger zone: each demands the
 * exact typed confirmation string, and each lands in `schema_changes` — a destructive action no one
 * asked for must at least be attributable afterwards. The reset deliberately keeps to metadata
 * overrides: it restores the shipped definitions, it never touches record data.
 */
@Injectable()
export class InternalInfoService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(METADATA_STORE) private readonly store: MetadataStoreService,
    @Inject(SettingsRegistryService) private readonly registry: SettingsRegistryService,
    @Inject(JobQueueService) private readonly queue: JobQueueService,
    @Inject(EXTENSION_HOST) private readonly extensions: ExtensionHost,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  /** Same predicate as a `sysAdmin` document: the one administrative tier this instance has. */
  private requireSysAdmin(): void {
    if (!this.registry.mayRead('sysAdmin')) {
      throw new AuthorizationDeniedError('System-administrator access is required.');
    }
  }

  private assertConfirm(confirm: unknown, expected: string): void {
    if (confirm !== expected) {
      throw new ValidationError('Type the exact confirmation phrase to run this action.', { expected });
    }
  }

  async info(): Promise<InternalInfoView> {
    this.requireSysAdmin();
    this.store.ensureLoaded();
    const overrideCount = await this.readOverrideCount();
    let counts: Record<string, number> | null = null;
    try {
      counts = await this.queue.counts();
    } catch {
      // A queue that is not reachable right now is a fact to show, not a failed request.
      counts = null;
    }
    return {
      metadataVersion: this.store.version(),
      entityCount: this.store.registry.getEntities().length,
      overrideCount,
      jobQueue: { name: this.queue.queueName, counts },
      extensions: this.extensions.ids(),
      nodeVersion: process.version,
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  /** Drops every administrator-written entity override; the shipped definitions take over again. */
  async resetMetadataOverrides(confirm: unknown): Promise<{ cleared: number }> {
    this.requireSysAdmin();
    this.assertConfirm(confirm, METADATA_RESET_CONFIRM);
    const cleared = await this.readOverrideCount();
    await this.database.db.deleteFrom('app_settings').where('name', '=', 'entity').execute();
    // Same invalidation the Entity Manager patch path uses: the next read rebuilds from the database.
    this.store.cache.invalidate();
    await this.audit('admin.internal.metadataReset', { actor: this.actorName(), cleared });
    return { cleared };
  }

  /** Removes the jobs waiting in the queue. Active and completed jobs are left where they are. */
  async purgeJobQueue(confirm: unknown): Promise<{ drained: number | null }> {
    this.requireSysAdmin();
    this.assertConfirm(confirm, QUEUE_PURGE_CONFIRM);
    let before: Record<string, number> | null = null;
    try {
      before = await this.queue.counts();
    } catch {
      before = null;
    }
    if (before === null) {
      throw new ValidationError('The job queue is not reachable, so there is nothing to purge.', { queue: this.queue.queueName });
    }
    const drained = before['waiting'] ?? 0;
    await this.queue.purgeWaiting();
    await this.audit('admin.internal.queuePurge', { actor: this.actorName(), drained, countsBefore: before });
    return { drained };
  }

  private async readOverrideCount(): Promise<number> {
    const row = await this.database.db.selectFrom('app_settings').select('data').where('name', '=', 'entity').executeTakeFirst();
    const entities = (row?.data as { entity?: Record<string, unknown> } | undefined)?.entity;
    return entities === undefined || entities === null ? 0 : Object.keys(entities).length;
  }

  private actorName(): string | null {
    return this.scope.principal?.userName ?? this.scope.userId ?? null;
  }

  /** The same `schema_changes` seam the settings documents and the Entity Manager write to. */
  private async audit(operation: string, payload: Record<string, unknown>): Promise<void> {
    await this.database.db
      .insertInto('schema_changes')
      .values({
        id: randomUUID(),
        operation,
        entity_type: 'Internal',
        field_name: null,
        payload: JSON.stringify(payload),
        status: 'applied',
        error: null,
        created_at: new Date(),
        applied_at: new Date(),
      })
      .execute();
  }
}
