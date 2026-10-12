import { generateId } from '@carocrm/core/utils/id.js';
import type { MatchableWorkflow, WorkflowDefinition , WorkflowStepSnapshot } from '@carocrm/workflow';

import type { Queryable } from '../db.js';
import { rowNumber, rowRecord, rowString } from '../db.js';

/**
 * Workflow persistence for the worker (PLAN §35).
 *
 * Plain `pg` through the worker's existing {@link Queryable} port — the worker has no Kysely and no
 * Nest container, and adding either for two tables would be ceremony.
 *
 * Everything here is written for **retry safety**: `startRun` reuses an existing run row for the
 * same (workflow, version, record, node) rather than creating a second one, and `recordStep`
 * upserts on `(run_id, node_id)`. A redelivered queue message therefore continues one run instead
 * of duplicating it.
 */

export const WORKFLOWS_QUERY = `
  SELECT w.id, w.name, v.id AS version_id, v.definition
    FROM workflows w
    JOIN workflow_versions v ON v.id = w.published_version_id
   WHERE w.is_active = TRUE
     AND w.is_deleted = FALSE
     AND v.status = 'published'
`;

export const ACTIVE_WORKFLOW_BY_EVENT_SQL = `
  SELECT w.id, w.name, v.id AS version_id, v.definition
    FROM workflows w
    JOIN workflow_versions v ON v.id = w.published_version_id
   WHERE w.is_active = TRUE
     AND w.is_deleted = FALSE
     AND v.status = 'published'
     AND v.definition -> 'trigger' ->> 'eventType' = $1
     AND v.definition -> 'trigger' ->> 'entityType' IN ($2, '*')
`;

export const RECORD_SQL = `
  SELECT id, entity_type, attrs, assigned_user_id, created_by_id
    FROM entity_records
   WHERE id = $1 AND entity_type = $2 AND deleted_at IS NULL
`;

export const RUN_BY_ID_SQL = `
  SELECT id, workflow_id, version_id, entity_type, entity_id, status, user_id, attempt
    FROM workflow_runs WHERE id = $1
`;

export const STEPS_BY_RUN_SQL = `
  SELECT node_id, node_type, name, status, attempt, output, error
    FROM workflow_run_steps WHERE run_id = $1 ORDER BY started_at ASC
`;

export const VERSION_BY_ID_SQL = `
  SELECT id, workflow_id, version, definition FROM workflow_versions WHERE id = $1
`;

export interface StoredRun {
  id: string;
  workflow_id: string;
  version_id: string;
  entity_type: string;
  entity_id: string;
  status: string;
  user_id: string | null;
  attempt: number;
}

export interface ActiveWorkflow extends MatchableWorkflow {
  readonly name: string;
}

export interface StoredRecord {
  id: string;
  entityType: string;
  attrs: Record<string, unknown>;
  assignedUserId: string | null;
  createdById: string | null;
}

export interface WorkflowStore {
  /** Workflows that are enabled and published, optionally narrowed to one event type. */
  activeWorkflows(eventType?: string, entityType?: string): Promise<ActiveWorkflow[]>;
  /** One enabled, published workflow by id — used when a run is (re)started by id. */
  activeWorkflow(id: string): Promise<ActiveWorkflow | undefined>;
  loadRecord(entityType: string, entityId: string): Promise<StoredRecord | undefined>;
  loadRun(runId: string): Promise<StoredRun | undefined>;
  loadSteps(runId: string): Promise<WorkflowStepSnapshot[]>;
  loadDefinition(versionId: string): Promise<WorkflowDefinition | undefined>;
  /** Reuse the run row for this exact (workflow, version, record) when a retry arrives. */
  startRun(input: {
    workflowId: string;
    versionId: string;
    entityType: string;
    entityId: string;
    userId: string | null;
  }): Promise<StoredRun>;
  recordStep(input: {
    runId: string;
    nodeId: string;
    nodeType: string;
    name: string;
    status: string;
    attempt: number;
    output: unknown;
    error: string | null;
  }): Promise<void>;
  markWaiting(input: { runId: string; currentNode: string | null }): Promise<void>;
  finishRun(input: { runId: string; status: string; error: string | null }): Promise<void>;
  /** Runs older than the retention window are pruned by `system.cleanupWorkflowRuns`. */
  pruneRuns(retentionDays: number): Promise<number>;
}

