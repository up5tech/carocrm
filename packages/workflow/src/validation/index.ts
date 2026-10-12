import { FormulaEngine } from '@carocrm/formula';

import type { WorkflowActionSpec } from '../actions/index.js';
import { actionSpec,MAX_DELAY_SECONDS,WORKFLOW_ACTIONS  } from '../actions/index.js';
import type { WorkflowIssue } from '../errors/index.js';
import { WorkflowValidationError } from '../errors/index.js';
import { isRecord } from '../shape.js';
import type { WorkflowDefinition, WorkflowNode } from '../types/index.js';
import { ANY_ENTITY, WORKFLOW_EVENT_TYPES } from '../types/index.js';

/**
 * Definition validation (PLAN §35, §12.4).
 *
 * A workflow definition is data, and the only thing standing between an administrator's typo and a
 * run that crashes halfway through is this check. It answers four questions, and answers all of
 * them at once so an editor can show every problem in one pass:
 *
 *   1. Is the document the right shape at all? (nodes, ids, types)
 *   2. Does every edge point at a node that exists, and is the graph acyclic?
 *   3. Is every action known, and are its parameters valid?
 *   4. Does every condition formula parse and only call allowlisted functions?
 *
 * Conditions reuse the §22 formula engine rather than inventing a second expression language, so a
 * workflow condition is sandboxed exactly like a computed field.
 */

export interface ValidateOptions {
  /** Engine used to validate condition formulas; the caller injects one with its own limits. */
  readonly engine?: FormulaEngine | undefined;
}

export function definitionIssues(value: unknown, options: ValidateOptions = {}): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  if (!isRecord(value)) {
    return [{ code: 'WORKFLOW_INVALID', message: 'A workflow definition must be a JSON object.' }];
  }

  const trigger = value['trigger'];
  const start = value['start'];
  const rawNodes = value['nodes'];

  if (!isRecord(trigger)) {
    issues.push({ code: 'WORKFLOW_BAD_TRIGGER', message: 'The workflow needs a trigger.', path: 'trigger' });
  } else {
    const eventType = trigger['eventType'];
    if (typeof eventType !== 'string' || !(WORKFLOW_EVENT_TYPES as readonly string[]).includes(eventType)) {
      issues.push({
        code: 'WORKFLOW_BAD_TRIGGER',
        message: `A trigger must name one of ${WORKFLOW_EVENT_TYPES.join(', ')}.`,
        path: 'trigger.eventType',
      });
    }
    const entityType = trigger['entityType'];
    if (typeof entityType !== 'string' || (entityType !== ANY_ENTITY && !/^[A-Z][A-Za-z0-9]{1,49}$/.test(entityType))) {
      issues.push({
        code: 'WORKFLOW_BAD_TRIGGER',
        message: `A trigger must limit the entity to a PascalCase entity name or "${ANY_ENTITY}".`,
        path: 'trigger.entityType',
      });
    }
  }

  if (typeof start !== 'string' || start.trim() === '') {
    issues.push({ code: 'WORKFLOW_INVALID', message: 'The workflow needs a start node.', path: 'start' });
  }

  if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
    issues.push({ code: 'WORKFLOW_INVALID', message: 'A workflow needs at least one node.', path: 'nodes' });
    return issues;
  }

  const nodes = new Map<string, WorkflowNode>();
  for (const [index, raw] of rawNodes.entries()) {
    if (!isRecord(raw)) {
      issues.push({ code: 'WORKFLOW_INVALID', message: 'Every node must be a JSON object.', path: `nodes[${String(index)}]` });
      continue;
    }
    const id = raw['id'];
    if (typeof id !== 'string' || id.trim() === '') {
      issues.push({ code: 'WORKFLOW_INVALID', message: 'Every node needs an id.', path: `nodes[${String(index)}].id` });
      continue;
    }
    if (nodes.has(id)) {
      issues.push({ code: 'WORKFLOW_INVALID', message: `Duplicate node id "${id}".`, path: id });
      continue;
    }
    const node = readNode(raw, id, issues);
    if (node !== undefined) nodes.set(id, node);
  }

  if (typeof start === 'string' && nodes.size > 0 && !nodes.has(start)) {
    issues.push({ code: 'WORKFLOW_NODE_NOT_FOUND', message: `The start node "${start}" does not exist.`, path: 'start' });
  }

  // Edges, then reachability and cycles.
  const edges = new Map<string, string[]>();
  for (const node of nodes.values()) {
    const targets = targetsOf(node);
    edges.set(node.id, targets);
    for (const target of targets) {
      if (!nodes.has(target)) {
        issues.push({ code: 'WORKFLOW_NODE_NOT_FOUND', message: `Node "${node.id}" points at "${target}", which does not exist.`, path: node.id });
      }
    }
  }

  const reachable = visit(nodes, edges, typeof start === 'string' ? start : undefined);
  for (const id of nodes.keys()) {
    if (!reachable.has(id)) {
      issues.push({ code: 'WORKFLOW_UNREACHABLE_NODE', message: `Node "${id}" is never reached from the start node.`, path: id });
    }
  }

  // Reachability alone cannot see a cycle: every node of a cycle *is* reachable. A cycle would make
  // a run revisit a node, which is why the graph must be acyclic (PLAN §35 has no loop construct).
  const cycle = findCycle(edges, typeof start === 'string' ? start : undefined);
  if (cycle !== undefined) {
    issues.push({ code: 'WORKFLOW_CYCLE', message: `The workflow contains a loop: ${cycle.join(' -> ')}.`, path: cycle[0] });
  }

  const engine = options.engine ?? new FormulaEngine();
  for (const node of nodes.values()) {
    if (node.type !== 'condition') continue;
    const result = engine.validate(node.formula);
    if (!result.valid) {
      issues.push({
        code: 'WORKFLOW_INVALID_FORMULA',
        message: `Condition "${node.name}" is not a valid formula: ${result.error ?? 'parse error'}.`,
        path: node.id,
      });
    }
  }

  return issues;
}

