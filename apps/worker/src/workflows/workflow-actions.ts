import { randomUUID } from 'node:crypto';

import type { Logger } from '@carocrm/core/logger/index.js';
import type { ActionNode, WorkflowRunContext } from '@carocrm/workflow';
import { interpolate, WorkflowActionPendingError } from '@carocrm/workflow';

import type { Queryable } from '../db.js';
import type { StoredRecord, WorkflowStore } from './workflow-store.js';

/**
 * Workflow actions (PLAN §35 "Actions") — the only code a workflow definition can reach.
 *
 * Every implementation is a narrow statement against data the platform already owns: record writes
 * go through the same `entity_records` table the entity engine uses, notifications through the same
 * table the stream writes, and email through the same §28 job the API uses. What a workflow **cannot**
 * do is run SQL, call an arbitrary URL or execute code — the catalog in `packages/workflow` is the
 * complete list, and each entry here is one implementation of it.
 *
 * Actions run with **system authority** in the worker, not as the user who triggered them: that is
 * what makes automation useful (a record created through an API key can still notify a colleague),
 * and it is why creating, publishing and enabling a workflow is administrator-only.
 */

/** Physical columns that are bookkeeping and must never be rewritten by an automation. */
const RESERVED_FIELDS = new Set(['id', 'createdAt', 'modifiedAt', 'createdById', 'modifiedById', 'deletedAt', 'teams']);

/**
 * Phase 25.5 — the worker↔API door for workflow AI steps. The worker owns no agent logic and no
 * model credentials: it only carries a bounded request and the workflow's idempotency key. The API
 * re-checks the published version, principal, approval policy and output schema.
 */
export interface WorkflowAIDoor {
  readonly apiBaseUrl: string;
  /** Shared worker→API capability. Empty disables the action loudly rather than silently skipping it. */
  readonly secret: string;
  /** Injectable so unit tests never open a socket. */
  readonly fetcher?: typeof fetch;
}

export interface ActionDeps {
  db: Queryable;
  log: Logger;
  store: WorkflowStore;
  /** Enqueue a job (§24). Used by `runJob` and by `sendEmail`. */
  enqueue: (job: string, data: Record<string, unknown>) => Promise<string>;
  workflowAI?: WorkflowAIDoor | undefined;
}

export interface ActionResult {
  readonly summary: string;
  readonly detail?: Record<string, unknown>;
}

export interface SplitFields {
  /** Attributes written to the JSONB `attrs` column. */
  readonly attrs: Record<string, unknown>;
  /** `assignedUserId` maps to the physical ownership column, not to attrs. */
  readonly assignedUserId: string | null;
}

/**
 * Separates the attribute patch from ownership, and refuses bookkeeping fields outright.
 *
 * `assignedUserId` is a physical column in this schema (PLAN §44), so writing it into `attrs` would
 * create a second, invisible copy that no read path would honour. Silently ignoring it would be
 * worse: an administrator who assigned a record in an automation would see it do nothing.
 */
export function splitFields(fields: Record<string, unknown>): SplitFields {
  const attrs: Record<string, unknown> = {};
  let assignedUserId: string | null = null;

  for (const [key, value] of Object.entries(fields)) {
    if (RESERVED_FIELDS.has(key)) {
      throw new Error(`"${key}" is managed by the platform and cannot be written by a workflow`);
    }
    if (key === 'assignedUserId') {
      assignedUserId = value === null || value === undefined || value === '' ? null : String(value);
      continue;
    }
    attrs[key] = value;
  }
  return { attrs, assignedUserId };
}

export type WorkflowActionHandler = (input: {
  readonly deps: ActionDeps;
  readonly run: WorkflowRunContext;
  readonly node: ActionNode;
  readonly params: Record<string, unknown>;
}) => Promise<ActionResult>;

const CREATE_RECORD = `
  INSERT INTO entity_records
    (id, entity_type, name, attrs, assigned_user_id, created_at, modified_at, version)
  VALUES ($1, $2, $3, $4::jsonb, $5, now(), now(), 1)
  RETURNING id
`;

const PATCH_RECORD = `
  UPDATE entity_records
     SET attrs = attrs || $3::jsonb, modified_at = now(), version = version + 1
   WHERE id = $1 AND entity_type = $2 AND deleted_at IS NULL
   RETURNING id
`;

const ASSIGN_RECORD = `
  UPDATE entity_records SET assigned_user_id = $3, modified_at = now(), version = version + 1
   WHERE id = $1 AND entity_type = $2 AND deleted_at IS NULL
   RETURNING id
`;

const INSERT_NOTIFICATION = `
  INSERT INTO notifications (id, type, user_id, data, is_read, created_at)
  SELECT $1, $2, u.id, $4::jsonb, FALSE, now()
    FROM users u
   WHERE u.id = $3 AND u.is_deleted = FALSE AND u.is_active = TRUE
   RETURNING id
`;

