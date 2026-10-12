import type { ProcessDefinition } from '@carocrm/bpm';
import { ANY_ENTITY, definitionIssues, ProcessValidationError, validateProcess } from '@carocrm/bpm';
import { AuthorizationDeniedError, DuplicateRecordError, NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { log } from '@carocrm/core/logger/index.js';
import { generateId } from '@carocrm/core/utils/id.js';
import { WORKFLOW_ACTIONS } from '@carocrm/workflow';
import { Inject, Injectable } from '@nestjs/common';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';

/**
 * Process definition administration (PLAN §36).
 *
 * The versioning rule is identical to workflows (§35) on purpose — one mental model for both:
 *
 *  - the identity (`process_definitions` row) carries the stable `key` instances are started by;
 *  - every save writes the *draft* version; a published version is immutable;
 *  - publishing freezes the current draft, so an instance that started against version N still runs
 *    the exact definition it began with while somebody edits N+1;
 *  - enabling is separate from publishing: a published process accepts no instances until enabled.
 *
 * Execution does not happen here. The API walks the state machine when a person acts (a task is
 * answered, an instance is started or cancelled) and the worker fires timers and runs dispatched
 * service tasks — both drive the pure engine in `@carocrm/bpm`.
 */

export type ProcessVersionStatus = 'draft' | 'published' | 'archived';

/** A process key is the handle instances are started by: lowercase, stable, URL-safe. */
const KEY_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

export interface ProcessVersionView {
  id: string;
  version: number;
  status: ProcessVersionStatus;
  definition: ProcessDefinition;
  createdAt: string;
  publishedAt: string | null;
}

export interface ProcessView {
  id: string;
  key: string;
  name: string;
  description: string | null;
  entityType: string;
  isActive: boolean;
  currentVersion: number | null;
  currentVersionStatus: ProcessVersionStatus | null;
  publishedVersion: number | null;
  versions: readonly ProcessVersionView[];
  createdAt: string;
  modifiedAt: string;
  /** A draft that fails validation is still stored, but it can never be published or started. */
  issues: { code: string; message: string; path?: string | undefined }[];
}

export interface CreateProcessInput {
  key: string;
  name: string;
  description?: string | undefined;
  definition: unknown;
}

export interface UpdateProcessInput {
  name?: string | undefined;
  description?: string | undefined;
  definition?: unknown;
}

/** What the runtime needs to start an instance: an enabled, published definition. */
export interface PublishedProcess {
  definitionId: string;
  versionId: string;
  name: string;
  key: string;
  entityType: string;
  definition: ProcessDefinition;
}

@Injectable()
export class ProcessService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  // ---------------------------------------------------------------- definitions

  async list(): Promise<{ list: ProcessView[]; total: number }> {
    this.requireAdmin();
    const rows = await this.database.db
      .selectFrom('process_definitions')
      .selectAll()
      .where('is_deleted', '=', false)
      .orderBy('name', 'asc')
      .execute();
    const versions = await this.versionsByProcess(rows.map((row) => row.id));
    const list = rows.map((row) => toView(row, versions.get(row.id) ?? []));
    return { list, total: list.length };
  }

  async get(id: string): Promise<ProcessView> {
    this.requireAdmin();
    const row = await this.processRow(id);
    const versions = await this.versionsByProcess([row.id]);
    return toView(row, versions.get(row.id) ?? []);
  }

  /** Creates the process and its first (draft) version. Nothing can run until it is published. */
  async create(input: CreateProcessInput): Promise<ProcessView> {
    this.requireAdmin();
    const key = requireKey(input.key);
    const name = requireName(input.name);
    const definition = this.validateOrThrow(input.definition);
    if (await this.keyTaken(key)) {
      throw new DuplicateRecordError(`A process with the key "${key}" already exists.`, { key });
    }

    const id = generateId();
    const versionId = generateId();
    await this.database.db
      .insertInto('process_definitions')
      .values({
        id,
        key,
        name,
        description: input.description ?? null,
        entity_type: definition.entityType ?? ANY_ENTITY,
        is_active: false,
        current_version_id: versionId,
        published_version_id: null,
        is_deleted: false,
        created_by_id: this.scope.userId ?? null,
        modified_by_id: this.scope.userId ?? null,
        created_at: new Date(),
        modified_at: new Date(),
      })
      .execute();
    await this.insertVersion(id, versionId, 1, definition, 'draft');
    log.info({ process: id, key, name }, 'process definition created');
    return this.get(id);
  }

  /**
   * Saves the draft. When the latest version is already published the edit becomes a **new** draft
   * version — a published version is immutable, and running instances keep pointing at it.
   */
  async update(id: string, input: UpdateProcessInput): Promise<ProcessView> {
    this.requireAdmin();
    const row = await this.processRow(id);
    const all = (await this.versionsByProcess([row.id])).get(row.id) ?? [];
    const current = all.find((version) => version.id === row.current_version_id) ?? all[0];
    if (current === undefined) throw new ValidationError(`Process "${id}" has no version to edit.`);

    const name = input.name === undefined ? row.name : requireName(input.name);
    const description = input.description === undefined ? row.description : input.description;
    const definition = input.definition === undefined ? undefined : this.validateOrThrow(input.definition);

    if (definition === undefined) {
      await this.database.db
        .updateTable('process_definitions')
        .set({ name, description, modified_by_id: this.scope.userId ?? null, modified_at: new Date() })
        .where('id', '=', row.id)
        .execute();
      return this.get(row.id);
    }

    const reusable = current.status === 'draft';
    const versionId = reusable ? current.id : generateId();
    const latest = all[0];
    const version = reusable ? current.version : (latest?.version ?? current.version) + 1;

    if (reusable) {
      await this.database.db
        .updateTable('process_definition_versions')
        .set({ definition: JSON.stringify(definition) })
        .where('id', '=', current.id)
        .execute();
    } else {
      await this.insertVersion(row.id, versionId, version, definition, 'draft');
    }

    await this.database.db
      .updateTable('process_definitions')
      .set({
        name,
        description,
        entity_type: definition.entityType ?? ANY_ENTITY,
        current_version_id: versionId,
        modified_by_id: this.scope.userId ?? null,
        modified_at: new Date(),
      })
      .where('id', '=', row.id)
      .execute();
    return this.get(row.id);
  }

  /** Publishes the current draft: the version becomes immutable and the one instances run against. */
  async publish(id: string): Promise<ProcessView> {
    this.requireAdmin();
    const row = await this.processRow(id);
    const current = await this.currentVersion(row);
    if (current.status === 'published') {
      throw new ValidationError(`Version ${String(current.version)} is already published.`, { version: current.version });
    }
    // Re-validate at publish time: the published version is what instances execute, so this is the
    // last chance to refuse a definition the engine could not run (a hand-edited row, a build that
    // no longer implements an action, …).
    this.validateOrThrow(current.definition);

    const now = new Date();
    await this.database.db.transaction().execute(async (tx) => {
      if (row.published_version_id !== null) {
        await tx
          .updateTable('process_definition_versions')
          .set({ status: 'archived' })
          .where('id', '=', row.published_version_id)
          .execute();
      }
      await tx
        .updateTable('process_definition_versions')
        .set({ status: 'published', published_at: now })
        .where('id', '=', current.id)
        .execute();
      await tx
        .updateTable('process_definitions')
        .set({ published_version_id: current.id, modified_by_id: this.scope.userId ?? null, modified_at: now })
        .where('id', '=', row.id)
        .execute();
    });
    log.info({ process: id, version: current.version }, 'process published');
    return this.get(id);
  }

  /** Enabling gates *starting new instances*; it never interrupts instances already running. */
  async setEnabled(id: string, enabled: boolean): Promise<ProcessView> {
    this.requireAdmin();
    const row = await this.processRow(id);
    if (enabled && row.published_version_id === null) {
      throw new ValidationError('Publish the process before enabling it.');
    }
    await this.database.db
      .updateTable('process_definitions')
      .set({ is_active: enabled, modified_by_id: this.scope.userId ?? null, modified_at: new Date() })
      .where('id', '=', row.id)
      .execute();
    return this.get(id);
  }

  /** Soft delete: instances in flight keep their definition and finish against it. */
  async remove(id: string): Promise<{ id: string; deleted: true }> {
    this.requireAdmin();
    await this.processRow(id);
    await this.database.db
      .updateTable('process_definitions')
      .set({ is_deleted: true, is_active: false, modified_by_id: this.scope.userId ?? null, modified_at: new Date() })
      .where('id', '=', id)
      .execute();
    return { id, deleted: true };
  }

  async validate(definition: unknown): Promise<{ valid: boolean; issues: { code: string; message: string; path?: string | undefined }[] }> {
    this.requireAdmin();
    const issues = definitionIssues(definition);
    return { valid: issues.length === 0, issues: issues.map((issue) => ({ code: issue.code, message: issue.message, ...(issue.path === undefined ? {} : { path: issue.path }) })) };
  }

  /** What the editor offers: the action catalog and the node vocabulary. */
  async catalog(): Promise<{
    actions: { name: string; label: string; description: string; mutatesRecords: boolean }[];
    nodeTypes: { type: string; label: string; description: string }[];
    assigneeTypes: { type: string; label: string; description: string }[];
  }> {
    this.requireAdmin();
    return {
      actions: WORKFLOW_ACTIONS.map((action) => ({
        name: action.name,
        label: action.label,
        description: action.description,
        mutatesRecords: action.mutatesRecords,
      })),
      nodeTypes: [
        { type: 'userTask', label: 'User task', description: 'Waits for a person; the outcomes it offers decide where the flow goes next.' },
        { type: 'serviceTask', label: 'Service task', description: 'Runs a platform action in the background without a person in the loop.' },
        { type: 'gateway', label: 'Gateway', description: 'Branches on a sandboxed condition; the default target is used when no branch matches.' },
        { type: 'end', label: 'End', description: 'Completes the instance and reports its outcome.' },
      ],
      assigneeTypes: [
        { type: 'user', label: 'User', description: 'A specific user, by id.' },
        { type: 'role', label: 'Role candidates', description: 'Every member of the role sees the task and any of them may answer it.' },
        { type: 'recordField', label: 'Record field', description: 'Whoever the attached record points at, e.g. its assigned user.' },
      ],
    };
  }

  // ---------------------------------------------------------------- runtime lookup

  /** The enabled, published definition instances start from. Used by the runtime, not by admins. */
  async publishedProcess(ref: { id?: string | undefined; key?: string | undefined }): Promise<PublishedProcess> {
    const query = this.database.db
      .selectFrom('process_definitions')
      .selectAll()
      .where('is_deleted', '=', false);
    const row = await (ref.id !== undefined
      ? query.where('id', '=', ref.id)
      : query.where('key', '=', ref.key ?? '')
    ).executeTakeFirst();
    if (row === undefined) {
      throw new NotFoundError(`No process definition "${ref.id ?? ref.key ?? ''}" was found.`);
    }
    if (!row.is_active || row.published_version_id === null) {
      throw new ValidationError(`Process "${row.key}" is not enabled and published.`, { key: row.key });
    }
    const version = await this.database.db
      .selectFrom('process_definition_versions')
      .selectAll()
      .where('id', '=', row.published_version_id)
      .executeTakeFirst();
    if (version === undefined) throw new NotFoundError(`The published version of "${row.key}" is missing.`);
    return {
      definitionId: row.id,
      versionId: version.id,
      name: row.name,
      key: row.key,
      entityType: row.entity_type,
      definition: version.definition as ProcessDefinition,
    };
  }

  /** Loads the exact version an instance runs against (never the mutable head). */
  async definitionOfVersion(versionId: string): Promise<{ definition: ProcessDefinition; definitionId: string; version: number }> {
    const version = await this.database.db
      .selectFrom('process_definition_versions')
      .selectAll()
      .where('id', '=', versionId)
      .executeTakeFirst();
    if (version === undefined) throw new NotFoundError(`Process version "${versionId}" was not found.`);
    return { definition: version.definition as ProcessDefinition, definitionId: version.definition_id, version: version.version };
  }

  // ---------------------------------------------------------------- internals

  private validateOrThrow(definition: unknown): ProcessDefinition {
    try {
      return validateProcess(definition);
    } catch (error: unknown) {
      if (error instanceof ProcessValidationError) {
        throw new ValidationError('The process definition is not valid.', { issues: error.issues });
      }
      throw error;
    }
  }

  private async keyTaken(key: string): Promise<boolean> {
    const row = await this.database.db
      .selectFrom('process_definitions')
      .select('id')
      .where('key', '=', key)
      .where('is_deleted', '=', false)
      .executeTakeFirst();
    return row !== undefined;
  }

  private async insertVersion(
    definitionId: string,
    versionId: string,
    version: number,
    definition: ProcessDefinition,
    status: ProcessVersionStatus,
  ): Promise<void> {
    await this.database.db
      .insertInto('process_definition_versions')
      .values({
        id: versionId,
        definition_id: definitionId,
        version,
        definition: JSON.stringify(definition),
        status,
        created_by_id: this.scope.userId ?? null,
        created_at: new Date(),
        published_at: status === 'published' ? new Date() : null,
      })
      .execute();
  }

  private async processRow(id: string): Promise<ProcessDefinitionsRow> {
    const row = await this.database.db
      .selectFrom('process_definitions')
      .selectAll()
      .where('id', '=', id)
      .where('is_deleted', '=', false)
      .executeTakeFirst();
    if (row === undefined) throw new NotFoundError(`No process definition "${id}" was found.`);
    return row;
  }

  private async versionsByProcess(processIds: readonly string[]): Promise<Map<string, ProcessVersionView[]>> {
    const map = new Map<string, ProcessVersionView[]>();
    if (processIds.length === 0) return map;
    const rows = await this.database.db
      .selectFrom('process_definition_versions')
      .selectAll()
      .where('definition_id', 'in', [...processIds])
      .orderBy('version', 'desc')
      .execute();
    for (const row of rows) {
      const list = map.get(row.definition_id) ?? [];
      list.push(toVersionView(row));
      map.set(row.definition_id, list);
    }
    return map;
  }

  private async currentVersion(row: { id: string; current_version_id: string | null }): Promise<{ id: string; version: number; status: ProcessVersionStatus; definition: ProcessDefinition }> {
    if (row.current_version_id === null) throw new ValidationError('The process has no version to publish.');
    const version = await this.database.db
      .selectFrom('process_definition_versions')
      .selectAll()
      .where('id', '=', row.current_version_id)
      .executeTakeFirst();
    if (version === undefined) throw new NotFoundError(`The current version of process "${row.id}" is missing.`);
    return { id: version.id, version: version.version, status: version.status, definition: version.definition as ProcessDefinition };
  }

  private requireAdmin(): void {
    if (!this.scope.isAdmin) {
      throw new AuthorizationDeniedError('Process administration requires admin access.');
    }
  }
}