export function createWorkflowStore(db: Queryable): WorkflowStore {
  return {
    activeWorkflows: async (eventType, entityType) => {
      const result = eventType === undefined || entityType === undefined
        ? await db.query(WORKFLOWS_QUERY)
        : await db.query(ACTIVE_WORKFLOW_BY_EVENT_SQL, [eventType, entityType]);
      return result.rows.map(toActiveWorkflow);
    },

    activeWorkflow: async (id) => {
      const result = await db.query(`${WORKFLOWS_QUERY} AND w.id = $1`, [id]);
      const row = result.rows[0];
      return row === undefined ? undefined : toActiveWorkflow(row);
    },

    loadRecord: async (entityType, entityId) => {
      const result = await db.query(RECORD_SQL, [entityId, entityType]);
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

    loadRun: async (runId) => {
      const result = await db.query(RUN_BY_ID_SQL, [runId]);
      const row = result.rows[0];
      if (row === undefined) return undefined;
      return {
        id: rowString(row, 'id'),
        workflow_id: rowString(row, 'workflow_id'),
        version_id: rowString(row, 'version_id'),
        entity_type: rowString(row, 'entity_type'),
        entity_id: rowString(row, 'entity_id'),
        status: rowString(row, 'status'),
        user_id: typeof row['user_id'] === 'string' ? row['user_id'] : null,
        attempt: rowNumber(row, 'attempt'),
      };
    },

    loadSteps: async (runId) => {
      const result = await db.query(STEPS_BY_RUN_SQL, [runId]);
      return result.rows.map((row): WorkflowStepSnapshot => ({
        runId,
        nodeId: rowString(row, 'node_id'),
        nodeType: rowString(row, 'node_type') as WorkflowStepSnapshot['nodeType'],
        name: rowString(row, 'name'),
        status: rowString(row, 'status') as WorkflowStepSnapshot['status'],
        attempt: rowNumber(row, 'attempt'),
        output: row['output'] === null || row['output'] === undefined ? null : row['output'],
      }));
    },

    loadDefinition: async (versionId) => {
      const result = await db.query(VERSION_BY_ID_SQL, [versionId]);
      const row = result.rows[0];
      if (row === undefined) return undefined;
      return row['definition'] as WorkflowDefinition;
    },

    startRun: async ({ workflowId, versionId, entityType, entityId, userId }) => {
      // One run per (workflow, version, record): a redelivered message resumes it instead of
      // starting a second automation over the same record.
      const existing = await db.query(
        `SELECT id, workflow_id, version_id, entity_type, entity_id, status, user_id, attempt
           FROM workflow_runs
          WHERE workflow_id = $1 AND version_id = $2 AND entity_type = $3 AND entity_id = $4
            AND status IN ('running', 'waiting')
          ORDER BY created_at DESC LIMIT 1`,
        [workflowId, versionId, entityType, entityId],
      );
      const found = existing.rows[0];
      if (found !== undefined) {
        await db.query(
          `UPDATE workflow_runs SET status = 'running', error = NULL, finished_at = NULL,
                  attempt = attempt + 1, current_node = NULL, modified_at = now()
            WHERE id = $1`,
          [rowString(found, 'id')],
        );
        return {
          id: rowString(found, 'id'),
          workflow_id: rowString(found, 'workflow_id'),
          version_id: rowString(found, 'version_id'),
          entity_type: rowString(found, 'entity_type'),
          entity_id: rowString(found, 'entity_id'),
          status: 'running',
          user_id: typeof found['user_id'] === 'string' ? found['user_id'] : null,
          attempt: rowNumber(found, 'attempt') + 1,
        };
      }

      const id = generateId();
      await db.query(
        `INSERT INTO workflow_runs
           (id, workflow_id, version_id, entity_type, entity_id, status, user_id, attempt, started_at)
         VALUES ($1, $2, $3, $4, $5, 'running', $6, 1, now())`,
        [id, workflowId, versionId, entityType, entityId, userId],
      );
      return {
        id,
        workflow_id: workflowId,
        version_id: versionId,
        entity_type: entityType,
        entity_id: entityId,
        status: 'running',
        user_id: userId,
        attempt: 1,
      };
    },

    recordStep: async ({ runId, nodeId, nodeType, name, status, attempt, output, error }) => {
      const now = new Date();
      await db.query(
        `INSERT INTO workflow_run_steps
           (id, run_id, node_id, node_type, name, status, attempt, output, error, started_at, finished_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, now(), $10, now(), now())
         ON CONFLICT (run_id, node_id) DO UPDATE
            SET status = EXCLUDED.status,
                attempt = EXCLUDED.attempt,
                output = EXCLUDED.output,
                error = EXCLUDED.error,
                finished_at = EXCLUDED.finished_at,
                updated_at = now()
         RETURNING id`,
        [
          generateId(),
          runId,
          nodeId,
          nodeType,
          name,
          status,
          attempt,
          JSON.stringify(output ?? null),
          error,
          status === 'running' ? null : now,
        ],
      );
    },

    markWaiting: async ({ runId, currentNode }) => {
      await db.query(`UPDATE workflow_runs SET status = 'waiting', current_node = $2, modified_at = now() WHERE id = $1`, [runId, currentNode]);
    },

    finishRun: async ({ runId, status, error }) => {
      await db.query(
        `UPDATE workflow_runs SET status = $2, error = $3, finished_at = now(), current_node = NULL, modified_at = now() WHERE id = $1`,
        [runId, status, error],
      );
    },

    pruneRuns: async (retentionDays) => {
      const result = await db.query(
        `DELETE FROM workflow_runs
          WHERE status IN ('completed', 'failed', 'cancelled')
            AND created_at < now() - make_interval(days => $1::int)`,
        [retentionDays],
      );
      return result.rowCount ?? 0;
    },
  };
}

function toActiveWorkflow(row: Record<string, unknown>): ActiveWorkflow {
  return {
    id: rowString(row, 'id'),
    name: rowString(row, 'name'),
    versionId: rowString(row, 'version_id'),
    definition: row['definition'] as unknown as WorkflowDefinition,
  };
}
