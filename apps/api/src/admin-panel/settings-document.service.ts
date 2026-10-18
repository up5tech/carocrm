import { randomUUID } from 'node:crypto';

import { AppError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import { DatabaseService, type Db, type DbTx } from '../database/database.service.js';
import { EventBus } from '../events/event-bus.js';
import type { SettingsDocumentDefinition, SettingsWarning } from './settings-registry.service.js';
import { SettingsRegistryService } from './settings-registry.service.js';

/**
 * Read, write and reset for the settings documents registered in `SettingsRegistryService`
 * (PLAN_Phase_20_Settings_UX.md §4.2, §6.2, §7.2). Every document stays one row of the existing
 * `app_settings` table, so this phase adds no settings store.
 */
export interface SettingsDocumentView<T = unknown> {
  readonly name: string;
  readonly group: string;
  readonly labelKey: string;
  readonly descriptionKey: string | undefined;
  readonly readLevel: string;
  readonly writeLevel: string;
  readonly value: T;
  readonly version: number;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly warnings: readonly SettingsWarning[];
}

/** Version and actor live inside the row JSON: `app_settings` has only `name/data/modified_at`. */
const BOOKKEEPING_KEYS = new Set(['version', 'updatedAt', 'updatedBy', 'updatedById']);

@Injectable()
export class SettingsDocumentService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(SettingsRegistryService) private readonly registry: SettingsRegistryService,
    @Inject(EventBus) private readonly events: EventBus,
  ) {}

  async read(name: string): Promise<SettingsDocumentView> {
    const definition = this.registry.get(name);
    this.assertReadAccess(definition);
    return this.readRow(definition);
  }

  /**
   * Apply a patch and bump the document version. `expectedVersion` is the version the caller read;
   * when it no longer matches the stored row the write is refused with 409 and the current version,
   * so a replayed payload cannot apply twice and two administrators cannot overwrite each other
   * silently (§8.4, §11).
   */
  async write(name: string, patch: unknown, expectedVersion?: number): Promise<SettingsDocumentView> {
    const definition = this.registry.get(name);
    this.registry.assertWriteAccess(definition);
    return this.apply(definition, { patch: asObject(patch), replace: false, expectedVersion });
  }

  /** Restore the registered default document, not `null`, so readers never see a missing row (§6.2). */
  async reset(name: string): Promise<SettingsDocumentView> {
    const definition = this.registry.get(name);
    this.registry.assertWriteAccess(definition);
    return this.apply(definition, { patch: asObject(definition.defaults), replace: true, expectedVersion: undefined });
  }

  /** Catalog entries for `GET /Settings/documents` — registry metadata only, no row reads. */
  catalog(): ReturnType<SettingsRegistryService['listVisible']> {
    return this.registry.listVisible();
  }

  /**
   * Read a document for a server-side consumer (the navigation resolver) that must not depend on the
   * caller's settings level: the resolved tree is open to every user while the raw document is not.
   */
  async readInternal(name: string): Promise<{ value: unknown; version: number }> {
    const definition = this.registry.get(name);
    const view = await this.readRow(definition);
    return { value: view.value, version: view.version };
  }

  /**
   * Subscribe to successful writes so an in-process consumer (the navigation cache) can drop its
   * copy the moment the document changes — otherwise an administrator who reorders the menu waits up
   * to the cache TTL to see their own change.
   */
  onChanged(listener: (name: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private readonly listeners = new Set<(name: string) => void>();

  private async apply(
    definition: SettingsDocumentDefinition,
    input: { patch: Record<string, unknown>; replace: boolean; expectedVersion: number | undefined },
  ): Promise<SettingsDocumentView> {
    const before = await this.readRow(definition);

    // A legacy document (brand, i18n) is written by the service that owns its rules (§7.1); the row
    // shape stays theirs and this service only guards and stamps the version. That guard is
    // best-effort for these two, because the pre-Phase-20 route still writes the same row without a
    // version. Everything else is written here, inside one transaction.
    if (definition.write !== undefined) {
      this.assertVersion(definition, before, input.expectedVersion);
      await definition.write(input.replace ? (definition.defaults as Record<string, unknown>) : input.patch);
      await this.stamp(definition, before.version + 1);
      const after = await this.readRow(definition);
      await this.recordChange(definition, before, after);
      return after;
    }

    const written = await this.database.db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom('app_settings')
        .select(['data', 'modified_at'])
        .where('name', '=', definition.row ?? definition.name)
        .forUpdate()
        .executeTakeFirst();
      const current = this.toView(definition, row?.data, row?.modified_at ?? null);
      this.assertVersion(definition, current, input.expectedVersion);
      const value = input.replace
        ? validate(definition, definition.defaults)
        : validate(definition, mergeValue(current.value, input.patch));
      const data: Record<string, unknown> = {
        value,
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
        updatedBy: this.scope.principal?.userName ?? this.scope.userId ?? null,
        updatedById: this.scope.userId ?? null,
      };
      await upsert(tx, definition.row ?? definition.name, data);
      return data;
    });

    const after = this.toView(definition, written, null);
    await this.recordChange(definition, before, after);
    return after;
  }

  private assertReadAccess(definition: SettingsDocumentDefinition): void {
    if (!this.registry.mayRead(definition.readLevel)) {
      throw new AppError('AUTHORIZATION_DENIED', `Administrator access is required to read "${definition.name}" settings.`, {
        document: definition.name,
        level: definition.readLevel,
      }, 403);
    }
  }

  private async readRow(definition: SettingsDocumentDefinition): Promise<SettingsDocumentView> {
    const row = await this.database.db
      .selectFrom('app_settings')
      .select(['data', 'modified_at'])
      .where('name', '=', definition.row ?? definition.name)
      .executeTakeFirst();
    return this.toView(definition, row?.data, row?.modified_at ?? null);
  }

  private assertVersion(definition: SettingsDocumentDefinition, current: SettingsDocumentView, expectedVersion?: number): void {
    if (expectedVersion === undefined || expectedVersion === current.version) return;
    throw new AppError(
      'CONCURRENCY_CONFLICT',
      `"${definition.name}" settings were changed by someone else. Reload the tab before saving.`,
      { document: definition.name, expectedVersion, currentVersion: current.version },
      409,
    );
  }

  /** Add version bookkeeping to a row its owning service has just written. */
  private async stamp(definition: SettingsDocumentDefinition, version: number): Promise<void> {
    const rowName = definition.row ?? definition.name;
    const existing = await this.database.db.selectFrom('app_settings').select('data').where('name', '=', rowName).executeTakeFirst();
    const stored = isRecord(existing?.data) ? { ...existing.data } : {};
    stored['version'] = version;
    stored['updatedAt'] = new Date().toISOString();
    stored['updatedBy'] = this.scope.principal?.userName ?? this.scope.userId ?? null;
    stored['updatedById'] = this.scope.userId ?? null;
    await upsert(this.database.db, rowName, stored);
  }

  /**
   * Configuration changes are audited through the same `schema_changes` seam the Entity Manager
   * uses, and published as a domain event so caches can drop the old value (§12). Only the changed
   * key names are recorded — a document may hold a policy that must not end up in an audit row.
   */
  private async recordChange(definition: SettingsDocumentDefinition, before: SettingsDocumentView, after: SettingsDocumentView): Promise<void> {
    const changed = changedKeys(before.value, after.value);
    const db = this.database.db;
    await db
      .insertInto('schema_changes')
      .values({
        id: randomUUID(),
        operation: 'settings.document.update',
        entity_type: definition.name,
        field_name: null,
        payload: JSON.stringify({
          document: definition.name,
          changedKeys: changed,
          fromVersion: before.version,
          toVersion: after.version,
          actor: this.scope.principal?.userName ?? this.scope.userId ?? null,
        }),
        status: 'applied',
        error: null,
        created_at: new Date(),
        applied_at: new Date(),
      })
      .execute();
    await this.events.dispatch(db, {
      type: 'settings.document.updated',
      payload: { document: definition.name, version: after.version, changedKeys: changed },
    });
    for (const listener of this.listeners) listener(definition.name);
  }

  private toView(definition: SettingsDocumentDefinition, data: unknown, modifiedAt: Date | null): SettingsDocumentView {
    const stored = isRecord(data) ? data : {};
    const value = decodeValue(definition, data);
    const version = stored['version'];
    const updatedAt = stored['updatedAt'];
    const updatedBy = stored['updatedBy'];
    return {
      name: definition.name,
      group: definition.group,
      labelKey: definition.labelKey,
      descriptionKey: definition.descriptionKey,
      readLevel: definition.readLevel,
      writeLevel: definition.writeLevel,
      value,
      version: typeof version === 'number' && Number.isInteger(version) ? version : 0,
      updatedAt: typeof updatedAt === 'string' ? updatedAt : (modifiedAt?.toISOString() ?? null),
      updatedBy: typeof updatedBy === 'string' ? updatedBy : null,
      warnings: definition.warnings === undefined ? [] : definition.warnings(value),
    };
  }
}

