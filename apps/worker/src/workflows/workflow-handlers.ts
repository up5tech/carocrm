import type { JobContext, JobRegistry } from '@carocrm/jobs';
import type { ActionNode, WorkflowExecutorPorts, WorkflowRunContext } from '@carocrm/workflow';
import { asEventType, executeWorkflow, matchWorkflows } from '@carocrm/workflow';

import type { DomainEventBus } from '../events/domain-event-bus.js';
import type { ActionDeps } from './workflow-actions.js';
import { runWorkflowAction } from './workflow-actions.js';
import type { WorkflowStore } from './workflow-store.js';
import { createWorkflowStore } from './workflow-store.js';

/**
 * Workflow execution in the worker (PLAN §35, §23.2, §24).
 *
 * ```text
 * entity write → outbox event → DomainEventBus → matching enabled workflows
 *   → workflow.run job (§24: retry, backoff, cancellable, visible in /admin/jobs)
 *   → executeWorkflow() walks the graph, one node per step
 *   → delay node → workflow.resume job scheduled for later
 * ```
 *
 * The engine never runs inside the outbox poller or the request path: an automation that took ten
 * seconds must not delay event delivery, and an automation must never be able to slow down an API
 * call (PLAN §7.4). Everything therefore lands in the ordinary §24 queue.
 *
 * Two jobs, not one: `workflow.run` starts (or resumes) a run from its beginning, `workflow.resume`
 * continues one that parked at a delay node.
 */

export const WORKFLOW_RUN_JOB = 'workflow.run';
export const WORKFLOW_RESUME_JOB = 'workflow.resume';
export const WORKFLOW_CLEANUP_JOB = 'system.cleanupWorkflowRuns';
export const DEFAULT_RUN_RETENTION_DAYS = 30;

export interface WorkflowEngineDeps extends Omit<ActionDeps, 'store'> {
  registry: JobRegistry;
  domainEvents: DomainEventBus;
  store?: WorkflowStore;
}

export function registerWorkflowEngine(deps: WorkflowEngineDeps): void {
  const store = deps.store ?? createWorkflowStore(deps.db);

  // ---- subscriber: an entity mutation that matches an enabled workflow starts a run
  deps.domainEvents.subscribe({
    eventType: '*',
    name: 'workflow:trigger',
    handler: async (event) => {
      const eventType = asEventType(event.eventType);
      if (eventType === undefined) return;
      const payload = event.payload;
      const entityType = typeof payload['entityType'] === 'string' ? payload['entityType'] : undefined;
      const entityId = typeof payload['entityId'] === 'string' ? payload['entityId'] : undefined;
      if (entityType === undefined || entityId === undefined) return;

      const workflows = await store.activeWorkflows(eventType, entityType);
      const matches = matchWorkflows({ eventType, entityType, entityId }, workflows);
      for (const match of matches) {
        await deps.enqueue(WORKFLOW_RUN_JOB, {
          workflowId: match.workflowId,
          versionId: match.versionId,
          entityType,
          entityId,
          userId: typeof payload['userId'] === 'string' ? payload['userId'] : null,
        });
      }
      if (matches.length > 0) {
        deps.log.info({ eventType, entityType, entityId, workflows: matches.length }, 'workflow runs queued');
      }
    },
  });

  // ---- jobs
  deps.registry.register(WORKFLOW_RUN_JOB, async (context) => {
    const data = context.data ?? {};
    const workflowId = stringOf(data['workflowId']);
    const versionId = stringOf(data['versionId']);
    const entityType = stringOf(data['entityType']);
    const entityId = stringOf(data['entityId']);
    if (workflowId === undefined || versionId === undefined || entityType === undefined || entityId === undefined) {
      return { status: 'failed', message: 'workflow.run needs workflowId, versionId, entityType and entityId.' };
    }

    const stored = await store.startRun({
      workflowId,
      versionId,
      entityType,
      entityId,
      userId: typeof data['userId'] === 'string' ? data['userId'] : null,
    });
    const definition = await store.loadDefinition(versionId);
    if (definition === undefined) {
      await store.finishRun({ runId: stored.id, status: 'failed', error: `version ${versionId} no longer exists` });
      return { status: 'failed', message: `workflow version ${versionId} no longer exists.` };
    }

    const record = await store.loadRecord(entityType, entityId);
    const run = runContextOf(stored, versionId, record?.attrs ?? {});
    return toJobResult(await executeWorkflow(definition, run, executorPorts(context, deps, store, stored.attempt)));
  });

  deps.registry.register(WORKFLOW_RESUME_JOB, async (context) => {
    const data = context.data ?? {};
    const runId = stringOf(data['runId']);
    const startNodeId = stringOf(data['startNodeId']);
    if (runId === undefined) return { status: 'failed', message: 'workflow.resume needs a runId.' };

    const stored = await store.loadRun(runId);
    if (stored === undefined) return { status: 'failed', message: `workflow run ${runId} no longer exists.` };
    if (stored.status === 'completed' || stored.status === 'cancelled') {
      return { status: 'completed', result: { skipped: `run already ${stored.status}` } };
    }

    const definition = await store.loadDefinition(stored.version_id);
    if (definition === undefined) {
      await store.finishRun({ runId, status: 'failed', error: `version ${stored.version_id} no longer exists` });
      return { status: 'failed', message: `workflow version ${stored.version_id} no longer exists.` };
    }
    await store.finishRun({ runId, status: 'running', error: null });

    const record = await store.loadRecord(stored.entity_type, stored.entity_id);
    const run = runContextOf(stored, stored.version_id, record?.attrs ?? {});
    return toJobResult(
      await executeWorkflow(definition, run, executorPorts(context, deps, store, stored.attempt), {
        ...(startNodeId === undefined ? {} : { startNodeId }),
      }),
    );
  });

  deps.registry.register(WORKFLOW_CLEANUP_JOB, async (context) => {
    const retentionDays = numberOf(context.data?.['retentionDays']) ?? DEFAULT_RUN_RETENTION_DAYS;
    const deleted = await store.pruneRuns(retentionDays);
    context.log(`pruned ${String(deleted)} workflow run(s) older than ${String(retentionDays)} day(s)`);
    return { status: 'completed', result: { deleted } };
  });
}

