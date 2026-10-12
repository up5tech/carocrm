import type { AdvanceResult, AssigneeSpec, PendingOutcome, ProcessAdvancePorts, ProcessDefinition } from '@carocrm/bpm';
import { advanceProcess, ANY_ENTITY, asRecord, errorMessage,ProcessExecutionError  } from '@carocrm/bpm';
import { AuthorizationDeniedError, NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { log } from '@carocrm/core/logger/index.js';
import { generateId } from '@carocrm/core/utils/id.js';
import { Inject, Injectable } from '@nestjs/common';
import type { Expression, SqlBool } from 'kysely';
import { sql } from 'kysely';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import type { Db, DbTx } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import { EntityCrudService } from '../entity/entity.service.js';
import { JobQueueService } from '../jobs/job-queue.service.js';
import { ProcessService } from './process.service.js';

/**
 * Process execution (PLAN §36).
 *
 * ```text
 * POST /ProcessInstance ─┐            ┌─ bpm.taskTimer  (worker: due / escalate)
 * POST /ProcessTask/…/complete ─┤──► state machine ─┤
 * POST /ProcessInstance/…/cancel ┘            └─ bpm.serviceTask (worker: run an action)
 * ```
 *
 * **The API walks the state machine, in one transaction, and the worker handles everything with a
 * clock or a side effect.** This is the one place BPM deliberately differs from workflows (§35):
 * a workflow is fire-and-forget automation, while a process's primary artifact is a *task another
 * person can already see*. Making the next approver wait for a worker round-trip would be a worse
 * product for no safety gain — advancing between two user tasks touches only rows in one
 * transaction, and every action with an external effect is dispatched to the queue instead
 * (PLAN §5.5: no HTTP request ever sends an email).
 *
 * **One token, one lock.** A process instance is sequential, so a completion locks the instance row
 * (`FOR UPDATE`) before advancing: two people answering at the same moment cannot both move the
 * token. The engine is deterministic, so a replay from the persisted position walks the same path.
 *
 * **Failure is data.** If advancement cannot continue (an assignee that no longer resolves, a
 * definition edited behind the API's back), the instance is marked `failed` with the reason in the
 * audit trail and the human's answer is kept — a lost approval is worse than a stopped process.
 */

const ACTIVE_STATUSES = ['running', 'waiting'] as const;
const ANSWERABLE_STATUSES = ['open', 'overdue', 'escalated'] as const;
const TASK_STATUSES = [...ANSWERABLE_STATUSES, 'completed', 'cancelled'] as const;
const INSTANCE_STATUSES = ['running', 'waiting', 'completed', 'cancelled', 'failed'] as const;
const TASK_PAGE_DEFAULT = 50;

type TaskStatus = (typeof TASK_STATUSES)[number];
type InstanceStatus = (typeof INSTANCE_STATUSES)[number];

export interface ProcessTaskView {
  id: string;
  instanceId: string;
  nodeId: string;
  name: string;
  status: string;
  assigneeId: string | null;
  assigneeRoleId: string | null;
  assigneeSpec: unknown;
  dueAt: string | null;
  escalatedAt: string | null;
  outcome: string | null;
  comment: string | null;
  completedById: string | null;
  createdAt: string;
  completedAt: string | null;
  updatedAt: string;
  /** Denormalized for the task list: which process, on which record. */
  processId: string;
  processName: string;
  entityType: string;
  entityId: string;
  /** What the answer buttons offer, taken from the task's node. */
  outcomes: { value: string; label: string }[];
}

export interface ProcessEventView {
  id: string;
  nodeId: string | null;
  type: string;
  message: string;
  actorId: string | null;
  data: unknown;
  createdAt: string;
}

export interface ProcessInstanceView {
  id: string;
  definitionId: string;
  processKey: string;
  processName: string;
  version: number | null;
  entityType: string;
  entityId: string;
  status: string;
  currentNode: string | null;
  outcome: string | null;
  error: string | null;
  initiatedBy: string | null;
  startedAt: string;
  finishedAt: string | null;
  createdAt: string;
  modifiedAt: string;
  tasks: ProcessTaskView[];
  events: ProcessEventView[];
}

export interface StartProcessInput {
  processId?: string | undefined;
  processKey?: string | undefined;
  entityType: string;
  entityId: string;
}

export interface CompleteTaskInput {
  outcome: string;
  comment?: string | undefined;
}

type Queryable = Db | DbTx;

@Injectable()
export class ProcessRuntimeService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(ProcessService) private readonly processes: ProcessService,
    @Inject(EntityCrudService) private readonly records: EntityCrudService,
    @Inject(JobQueueService) private readonly queue: JobQueueService,
  ) {}

  // ---------------------------------------------------------------- starting

  /**
   * Starts an instance of an enabled, published process on a record. Anyone who can *read* the
   * record may start it — approvals are started by the people who own the records, not only by
   * admins; the definition itself stays admin-only.
   */
  async start(input: StartProcessInput): Promise<ProcessInstanceView> {
    const principal = this.scope.requirePrincipal();
    const process = await this.processes.publishedProcess({ id: input.processId, key: input.processKey });
    const entityType = requireEntityType(input.entityType);
    const entityId = requireEntityId(input.entityId);
    if (process.entityType !== ANY_ENTITY && process.entityType !== entityType) {
      throw new ValidationError(`Process "${process.key}" only runs on "${process.entityType}" records.`, {
        expected: process.entityType,
        received: entityType,
      });
    }
    // Record-level ACL by construction: a 404 here means "does not exist or not readable".
    await this.records.get(entityType, entityId);
    const record = await this.loadRecordAttrs(entityType, entityId);

    const instanceId = generateId();
    await this.database.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('process_instances')
        .values({
          id: instanceId,
          definition_id: process.definitionId,
          version_id: process.versionId,
          entity_type: entityType,
          entity_id: entityId,
          status: 'running',
          current_node: null,
          context: JSON.stringify({}),
          outcome: null,
          error: null,
          initiated_by: principal.userId ?? null,
          started_at: new Date(),
          finished_at: null,
          created_at: new Date(),
          modified_at: new Date(),
        })
        .execute();
      await this.writeEvent(trx, {
        instanceId,
        type: 'instance.started',
        message: `Process "${process.name}" started on ${entityType} "${entityId}".`,
        actorId: principal.userId ?? null,
        data: { definitionId: process.definitionId, versionId: process.versionId },
      });
      await this.advance(trx, {
        instanceId,
        definition: process.definition,
        currentNode: null,
        context: {},
        record,
        entityType,
        entityId,
        userId: principal.userId,
      });
    });
    log.info({ instance: instanceId, process: process.key, entity: `${entityType}:${entityId}` }, 'process instance started');
    return this.getInstance(instanceId);
  }

  // ---------------------------------------------------------------- tasks

  /** Open tasks for the signed-in person (or their candidate roles); admins may list everything. */
  async listTasks(input: { status?: string | undefined; all?: boolean | undefined; offset?: number; limit?: number }): Promise<{
    list: ProcessTaskView[];
    total: number;
    offset: number;
    count: number;
  }> {
    this.scope.requirePrincipal(); // authentication: task lists are per-person
    const statuses = taskStatuses(input.status);
    const offset = Math.max(0, input.offset ?? 0);
    const limit = clampLimit(input.limit);

    const base = this.database.db
      .selectFrom('process_tasks as t')
      .innerJoin('process_instances as i', 'i.id', 't.instance_id')
      .innerJoin('process_definitions as d', 'd.id', 'i.definition_id')
      .where('t.status', 'in', statuses)
      .where('d.is_deleted', '=', false);

    const scoped = input.all === true && this.scope.isAdmin ? base : base.where(this.taskParticipantClause());

    const rows = await scoped
      .selectAll('t')
      .select(['i.entity_type as entity_type', 'i.entity_id as entity_id', 'i.version_id as version_id', 'd.name as process_name', 'd.id as process_id'])
      .orderBy('t.due_at', 'asc')
      .orderBy('t.created_at', 'desc')
      .limit(limit)
      .offset(offset)
      .execute();
    const totalRow = await scoped.select((eb) => eb.fn.countAll().as('total')).executeTakeFirst();

    const list = await Promise.all(rows.map((row) => this.toTaskView(row)));
    return { list, total: Number(totalRow?.total ?? 0), offset, count: list.length };
  }

  async getTask(id: string): Promise<ProcessTaskView> {
    const principal = this.scope.requirePrincipal();
    const row = await this.taskRow(id);
    if (!this.scope.isAdmin && !this.maySeeTask(principal.userId, principal.roles, row)) {
      throw new AuthorizationDeniedError('This task is not assigned to you.');
    }
    return this.toTaskView(row);
  }

  /**
   * Answers a task: the human decision moves the token. The instance row is locked for the duration
   * so two people answering the same task (or two tasks of the same instance) cannot both advance.
   */
  async completeTask(id: string, input: CompleteTaskInput): Promise<ProcessInstanceView> {
    const principal = this.scope.requirePrincipal();
    const outcome = requireOutcome(input.outcome);
    const comment = input.comment === undefined || input.comment.trim() === '' ? null : input.comment.trim();

    const task = await this.taskRow(id);
    if (!this.scope.isAdmin && !this.maySeeTask(principal.userId, principal.roles, task)) {
      throw new AuthorizationDeniedError('This task is not assigned to you.');
    }
    if (!(ANSWERABLE_STATUSES as readonly string[]).includes(task.status)) {
      throw new ValidationError(`Task "${task.name}" is ${task.status} and can no longer be answered.`, { status: task.status });
    }

    const instance = await this.instanceRow(task.instance_id);
    const { definition } = await this.processes.definitionOfVersion(instance.version_id);
    const node = definition.nodes.find((candidate) => candidate.id === task.node_id);
    if (node === undefined || node.type !== 'userTask') {
      throw new ValidationError(`The stored definition no longer contains the task node "${task.node_id}".`);
    }
    if (!node.outcomes.some((candidate) => candidate.value === outcome)) {
      throw new ValidationError(`Outcome "${outcome}" is not offered by "${node.name}".`, {
        offered: node.outcomes.map((candidate) => candidate.value),
      });
    }
    const record = await this.loadRecordAttrs(instance.entity_type, instance.entity_id);

    await this.database.db.transaction().execute(async (trx) => {
      const locked = await trx
        .selectFrom('process_instances')
        .select(['status'])
        .where('id', '=', instance.id)
        .forUpdate()
        .executeTakeFirst();
      if (locked === undefined || !(ACTIVE_STATUSES as readonly string[]).includes(locked.status)) {
        throw new ValidationError('The process is no longer active.', { status: locked?.status ?? 'missing' });
      }
      const updated = await trx
        .updateTable('process_tasks')
        .set({ status: 'completed', outcome, comment, completed_by_id: principal.userId ?? null, completed_at: new Date(), updated_at: new Date() })
        .where('id', '=', task.id)
        .where('status', 'in', [...ANSWERABLE_STATUSES])
        .executeTakeFirst();
      if (updated.numUpdatedRows === 0n) {
        throw new ValidationError(`Task "${task.name}" was answered already.`, { status: task.status });
      }
      const pending: PendingOutcome = { nodeId: task.node_id, outcome, comment: comment ?? undefined, userId: principal.userId };
      await this.advance(trx, {
        instanceId: instance.id,
        definition,
        currentNode: task.node_id,
        context: asRecord(instance.context),
        record,
        entityType: instance.entity_type,
        entityId: instance.entity_id,
        userId: principal.userId,
        pending,
      });
    });
    log.info({ instance: instance.id, task: task.id, outcome }, 'process task answered');
    return this.getInstance(instance.id);
  }

  // ---------------------------------------------------------------- instances

  /** Admins see everything; other people see processes they started or take part in. */
  async listInstances(input: { definitionId?: string | undefined; status?: string | undefined; offset?: number; limit?: number }): Promise<{
    list: ProcessInstanceView[];
    total: number;
    offset: number;
    count: number;
  }> {
    this.scope.requirePrincipal(); // authentication: instance lists are scoped per person
    const offset = Math.max(0, input.offset ?? 0);
    const limit = clampLimit(input.limit);

    const statusFilter = instanceStatus(input.status).status;
    let base = this.database.db
      .selectFrom('process_instances as i')
      .innerJoin('process_definitions as d', 'd.id', 'i.definition_id')
      .where('d.is_deleted', '=', false);
    if (input.definitionId !== undefined) base = base.where('i.definition_id', '=', input.definitionId);
    if (statusFilter !== undefined) base = base.where('i.status', '=', statusFilter);

    const scoped = this.scope.isAdmin ? base : base.where(this.instanceParticipantClause());

    const rows = await scoped
      .select(['i.id as id'])
      .orderBy('i.created_at', 'desc')
      .limit(limit)
      .offset(offset)
      .execute();
    const totalRow = await scoped.select((eb) => eb.fn.countAll().as('total')).executeTakeFirst();

    const list = await Promise.all(rows.map((row) => this.getInstance(row.id)));
    return { list, total: Number(totalRow?.total ?? 0), offset, count: list.length };
  }

  async getInstance(id: string): Promise<ProcessInstanceView> {
    const principal = this.scope.requirePrincipal();
    const instance = await this.instanceRow(id);
    if (!this.scope.isAdmin && !(await this.maySeeInstance(principal.userId, principal.roles, instance))) {
      throw new AuthorizationDeniedError('This process instance is not visible to you.');
    }
    const { version } = await this.processes.definitionOfVersion(instance.version_id);
    const process = await this.database.db
      .selectFrom('process_definitions')
      .select(['id', 'key', 'name'])
      .where('id', '=', instance.definition_id)
      .executeTakeFirst();

    const taskRows = await this.taskRows(instance.id);
    const eventRows = await this.database.db
      .selectFrom('process_events')
      .selectAll()
      .where('instance_id', '=', instance.id)
      .orderBy('seq', 'asc')
      .execute();

    const tasks = await Promise.all(taskRows.map((row) => this.toTaskView(row)));
    return {
      id: instance.id,
      definitionId: instance.definition_id,
      processKey: process?.key ?? '',
      processName: process?.name ?? '',
      version,
      entityType: instance.entity_type,
      entityId: instance.entity_id,
      status: instance.status,
      currentNode: instance.current_node,
      outcome: instance.outcome,
      error: instance.error,
      initiatedBy: instance.initiated_by,
      startedAt: instance.started_at.toISOString(),
      finishedAt: instance.finished_at?.toISOString() ?? null,
      createdAt: instance.created_at.toISOString(),
      modifiedAt: instance.modified_at.toISOString(),
      tasks,
      events: eventRows.map((row) => ({
        id: row.id,
        nodeId: row.node_id,
        type: row.type,
        message: row.message,
        actorId: row.actor_id,
        data: row.data,
        createdAt: row.created_at.toISOString(),
      })),
    };
  }

  /** Cancels a running instance: the initiator or an admin. Open tasks are cancelled with it. */
  async cancel(id: string): Promise<ProcessInstanceView> {
    const principal = this.scope.requirePrincipal();
    const instance = await this.instanceRow(id);
    if (!this.scope.isAdmin && instance.initiated_by !== principal.userId) {
      throw new AuthorizationDeniedError('Only the person who started this process (or an admin) may cancel it.');
    }
    if (!(ACTIVE_STATUSES as readonly string[]).includes(instance.status)) {
      throw new ValidationError(`The process is ${instance.status} and cannot be cancelled.`, { status: instance.status });
    }

    await this.database.db.transaction().execute(async (trx) => {
      const open = await trx
        .selectFrom('process_tasks')
        .select(['id', 'name'])
        .where('instance_id', '=', instance.id)
        .where('status', 'in', [...ANSWERABLE_STATUSES])
        .execute();
      if (open.length > 0) {
        await trx
          .updateTable('process_tasks')
          .set({ status: 'cancelled', updated_at: new Date() })
          .where('instance_id', '=', instance.id)
          .where('status', 'in', [...ANSWERABLE_STATUSES])
          .execute();
      }
      await trx
        .updateTable('process_instances')
        .set({ status: 'cancelled', finished_at: new Date(), modified_at: new Date() })
        .where('id', '=', instance.id)
        .execute();
      for (const task of open) {
        await this.writeEvent(trx, {
          instanceId: instance.id,
          type: 'task.cancelled',
          message: `Task "${task.name}" was cancelled with the process.`,
          actorId: principal.userId ?? null,
        });
      }
      await this.writeEvent(trx, {
        instanceId: instance.id,
        type: 'instance.cancelled',
        message: 'The process was cancelled.',
        actorId: principal.userId ?? null,
      });
    });
    log.info({ instance: instance.id }, 'process instance cancelled');
    return this.getInstance(instance.id);
  }

  // ---------------------------------------------------------------- engine ports

  /** Walks the single token until it parks at a task or ends; failures stop the instance visibly. */
  private async advance(
    trx: DbTx,
    input: {
      instanceId: string;
      definition: ProcessDefinition;
      currentNode: string | null;
      context: Record<string, unknown>;
      record: Record<string, unknown>;
      entityType: string;
      entityId: string;
      userId?: string | undefined;
      pending?: PendingOutcome | undefined;
    },
  ): Promise<AdvanceResult | null> {
    const ports = this.ports(trx, input);
    try {
      return await advanceProcess({
        definition: input.definition,
        state: { currentNode: input.currentNode, context: input.context },
        ports,
        ...(input.pending === undefined ? {} : { pending: input.pending }),
        options: {
          record: input.record,
          entityType: input.entityType,
          entityId: input.entityId,
          userId: input.userId,
        },
      });
    } catch (error: unknown) {
      const message = errorMessage(error);
      log.error({ instance: input.instanceId, error: message }, 'process advancement failed');
      await this.markFailed(trx, input.instanceId, message);
      return null;
    }
  }

  private ports(
    trx: DbTx,
    input: { instanceId: string; entityType: string; entityId: string },
  ): ProcessAdvancePorts {
    return {
      createTask: async (task) => {
        const resolved = await this.resolveAssignee(trx, task.assignee, input.entityType, input.entityId);
        const taskId = generateId();
        await trx
          .insertInto('process_tasks')
          .values({
            id: taskId,
            instance_id: input.instanceId,
            node_id: task.nodeId,
            name: task.name,
            status: 'open',
            assignee_id: resolved.userId,
            assignee_role_id: resolved.roleId,
            assignee_spec: JSON.stringify(task.assignee),
            due_at: task.dueAt,
            escalated_at: null,
            outcome: null,
            comment: null,
            completed_by_id: null,
            created_at: new Date(),
            completed_at: null,
            updated_at: new Date(),
          })
          .execute();
        // A concrete assignee is notified; role candidates discover work on their tasks page.
        if (resolved.userId !== null) {
          await this.notify(trx, resolved.userId, `You have a process task: ${task.name}`, {
            taskId,
            instanceId: input.instanceId,
          });
        }
        return { taskId };
      },
      dispatchServiceTask: async (service) => {
        // Enqueued, never run in the request: the worker owns side effects (PLAN §5.5).
        await this.queue.enqueue({
          job: 'bpm.serviceTask',
          data: {
            instanceId: input.instanceId,
            nodeId: service.nodeId,
            action: service.action,
            params: service.params,
            entityType: input.entityType,
            entityId: input.entityId,
          },
        });
      },
      scheduleTimer: async (timer) => {
        await this.queue.enqueue({
          job: 'bpm.taskTimer',
          data: { taskId: timer.taskId, kind: timer.kind },
          delayMs: Math.round(timer.seconds * 1000),
        });
      },
      recordEvent: async (event) => {
        await this.writeEvent(trx, {
          instanceId: input.instanceId,
          type: event.type,
          nodeId: event.nodeId ?? null,
          message: event.message,
          data: event.data ?? {},
        });
      },
      setCurrentNode: async (nodeId, context) => {
        await trx
          .updateTable('process_instances')
          .set({ current_node: nodeId, context: JSON.stringify(context), status: 'waiting', modified_at: new Date() })
          .where('id', '=', input.instanceId)
          .execute();
      },
      finishInstance: async (finished) => {
        await trx
          .updateTable('process_instances')
          .set({
            status: 'completed',
            outcome: finished.outcome,
            context: JSON.stringify(finished.context),
            current_node: null,
            finished_at: new Date(),
            modified_at: new Date(),
          })
          .where('id', '=', input.instanceId)
          .execute();
      },
    };
  }

  /**
   * Resolves who a task belongs to: a user id, a role's members (candidates), or whoever the
   * attached record points at. An unresolvable assignee is a *failure*, never a silently orphaned
   * task — the instance is stopped with the reason in its audit trail.
   */
  private async resolveAssignee(
    db: Queryable,
    spec: AssigneeSpec,
    entityType: string,
    entityId: string,
  ): Promise<{ userId: string | null; roleId: string | null }> {
    if (spec.type === 'role') {
      const role = await db
        .selectFrom('roles')
        .select('id')
        .where('name', '=', spec.value)
        .where('is_deleted', '=', false)
        .executeTakeFirst();
      if (role === undefined) {
        throw new ProcessExecutionError(`No active role is named "${spec.value}".`);
      }
      return { userId: null, roleId: role.id };
    }

    let userId = spec.value;
    if (spec.type === 'recordField') {
      const record = await this.loadRecordAttrs(entityType, entityId, db);
      const value = record[spec.value];
      if (typeof value !== 'string' || value === '') {
        throw new ProcessExecutionError(`The record has no value in field "${spec.value}" to assign the task to.`);
      }
      userId = value;
    }
    const user = await db
      .selectFrom('users')
      .select('id')
      .where('id', '=', userId)
      .where('is_active', '=', true)
      .executeTakeFirst();
    if (user === undefined) {
      throw new ProcessExecutionError(`User "${userId}" does not exist or is not active.`);
    }
    return { userId: user.id, roleId: null };
  }

  // ---------------------------------------------------------------- helpers

  /** Raw attributes for formulas and `{{placeholders}}` — not the caller's field-permission view. */
  private async loadRecordAttrs(entityType: string, entityId: string, db: Queryable = this.database.db): Promise<Record<string, unknown>> {
    const row = await db
      .selectFrom('entity_records')
      .select(['id', 'name', 'attrs'])
      .where('entity_type', '=', entityType)
      .where('id', '=', entityId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (row === undefined) throw new NotFoundError(`No ${entityType} record "${entityId}" was found.`);
    return { ...asRecord(row.attrs), id: row.id, name: row.name, entityType };
  }

  private async markFailed(trx: DbTx, instanceId: string, message: string): Promise<void> {
    await trx
      .updateTable('process_tasks')
      .set({ status: 'cancelled', updated_at: new Date() })
      .where('instance_id', '=', instanceId)
      .where('status', 'in', [...ANSWERABLE_STATUSES])
      .execute();
    await trx
      .updateTable('process_instances')
      .set({ status: 'failed', error: message, finished_at: new Date(), modified_at: new Date() })
      .where('id', '=', instanceId)
      .execute();
    await this.writeEvent(trx, {
      instanceId,
      type: 'instance.failed',
      message: `The process could not continue: ${message}`,
      data: { error: message },
    });
  }

  private async writeEvent(
    db: Queryable,
    event: { instanceId: string; type: string; nodeId?: string | null; message: string; actorId?: string | null; data?: unknown },
  ): Promise<void> {
    await db
      .insertInto('process_events')
      .values({
        id: generateId(),
        instance_id: event.instanceId,
        node_id: event.nodeId ?? null,
        type: event.type,
        message: event.message,
        actor_id: event.actorId ?? null,
        data: JSON.stringify(event.data ?? {}),
        created_at: new Date(),
      })
      .execute();
  }

  private async notify(db: Queryable, userId: string, message: string, data: Record<string, unknown>): Promise<void> {
    await db
      .insertInto('notifications')
      .values({
        id: generateId(),
        type: 'ProcessTask',
        user_id: userId,
        data: JSON.stringify({ ...data, message }),
        is_read: false,
        created_at: new Date(),
      })
      .execute();
  }

  private async instanceRow(id: string): Promise<{
    id: string;
    definition_id: string;
    version_id: string;
    entity_type: string;
    entity_id: string;
    status: string;
    current_node: string | null;
    context: unknown;
    outcome: string | null;
    error: string | null;
    initiated_by: string | null;
    started_at: Date;
    finished_at: Date | null;
    created_at: Date;
    modified_at: Date;
  }> {
    const row = await this.database.db
      .selectFrom('process_instances')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (row === undefined) throw new NotFoundError(`No process instance "${id}" was found.`);
    return row;
  }

  private async taskRow(id: string): Promise<TaskJoinedRow> {
    const row = await this.taskJoinedQuery().where('t.id', '=', id).executeTakeFirst();
    if (row === undefined) throw new NotFoundError(`No process task "${id}" was found.`);
    return row;
  }

  private async taskRows(instanceId: string): Promise<TaskJoinedRow[]> {
    return this.taskJoinedQuery().where('t.instance_id', '=', instanceId).orderBy('t.created_at', 'asc').execute();
  }

  private taskJoinedQuery() {
    return this.database.db
      .selectFrom('process_tasks as t')
      .innerJoin('process_instances as i', 'i.id', 't.instance_id')
      .innerJoin('process_definitions as d', 'd.id', 'i.definition_id')
      .selectAll('t')
      .select([
        'i.entity_type as entity_type',
        'i.entity_id as entity_id',
        'i.version_id as version_id',
        'd.name as process_name',
        'd.id as process_id',
      ]);
  }

  private async toTaskView(row: TaskJoinedRow): Promise<ProcessTaskView> {
    const definition = await this.definitionOfTask(row);
    const node = definition?.nodes.find((candidate) => candidate.id === row.node_id);
    const outcomes: { value: string; label: string }[] =
      node?.type === 'userTask' ? node.outcomes.map((outcome) => ({ value: outcome.value, label: outcome.label })) : [];
    return {
      id: row.id,
      instanceId: row.instance_id,
      nodeId: row.node_id,
      name: row.name,
      status: row.status,
      assigneeId: row.assignee_id,
      assigneeRoleId: row.assignee_role_id,
      assigneeSpec: row.assignee_spec,
      dueAt: row.due_at?.toISOString() ?? null,
      escalatedAt: row.escalated_at?.toISOString() ?? null,
      outcome: row.outcome,
      comment: row.comment,
      completedById: row.completed_by_id,
      createdAt: row.created_at.toISOString(),
      completedAt: row.completed_at?.toISOString() ?? null,
      updatedAt: row.updated_at.toISOString(),
      processId: row.process_id,
      processName: row.process_name,
      entityType: row.entity_type,
      entityId: row.entity_id,
      outcomes,
    };
  }

  private async definitionOfTask(row: TaskJoinedRow): Promise<ProcessDefinition | null> {
    try {
      const { definition } = await this.processes.definitionOfVersion(row.version_id);
      return definition;
    } catch {
      return null;
    }
  }

  /** Task visibility: the assignee, members of the candidate role, and admins. */
  private maySeeTask(userId: string | undefined, roleIds: readonly string[], task: TaskJoinedRow): boolean {
    if (userId === undefined) return false;
    if (task.assignee_id !== null && task.assignee_id === userId) return true;
    return task.assignee_role_id !== null && roleIds.includes(task.assignee_role_id);
  }

  /** Instance visibility: admins, the initiator, and anyone holding (or eligible for) its tasks. */
  private async maySeeInstance(
    userId: string | undefined,
    roleIds: readonly string[],
    instance: { id: string; initiated_by: string | null },
  ): Promise<boolean> {
    if (userId === undefined) return false;
    if (instance.initiated_by === userId) return true;
    // Participants see the whole instance — an approval trail makes no sense half-hidden.
    const row = await this.database.db
      .selectFrom('process_tasks as t')
      .select('t.id')
      .where('t.instance_id', '=', instance.id)
      .where((eb) =>
        eb.or([
          eb('t.assignee_id', '=', userId),
          ...(roleIds.length > 0 ? [eb('t.assignee_role_id', 'in', [...roleIds])] : []),
        ]),
      )
      .executeTakeFirst();
    return row !== undefined;
  }

  /** The row is visible to the current person: they hold the task, or are eligible for it. */
  private taskParticipantClause(): Expression<SqlBool> {
    const me = this.scope.userId ?? '';
    const roleIds = this.scope.roleIds();
    return this.assigneeClause('t', me, roleIds);
  }

  /** The instance has a task the current person holds or is eligible for. */
  private instanceParticipantClause(): Expression<SqlBool> {
    const me = this.scope.userId ?? '';
    const roleIds = this.scope.roleIds();
    const assignee = this.assigneeClause('t', me, roleIds);
    return sql<SqlBool>`exists (select 1 from process_tasks t where t.instance_id = i.id and ${assignee})`;
  }

  private assigneeClause(alias: 't', userId: string, roleIds: readonly string[]): Expression<SqlBool> {
    if (roleIds.length === 0) {
      return sql<SqlBool>`${sql.ref(`${alias}.assignee_id`)} = ${userId}`;
    }
    const inList = sql.join(roleIds.map((roleId) => sql`${roleId}`));
    return sql<SqlBool>`(${sql.ref(`${alias}.assignee_id`)} = ${userId} or ${sql.ref(`${alias}.assignee_role_id`)} in (${inList}))`;
  }
}