function decodeValue(definition: SettingsDocumentDefinition, data: unknown): unknown {
  const stored = isRecord(data) ? data : {};
  const raw = definition.storage === 'envelope' ? stored['value'] : omitBookkeeping(stored);
  const parsed = definition.schema.safeParse(raw ?? {});
  // A row that no longer satisfies the schema (an upgrade renamed a policy) falls back to the
  // registered defaults rather than refusing to paint the settings page — the Sales behaviour.
  return parsed.success ? parsed.data : definition.defaults;
}

function validate(definition: SettingsDocumentDefinition, candidate: unknown): unknown {
  const parsed = definition.schema.safeParse(candidate);
  if (!parsed.success) {
    throw new ValidationError(`Invalid "${definition.name}" settings.`, {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  return parsed.data;
}

function omitBookkeeping(stored: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stored)) {
    if (!BOOKKEEPING_KEYS.has(key)) out[key] = value;
  }
  return out;
}

/** Objects merge key by key; arrays and scalars replace, which is what the tab forms send. */
function mergeValue(base: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = isRecord(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    const current = merged[key];
    merged[key] = isRecord(current) && isRecord(value) ? mergeValue(current, value) : value;
  }
  return merged;
}

function changedKeys(before: unknown, after: unknown): string[] {
  if (!isRecord(before) || !isRecord(after)) return ['value'];
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asObject(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) throw new ValidationError('Settings payload must be a JSON object.');
  return body;
}

async function upsert(db: Db | DbTx, name: string, data: Record<string, unknown>): Promise<void> {
  const serialized = JSON.stringify(data);
  await db
    .insertInto('app_settings')
    .values({ name, data: serialized, modified_at: new Date() })
    .onConflict((oc) => oc.column('name').doUpdateSet({ data: serialized, modified_at: new Date() }))
    .execute();
}
