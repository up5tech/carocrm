import { FormulaEngine } from '@carocrm/formula';
import { formulaContextOf, interpolate } from '@carocrm/workflow';

import { ProcessExecutionError } from '../errors/index.js';
import type {
  AdvanceResult,
  PendingOutcome,
  ProcessAdvancePorts,
  ProcessAdvanceState,
  ProcessDefinition,
  ProcessNode,
} from '../types/index.js';
import { commentContextKey, LAST_COMMENT_KEY, LAST_OUTCOME_KEY, outcomeContextKey } from '../types/index.js';
import { validateProcess } from '../validation/index.js';

/**
 * The BPM state machine (PLAN §36).
 *
 * ```text
 * Process Instance → State Machine → Jobs / User Tasks / Events
 * ```
 *
 * The engine walks the single token forward and does exactly four things: dispatch a service task,
 * evaluate a gateway, park at a user task, or finish. Every effect goes through
 * {@link ProcessAdvancePorts}, so the file holds no database, queue or network concern and is
 * testable without any of them.
 *
 * **Deterministic and resumable** means: the only places a process can be standing are a `userTask`
 * (parked, waiting for a person) or a node the host persisted (`setCurrentNode`). Advancing is a
 * pure function of (definition, position, context, pending outcome) — the same inputs always walk
 * the same path, so a crash mid-advance can simply be replayed from the persisted position.
 *
 * A stored definition is re-validated before it runs, exactly as workflows do: metadata can be
 * edited by hand, and half a process executing before the error surfaces is worse than a clean
 * refusal. The validator's hot-loop rule is what makes the loop below terminate.
 */

/** Belt-and-braces bound; a validated definition cannot come close (it must park at every loop). */
const MAX_STEPS_FACTOR = 4;
const MAX_STEPS_SLACK = 8;

export interface AdvanceOptions {
  /** Engine used to evaluate gateway formulas; the caller injects one with its own limits. */
  readonly engine?: FormulaEngine | undefined;
  readonly now?: Date | undefined;
  /** Attributes of the record the process is attached to (read by formulas and `{{placeholders}}`). */
  readonly record?: Record<string, unknown> | undefined;
  readonly entityType?: string | undefined;
  readonly entityId?: string | undefined;
  readonly userId?: string | undefined;
}

export interface AdvanceInput {
  readonly definition: ProcessDefinition;
  readonly state: ProcessAdvanceState;
  readonly ports: ProcessAdvancePorts;
  /** A human decision being applied: the engine continues *from* that task instead of parking. */
  readonly pending?: PendingOutcome | undefined;
  readonly options?: AdvanceOptions | undefined;
}