type TaskJoinedRow = {
  id: string;
  instance_id: string;
  version_id: string;
  node_id: string;
  name: string;
  status: string;
  assignee_id: string | null;
  assignee_role_id: string | null;
  assignee_spec: unknown;
  due_at: Date | null;
  escalated_at: Date | null;
  outcome: string | null;
  comment: string | null;
  completed_by_id: string | null;
  created_at: Date;
  completed_at: Date | null;
  updated_at: Date;
  entity_type: string;
  entity_id: string;
  process_name: string;
  process_id: string;
};

function clampLimit(limit: number | undefined): number {
  const value = limit ?? TASK_PAGE_DEFAULT;
  if (!Number.isFinite(value) || value < 1) return TASK_PAGE_DEFAULT;
  return Math.min(Math.floor(value), 200);
}

function taskStatuses(status: string | undefined): TaskStatus[] {
  if (status === undefined || status === '') return [...ANSWERABLE_STATUSES];
  if (status === 'all') return [...TASK_STATUSES];
  if (!(TASK_STATUSES as readonly string[]).includes(status)) {
    throw new ValidationError(`Unknown task status "${status}".`, { allowed: TASK_STATUSES });
  }
  return [status as TaskStatus];
}

function instanceStatus(value: string | undefined): { status?: InstanceStatus } {
  if (value === undefined || value === '') return {};
  if (!(INSTANCE_STATUSES as readonly string[]).includes(value)) {
    throw new ValidationError(`Unknown process status "${value}".`, { allowed: INSTANCE_STATUSES });
  }
  return { status: value as InstanceStatus };
}

function requireEntityType(value: string): string {
  const entityType = String(value ?? '').trim();
  if (!/^[A-Z][A-Za-z0-9]{1,49}$/.test(entityType)) {
    throw new ValidationError('An entity type is required to start a process.', { entityType });
  }
  return entityType;
}

function requireEntityId(value: string): string {
  const entityId = String(value ?? '').trim();
  if (entityId === '') throw new ValidationError('A record id is required to start a process.');
  return entityId;
}

function requireOutcome(value: string): string {
  const outcome = String(value ?? '').trim();
  if (outcome === '') throw new ValidationError('An outcome is required to answer a task.');
  return outcome;
}
