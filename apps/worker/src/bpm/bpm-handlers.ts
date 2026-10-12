import type { AssigneeSpec } from '@carocrm/bpm';
import type { Logger } from '@carocrm/core/logger/index.js';
import type { JobRegistry } from '@carocrm/jobs';
import type { ActionNode, WorkflowRunContext } from '@carocrm/workflow';

import type { Queryable } from '../db.js';
import { runWorkflowAction } from '../workflows/workflow-actions.js';
import type { WorkflowStore } from '../workflows/workflow-store.js';
import { createWorkflowStore } from '../workflows/workflow-store.js';
import type { BpmStore, StoredProcessInstance } from './bpm-store.js';
import { createBpmStore } from './bpm-store.js';

/**
 * BPM jobs in the worker (PLAN §36, §24).
 *
 * The API owns the state machine; the worker owns the two things that need a *clock* or a side
 * effect:
 *
 * ```text
 * userTask.dueSeconds           ─► bpm.taskTimer → task overdue + one more notification
 * userTask.escalateAfterSeconds ─► bpm.taskTimer → reassign to the escalation target, mark escalated
 * serviceTask                   ─► bpm.serviceTask → run one §35 action, report into the audit trail
 * ```
 *
 * Both handlers are **idempotent under redelivery**: every write is guarded by the current status,
 * so a redelivered timer does not escalate an answered task twice, and a service task for an
 * instance that was cancelled while the message sat in the queue is skipped, not executed
 * (PLAN §5.5).
 *
 * A failing service task stops the instance rather than silently re-running the action: the action
 * catalog's operations are fast, local writes whose realistic failure is a *permanent* condition
 * (a record that no longer exists, a user that was deactivated), and re-running one is exactly how
 * a notification gets sent twice. The instance stops with the reason in `process_events`, which is
 * BPM's native answer — a visible incident, not a silent stall. A node may opt out with
 * `onError: "continue"`, which records the failure and lets the process move on.
 */

export const BPM_SERVICE_TASK_JOB = 'bpm.serviceTask';
export const BPM_TASK_TIMER_JOB = 'bpm.taskTimer';

export interface BpmEngineDeps {
  db: Queryable;
  log: Logger;
  registry: JobRegistry;
  enqueue: (job: string, data: Record<string, unknown>) => Promise<string>;
  /** Injected in tests; production builds its own stores from `db`. */
  store?: BpmStore;
  workflowStore?: WorkflowStore;
}

/** Instance statuses a job may still act on; anything else finished while the message waited. */
function isActive(status: string): boolean {
  return status === 'running' || status === 'waiting';
}

