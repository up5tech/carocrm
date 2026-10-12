import { isRecord } from '../shape.js';
import type { WorkflowDefinition, WorkflowEventType } from '../types/index.js';
import { ANY_ENTITY } from '../types/index.js';

/**
 * Trigger matching (PLAN §35 "Trigger").
 *
 * The worker already receives every entity mutation as a domain event (PLAN §23.2), so a workflow
 * trigger is *data matched against that stream* rather than a new subscription mechanism: an event
 * type and, optionally, an entity type (`*` for any). Matching is pure so the same rule decides
 * whether a run is enqueued — no hidden state, no per-workflow listener.
 */

export interface WorkflowEventLike {
  readonly eventType: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly userId?: string | undefined;
}

export interface MatchableWorkflow {
  readonly id: string;
  readonly versionId: string;
  readonly definition: unknown;
}

export interface WorkflowMatch {
  readonly workflowId: string;
  readonly versionId: string;
  readonly definition: WorkflowDefinition;
}

/** Every active, published workflow whose trigger covers this event, in a deterministic order. */
export function matchWorkflows(
  event: WorkflowEventLike,
  workflows: readonly MatchableWorkflow[],
): WorkflowMatch[] {
  const matches: WorkflowMatch[] = [];
  for (const workflow of workflows) {
    const definition = workflow.definition;
    if (!isRecord(definition) || !isRecord(definition['trigger'])) continue;
    const trigger = definition['trigger'];
    const eventType = trigger['eventType'];
    const entityType = trigger['entityType'];
    if (eventType !== event.eventType) continue;
    if (entityType !== ANY_ENTITY && entityType !== event.entityType) continue;
    matches.push({ workflowId: workflow.id, versionId: workflow.versionId, definition: definition as unknown as WorkflowDefinition });
  }
  return matches.sort((left, right) => left.workflowId.localeCompare(right.workflowId));
}

/** Narrows a domain-event type to the workflow catalog; `'*'` and anything unknown cannot trigger. */
export function asEventType(value: string): WorkflowEventType | undefined {
  return value === 'entity.created' ||
    value === 'entity.updated' ||
    value === 'entity.deleted' ||
    value === 'entity.restored'
    ? value
    : undefined;
}