/**
 * BPM definition and execution types (PLAN §36).
 *
 * A process definition is a **single-token state machine**: one token walks the graph, parking at a
 * `userTask` (waiting for a person) or a `timer`, and running straight through the automatic parts
 * (`serviceTask`, `gateway`) until it stops or ends.
 *
 * ```text
 *        ┌──────────────── request changes ────────────────┐
 *        ▼                                                │
 * start ─▶ review (userTask: approve/reject) ──▶ approve (serviceTask) ─▶ end
 *                 └─ reject ───────────────────────────────▶ end (rejected)
 * ```
 *
 * Two deliberate scope decisions, both documented in `docs/bpm.md`:
 *
 *  - **Timers attach to tasks** (`dueSeconds`, `escalateAfterSeconds`) instead of being a node the
 *    flow waits on. A process that needs "wait three days then act" expresses that as an escalation
 *    timer on the task that should have been done in those three days; the *fire-and-forget* delay
 *    already exists as a workflow delay node (PLAN §35).
 *  - **One token.** A `gateway` branches, it never forks into parallel branches. Multi-step
 *    approvals are sequential in practice, and a single token keeps execution deterministic and
 *    resumable, which is what PLAN §36 asks for.
 *
 * Cycles *are* allowed here (unlike workflows) — "request changes, back to review" is the canonical
 * approval loop — so the validator's rule is the honest one: every cycle must contain a wait.
 */

export const PROCESS_NODE_TYPES = ['userTask', 'serviceTask', 'gateway', 'end'] as const;
export type ProcessNodeType = (typeof PROCESS_NODE_TYPES)[number];

export const PROCESS_INSTANCE_STATUSES = ['running', 'waiting', 'completed', 'cancelled', 'failed'] as const;
export type ProcessInstanceStatus = (typeof PROCESS_INSTANCE_STATUSES)[number];

export const PROCESS_TASK_STATUSES = ['open', 'overdue', 'escalated', 'completed', 'cancelled'] as const;
export type ProcessTaskStatus = (typeof PROCESS_TASK_STATUSES)[number];

/** How a task's responsible person is chosen. Resolved against live data when a task is created. */
export interface AssigneeSpec {
  /** `user`: a user id. `role`: every member of a role is a candidate. `recordField`: the record's field. */
  readonly type: 'user' | 'role' | 'recordField';
  readonly value: string;
}

/** A human decision: what can be answered at a task, its label, and where the flow goes. */
export interface OutcomeSpec {
  readonly value: string;
  readonly label: string;
  readonly next: string;
}

/** Waits for a person. The only node a `userTask` can leave through is one of its outcomes. */
export interface UserTaskNode {
  readonly id: string;
  readonly type: 'userTask';
  readonly name: string;
  readonly assignee: AssigneeSpec;
  readonly outcomes: readonly OutcomeSpec[];
  /** Marks the task overdue after this many seconds (and notifies the assignee once more). */
  readonly dueSeconds?: number | undefined;
  /** Escalates the task after this many seconds: reassigned to `escalateTo` when set, marked escalated. */
  readonly escalateAfterSeconds?: number | undefined;
  readonly escalateTo?: AssigneeSpec | undefined;
}

/** Runs one platform action (the PLAN §35 action catalog) without a person in the loop. */
export interface ServiceTaskNode {
  readonly id: string;
  readonly type: 'serviceTask';
  readonly name: string;
  readonly action: string;
  /** Parameters; `{{field}}` placeholders resolve against the record and the process context. */
  readonly params: Record<string, unknown>;
  readonly next: string;
  /** What a failing action does to the instance. Default `fail` — a broken step must be visible. */
  readonly onError?: 'fail' | 'continue' | undefined;
}

export interface GatewayBranch {
  /** Sandbox formula (PLAN §22) evaluated against the record and the process context. */
  readonly when: string;
  readonly next: string;
}

/** Exclusive gateway: the first branch whose condition holds wins, else the default target. */
export interface GatewayNode {
  readonly id: string;
  readonly type: 'gateway';
  readonly name: string;
  readonly branches: readonly GatewayBranch[];
  readonly default: string;
}

export interface EndNode {
  readonly id: string;
  readonly type: 'end';
  readonly name: string;
  /** Reported on the instance, e.g. `approved` / `rejected`. Defaults to `completed`. */
  readonly outcome?: string | undefined;
}

export type ProcessNode = UserTaskNode | ServiceTaskNode | GatewayNode | EndNode;

export interface ProcessDefinition {
  /** Record type instances attach to, or `*`. Duplicated into the definition row for list queries. */
  readonly entityType?: string | undefined;
  readonly start: string;
  readonly nodes: readonly ProcessNode[];
}

/**
 * The outcome of a human decision, applied when the flow reaches the task again.
 * `nodeId` ties the input to the task's node, so a stale completion cannot move a newer task.
 */
export interface PendingOutcome {
  readonly nodeId: string;
  readonly outcome: string;
  readonly comment?: string | undefined;
  readonly userId?: string | undefined;
}

/** Where the token currently is, plus the variables the process has accumulated. */
export interface ProcessAdvanceState {
  readonly currentNode: string | null;
  readonly context: Record<string, unknown>;
}

export interface CreateTaskInput {
  readonly nodeId: string;
  readonly name: string;
  readonly assignee: AssigneeSpec;
  readonly dueAt: Date | null;
  readonly escalateAt: Date | null;
}

export interface ProcessAdvancePorts {
  /** Creates the task row. Resolves the assignee spec; throws when it cannot (unknown role, …). */
  createTask(input: CreateTaskInput): Promise<{ taskId: string }>;
  /** Hands a service task to the background queue; the engine does not wait for its result. */
  dispatchServiceTask(input: { readonly nodeId: string; readonly action: string; readonly params: Record<string, unknown> }): Promise<void>;
  /** Arms a due/escalation timer for a task (a delayed job the worker fires). */
  scheduleTimer(input: { readonly taskId: string; readonly kind: 'due' | 'escalate'; readonly seconds: number }): Promise<void>;
  /** Persists one audit-trail entry (PLAN §36 auditability). */
  recordEvent(input: { readonly type: string; readonly nodeId?: string | undefined; readonly message: string; readonly data?: Record<string, unknown> | undefined }): Promise<void>;
  /** Persists the token position while the process is waiting (so a restart resumes there). */
  setCurrentNode(nodeId: string | null, context: Record<string, unknown>): Promise<void>;
  /** Closes the instance. */
  finishInstance(input: { readonly outcome: string; readonly context: Record<string, unknown> }): Promise<void>;
}

export interface AdvanceResult {
  readonly status: 'waiting' | 'completed';
  readonly currentNode: string | null;
  readonly outcome?: string | undefined;
  readonly context: Record<string, unknown>;
}

/** Context keys the engine writes, and how a formula reads them. */
export const outcomeContextKey = (nodeId: string): string => `${nodeId}Outcome`;
export const commentContextKey = (nodeId: string): string => `${nodeId}Comment`;
/** The most recent decision — `field("outcome")` in a gateway condition. */
export const LAST_OUTCOME_KEY = 'outcome';
export const LAST_COMMENT_KEY = 'comment';
