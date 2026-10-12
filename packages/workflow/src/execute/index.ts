import { FormulaEngine } from '@carocrm/formula';

import { errorMessage } from '../errors/index.js';
import { formulaContextOf } from '../interpolate/index.js';
import type { ActionNode, WorkflowDefinition, WorkflowNode, WorkflowRunContext, WorkflowRunResult, WorkflowStepRecord, WorkflowStepSnapshot } from '../types/index.js';
import { validateDefinition } from '../validation/index.js';

/**
 * The workflow executor (PLAN §35).
 *
 * It walks the graph from the start node, one node at a time, and does exactly three things:
 * evaluate a condition, run an action, or park the run for a delay. Everything that touches the
 * world goes through {@link WorkflowExecutorPorts}, which is what keeps this file free of database,
 * queue and network concerns — and therefore testable without any of them.
 *
 * **Retries are safe by construction.** The run-steps ledger is the idempotency record: before a
 * node runs, the executor looks up whether that node already completed *in this run*, and if it did
 * it reuses the stored output instead of acting again. A retried job therefore resumes rather than
 * repeats — a notification is not sent twice just because the queue redelivered the message.
 *
 * **No loops.** A validated definition is acyclic, so a run visits each node at most once; the
 * `visited` set below is a belt-and-braces guard against a definition that bypassed validation.
 */

export interface WorkflowExecutorPorts {
  /** Execute one action. Implementations live in the host process (the worker). */
  runAction(input: { readonly run: WorkflowRunContext; readonly node: ActionNode; readonly params: Record<string, unknown> }): Promise<unknown>;
  /** Persist a step transition into the run-steps ledger. */
  recordStep(step: WorkflowStepRecord): Promise<void>;
  /** Steps already recorded for this run, used to make a retried attempt idempotent. */
  loadSteps(runId: string): Promise<WorkflowStepSnapshot[]>;
  /** Close the run out. */
  finishRun(input: { readonly runId: string; readonly status: 'completed' | 'failed' | 'cancelled'; readonly error?: string | undefined }): Promise<void>;
  /** Park the run for `delaySeconds`, continuing at `nextNodeId` when it fires. */
  scheduleResume(input: { readonly runId: string; readonly delaySeconds: number; readonly nextNodeId: string | undefined }): Promise<void>;
  /** Mark the run as waiting for a delay (so the UI can tell "paused" from "stuck"). */
  markWaiting(input: { readonly runId: string; readonly nextNodeId: string | undefined; readonly delaySeconds: number }): Promise<void>;
  log?(message: string): void;
  /** Cooperative cancellation (§24): a long run is asked to stop between nodes. */
  shouldStop?(): Promise<boolean>;
}

export interface ExecuteOptions {
  /** Start somewhere other than the definition's start node (a resumed run continues at `next`). */
  readonly startNodeId?: string | undefined;
  readonly engine?: FormulaEngine | undefined;
  readonly now?: Date | undefined;
}

