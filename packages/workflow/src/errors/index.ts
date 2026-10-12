/**
 * Workflow errors (PLAN §35).
 *
 * A definition that cannot run is a *validation* problem and must be reported to whoever is editing
 * it, with every issue listed at once — an automation builder that rejects one mistake per save is
 * unusable. A run that fails is a different thing and carries the node it died on.
 */

export type WorkflowIssueCode =
  | 'WORKFLOW_INVALID'
  | 'WORKFLOW_NOT_FOUND'
  | 'WORKFLOW_ALREADY_EXISTS'
  | 'WORKFLOW_IMMUTABLE_VERSION'
  | 'WORKFLOW_RUN_NOT_FOUND'
  | 'WORKFLOW_NODE_NOT_FOUND'
  | 'WORKFLOW_CYCLE'
  | 'WORKFLOW_UNREACHABLE_NODE'
  | 'WORKFLOW_UNKNOWN_ACTION'
  | 'WORKFLOW_INVALID_FORMULA'
  | 'WORKFLOW_BAD_TRIGGER';

export interface WorkflowIssue {
  readonly code: WorkflowIssueCode;
  readonly message: string;
  /** Where the issue is: a node id, a field name, … */
  readonly path?: string | undefined;
}

export class WorkflowValidationError extends Error {
  readonly code: WorkflowIssueCode;
  readonly issues: readonly WorkflowIssue[];

  constructor(message: string, issues: readonly WorkflowIssue[]) {
    super(message);
    this.name = 'WorkflowValidationError';
    this.code = 'WORKFLOW_INVALID';
    this.issues = issues;
  }

  toJSON(): { code: WorkflowIssueCode; message: string; issues: readonly WorkflowIssue[] } {
    return { code: this.code, message: this.message, issues: this.issues };
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}