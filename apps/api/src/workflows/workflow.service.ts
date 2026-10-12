import { AuthorizationDeniedError, NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { log } from '@carocrm/core/logger/index.js';
import { generateId } from '@carocrm/core/utils/id.js';
import type { RunStatus, WorkflowDefinition } from '@carocrm/workflow';
import { definitionIssues, validateDefinition,WORKFLOW_ACTIONS, WORKFLOW_EVENT_TYPES, WorkflowValidationError } from '@carocrm/workflow';
import { Inject, Injectable } from '@nestjs/common';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';

/**
 * Workflow administration and run history (PLAN §35, §19.1).
 *
 * The service owns the **versioning rule**, because it is the part that is easy to get wrong:
 *
 *  - a workflow's identity never changes (`workflows` row);
 *  - every save writes the *draft* version; a published version is immutable;
 *  - publishing freezes the current draft, so a run that started against version N still finds the
 *    exact definition it began with, even while somebody edits version N+1.
 *
 * Execution itself does not happen here: the worker owns side effects, and this service only
 * configures them and reads what happened.
 */

export type WorkflowVersionStatus = 'draft' | 'published' | 'archived';

export interface WorkflowVersionView {
  id: string;
  version: number;
  status: WorkflowVersionStatus;
  definition: WorkflowDefinition;
  createdAt: string;
  publishedAt: string | null;
}

export interface WorkflowView {
  id: string;
  name: string;
  entityType: string;
  eventType: string;
  isActive: boolean;
  currentVersion: number | null;
  currentVersionStatus: WorkflowVersionStatus | null;
  publishedVersion: number | null;
  /** Ids of the versions the runs in the table were started against. */
  versions: readonly WorkflowVersionView[];
  createdAt: string;
  modifiedAt: string;
  /** A draft that fails validation is still stored, but it can never be published or run. */
  issues: { code: string; message: string; path?: string | undefined }[];
}

export interface WorkflowRunStepView {
  nodeId: string;
  nodeType: string;
  name: string;
  status: string;
  attempt: number;
  output: unknown;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface WorkflowRunView {
  id: string;
  workflowId: string;
  workflowName: string;
  version: number | null;
  entityType: string;
  entityId: string;
  status: RunStatus;
  userId: string | null;
  error: string | null;
  attempt: number;
  startedAt: string;
  finishedAt: string | null;
  steps: WorkflowRunStepView[];
}

export interface CreateWorkflowInput {
  name: string;
  definition: unknown;
}

export interface UpdateWorkflowInput {
  name?: string | undefined;
  definition?: unknown;
}

@Injectable()
export class WorkflowService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  // ---------------------------------------------------------------- workflows

  async list(): Promise<{ list: WorkflowView[]; total: number }> {
    this.requireAdmin();
    const rows = await this.database.db
      .selectFrom('workflows')
      .selectAll()
      .where('is_deleted', '=', false)
      .orderBy('name', 'asc')
      .execute();
    const versions = await this.versionsByWorkflow(rows.map((row) => row.id));
    const list = rows.map((row) => toView(row, versions.get(row.id) ?? []));
    return { list, total: list.length };
  }

  async get(id: string): Promise<WorkflowView> {
    this.requireAdmin();
    const row = await this.workflowRow(id);
    const versions = await this.versionsByWorkflow([row.id]);
    return toView(row, versions.get(row.id) ?? []);
  }

  /** Creates the workflow and its first (draft) version. Nothing runs until it is published. */
  async create(input: CreateWorkflowInput): Promise<WorkflowView> {
    this.requireAdmin();
    const name = requireName(input.name);
    const definition = this.validateOrThrow(input.definition);

    const id = generateId();
    const versionId = generateId();
    const trigger = definition.trigger;
    await this.database.db
      .insertInto('workflows')
      .values({
        id,
        name,
        entity_type: trigger.entityType,
        event_type: trigger.eventType,
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
    log.info({ workflow: id, name }, 'workflow created');
    return this.get(id);
  }

  /**
   * Saves the draft. When the latest version is already published, the edit becomes a **new** draft
   * version rather than changing the published one (PLAN §35: never mutate in place).
   */
  async update(id: string, input: UpdateWorkflowInput): Promise<WorkflowView> {
    this.requireAdmin();
    const row = await this.workflowRow(id);
    const versions = await this.versionsByWorkflow([row.id]);
    const all = versions.get(row.id) ?? [];
    const current = all.find((version) => version.id === row.current_version_id) ?? all[0];
    if (current === undefined) throw new ValidationError(`Workflow "${id}" has no version to edit.`);

    const name = input.name === undefined ? row.name : requireName(input.name);
    const definition = input.definition === undefined ? undefined : this.validateOrThrow(input.definition);

    if (definition === undefined) {
      await this.database.db
        .updateTable('workflows')
        .set({ name, modified_by_id: this.scope.userId ?? null, modified_at: new Date() })
        .where('id', '=', row.id)
        .execute();
      return this.get(row.id);
    }

    const reusable = current.status === 'draft';
    const versionId = reusable ? current.id : generateId();
    // `versionsByWorkflow` orders by version desc, so the head is the newest one; `current` is that
    // head when it is a draft, and the newest published one otherwise.
    const latest = all[0];
    const version = reusable ? current.version : (latest?.version ?? current.version) + 1;

    if (reusable) {
      await this.database.db
        .updateTable('workflow_versions')
        .set({ definition: JSON.stringify(definition) })
        .where('id', '=', current.id)
        .execute();
    } else {
      await this.insertVersion(row.id, versionId, version, definition, 'draft');
    }

    const trigger = definition.trigger;
    await this.database.db
      .updateTable('workflows')
      .set({
        name,
        entity_type: trigger.entityType,
        event_type: trigger.eventType,
        current_version_id: versionId,
        modified_by_id: this.scope.userId ?? null,
        modified_at: new Date(),
      })
      .where('id', '=', row.id)
      .execute();
    return this.get(row.id);
  }

  /**
   * Publishes the current draft: the version becomes immutable and becomes the one runs execute.
   * The workflow still has to be enabled separately, so publishing a definition can never start it
   * by surprise.
   */
  async publish(id: string): Promise<WorkflowView> {
    this.requireAdmin();
    const row = await this.workflowRow(id);
    const current = await this.currentVersion(row);
    if (current.status === 'published') {
      throw new ValidationError(`Version ${String(current.version)} is already published.`, { version: current.version });
    }
    // Re-validate at publish time: the stored draft is what the worker will execute, so this is the
    // last chance to refuse a definition the engine could not run (a hand-edited row, a build that
    // no longer implements an action, …).
    this.validateOrThrow(current.definition);

    const now = new Date();
    await this.database.db.transaction().execute(async (tx) => {
      if (row.published_version_id !== null) {
        await tx
          .updateTable('workflow_versions')
          .set({ status: 'archived' })
          .where('id', '=', row.published_version_id)
          .execute();
      }
      await tx
        .updateTable('workflow_versions')
        .set({ status: 'published', published_at: now })
        .where('id', '=', current.id)
        .execute();
      await tx
        .updateTable('workflows')
        .set({ published_version_id: current.id, modified_at: now })
        .where('id', '=', row.id)
        .execute();
    });
    log.info({ workflow: row.id, version: current.version }, 'workflow version published');
    return this.get(row.id);
  }

  async setEnabled(id: string, enabled: boolean): Promise<WorkflowView> {
    this.requireAdmin();
    const row = await this.workflowRow(id);
    if (enabled && row.published_version_id === null) {
      throw new ValidationError('Publish a version before enabling the workflow.', { id });
    }
    await this.database.db
      .updateTable('workflows')
      .set({ is_active: enabled, modified_at: new Date() })
      .where('id', '=', row.id)
      .execute();
    log.info({ workflow: row.id, enabled }, 'workflow enabled state changed');
    return this.get(row.id);
  }

  async remove(id: string): Promise<{ id: string; deleted: true }> {
    this.requireAdmin();
    const row = await this.workflowRow(id);
    await this.database.db
      .updateTable('workflows')
      .set({ is_deleted: true, is_active: false, modified_at: new Date() })
      .where('id', '=', row.id)
      .execute();
    log.info({ workflow: row.id }, 'workflow deleted');
    return { id: row.id, deleted: true };
  }

  // -------------------------------------------------------------------- runs

  async listRuns(input: { workflowId?: string | undefined; status?: RunStatus | undefined; offset?: number; limit?: number }): Promise<{
    list: WorkflowRunView[];
    total: number;
    offset: number;
    count: number;
  }> {
    this.requireAdmin();
    const offset = input.offset ?? 0;
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 200);

    let base = this.database.db
      .selectFrom('workflow_runs')
      .innerJoin('workflows', 'workflows.id', 'workflow_runs.workflow_id')
      .leftJoin('workflow_versions', 'workflow_versions.id', 'workflow_runs.version_id');
    if (input.workflowId !== undefined) base = base.where('workflow_runs.workflow_id', '=', input.workflowId);
    if (input.status !== undefined) base = base.where('workflow_runs.status', '=', input.status);

    const rows = await base
      .selectAll('workflow_runs')
      .select(['workflows.name as workflow_name', 'workflow_versions.version as version_number'])
      .orderBy('workflow_runs.created_at', 'desc')
      .limit(limit)
      .offset(offset)
      .execute();

    const counted = await base.clearSelect().select((eb) => eb.fn.countAll<number>().as('total')).executeTakeFirst();

    const runs = rows.map((row) => ({
      id: row.id,
      workflowId: row.workflow_id,
      workflowName: String(row['workflow_name'] ?? ''),
      version: numberOrNull(row['version_number']),
      entityType: row.entity_type,
      entityId: row.entity_id,
      status: row.status,
      userId: row.user_id,
      error: row.error,
      attempt: row.attempt,
      startedAt: row.started_at.toISOString(),
      finishedAt: row.finished_at?.toISOString() ?? null,
      steps: [] as WorkflowRunStepView[],
    }));

    // Steps are only needed for the page being displayed, not for the list.
    if (runs.length > 0) {
      const steps = await this.database.db
        .selectFrom('workflow_run_steps')
        .selectAll()
        .where(
          'run_id',
          'in',
          runs.map((run) => run.id),
        )
        .orderBy('started_at', 'asc')
        .execute();
      const byRun = new Map<string, WorkflowRunStepView[]>();
      for (const step of steps) {
        const view = toStepView(step);
        const list = byRun.get(step.run_id) ?? [];
        list.push(view);
        byRun.set(step.run_id, list);
      }
      for (const run of runs) run.steps = byRun.get(run.id) ?? [];
    }

    return { list: runs, total: Number(counted?.total ?? 0), offset, count: runs.length };
  }

  /** One run with its steps — the run history detail an operator reads after a failure. */
  async getRun(id: string): Promise<WorkflowRunView> {
    this.requireAdmin();
    const row = await this.database.db
      .selectFrom('workflow_runs')
      .innerJoin('workflows', 'workflows.id', 'workflow_runs.workflow_id')
      .leftJoin('workflow_versions', 'workflow_versions.id', 'workflow_runs.version_id')
      .selectAll('workflow_runs')
      .select(['workflows.name as workflow_name', 'workflow_versions.version as version_number'])
      .where('workflow_runs.id', '=', requireId(id))
      .executeTakeFirst();
    if (row === undefined) throw new NotFoundError(`Workflow run "${id}" does not exist.`);

    const steps = await this.database.db
      .selectFrom('workflow_run_steps')
      .selectAll()
      .where('run_id', '=', row.id)
      .orderBy('started_at', 'asc')
      .execute();

    return {
      id: row.id,
      workflowId: row.workflow_id,
      workflowName: String(row['workflow_name'] ?? ''),
      version: numberOrNull(row['version_number']),
      entityType: row.entity_type,
      entityId: row.entity_id,
      status: row.status,
      userId: row.user_id,
      error: row.error,
      attempt: row.attempt,
      startedAt: row.started_at.toISOString(),
      finishedAt: row.finished_at?.toISOString() ?? null,
      steps: steps.map(toStepView),
    };
  }

  // ------------------------------------------------------------------ helpers

  /** Validation issues for a definition the caller has not saved yet (live editor feedback). */
  async validate(definition: unknown): Promise<{ valid: boolean; issues: { code: string; message: string; path?: string | undefined }[] }> {
    this.requireAdmin();
    const issues = definitionIssues(definition);
    return { valid: issues.length === 0, issues };
  }

  /**
   * What the editor can offer: the trigger events and the action catalog.
   * Exposed so the UI never has to hard-code the action list (PLAN §35 actions).
   */
  async catalog(): Promise<{ events: string[]; actions: { name: string; label: string; description: string; mutatesRecords: boolean }[] }> {
    this.requireAdmin();
    return {
      events: [...WORKFLOW_EVENT_TYPES],
      actions: WORKFLOW_ACTIONS.map((action) => ({
        name: action.name,
        label: action.label,
        description: action.description,
        mutatesRecords: action.mutatesRecords,
      })),
    };
  }

  private validateOrThrow(definition: unknown): WorkflowDefinition {
    try {
      return validateDefinition(definition);
    } catch (error: unknown) {
      if (error instanceof WorkflowValidationError) {
        throw new ValidationError('The workflow definition is not valid.', { issues: error.issues });
      }
      throw error;
    }
  }

  private async insertVersion(
    workflowId: string,
    versionId: string,
    version: number,
    definition: WorkflowDefinition,
    status: WorkflowVersionStatus,
  ): Promise<void> {
    await this.database.db
      .insertInto('workflow_versions')
      .values({
        id: versionId,
        workflow_id: workflowId,
        version,
        definition: JSON.stringify(definition),
        status,
        created_by_id: this.scope.userId ?? null,
        created_at: new Date(),
        published_at: null,
      })
      .execute();
  }

  private async workflowRow(id: string): Promise<{
    id: string;
    name: string;
    entity_type: string;
    event_type: string;
    is_active: boolean;
    current_version_id: string | null;
    published_version_id: string | null;
    is_deleted: boolean;
    created_by_id: string | null;
    modified_by_id: string | null;
    created_at: Date;
    modified_at: Date;
  }> {
    const row = await this.database.db
      .selectFrom('workflows')
      .selectAll()
      .where('id', '=', requireId(id))
      .executeTakeFirst();
    if (row === undefined || row.is_deleted) throw new NotFoundError(`Workflow "${id}" does not exist.`);
    return row;
  }

  private async versionsByWorkflow(workflowIds: readonly string[]): Promise<Map<string, WorkflowVersionView[]>> {
    const result = new Map<string, WorkflowVersionView[]>();
    if (workflowIds.length === 0) return result;
    const rows = await this.database.db
      .selectFrom('workflow_versions')
      .selectAll()
      .where('workflow_id', 'in', [...workflowIds])
      .orderBy('version', 'desc')
      .execute();
    for (const row of rows) {
      const list = result.get(row.workflow_id) ?? [];
      list.push({
        id: row.id,
        version: row.version,
        status: row.status,
        definition: row.definition as WorkflowDefinition,
        createdAt: row.created_at.toISOString(),
        publishedAt: row.published_at?.toISOString() ?? null,
      });
      result.set(row.workflow_id, list);
    }
    return result;
  }

  private async currentVersion(row: { id: string; current_version_id: string | null }): Promise<{
    id: string;
    version: number;
    status: WorkflowVersionStatus;
    definition: WorkflowDefinition;
  }> {
    const versions = await this.versionsByWorkflow([row.id]);
    const all = versions.get(row.id) ?? [];
    const current = all.find((version) => version.id === row.current_version_id) ?? all[0];
    if (current === undefined) throw new ValidationError(`Workflow "${row.id}" has no version.`);
    return current;
  }

  private requireAdmin(): void {
    if (!this.scope.isAdmin) {
      throw new AuthorizationDeniedError('Administrator access is required to manage workflows.');
    }
  }
}

interface WorkflowRow {
  id: string;
  name: string;
  entity_type: string;
  event_type: string;
  is_active: boolean;
  current_version_id: string | null;
  published_version_id: string | null;
  is_deleted: boolean;
  created_by_id: string | null;
  modified_by_id: string | null;
  created_at: Date;
  modified_at: Date;
}

function toView(row: WorkflowRow, versions: readonly WorkflowVersionView[]): WorkflowView {
  const current = versions.find((version) => version.id === row.current_version_id) ?? versions[0];
  const published = versions.find((version) => version.id === row.published_version_id);
  return {
    id: row.id,
    name: row.name,
    entityType: row.entity_type,
    eventType: row.event_type,
    isActive: row.is_active,
    currentVersion: current?.version ?? null,
    currentVersionStatus: current?.status ?? null,
    publishedVersion: published?.version ?? null,
    versions,
    createdAt: row.created_at.toISOString(),
    modifiedAt: row.modified_at.toISOString(),
    issues: current === undefined ? [] : definitionIssues(current.definition),
  };
}

function toStepView(step: {
  node_id: string;
  node_type: string;
  name: string;
  status: string;
  attempt: number;
  output: unknown;
  error: string | null;
  started_at: Date;
  finished_at: Date | null;
}): WorkflowRunStepView {
  return {
    nodeId: step.node_id,
    nodeType: step.node_type,
    name: step.name,
    status: step.status,
    attempt: step.attempt,
    output: step.output ?? null,
    error: step.error,
    startedAt: step.started_at.toISOString(),
    finishedAt: step.finished_at?.toISOString() ?? null,
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function requireName(value: string): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (name === '') throw new ValidationError('A workflow needs a name.');
  if (name.length > 120) throw new ValidationError('A workflow name may be at most 120 characters.');
  return name;
}

function requireId(value: string): string {
  const id = value.trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new ValidationError(`"${value}" is not a workflow id.`);
  return id;
}

export const WORKFLOW_EVENT_OPTIONS = WORKFLOW_EVENT_TYPES;