import { FormulaEngine } from '@carocrm/formula';
import { actionSpec, WORKFLOW_ACTIONS } from '@carocrm/workflow';

import type { ProcessIssue, ProcessIssueCode } from '../errors/index.js';
import { ProcessValidationError } from '../errors/index.js';
import { isRecord } from '../shape.js';
import type { AssigneeSpec, ProcessDefinition, ProcessNode } from '../types/index.js';

/**
 * Process definition validation (PLAN §36 "BPM Compiler/Validator").
 *
 * Like the workflow validator it answers every question in one pass, so an editor can show all
 * problems at once. The graph rules differ from §35 in exactly one way, and it is the interesting
 * one: **loops are legal** — "request changes, back to review" is the canonical approval flow, so a
 * cycle is not an error here. What must never be legal is a cycle with *nothing to wait for*: a
 * token would spin through service tasks and gateways forever without touching the database again.
 * So every cycle must contain a wait (`userTask`), which is also what makes the execution
 * "deterministic and resumable" (PLAN §36): the token can only ever be parked at a human.
 *
 * Four families of rules:
 *
 *   1. Shape — ids, node types, timers, assignee specs, outcomes.
 *   2. Edges — every target exists; every reachable node can reach an `end` (no dead ends).
 *   3. Structure — everything reachable from `start`; every cycle contains a wait.
 *   4. Payload — actions known (the §35 catalog), formulas parse in the §22 sandbox.
 */

export interface ValidateProcessOptions {
  /** Engine used to validate gateway formulas; the caller injects one with its own limits. */
  readonly engine?: FormulaEngine | undefined;
}

/** Longest a task timer may be set for (mirrors the workflow delay bound). */
export const MAX_PROCESS_TIMER_SECONDS = 365 * 24 * 60 * 60;

const ENTITY_NAME = /^[A-Z][A-Za-z0-9]{1,49}$/;
export const ANY_ENTITY = '*';

