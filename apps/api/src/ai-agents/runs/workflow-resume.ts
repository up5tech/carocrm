/**
 * Phase 25.5 — deterministic resume of a workflow step parked on an agent run.
 *
 * Kept out of the step loop so `runs/executor.ts` does not grow another external-life cycle branch.
 * The helper owns no queries: the caller supplies the two capabilities it needs.
 */

import { createHash } from 'node:crypto';

import { DuplicateRecordError } from '@carocrm/core/errors/index.js';
import { log } from '@carocrm/core/logger/index.js';

import { type RunStatus, TERMINAL_RUN_STATUSES } from '../ai-agents-module.js';
import { asRecord, type WorkflowRunMetadata } from './shared.js';

export interface WorkflowResumePorts {
  /** The job queue already de-duplicates on `id`; a repeated settlement is a no-op. */
  readonly enqueue: (input: { readonly job: string; readonly id: string; readonly data: Record<string, unknown> }) => Promise<unknown>;
  readonly note: (payload: Record<string, unknown>) => Promise<void>;
}

/**
 * Resume the parked node once an agent run settles (success or failure). The deterministic job id
 * makes a repeated `finish` harmless, and missing provenance fails closed with a warning rather than
 * waking an arbitrary workflow node.
 */
export async function resumeLinkedWorkflow(
  ports: WorkflowResumePorts,
  runId: string,
  status: RunStatus,
  settled: { readonly trigger: string | null; readonly input: unknown },
): Promise<void> {
  if (settled.trigger !== 'workflow' || !TERMINAL_RUN_STATUSES.has(status)) return;
  const meta = asRecord(asRecord(settled.input)['workflow']) as unknown as WorkflowRunMetadata;
  const workflowRunId = typeof meta.workflowRunId === 'string' ? meta.workflowRunId : '';
  const nodeId = typeof meta.nodeId === 'string' ? meta.nodeId : '';
  if (workflowRunId === '' || nodeId === '') {
    log.warn({ runId }, 'workflow-linked agent run has no workflow provenance; not resuming');
    return;
  }
  const jobId = createHash('sha256')
    .update(`${runId}:${workflowRunId}:${nodeId}`)
    .digest('hex')
    .slice(0, 32);
  try {
    await ports.enqueue({
      job: 'workflow.resume',
      id: jobId,
      data: { runId: workflowRunId, startNodeId: nodeId },
    });
    await ports.note({ workflowRunId, nodeId });
  } catch (error) {
    if (error instanceof DuplicateRecordError) return;
    log.warn({ runId, error: error instanceof Error ? error.message : 'unknown queue error' }, 'workflow resume could not be queued');
  }
}
