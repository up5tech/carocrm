/**
 * BPM errors (PLAN §36).
 *
 * A definition that cannot run is a *validation* problem and must list every issue at once — an
 * approval builder that rejects one mistake per save is unusable. Runtime failures are different:
 * they carry the instance and the node they stopped on, because a process that dies halfway must
 * leave a visible trail rather than a silent half-state.
 */

export type ProcessIssueCode =
  | 'PROCESS_INVALID'
  | 'PROCESS_NOT_FOUND'
  | 'PROCESS_ALREADY_EXISTS'
  | 'PROCESS_IMMUTABLE_VERSION'
  | 'PROCESS_INSTANCE_NOT_FOUND'
  | 'PROCESS_TASK_NOT_FOUND'
  | 'PROCESS_NODE_NOT_FOUND'
  | 'PROCESS_UNREACHABLE_NODE'
  | 'PROCESS_DEAD_END'
  | 'PROCESS_HOT_LOOP'
  | 'PROCESS_UNKNOWN_ACTION'
  | 'PROCESS_INVALID_FORMULA'
  | 'PROCESS_INVALID_ASSIGNEE'
  | 'PROCESS_INVALID_OUTCOME';

export interface ProcessIssue {
  readonly code: ProcessIssueCode;
  readonly message: string;
  /** Where the issue is: a node id, a field name, … */
  readonly path?: string | undefined;
}

export class ProcessValidationError extends Error {
  readonly code: ProcessIssueCode;
  readonly issues: readonly ProcessIssue[];

  constructor(message: string, issues: readonly ProcessIssue[]) {
    super(message);
    this.name = 'ProcessValidationError';
    this.code = 'PROCESS_INVALID';
    this.issues = issues;
  }

  toJSON(): { code: ProcessIssueCode; message: string; issues: readonly ProcessIssue[] } {
    return { code: this.code, message: this.message, issues: this.issues };
  }
}

/**
 * Raised when execution cannot continue — a broken definition that slipped through, an assignee
 * that no longer resolves, a failed service task with `onError: "fail"`. The caller turns this into
 * an `instance.failed` event so the audit trail explains why the process stopped.
 */
export class ProcessExecutionError extends Error {
  readonly nodeId: string | undefined;

  constructor(message: string, nodeId?: string) {
    super(message);
    this.name = 'ProcessExecutionError';
    this.nodeId = nodeId;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
