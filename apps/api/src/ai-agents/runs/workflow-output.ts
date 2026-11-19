/**
 * Phase 25.5 — bounded output mapping for workflow AI steps.
 *
 * The model's answer is never an expression and never code. It is read only after the run has
 * settled and, in `json` mode, revalidated against the exact schema of the captured version.
 * Only named primitive values are copied into a workflow's field patch; everything else is refused.
 */

import { validateBoundedJsonSchema } from '../ai-agent-config.js';
import type { WorkflowRunStartResult } from './triggers.js';

export interface WorkflowOutputMapping {
  readonly entity?: string | undefined;
  readonly recordId?: string | undefined;
  readonly fields: Record<string, string>;
}

export type WorkflowOutputResult =
  | { readonly kind: 'pending'; readonly runId: string }
  | { readonly kind: 'failed'; readonly runId: string; readonly failureCategory: string | null; readonly failureMessage: string | null }
  | { readonly kind: 'mapped'; readonly runId: string; readonly fields: Record<string, unknown> }
  | { readonly kind: 'unmapped'; readonly runId: string };

const SUCCESSFUL = new Set(['succeeded', 'partially_succeeded']);
const TERMINAL = new Set(['succeeded', 'partially_succeeded', 'failed', 'canceled', 'expired', 'blocked_by_policy', 'outcome_unknown']);

/** Resolve a dot path inside an already-validated result object. */
function valueAt(source: unknown, path: string): unknown {
  let current = source;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function primitiveOf(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

export function mapWorkflowOutput(start: WorkflowRunStartResult, mapping: WorkflowOutputMapping | undefined): WorkflowOutputResult {
  const run = start.run;
  if (!TERMINAL.has(run.status)) return { kind: 'pending', runId: run.id };
  if (!SUCCESSFUL.has(run.status)) {
    return {
      kind: 'failed',
      runId: run.id,
      failureCategory: run.failureCategory,
      failureMessage: run.failureMessage,
    };
  }
  if (mapping === undefined) return { kind: 'unmapped', runId: run.id };

  const result = typeof run.result === 'object' && run.result !== null ? run.result : {};
  if (start.outputMode === 'json') {
    if (start.outputSchema === undefined) {
      throw new Error('The captured version declares JSON output without a schema.');
    }
    const data = (result as Record<string, unknown>)['data'];
    const issues = validateBoundedJsonSchema(data, start.outputSchema);
    if (issues.length > 0) throw new Error('The agent result did not match its bounded output schema.');
  }

  const fields: Record<string, unknown> = {};
  let bytes = 0;
  for (const [target, path] of Object.entries(mapping.fields)) {
    const value = primitiveOf(valueAt(result, path));
    if (value === undefined) throw new Error(`The agent result has no bounded value at "${path}".`);
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    bytes += Buffer.byteLength(text, 'utf8') + target.length;
    if (bytes > 16_384) throw new Error('The mapped agent output is too large for a workflow field patch.');
    fields[target] = value;
  }
  return { kind: 'mapped', runId: run.id, fields };
}