export async function advanceProcess(input: AdvanceInput): Promise<AdvanceResult> {
  const definition = validateProcess(input.definition);
  const engine = input.options?.engine ?? new FormulaEngine();
  const now = input.options?.now ?? new Date();
  const nodes = new Map<string, ProcessNode>(definition.nodes.map((node) => [node.id, node]));

  const context: Record<string, unknown> = { ...input.state.context };
  // The formula/parameter view is rebuilt at every evaluation, not snapshotted at the start: a task
  // outcome written mid-advance must be visible to the very next gateway that reads it.
  const contextSnapshot = (): Record<string, unknown> => ({
    ...formulaContextOf({
      record: input.options?.record ?? {},
      entityType: input.options?.entityType ?? '',
      entityId: input.options?.entityId ?? '',
      userId: input.options?.userId,
    }),
    ...context,
  });

  let pending = input.pending;
  let currentId = input.state.currentNode ?? definition.start;
  let previousId: string | null = input.state.currentNode ?? null;
  const guard = definition.nodes.length * MAX_STEPS_FACTOR + MAX_STEPS_SLACK;

  for (let steps = 0; steps < guard; steps += 1) {
    const node = nodes.get(currentId);
    if (node === undefined) {
      throw new ProcessExecutionError(`Node "${currentId}" does not exist in the stored definition.`, currentId);
    }

    if (previousId !== currentId) {
      await input.ports.recordEvent({
        type: 'node.entered',
        nodeId: node.id,
        message: `${previousId === null ? 'Started' : `Moved from "${previousId}" to`} "${node.name}".`,
        data: { from: previousId, to: node.id },
      });
      previousId = currentId;
    }

    switch (node.type) {
      case 'end': {
        const outcome = node.outcome ?? 'completed';
        await input.ports.recordEvent({
          type: 'instance.completed',
          nodeId: node.id,
          message: `Process completed at "${node.name}" with outcome "${outcome}".`,
          data: { outcome },
        });
        await input.ports.finishInstance({ outcome, context });
        return { status: 'completed', currentNode: null, outcome, context };
      }

      case 'gateway': {
        const branch = node.branches.find((candidate) => engine.evaluateCondition(candidate.when, { record: contextSnapshot(), now }));
        const target = branch?.next ?? node.default;
        await input.ports.recordEvent({
          type: 'branch.selected',
          nodeId: node.id,
          message: `Gateway "${node.name}" chose "${target}"${branch === undefined ? ' (default)' : ` on condition ${branch.when}`}.`,
          data: { chosen: target, matched: branch?.when ?? null },
        });
        currentId = target;
        continue;
      }

      case 'serviceTask': {
        // Dispatched, not awaited: a service task is background work (PLAN §5.5), so the engine
        // moves on and the worker reports back through the audit trail.
        const params = interpolate(node.params, contextSnapshot()) as Record<string, unknown>;
        await input.ports.dispatchServiceTask({ nodeId: node.id, action: node.action, params });
        await input.ports.recordEvent({
          type: 'service.dispatched',
          nodeId: node.id,
          message: `Dispatched action "${node.action}" for "${node.name}".`,
          data: { action: node.action },
        });
        currentId = node.next;
        continue;
      }

      case 'userTask': {
        if (pending?.nodeId === node.id) {
          // This arrival carries a human decision: record it and follow the chosen outcome.
          const outcomeSpec = node.outcomes.find((candidate) => candidate.value === pending?.outcome);
          if (outcomeSpec === undefined) {
            throw new ProcessExecutionError(
              `Outcome "${String(pending?.outcome)}" is not one of the outcomes of "${node.name}".`,
              node.id,
            );
          }
          context[outcomeContextKey(node.id)] = outcomeSpec.value;
          context[commentContextKey(node.id)] = pending?.comment ?? null;
          context[LAST_OUTCOME_KEY] = outcomeSpec.value;
          context[LAST_COMMENT_KEY] = pending?.comment ?? null;
          await input.ports.recordEvent({
            type: 'task.outcome',
            nodeId: node.id,
            message: `Task "${node.name}" was answered "${outcomeSpec.value}"${pending?.comment === undefined || pending?.comment === '' ? '' : `: ${pending.comment}`}.`,
            data: { outcome: outcomeSpec.value, comment: pending?.comment ?? null, userId: pending?.userId ?? null },
          });
          // Consumed: a later arrival at the same node must park and create a *new* task.
          pending = undefined;
          currentId = outcomeSpec.next;
          continue;
        }

        const dueAt = node.dueSeconds === undefined ? null : new Date(now.getTime() + node.dueSeconds * 1000);
        const escalateAt =
          node.escalateAfterSeconds === undefined ? null : new Date(now.getTime() + node.escalateAfterSeconds * 1000);
        const { taskId } = await input.ports.createTask({
          nodeId: node.id,
          name: node.name,
          assignee: node.assignee,
          dueAt,
          escalateAt,
        });
        if (node.dueSeconds !== undefined) {
          await input.ports.scheduleTimer({ taskId, kind: 'due', seconds: node.dueSeconds });
        }
        if (node.escalateAfterSeconds !== undefined) {
          await input.ports.scheduleTimer({ taskId, kind: 'escalate', seconds: node.escalateAfterSeconds });
        }
        await input.ports.recordEvent({
          type: 'task.created',
          nodeId: node.id,
          message: `Waiting at task "${node.name}"${dueAt === null ? '' : `, due ${dueAt.toISOString()}`}.`,
          data: { taskId, name: node.name, assignee: node.assignee, dueAt: dueAt?.toISOString() ?? null, escalateAt: escalateAt?.toISOString() ?? null },
        });
        await input.ports.setCurrentNode(node.id, context);
        return { status: 'waiting', currentNode: node.id, context };
      }
    }
  }

  throw new ProcessExecutionError(
    `The process made no progress after ${String(guard)} steps; the stored definition is not safe to run.`,
    currentId,
  );
}