export const WORKFLOW_ACTION_HANDLERS: Record<string, WorkflowActionHandler> = {
  updateRecord: async ({ deps, run, params }) => {
    const { attrs, assignedUserId } = splitFields((params['fields'] ?? {}) as Record<string, unknown>);
    if (Object.keys(attrs).length === 0 && assignedUserId === null) {
      return { summary: 'no writable fields' };
    }
    if (Object.keys(attrs).length > 0) {
      const result = await deps.db.query(PATCH_RECORD, [run.entityId, run.entityType, JSON.stringify(attrs)]);
      if ((result.rowCount ?? 0) === 0) throw new Error(`record ${run.entityType}/${run.entityId} no longer exists`);
    }
    if (assignedUserId !== null) {
      const assigned = await deps.db.query(ASSIGN_RECORD, [run.entityId, run.entityType, assignedUserId]);
      if ((assigned.rowCount ?? 0) === 0) throw new Error(`record ${run.entityType}/${run.entityId} no longer exists`);
    }
    return {
      summary: `updated ${run.entityType}/${run.entityId}`,
      detail: { fields: [...Object.keys(attrs), ...(assignedUserId === null ? [] : ['assignedUserId'])] },
    };
  },

  createRecord: async ({ deps, run, params }) => {
    const entityType = String(params['entityType'] ?? '');
    const { attrs, assignedUserId } = splitFields((params['fields'] ?? {}) as Record<string, unknown>);
    const id = randomUUID();
    const name = typeof attrs['name'] === 'string' && attrs['name'] !== '' ? attrs['name'] : `${entityType} from workflow`;
    await deps.db.query(CREATE_RECORD, [id, entityType, name, JSON.stringify(attrs), assignedUserId]);
    deps.log.info({ workflow: run.workflowId, entityType, id }, 'workflow created a record');
    return { summary: `created ${entityType}/${id}`, detail: { id, entityType } };
  },

  createNotification: async ({ deps, params }) => {
    const userId = String(params['userId'] ?? '');
    const message = String(params['message'] ?? '');
    const data = (params['data'] ?? {}) as Record<string, unknown>;
    const result = await deps.db.query(INSERT_NOTIFICATION, [randomUUID(), 'Workflow', userId, JSON.stringify({ message, ...data })]);
    if ((result.rowCount ?? 0) === 0) throw new Error(`cannot notify "${userId}": no such active user`);
    return { summary: `notified ${userId}` };
  },

  sendEmail: async ({ deps, params }) => {
    const to = String(params['to'] ?? '');
    const subject = String(params['subject'] ?? '');
    const body = String(params['body'] ?? '');
    const emailId = randomUUID();
    const attrs: Record<string, unknown> = {
      name: subject,
      status: 'Draft',
      toAddressList: to,
      subject,
      body,
      ...(params['cc'] === undefined ? {} : { ccAddressList: String(params['cc']) }),
      ...(params['bcc'] === undefined ? {} : { bccAddressList: String(params['bcc']) }),
    };
    await deps.db.query(CREATE_RECORD, [emailId, 'Email', subject, JSON.stringify(attrs), null]);
    // The API owns drafting and validation, the worker owns delivery (§28). Reusing that path means
    // a workflow email gets the same transport, ledger and retry behaviour as a human-sent one.
    await deps.enqueue('system.sendEmail', { emailId });
    deps.log.info({ emailId, to }, 'workflow queued an email');
    return { summary: `queued email to ${to}`, detail: { emailId } };
  },

  runJob: async ({ deps, params }) => {
    const jobName = String(params['jobName'] ?? '');
    const data = (params['data'] ?? {}) as Record<string, unknown>;
    const id = await deps.enqueue(jobName, data);
    return { summary: `queued ${jobName}`, detail: { jobId: id } };
  },

  runAgent: async ({ deps, run, node, params }) => {
    const door = deps.workflowAI;
    if (door === undefined || door.secret.trim() === '') {
      throw new Error('the AI workflow action is disabled: no worker capability is configured');
    }
    const agentId = String(params['agentId'] ?? '');
    const task = String(params['task'] ?? '').trim();
    if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(agentId)) {
      throw new Error('runAgent needs a published agent id');
    }
    if (task === '' || task.length > 4_000) throw new Error('runAgent needs a task of at most 4000 characters');

    // The ledger already owns workflow idempotency; this key reaches the agent run engine too, so a
    // resumed node cannot start a second model run even if the step row was lost.
    const idempotencyKey = `wf:${run.runId}:${node.id}`.slice(0, 120);
    const record = asObject(params['record']);
    const outputMapping = asObject(params['outputMapping']);
    const body: Record<string, unknown> = {
      agentId,
      task,
      idempotencyKey,
      approvalExpectation: params['approvalExpectation'] === 'must_require' ? 'must_require' : 'policy',
      workflow: {
        workflowId: run.workflowId,
        workflowRunId: run.runId,
        nodeId: node.id,
        entityType: run.entityType,
        entityId: run.entityId,
        ...(run.userId === undefined ? {} : { userId: run.userId }),
        ...(Object.keys(outputMapping).length === 0 ? {} : { outputMapping }),
      },
      ...(Object.keys(record).length === 0 ? {} : { record }),
      ...(params['skillKeys'] === undefined ? {} : { skillKeys: params['skillKeys'] }),
    };
    const fetcher = door.fetcher ?? fetch;
    const response = await fetcher(`${door.apiBaseUrl.replace(/\/$/, '')}/api/v1/AIAgents/action/worker/workflow/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-worker-secret': door.secret },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`agent workflow door answered HTTP ${String(response.status)}`);
    const payload = await response.json() as Record<string, unknown>;
    const agentRunId = String(payload['runId'] ?? '');
    if (payload['pending'] === true) {
      throw new WorkflowActionPendingError(`agent run ${agentRunId}`, { agentRunId, workflowNodeId: node.id });
    }
    const failure = asObject(payload['failure']);
    if (Object.keys(failure).length > 0) {
      throw new Error(`agent run ${agentRunId} failed: ${String(failure['message'] ?? failure['category'] ?? 'unknown')}`);
    }

    const fields = asObject(payload['fields']);
    if (Object.keys(fields).length > 0) {
      const target = mappedTarget(outputMapping, run);
      const { attrs, assignedUserId } = splitFields(fields);
      if (Object.keys(attrs).length > 0) {
        const patched = await deps.db.query(PATCH_RECORD, [target.id, target.entityType, JSON.stringify(attrs)]);
        if ((patched.rowCount ?? 0) === 0) throw new Error(`record ${target.entityType}/${target.id} no longer exists`);
      }
      if (assignedUserId !== null) {
        const assigned = await deps.db.query(ASSIGN_RECORD, [target.id, target.entityType, assignedUserId]);
        if ((assigned.rowCount ?? 0) === 0) throw new Error(`record ${target.entityType}/${target.id} no longer exists`);
      }
    }
    return {
      summary: `agent run ${agentRunId} settled as ${String(payload['status'] ?? 'unknown')}`,
      detail: { agentRunId, status: String(payload['status'] ?? 'unknown'), fields: Object.keys(fields) },
    };
  },
};

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function mappedTarget(mapping: Record<string, unknown>, run: WorkflowRunContext): { entityType: string; id: string } {
  const entityType = typeof mapping['entity'] === 'string' && mapping['entity'] !== '' ? mapping['entity'] : run.entityType;
  const id = typeof mapping['recordId'] === 'string' && mapping['recordId'] !== '' ? mapping['recordId'] : run.entityId;
  if (!/^[A-Z][A-Za-z0-9]{1,49}$/.test(entityType) || id.length > 120) {
    throw new Error('runAgent outputMapping names an invalid target record');
  }
  return { entityType, id };
}

/**
 * Runs one action with `{{field}}` placeholders resolved against the triggering record.
 *
 * A definition naming an action the catalog does not implement can only happen if a version was
 * published against a different build, so it fails loudly rather than silently doing nothing.
 */
export async function runWorkflowAction(
  deps: ActionDeps,
  run: WorkflowRunContext,
  node: ActionNode,
  stored: StoredRecord | undefined,
): Promise<ActionResult> {
  const handler = WORKFLOW_ACTION_HANDLERS[node.action];
  if (handler === undefined) {
    throw new Error(`action "${node.action}" has no implementation in this worker build`);
  }
  const params = interpolate(node.params, actionContextOf(stored, run)) as Record<string, unknown>;
  try {
    return await handler({ deps, run, node, params });
  } catch (error: unknown) {
    // Parking is a control signal for the executor, not an action failure: preserve the typed error
    // and its detail so the node can stay re-enterable until the agent run settles.
    if (error instanceof WorkflowActionPendingError) throw error;
    throw new Error(`${node.action} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The interpolation context for an action: the record's attributes plus its identity and owner. */
export function actionContextOf(stored: StoredRecord | undefined, run: WorkflowRunContext): Record<string, unknown> {
  return {
    ...(stored?.attrs ?? {}),
    id: run.entityId,
    entityId: run.entityId,
    entityType: run.entityType,
    userId: run.userId ?? null,
    assignedUserId: stored?.assignedUserId ?? null,
    createdById: stored?.createdById ?? null,
  };
}