type ProcessDefinitionsRow = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  entity_type: string;
  is_active: boolean;
  current_version_id: string | null;
  published_version_id: string | null;
  is_deleted: boolean;
  created_by_id: string | null;
  modified_by_id: string | null;
  created_at: Date;
  modified_at: Date;
};

function toVersionView(row: {
  id: string;
  version: number;
  status: ProcessVersionStatus;
  definition: unknown;
  created_at: Date;
  published_at: Date | null;
}): ProcessVersionView {
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    definition: row.definition as ProcessDefinition,
    createdAt: row.created_at.toISOString(),
    publishedAt: row.published_at?.toISOString() ?? null,
  };
}

function toView(
  row: ProcessDefinitionsRow,
  versions: readonly ProcessVersionView[],
): ProcessView {
  const current = versions.find((version) => version.id === row.current_version_id) ?? versions[0] ?? null;
  const published = versions.find((version) => version.id === row.published_version_id) ?? null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    entityType: row.entity_type,
    isActive: row.is_active,
    currentVersion: current?.version ?? null,
    currentVersionStatus: current?.status ?? null,
    publishedVersion: published?.version ?? null,
    versions,
    createdAt: row.created_at.toISOString(),
    modifiedAt: row.modified_at.toISOString(),
    issues: current === null ? [] : definitionIssues(current.definition),
  };
}

function requireKey(key: string): string {
  const trimmed = String(key ?? '').trim();
  if (!KEY_PATTERN.test(trimmed)) {
    throw new ValidationError('A process key must be lowercase letters, digits and dashes, starting with a letter.', { key: trimmed });
  }
  return trimmed;
}

function requireName(value: string): string {
  const name = String(value ?? '').trim();
  if (name === '') throw new ValidationError('A process needs a name.');
  return name;
}