export function definitionIssues(value: unknown, options: ValidateProcessOptions = {}): ProcessIssue[] {
  const issues: ProcessIssue[] = [];
  if (!isRecord(value)) {
    return [{ code: 'PROCESS_INVALID', message: 'A process definition must be a JSON object.' }];
  }

  const entityType = value['entityType'];
  if (
    entityType !== undefined &&
    (typeof entityType !== 'string' || (entityType !== ANY_ENTITY && !ENTITY_NAME.test(entityType)))
  ) {
    issues.push({
      code: 'PROCESS_INVALID',
      message: `A process must limit its records to a PascalCase entity name or "${ANY_ENTITY}".`,
      path: 'entityType',
    });
  }

  const start = value['start'];
  if (typeof start !== 'string' || start.trim() === '') {
    issues.push({ code: 'PROCESS_INVALID', message: 'A process needs a start node.', path: 'start' });
  }

  const rawNodes = value['nodes'];
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
    issues.push({ code: 'PROCESS_INVALID', message: 'A process needs at least one node.', path: 'nodes' });
    return issues;
  }

  const nodes = new Map<string, ProcessNode>();
  for (const [index, raw] of rawNodes.entries()) {
    if (!isRecord(raw)) {
      issues.push({ code: 'PROCESS_INVALID', message: 'Every node must be a JSON object.', path: `nodes[${String(index)}]` });
      continue;
    }
    const id = raw['id'];
    if (typeof id !== 'string' || id.trim() === '') {
      issues.push({ code: 'PROCESS_INVALID', message: 'Every node needs an id.', path: `nodes[${String(index)}].id` });
      continue;
    }
    if (nodes.has(id)) {
      issues.push({ code: 'PROCESS_INVALID', message: `Duplicate node id "${id}".`, path: id });
      continue;
    }
    const node = readNode(raw, id, issues);
    if (node !== undefined) nodes.set(id, node);
  }

  if (typeof start === 'string' && nodes.size > 0 && !nodes.has(start)) {
    issues.push({ code: 'PROCESS_NODE_NOT_FOUND', message: `The start node "${start}" does not exist.`, path: 'start' });
  }

  // Edges.
  const edges = new Map<string, string[]>();
  for (const node of nodes.values()) {
    const targets = targetsOf(node);
    edges.set(node.id, targets);
    for (const target of targets) {
      if (!nodes.has(target)) {
        issues.push({
          code: 'PROCESS_NODE_NOT_FOUND',
          message: `Node "${node.id}" points at "${target}", which does not exist.`,
          path: node.id,
        });
      }
    }
  }

  const startId = typeof start === 'string' ? start : undefined;
  const reachable = walkForward(nodes, edges, startId);
  // Reachability is only meaningful once the start node resolves; reporting every node as
  // unreachable on top of "the start node does not exist" is noise, not information.
  if (nodes.has(typeof start === 'string' ? start : '')) {
    for (const id of nodes.keys()) {
      if (!reachable.has(id)) {
        issues.push({ code: 'PROCESS_UNREACHABLE_NODE', message: `Node "${id}" is never reached from the start node.`, path: id });
      }
    }
  }

  // Dead ends: a node the flow can enter but from which no end node is reachable. The token would
  // be stuck there with nothing to do and no failure to report.
  const toEnd = walkBackward(edges, nodes, new Set([...nodes.values()].filter((n) => n.type === 'end').map((n) => n.id)));
  for (const id of reachable) {
    if (!toEnd.has(id)) {
      issues.push({
        code: 'PROCESS_DEAD_END',
        message: `Node "${id}" can never reach an end node; the process would be stuck there.`,
        path: id,
      });
    }
  }

  // Every cycle must contain a wait.
  for (const component of stronglyConnectedComponents(edges)) {
    const first = component[0];
    if (first === undefined) continue;
    const selfLoop = component.length === 1 && (edges.get(first) ?? []).includes(first);
    if (component.length === 1 && !selfLoop) continue;
    if (component.some((id) => isWait(nodes.get(id)))) continue;
    issues.push({
      code: 'PROCESS_HOT_LOOP',
      message: `The loop ${component.join(' -> ')} contains no user task, so a token would spin through it without ever waiting.`,
      path: first,
    });
  }

  const engine = options.engine ?? new FormulaEngine();
  for (const node of nodes.values()) {
    if (node.type !== 'gateway') continue;
    for (const [index, branch] of node.branches.entries()) {
      const result = engine.validate(branch.when);
      if (!result.valid) {
        issues.push({
          code: 'PROCESS_INVALID_FORMULA',
          message: `Gateway "${node.name}" branch ${String(index + 1)} is not a valid formula: ${result.error ?? 'parse error'}.`,
          path: node.id,
        });
      }
    }
  }

  return issues;
}

/** Parses and validates a definition, throwing {@link ProcessValidationError} when unusable. */
export function validateProcess(value: unknown, options: ValidateProcessOptions = {}): ProcessDefinition {
  const issues = definitionIssues(value, options);
  if (issues.length > 0) {
    throw new ProcessValidationError('The process definition is not valid.', issues);
  }
  return value as unknown as ProcessDefinition;
}