export function registerBpmJobs(deps: BpmEngineDeps): void {
  const store = deps.store ?? createBpmStore(deps.db);
  const workflowStore = deps.workflowStore ?? createWorkflowStore(deps.db);

  // ---------------------------------------------------------------- service tasks
  deps.registry.register(BPM_SERVICE_TASK_JOB, async (context) => {
    const data = context.data ?? {};
    const instanceId = stringOf(data['instanceId']);
    const nodeId = stringOf(data['nodeId']);
    const action = stringOf(data['action']);
    if (instanceId === undefined || nodeId === undefined || action === undefined) {
      return { status: 'failed', message: 'bpm.serviceTask needs instanceId, nodeId and action.' };
    }

    const instance = await store.loadInstance(instanceId);
    if (instance === undefined) return { status: 'failed', message: `process instance ${instanceId} no longer exists.` };
    if (!isActive(instance.status)) {
      return { status: 'completed', result: { skipped: `instance already ${instance.status}` } };
    }

    const definition = await store.loadDefinition(instance.version_id);
    const node = definition?.nodes.find((candidate) => candidate.id === nodeId);
    if (node === undefined || node.type !== 'serviceTask') {
      await store.recordEvent({
        instanceId,
        nodeId,
        type: 'service.failed',
        message: `The definition no longer contains the service task "${nodeId}".`,
      });
      return { status: 'failed', message: `service task ${nodeId} is not in the stored definition.` };
    }

    const record = await store.loadRecord(instance.entity_type, instance.entity_id);
    const run = runContextOf(instance, record?.attrs ?? {});
    const actionNode: ActionNode = { id: nodeId, type: 'action', name: node.name, action, params: node.params };
    try {
      const result = await runWorkflowAction({ db: deps.db, log: deps.log, store: workflowStore, enqueue: deps.enqueue }, run, actionNode, record);
      await store.recordEvent({ instanceId, nodeId, type: 'service.completed', message: `${node.name}: ${result.summary}`, data: { action } });
      context.log(`${node.name}: ${result.summary}`);
      return { status: 'completed', result: { action, summary: result.summary } };
    } catch (error: unknown) {
      const message = errorMessage(error);
      await store.recordEvent({ instanceId, nodeId, type: 'service.failed', message: `${node.name}: ${message}`, data: { action } });
      if ((node.onError ?? 'fail') === 'fail') {
        await store.failInstance({ instanceId, error: `${node.name}: ${message}` });
        context.log(`${node.name} failed; the process was stopped: ${message}`);
        return { status: 'completed', result: { action, failed: message } };
      }
      context.log(`${node.name} failed and was tolerated (onError: continue): ${message}`);
      return { status: 'completed', result: { action, failed: message, continued: true } };
    }
  });

  // ---------------------------------------------------------------- timers
  deps.registry.register(BPM_TASK_TIMER_JOB, async (context) => {
    const data = context.data ?? {};
    const taskId = stringOf(data['taskId']);
    const kind = stringOf(data['kind']);
    if (taskId === undefined || (kind !== 'due' && kind !== 'escalate')) {
      return { status: 'failed', message: 'bpm.taskTimer needs a taskId and kind "due" or "escalate".' };
    }

    const task = await store.loadTask(taskId);
    // Stale timers are normal: the task was answered, or the process was cancelled while this
    // message waited in the queue. Skipping is the correct, idempotent behaviour.
    if (task === undefined) return { status: 'completed', result: { skipped: 'task no longer exists' } };
    const instance = await store.loadInstance(task.instance_id);
    if (instance === undefined || !isActive(instance.status)) {
      return { status: 'completed', result: { skipped: 'instance is no longer active' } };
    }

    if (kind === 'due') {
      const changed = await store.markTaskOverdue(taskId);
      if (!changed) return { status: 'completed', result: { skipped: `task already ${task.status}` } };
      await store.recordEvent({
        instanceId: task.instance_id,
        nodeId: task.node_id,
        type: 'task.overdue',
        message: `Task "${task.name}" is overdue.`,
      });
      if (task.assignee_id !== null) {
        await store.notify(task.assignee_id, `Overdue process task: ${task.name}`, { taskId, instanceId: task.instance_id });
      }
      context.log(`task ${taskId} is overdue`);
      return { status: 'completed', result: { overdue: taskId } };
    }

    // ---- escalation: re-resolve the target against live data (it may be long after creation)
    const definition = await store.loadDefinition(instance.version_id);
    const node = definition?.nodes.find((candidate) => candidate.id === task.node_id);
    if (node === undefined || node.type !== 'userTask' || node.escalateTo === undefined) {
      return { status: 'completed', result: { skipped: 'the task no longer escalates' } };
    }
    let resolved: { userId: string | null; roleId: string | null };
    try {
      resolved = await resolveAssignee(store, node.escalateTo, instance.entity_type, instance.entity_id);
    } catch (error: unknown) {
      const message = errorMessage(error);
      await store.recordEvent({
        instanceId: task.instance_id,
        nodeId: task.node_id,
        type: 'escalation.failed',
        message: `Task "${task.name}" could not be escalated: ${message}`,
      });
      return { status: 'completed', result: { failed: message } };
    }
    const changed = await store.escalateTask({ taskId, assigneeId: resolved.userId, assigneeRoleId: resolved.roleId });
    if (!changed) return { status: 'completed', result: { skipped: `task already ${task.status}` } };
    await store.recordEvent({
      instanceId: task.instance_id,
      nodeId: task.node_id,
      type: 'task.escalated',
      message: `Task "${task.name}" was escalated to ${node.escalateTo.type} "${node.escalateTo.value}".`,
      data: { escalateTo: node.escalateTo },
    });
    if (resolved.userId !== null) {
      await store.notify(resolved.userId, `Escalated process task: ${task.name}`, { taskId, instanceId: task.instance_id });
    }
    context.log(`task ${taskId} escalated`);
    return { status: 'completed', result: { escalated: taskId } };
  });
}

/**
 * Resolves who a task belongs to — the same three specs the API resolves when a task is created
 * (user id, role candidates, a field of the attached record), re-resolved here against live data
 * because an escalation may fire long after the task was created.
 */
async function resolveAssignee(
  store: BpmStore,
  spec: AssigneeSpec,
  entityType: string,
  entityId: string,
): Promise<{ userId: string | null; roleId: string | null }> {
  if (spec.type === 'role') {
    const roleId = await store.resolveRoleByName(spec.value);
    if (roleId === undefined) throw new Error(`no active role is named "${spec.value}"`);
    return { userId: null, roleId };
  }
  let userId = spec.value;
  if (spec.type === 'recordField') {
    const record = await store.loadRecord(entityType, entityId);
    const value = record?.attrs[spec.value];
    if (typeof value !== 'string' || value === '') {
      throw new Error(`the record has no value in field "${spec.value}"`);
    }
    userId = value;
  }
  if (!(await store.userIsActive(userId))) throw new Error(`user "${userId}" does not exist or is not active`);
  return { userId, roleId: null };
}

function runContextOf(instance: StoredProcessInstance, attrs: Record<string, unknown>): WorkflowRunContext {
  return {
    runId: instance.id,
    workflowId: instance.id,
    versionId: instance.version_id,
    entityType: instance.entity_type,
    entityId: instance.entity_id,
    userId: instance.initiated_by ?? undefined,
    record: attrs,
    attempt: 1,
  };
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
