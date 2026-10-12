import type { AssigneeSpec, ProcessDefinition } from '@carocrm/bpm';
import { generateId } from '@carocrm/core/utils/id.js';

import type { Queryable } from '../db.js';
import { rowRecord, rowString } from '../db.js';
import type { StoredRecord } from '../workflows/workflow-store.js';

/**
 * BPM persistence for the worker (PLAN §36).
 *
 * Plain `pg` through the worker's existing {@link Queryable} port, same as the workflow store — the
 * worker has no Kysely and no Nest container.
 *
 * The worker only ever performs the two things a *clock* owns: firing a task's due/escalation
 * timer and running a dispatched service task. Every statement is written to be **idempotent under
 * redelivery**: status guards (`WHERE status = 'open'`) mean a timer that fires twice escalates
 * once, and an instance that was cancelled while the job sat in the queue is skipped rather than
 * acted upon (PLAN §5.5).
 */

export const INSTANCE_BY_ID_SQL = `
  SELECT id, version_id, entity_type, entity_id, status, initiated_by
    FROM process_instances WHERE id = $1
`;

export const PROCESS_VERSION_BY_ID_SQL = `
  SELECT id, definition FROM process_definition_versions WHERE id = $1
`;

export const TASK_BY_ID_SQL = `
  SELECT id, instance_id, node_id, name, status, assignee_id, assignee_role_id, assignee_spec, escalated_at
    FROM process_tasks WHERE id = $1
`;

export const PROCESS_RECORD_SQL = `
  SELECT id, entity_type, attrs, assigned_user_id, created_by_id
    FROM entity_records
   WHERE id = $1 AND entity_type = $2 AND deleted_at IS NULL
`;

export const ROLE_BY_NAME_SQL = `SELECT id FROM roles WHERE name = $1 AND is_deleted = FALSE`;
export const ACTIVE_USER_BY_ID_SQL = `SELECT id FROM users WHERE id = $1 AND is_active = TRUE AND is_deleted = FALSE`;

export interface StoredProcessInstance {
  id: string;
  version_id: string;
  entity_type: string;
  entity_id: string;
  status: string;
  initiated_by: string | null;
}

export interface StoredProcessTask {
  id: string;
  instance_id: string;
  node_id: string;
  name: string;
  status: string;
  assignee_id: string | null;
  assignee_role_id: string | null;
  assignee_spec: AssigneeSpec;
}

export interface BpmStore {
  loadInstance(instanceId: string): Promise<StoredProcessInstance | undefined>;
  loadDefinition(versionId: string): Promise<ProcessDefinition | undefined>;
  loadTask(taskId: string): Promise<StoredProcessTask | undefined>;
  /** Same shape as the workflow store's, so a service task can reuse §35 actions as-is. */
  loadRecord(entityType: string, entityId: string): Promise<StoredRecord | undefined>;
  resolveRoleByName(name: string): Promise<string | undefined>;
  userIsActive(userId: string): Promise<boolean>;
  /** `open -> overdue`; returns false when the task was answered or cancelled already. */
  markTaskOverdue(taskId: string): Promise<boolean>;
  /** Reassigns and marks `escalated`; returns false unless the task was still answerable. */
  escalateTask(input: { taskId: string; assigneeId: string | null; assigneeRoleId: string | null }): Promise<boolean>;
  recordEvent(input: { instanceId: string; nodeId?: string | undefined; type: string; message: string; data?: Record<string, unknown> | undefined }): Promise<void>;
  notify(userId: string, message: string, data: Record<string, unknown>): Promise<void>;
  /** Stops the instance with a visible reason and cancels the tasks waiting on it. */
  failInstance(input: { instanceId: string; error: string }): Promise<void>;
}

