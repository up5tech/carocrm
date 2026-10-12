/**
 * Workflow definition and execution types (PLAN §35).
 *
 * A workflow is a **versioned definition plus a published pointer**. The definition is a small
 * directed graph:
 *
 * ```text
 * start ──▶ node ──▶ node ──▶ end
 *             │
 *             └─ condition ──then──▶ … ──▶ …
 *                      └otherwise──▶ …
 *             delay (resume later) ──▶ …
 * ```
 *
 * Nodes, edges and the trigger live in one JSON document, because a version must be an *atomic*
 * snapshot: a run that started against version 3 must still find exactly version 3 later, even while
 * somebody edits version 4. Published versions are immutable (PLAN §35: "never mutate a published
 * workflow in place without versioning").
 *
 * The shape is deliberately small. Automation is a data structure an administrator edits in a form,
 * not a program: there is no loop construct, no arbitrary code, and every branch is explicit.
 */

/** Domain events a workflow can trigger on (the §23.2 outbox catalog). */
export const WORKFLOW_EVENT_TYPES = ['entity.created', 'entity.updated', 'entity.deleted', 'entity.restored'] as const;
export type WorkflowEventType = (typeof WORKFLOW_EVENT_TYPES)[number];

/** `*` matches every entity type, as in the domain-event bus. */
export const ANY_ENTITY = '*';

export type WorkflowNodeType = 'action' | 'condition' | 'delay' | 'end';

export type RunStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
export type StepStatus = 'running' | 'completed' | 'failed' | 'skipped';

export interface WorkflowTrigger {
  readonly eventType: WorkflowEventType;
  /** Entity type the trigger is limited to, or `*`. */
  readonly entityType: string;
}

export interface ActionNode {
  readonly id: string;
  readonly type: 'action';
  readonly name: string;
  /** Action name, from {@link WORKFLOW_ACTIONS}. */
  readonly action: string;
  /** Action arguments; `{{field}}` placeholders are resolved against the run context. */
  readonly params: Record<string, unknown>;
  readonly next?: string | undefined;
}

export interface ConditionNode {
  readonly id: string;
  readonly type: 'condition';
  readonly name: string;
  /** A sandboxed formula (PLAN §22) evaluated against the triggering record. */
  readonly formula: string;
  readonly then: string;
  readonly otherwise?: string | undefined;
}

export interface DelayNode {
  readonly id: string;
  readonly type: 'delay';
  readonly name: string;
  /** Seconds to wait before continuing at `next`. */
  readonly seconds: number;
  readonly next?: string | undefined;
}

export interface EndNode {
  readonly id: string;
  readonly type: 'end';
  readonly name: string;
}

export type WorkflowNode = ActionNode | ConditionNode | DelayNode | EndNode;

export interface WorkflowDefinition {
  readonly trigger: WorkflowTrigger;
  /** Node the run starts at. Usually the first node; kept explicit so a draft can be edited freely. */
  readonly start: string;
  readonly nodes: readonly WorkflowNode[];
}

export interface WorkflowStepRecord {
  readonly runId: string;
  readonly nodeId: string;
  readonly nodeType: WorkflowNodeType;
  readonly name: string;
  readonly status: StepStatus;
  readonly attempt: number;
  readonly output?: unknown;
  readonly error?: string | undefined;
}

export interface WorkflowStepSnapshot extends WorkflowStepRecord {
  readonly id?: string | undefined;
}

export interface WorkflowRunContext {
  readonly runId: string;
  readonly workflowId: string;
  readonly versionId: string;
  readonly entityType: string;
  readonly entityId: string;
  /** The user whose action triggered the run, when there was one. */
  readonly userId?: string | undefined;
  /** Attributes of the triggering record at execution time. */
  readonly record: Record<string, unknown>;
  readonly attempt: number;
}

export interface WorkflowRunResult {
  readonly status: RunStatus;
  readonly message?: string | undefined;
  readonly result?: Record<string, unknown>;
}

export type { WorkflowIssue, WorkflowIssueCode } from '../errors/index.js';