/**
 * Binds the pure engine to this worker.
 *
 * `scheduleResume` is the one place where the engine reaches outside itself: a delay becomes a
 * scheduled §24 job, which is what makes a delayed workflow survive a worker restart.
 */
function executorPorts(
  context: JobContext,
  deps: WorkflowEngineDeps,
  store: WorkflowStore,
  attempt: number,
): WorkflowExecutorPorts {
  return {
    runAction: async ({ run, node }: { run: WorkflowRunContext; node: ActionNode }) => {
      const stored = await store.loadRecord(run.entityType, run.entityId);
      const result = await runWorkflowAction({ ...deps, store }, run, node, stored);
      context.log(`${node.name}: ${result.summary}`);
      return { ...result, ...(result.detail === undefined ? {} : { detail: result.detail }) };
    },
    recordStep: async (step) => {
      await store.recordStep({
        runId: step.runId,
        nodeId: step.nodeId,
        nodeType: step.nodeType,
        name: step.name,
        status: step.status,
        attempt: step.attempt > 0 ? step.attempt : attempt,
        output: step.output ?? null,
        error: step.error ?? null,
      });
    },
    loadSteps: async (runId) => store.loadSteps(runId),
    finishRun: async ({ runId, status, error }) => {
      await store.finishRun({ runId, status, error: error ?? null });
    },
    markWaiting: async ({ runId, nextNodeId }) => {
      await store.markWaiting({ runId, currentNode: nextNodeId ?? null });
    },
    scheduleResume: async ({ runId, delaySeconds, nextNodeId }) => {
      await deps.enqueue(WORKFLOW_RESUME_JOB, {
        runId,
        delaySeconds,
        ...(nextNodeId === undefined ? {} : { startNodeId: nextNodeId }),
      });
    },
    log: (message) => context.log(message),
    shouldStop: async () => context.shouldStop(),
  };
}

function runContextOf(
  stored: { id: string; workflow_id: string; version_id: string; entity_type: string; entity_id: string; user_id: string | null; attempt: number },
  versionId: string,
  attrs: Record<string, unknown>,
): WorkflowRunContext {
  return {
    runId: stored.id,
    workflowId: stored.workflow_id,
    versionId,
    entityType: stored.entity_type,
    entityId: stored.entity_id,
    userId: stored.user_id ?? undefined,
    record: attrs,
    attempt: stored.attempt,
  };
}

/** A waiting run is a success for the job (it finished its work), not a failure to retry. */
function toJobResult(result: { status: string; message?: string | undefined; result?: Record<string, unknown> | undefined }): {
  status: 'completed' | 'cancelled' | 'failed';
  message?: string;
  result?: Record<string, unknown>;
} {
  if (result.status === 'waiting') {
    return { status: 'completed', result: result.result ?? { waiting: true } };
  }
  if (result.status === 'completed') return { status: 'completed', ...(result.result === undefined ? {} : { result: result.result }) };
  if (result.status === 'cancelled') return { status: 'cancelled' };
  return { status: 'failed', message: result.message ?? 'workflow run failed' };
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