export async function executeWorkflow(
  definition: WorkflowDefinition,
  run: WorkflowRunContext,
  ports: WorkflowExecutorPorts,
  options: ExecuteOptions = {},
): Promise<WorkflowRunResult> {
  // A stored definition is re-validated before it runs: metadata can be edited by hand, and half a
  // graph executing before the error surfaces is worse than a clean refusal.
  const validated = validateDefinition(definition);
  const engine = options.engine ?? new FormulaEngine();
  const now = options.now ?? new Date();
  const nodes = new Map<string, WorkflowNode>(validated.nodes.map((node) => [node.id, node]));

  const done = new Map<string, WorkflowStepSnapshot>();
  for (const step of await ports.loadSteps(run.runId)) {
    if (step.status === 'completed') done.set(step.nodeId, step);
  }

  const visited = new Set<string>();
  const executed: string[] = [];
  let currentId: string | undefined = options.startNodeId ?? validated.start;

  while (currentId !== undefined) {
    const node: WorkflowNode | undefined = nodes.get(currentId);
    if (node === undefined) {
      await ports.finishRun({ runId: run.runId, status: 'failed', error: `Node "${currentId}" does not exist.` });
      return { status: 'failed', message: `Node "${currentId}" does not exist.` };
    }
    if (visited.has(node.id)) {
      // Validation rejects cycles; reaching one anyway means the stored definition was edited
      // outside the API. Stop rather than loop.
      const message = `Workflow reached "${node.id}" twice; the stored definition is not acyclic.`;
      await ports.finishRun({ runId: run.runId, status: 'failed', error: message });
      return { status: 'failed', message };
    }
    visited.add(node.id);

    if (await isCancelled(ports)) {
      await ports.finishRun({ runId: run.runId, status: 'cancelled' });
      return { status: 'cancelled' };
    }

    try {
      switch (node.type) {
        case 'end': {
          await ports.recordStep(step(run, node, 'completed', {}));
          await ports.finishRun({ runId: run.runId, status: 'completed' });
          return { status: 'completed', result: { executed } };
        }
        case 'condition': {
          const matched = evaluateCondition(engine, node.formula, run, now);
          await ports.recordStep(step(run, node, 'completed', { matched }));
          currentId = matched ? node.then : node.otherwise;
          break;
        }
        case 'delay': {
          await ports.recordStep(step(run, node, 'completed', { delaySeconds: node.seconds }));
          await ports.markWaiting({ runId: run.runId, nextNodeId: node.next, delaySeconds: node.seconds });
          await ports.scheduleResume({ runId: run.runId, delaySeconds: node.seconds, nextNodeId: node.next });
          return { status: 'waiting', result: { executed, resumeAt: node.next ?? null, delaySeconds: node.seconds } };
        }
        case 'action': {
          const previous = done.get(node.id);
          if (previous !== undefined) {
            // A retried attempt: this node already did its work in an earlier attempt of this run.
            ports.log?.(`Node "${node.name}" already completed in an earlier attempt; reusing its result.`);
            executed.push(node.name);
            currentId = node.next;
            break;
          }
          await ports.recordStep(step(run, node, 'running', {}));
          const output = await ports.runAction({ run, node, params: node.params });
          await ports.recordStep(step(run, node, 'completed', { output }));
          executed.push(node.name);
          currentId = node.next;
          break;
        }
      }
    } catch (error: unknown) {
      const message = `${node.name}: ${errorMessage(error)}`;
      ports.log?.(`Workflow run ${run.runId} failed at "${node.name}": ${errorMessage(error)}`);
      await ports.recordStep(step(run, node, 'failed', {}, errorMessage(error)));
      await ports.finishRun({ runId: run.runId, status: 'failed', error: message });
      // Rethrow so the queue retries (§24). The steps already completed are skipped on the next
      // attempt, so a retry re-runs this node only.
      throw error;
    }
  }

  // A definition whose last action has no `next` and no end node simply finishes.
  await ports.finishRun({ runId: run.runId, status: 'completed' });
  return { status: 'completed', result: { executed } };
}

function evaluateCondition(
  engine: FormulaEngine,
  formula: string,
  run: WorkflowRunContext,
  now: Date,
): boolean {
  return engine.evaluateCondition(formula, {
    record: formulaContextOf({
      record: run.record,
      entityType: run.entityType,
      entityId: run.entityId,
      userId: run.userId,
    }),
    now,
  });
}

function step(
  run: WorkflowRunContext,
  node: WorkflowNode,
  status: WorkflowStepRecord['status'],
  extra: Record<string, unknown>,
  error?: string,
): WorkflowStepRecord {
  return {
    runId: run.runId,
    nodeId: node.id,
    nodeType: node.type,
    name: node.name,
    status,
    attempt: run.attempt,
    output: extra,
    error,
  };
}

async function isCancelled(ports: WorkflowExecutorPorts): Promise<boolean> {
  return ports.shouldStop === undefined ? false : await ports.shouldStop();
}