export function createBpmStore(db: Queryable): BpmStore {
  return {
    loadInstance: async (instanceId) => {
      const result = await db.query(INSTANCE_BY_ID_SQL, [instanceId]);
      const row = result.rows[0];
      if (row === undefined) return undefined;
      return {
        id: rowString(row, 'id'),
        version_id: rowString(row, 'version_id'),
        entity_type: rowString(row, 'entity_type'),
        entity_id: rowString(row, 'entity_id'),
        status: rowString(row, 'status'),
        initiated_by: typeof row['initiated_by'] === 'string' ? row['initiated_by'] : null,
      };
    },

    loadDefinition: async (versionId) => {
      const result = await db.query(PROCESS_VERSION_BY_ID_SQL, [versionId]);
      const row = result.rows[0];
      return row === undefined ? undefined : (row['definition'] as ProcessDefinition);
    },

    loadTask: async (taskId) => {
      const result = await db.query(TASK_BY_ID_SQL, [taskId]);
      const row = result.rows[0];
      if (row === undefined) return undefined;
      return {
        id: rowString(row, 'id'),
        instance_id: rowString(row, 'instance_id'),
        node_id: rowString(row, 'node_id'),
        name: rowString(row, 'name'),
        status: rowString(row, 'status'),
        assignee_id: typeof row['assignee_id'] === 'string' ? row['assignee_id'] : null,
        assignee_role_id: typeof row['assignee_role_id'] === 'string' ? row['assignee_role_id'] : null,
        assignee_spec: rowRecord(row, 'assignee_spec') as unknown as AssigneeSpec,
      };
    },

    loadRecord: async (entityType, entityId) => {
      const result = await db.query(PROCESS_RECORD_SQL, [entityId, entityType]);
      const row = result.rows[0];
      if (row === undefined) return undefined;
      return {
        id: rowString(row, 'id'),
        entityType: rowString(row, 'entity_type'),
        attrs: rowRecord(row, 'attrs'),
        assignedUserId: typeof row['assigned_user_id'] === 'string' ? row['assigned_user_id'] : null,
        createdById: typeof row['created_by_id'] === 'string' ? row['created_by_id'] : null,
      };
    },

    resolveRoleByName: async (name) => {
      const result = await db.query(ROLE_BY_NAME_SQL, [name]);
      const row = result.rows[0];
      return row === undefined ? undefined : rowString(row, 'id');
    },

    userIsActive: async (userId) => {
      const result = await db.query(ACTIVE_USER_BY_ID_SQL, [userId]);
      return (result.rowCount ?? 0) > 0;
    },

    markTaskOverdue: async (taskId) => {
      const result = await db.query(
        `UPDATE process_tasks SET status = 'overdue', updated_at = now()
          WHERE id = $1 AND status = 'open'
          RETURNING id`,
        [taskId],
      );
      return (result.rowCount ?? 0) > 0;
    },

    escalateTask: async ({ taskId, assigneeId, assigneeRoleId }) => {
      const result = await db.query(
        `UPDATE process_tasks
            SET status = 'escalated',
                assignee_id = $2,
                assignee_role_id = $3,
                escalated_at = now(),
                updated_at = now()
          WHERE id = $1 AND status IN ('open', 'overdue')
          RETURNING id`,
        [taskId, assigneeId, assigneeRoleId],
      );
      return (result.rowCount ?? 0) > 0;
    },

    recordEvent: async ({ instanceId, nodeId, type, message, data }) => {
      await db.query(
        `INSERT INTO process_events (id, instance_id, node_id, type, message, actor_id, data, created_at)
         VALUES ($1, $2, $3, $4, $5, NULL, $6::jsonb, now())`,
        [generateId(), instanceId, nodeId ?? null, type, message, JSON.stringify(data ?? {})],
      );
    },

    notify: async (userId, message, data) => {
      await db.query(
        `INSERT INTO notifications (id, type, user_id, data, is_read, created_at)
         VALUES ($1, 'ProcessTask', $2, $3::jsonb, FALSE, now())`,
        [generateId(), userId, JSON.stringify({ ...data, message })],
      );
    },

    failInstance: async ({ instanceId, error }) => {
      await db.query(
        `UPDATE process_tasks SET status = 'cancelled', updated_at = now()
          WHERE instance_id = $1 AND status IN ('open', 'overdue', 'escalated')`,
        [instanceId],
      );
      await db.query(
        `UPDATE process_instances
            SET status = 'failed', error = $2, finished_at = now(), modified_at = now()
          WHERE id = $1`,
        [instanceId, error],
      );
      await db.query(
        `INSERT INTO process_events (id, instance_id, node_id, type, message, actor_id, data, created_at)
         VALUES ($1, $2, NULL, 'instance.failed', $3, NULL, $4::jsonb, now())`,
        [generateId(), instanceId, `The process could not continue: ${error}`, JSON.stringify({ error })],
      );
    },
  };
}