/** Parses and validates a definition, throwing {@link WorkflowValidationError} when unusable. */
export function validateDefinition(value: unknown, options: ValidateOptions = {}): WorkflowDefinition {
  const issues = definitionIssues(value, options);
  if (issues.length > 0) {
    throw new WorkflowValidationError('The workflow definition is not valid.', issues);
  }
  return value as unknown as WorkflowDefinition;
}

function readNode(raw: Record<string, unknown>, id: string, issues: WorkflowIssue[]): WorkflowNode | undefined {
  const type = raw['type'];
  const name = typeof raw['name'] === 'string' && raw['name'].trim() !== '' ? raw['name'] : id;

  if (type === 'end') {
    return { id, type: 'end', name };
  }

  if (type === 'action') {
    const action = raw['action'];
    if (typeof action !== 'string') {
      issues.push({ code: 'WORKFLOW_UNKNOWN_ACTION', message: 'An action node must name an action.', path: id });
      return undefined;
    }
    const spec: WorkflowActionSpec | undefined = actionSpec(action);
    if (spec === undefined) {
      issues.push({
        code: 'WORKFLOW_UNKNOWN_ACTION',
        message: `"${action}" is not a known action. Available: ${WORKFLOW_ACTIONS.map((entry) => entry.name).join(', ')}.`,
        path: id,
      });
      return undefined;
    }
    const params = raw['params'] ?? {};
    if (!isRecord(params)) {
      issues.push({ code: 'WORKFLOW_INVALID', message: 'Action parameters must be a JSON object.', path: `${id}.params` });
      return undefined;
    }
    const parsed = spec.params.safeParse(params);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        issues.push({
          code: 'WORKFLOW_INVALID',
          message: `Action "${action}": ${issue.path.join('.') || '<root>'} ${issue.message}.`,
          path: `${id}.params`,
        });
      }
      return undefined;
    }
    const next = raw['next'];
    return {
      id,
      type: 'action',
      name,
      action,
      params: parsed.data,
      ...(typeof next === 'string' && next !== '' ? { next } : {}),
    };
  }

  if (type === 'condition') {
    const formula = raw['formula'];
    const then = raw['then'];
    if (typeof formula !== 'string' || formula.trim() === '') {
      issues.push({ code: 'WORKFLOW_INVALID_FORMULA', message: 'A condition node needs a formula.', path: id });
      return undefined;
    }
    if (typeof then !== 'string' || then === '') {
      issues.push({ code: 'WORKFLOW_INVALID', message: 'A condition node needs a "then" target.', path: id });
      return undefined;
    }
    const otherwise = raw['otherwise'];
    return {
      id,
      type: 'condition',
      name,
      formula,
      then,
      ...(typeof otherwise === 'string' && otherwise !== '' ? { otherwise } : {}),
    };
  }

  if (type === 'delay') {
    const seconds = raw['seconds'];
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
      issues.push({ code: 'WORKFLOW_INVALID', message: 'A delay node needs a non-negative number of seconds.', path: id });
      return undefined;
    }
    if (seconds > MAX_DELAY_SECONDS) {
      issues.push({
        code: 'WORKFLOW_INVALID',
        message: `A delay may not exceed ${String(MAX_DELAY_SECONDS)} seconds.`,
        path: id,
      });
      return undefined;
    }
    const next = raw['next'];
    return {
      id,
      type: 'delay',
      name,
      seconds,
      ...(typeof next === 'string' && next !== '' ? { next } : {}),
    };
  }

  issues.push({
    code: 'WORKFLOW_INVALID',
    message: `"${String(type)}" is not a node type (action, condition, delay, end).`,
    path: id,
  });
  return undefined;
}

function targetsOf(node: WorkflowNode): string[] {
  if (node.type === 'condition') return [node.then, ...(node.otherwise === undefined ? [] : [node.otherwise])];
  if (node.type === 'end') return [];
  return node.next === undefined ? [] : [node.next];
}

/** Nodes reachable from `start`, used to report configuration nobody can ever execute. */
function visit(nodes: Map<string, WorkflowNode>, edges: Map<string, string[]>, start: string | undefined): Set<string> {
  const seen = new Set<string>();
  if (start === undefined || !nodes.has(start)) return seen;
  const stack = [start];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    for (const target of edges.get(id) ?? []) {
      if (nodes.has(target) && !seen.has(target)) stack.push(target);
    }
  }
  return seen;
}

/**
 * First loop found from `start`, as the node ids that form it.
 *
 * Depth-first search with a "currently on the stack" marker: reaching a node that is already on the
 * stack means the edge being examined closes a cycle. Reachability alone cannot see this — every
 * node of a cycle is reachable.
 */
function findCycle(edges: Map<string, string[]>, start: string | undefined): string[] | undefined {
  if (start === undefined) return undefined;
  const onStack = new Set<string>();
  const done = new Set<string>();
  const path: string[] = [];

  const walk = (id: string): string[] | undefined => {
    if (onStack.has(id)) return [...path.slice(path.indexOf(id)), id];
    if (done.has(id)) return undefined;
    onStack.add(id);
    path.push(id);
    for (const target of edges.get(id) ?? []) {
      const found = walk(target);
      if (found !== undefined) return found;
    }
    path.pop();
    onStack.delete(id);
    done.add(id);
    return undefined;
  };

  return walk(start);
}