function readNode(raw: Record<string, unknown>, id: string, issues: ProcessIssue[]): ProcessNode | undefined {
  const type = raw['type'];
  const name = typeof raw['name'] === 'string' && raw['name'].trim() !== '' ? raw['name'] : id;
  const push = (code: ProcessIssueCode, message: string): undefined => {
    issues.push({ code, message, path: id });
    return undefined;
  };

  if (type === 'end') {
    const outcome = raw['outcome'];
    return {
      id,
      type: 'end',
      name,
      ...(typeof outcome === 'string' && outcome.trim() !== '' ? { outcome } : {}),
    };
  }

  if (type === 'userTask') {
    const assignee = readAssignee(raw['assignee'], `${id}.assignee`, issues);
    if (assignee === undefined) return undefined;

    const rawOutcomes = raw['outcomes'];
    if (!Array.isArray(rawOutcomes) || rawOutcomes.length === 0) {
      return push('PROCESS_INVALID_OUTCOME', `User task "${name}" needs at least one outcome.`);
    }
    const outcomes: { value: string; label: string; next: string }[] = [];
    const seen = new Set<string>();
    for (const [index, entry] of rawOutcomes.entries()) {
      if (!isRecord(entry) || typeof entry['value'] !== 'string' || entry['value'].trim() === '') {
        issues.push({ code: 'PROCESS_INVALID_OUTCOME', message: `Outcome ${String(index + 1)} of "${name}" needs a value.`, path: `${id}.outcomes` });
        continue;
      }
      const value = entry['value'];
      if (seen.has(value)) {
        issues.push({ code: 'PROCESS_INVALID_OUTCOME', message: `User task "${name}" repeats the outcome value "${value}".`, path: `${id}.outcomes` });
        continue;
      }
      seen.add(value);
      const next = entry['next'];
      if (typeof next !== 'string' || next === '') {
        issues.push({ code: 'PROCESS_INVALID', message: `Outcome "${value}" of "${name}" needs a target node.`, path: `${id}.outcomes` });
        continue;
      }
      outcomes.push({
        value,
        label: typeof entry['label'] === 'string' && entry['label'].trim() !== '' ? entry['label'] : value,
        next,
      });
    }
    if (outcomes.length === 0) return undefined;

    const dueSeconds = readTimer(raw['dueSeconds'], `${id}.dueSeconds`, issues);
    const escalateAfterSeconds = readTimer(raw['escalateAfterSeconds'], `${id}.escalateAfterSeconds`, issues);
    const escalateTo =
      raw['escalateTo'] === undefined ? undefined : readAssignee(raw['escalateTo'], `${id}.escalateTo`, issues);

    return {
      id,
      type: 'userTask',
      name,
      assignee,
      outcomes,
      ...(dueSeconds !== undefined ? { dueSeconds } : {}),
      ...(escalateAfterSeconds !== undefined ? { escalateAfterSeconds } : {}),
      ...(escalateTo !== undefined ? { escalateTo } : {}),
    };
  }

  if (type === 'serviceTask') {
    const action = raw['action'];
    if (typeof action !== 'string') {
      return push('PROCESS_UNKNOWN_ACTION', 'A service task must name an action.');
    }
    const spec = actionSpec(action);
    if (spec === undefined) {
      return push(
        'PROCESS_UNKNOWN_ACTION',
        `"${action}" is not a known action. Available: ${WORKFLOW_ACTIONS.map((entry) => entry.name).join(', ')}.`,
      );
    }
    const params = raw['params'] ?? {};
    if (!isRecord(params)) {
      return push('PROCESS_INVALID', 'Action parameters must be a JSON object.');
    }
    const parsed = spec.params.safeParse(params);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        issues.push({
          code: 'PROCESS_INVALID',
          message: `Action "${action}": ${issue.path.join('.') || '<root>'} ${issue.message}.`,
          path: `${id}.params`,
        });
      }
      return undefined;
    }
    const next = raw['next'];
    if (typeof next !== 'string' || next === '') {
      return push('PROCESS_INVALID', `Service task "${name}" needs a target node.`);
    }
    const onError = raw['onError'];
    return {
      id,
      type: 'serviceTask',
      name,
      action,
      params: parsed.data,
      next,
      ...(onError === 'continue' || onError === 'fail' ? { onError } : {}),
    };
  }

  if (type === 'gateway') {
    const rawBranches = raw['branches'];
    if (!Array.isArray(rawBranches) || rawBranches.length === 0) {
      return push('PROCESS_INVALID', `Gateway "${name}" needs at least one branch.`);
    }
    const branches: { when: string; next: string }[] = [];
    for (const [index, entry] of rawBranches.entries()) {
      if (!isRecord(entry) || typeof entry['when'] !== 'string' || entry['when'].trim() === '') {
        issues.push({ code: 'PROCESS_INVALID_FORMULA', message: `Branch ${String(index + 1)} of gateway "${name}" needs a condition.`, path: `${id}.branches` });
        continue;
      }
      const next = entry['next'];
      if (typeof next !== 'string' || next === '') {
        issues.push({ code: 'PROCESS_INVALID', message: `Branch ${String(index + 1)} of gateway "${name}" needs a target node.`, path: `${id}.branches` });
        continue;
      }
      branches.push({ when: entry['when'], next });
    }
    if (branches.length === 0) return undefined;
    const fallback = raw['default'];
    if (typeof fallback !== 'string' || fallback === '') {
      return push('PROCESS_INVALID', `Gateway "${name}" needs a default target for when no branch matches.`);
    }
    return { id, type: 'gateway', name, branches, default: fallback };
  }

  return push('PROCESS_INVALID', `"${String(type)}" is not a node type (userTask, serviceTask, gateway, end).`);
}

function readAssignee(
  raw: unknown,
  path: string,
  issues: ProcessIssue[],
): AssigneeSpec | undefined {
  if (!isRecord(raw) || typeof raw['type'] !== 'string' || typeof raw['value'] !== 'string' || raw['value'].trim() === '') {
    issues.push({
      code: 'PROCESS_INVALID_ASSIGNEE',
      message: 'An assignee needs a type (user, role, recordField) and a value.',
      path,
    });
    return undefined;
  }
  if (raw['type'] !== 'user' && raw['type'] !== 'role' && raw['type'] !== 'recordField') {
    issues.push({
      code: 'PROCESS_INVALID_ASSIGNEE',
      message: `"${String(raw['type'])}" is not an assignee type (user, role, recordField).`,
      path,
    });
    return undefined;
  }
  if (raw['type'] === 'recordField' && !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(raw['value'])) {
    issues.push({
      code: 'PROCESS_INVALID_ASSIGNEE',
      message: 'A record-field assignee must be a field name.',
      path,
    });
    return undefined;
  }
  return { type: raw['type'], value: raw['value'] };
}

function readTimer(raw: unknown, path: string, issues: ProcessIssue[]): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    issues.push({ code: 'PROCESS_INVALID', message: 'A timer needs a positive number of seconds.', path });
    return undefined;
  }
  if (raw > MAX_PROCESS_TIMER_SECONDS) {
    issues.push({ code: 'PROCESS_INVALID', message: `A timer may not exceed ${String(MAX_PROCESS_TIMER_SECONDS)} seconds.`, path });
    return undefined;
  }
  return raw;
}

function isWait(node: ProcessNode | undefined): boolean {
  return node?.type === 'userTask';
}

/** Outgoing edge targets, in flow order. */
export function targetsOf(node: ProcessNode): string[] {
  if (node.type === 'end') return [];
  if (node.type === 'userTask') return node.outcomes.map((outcome) => outcome.next);
  if (node.type === 'gateway') return [...node.branches.map((branch) => branch.next), node.default];
  return [node.next];
}

function walkForward(nodes: Map<string, ProcessNode>, edges: Map<string, string[]>, start: string | undefined): Set<string> {
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

/** Nodes from which some end node is reachable (a reverse walk from every `end` node). */
function walkBackward(edges: Map<string, string[]>, nodes: Map<string, ProcessNode>, ends: Set<string>): Set<string> {
  const reverse = new Map<string, string[]>();
  for (const [id, targets] of edges) {
    for (const target of targets) {
      if (!nodes.has(target)) continue;
      const incoming = reverse.get(target) ?? [];
      incoming.push(id);
      reverse.set(target, incoming);
    }
  }
  const seen = new Set<string>();
  const stack = [...ends];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    for (const source of reverse.get(id) ?? []) {
      if (!seen.has(source)) stack.push(source);
    }
  }
  return seen;
}

/**
 * Tarjan's strongly connected components: a component of size > 1 (or a single node with a
 * self-edge) is a cycle. Reported once per component rather than once per edge, so the editor
 * shows one issue per loop instead of one per branch back into it.
 */
function stronglyConnectedComponents(edges: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  const strongConnect = (id: string): void => {
    index.set(id, counter);
    low.set(id, counter);
    counter += 1;
    stack.push(id);
    onStack.add(id);

    for (const target of edges.get(id) ?? []) {
      if (!edges.has(target)) continue;
      if (!index.has(target)) {
        strongConnect(target);
        low.set(id, Math.min(low.get(id) ?? 0, low.get(target) ?? 0));
      } else if (onStack.has(target)) {
        low.set(id, Math.min(low.get(id) ?? 0, index.get(target) ?? 0));
      }
    }

    if (low.get(id) === index.get(id)) {
      const component: string[] = [];
      for (;;) {
        const member = stack.pop();
        if (member === undefined) break;
        onStack.delete(member);
        component.push(member);
        if (member === id) break;
      }
      components.push(component);
    }
  };

  for (const id of edges.keys()) {
    if (!index.has(id)) strongConnect(id);
  }
  return components;
}
