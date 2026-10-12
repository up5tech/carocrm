import { describe, expect, it } from 'vitest';

import { MAX_DELAY_SECONDS } from '../actions/index.js';
import { WorkflowValidationError } from '../errors/index.js';
import type { WorkflowDefinition } from '../types/index.js';
import { definitionIssues, validateDefinition } from './index.js';

function definition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    trigger: { eventType: 'entity.created', entityType: 'Account' },
    start: 'a1',
    nodes: [
      { id: 'a1', type: 'action', name: 'Update', action: 'updateRecord', params: { fields: { status: 'Active' } }, next: 'e' },
      { id: 'e', type: 'end', name: 'Done' },
    ],
    ...overrides,
  };
}

describe('workflow definition validation', () => {
  it('accepts a linear definition and returns it typed', () => {
    const parsed = validateDefinition(definition());
    expect(parsed.start).toBe('a1');
    expect(parsed.nodes).toHaveLength(2);
  });

  it('rejects a non-object definition', () => {
    expect(definitionIssues('nope')).toEqual([
      { code: 'WORKFLOW_INVALID', message: 'A workflow definition must be a JSON object.' },
    ]);
  });

  it('requires a trigger with a known event and an entity type', () => {
    const issues = definitionIssues(definition({ trigger: { eventType: 'record.exploded', entityType: 'lowercase' } }));
    expect(issues.map((issue) => issue.path)).toEqual(['trigger.eventType', 'trigger.entityType']);
  });

  it('accepts the wildcard entity type', () => {
    expect(definitionIssues(definition({ trigger: { eventType: 'entity.updated', entityType: '*' } }))).toEqual([]);
  });

  it('requires a start node that exists', () => {
    expect(definitionIssues(definition({ start: 'nope' }))).toContainEqual({
      code: 'WORKFLOW_NODE_NOT_FOUND',
      message: 'The start node "nope" does not exist.',
      path: 'start',
    });
  });

  it('rejects duplicate node ids', () => {
    const issues = definitionIssues(
      definition({
        nodes: [
          { id: 'a1', type: 'action', name: 'A', action: 'updateRecord', params: { fields: {} } },
          { id: 'a1', type: 'end', name: 'B' },
        ],
      }),
    );
    expect(issues.some((issue) => issue.message.includes('Duplicate node id'))).toBe(true);
  });

  it('reports an edge that points nowhere', () => {
    const issues = definitionIssues(definition({ nodes: [{ id: 'a1', type: 'action', name: 'A', action: 'updateRecord', params: { fields: {} }, next: 'ghost' }] }));
    expect(issues).toContainEqual({
      code: 'WORKFLOW_NODE_NOT_FOUND',
      message: 'Node "a1" points at "ghost", which does not exist.',
      path: 'a1',
    });
  });

  it('rejects a cycle', () => {
    const issues = definitionIssues(
      definition({
        nodes: [
          { id: 'a1', type: 'action', name: 'A', action: 'updateRecord', params: { fields: {} }, next: 'a2' },
          { id: 'a2', type: 'action', name: 'B', action: 'updateRecord', params: { fields: {} }, next: 'a1' },
        ],
      }),
    );
    // Every node of a cycle is reachable, so only a real cycle check catches this.
    expect(issues).toEqual([
      { code: 'WORKFLOW_CYCLE', message: 'The workflow contains a loop: a1 -> a2 -> a1.', path: 'a1' },
    ]);
  });

  it('reports unreachable nodes', () => {
    const issues = definitionIssues(
      definition({
        nodes: [
          { id: 'a1', type: 'end', name: 'End' },
          { id: 'orphan', type: 'action', name: 'Orphan', action: 'updateRecord', params: { fields: {} } },
        ],
      }),
    );
    expect(issues).toContainEqual({
      code: 'WORKFLOW_UNREACHABLE_NODE',
      message: 'Node "orphan" is never reached from the start node.',
      path: 'orphan',
    });
  });

  it('rejects an unknown action and lists the available ones', () => {
    const issues = definitionIssues(
      definition({ nodes: [{ id: 'a1', type: 'action', name: 'A', action: 'dropDatabase', params: {} }] }),
    );
    expect(issues[0]?.code).toBe('WORKFLOW_UNKNOWN_ACTION');
    expect(issues[0]?.message).toContain('updateRecord');
  });

  it('rejects invalid action parameters', () => {
    const issues = definitionIssues(
      definition({ nodes: [{ id: 'a1', type: 'action', name: 'A', action: 'updateRecord', params: { fieldz: {} } }] }),
    );
    expect(issues[0]?.message).toContain('Action "updateRecord"');
  });

  it('validates a condition formula through the sandboxed engine', () => {
    const bad = definitionIssues(
      definition({
        nodes: [
          { id: 'c', type: 'condition', name: 'Big?', formula: 'evilFunction(1)', then: 'e' },
          { id: 'e', type: 'end', name: 'End' },
        ],
        start: 'c',
      }),
    );
    expect(bad[0]?.code).toBe('WORKFLOW_INVALID_FORMULA');

    const good = definitionIssues(
      definition({
        nodes: [
          { id: 'c', type: 'condition', name: 'Big?', formula: 'number(field("amount")) > 1000', then: 'e' },
          { id: 'e', type: 'end', name: 'End' },
        ],
        start: 'c',
      }),
    );
    expect(good).toEqual([]);
  });

  it('checks delay bounds', () => {
    expect(definitionIssues(definition({ nodes: [{ id: 'd', type: 'delay', name: 'Wait', seconds: -1 }] }))[0]?.message).toContain(
      'non-negative',
    );
    expect(
      definitionIssues(definition({ nodes: [{ id: 'd', type: 'delay', name: 'Wait', seconds: MAX_DELAY_SECONDS + 1 }] }))[0]?.message,
    ).toContain('may not exceed');
  });

  it('rejects an unknown node type', () => {
    expect(definitionIssues(definition({ nodes: [{ id: 'x', type: 'loop' }] }))[0]?.message).toContain('is not a node type');
  });

  it('throws with every issue at once', () => {
    try {
      validateDefinition(definition({ trigger: {}, nodes: [] }));
      expect.unreachable('should have thrown');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(WorkflowValidationError);
      const issues = (error as WorkflowValidationError).issues;
      expect(issues.length).toBeGreaterThan(1);
      expect((error as WorkflowValidationError).toJSON().code).toBe('WORKFLOW_INVALID');
    }
  });

  it('keeps a condition branch without an otherwise target valid', () => {
    const graph: WorkflowDefinition = validateDefinition(
      definition({
        start: 'c',
        nodes: [
          { id: 'c', type: 'condition', name: 'Yes?', formula: 'true', then: 'e' },
          { id: 'e', type: 'end', name: 'End' },
        ],
      }),
    );
    expect(graph.nodes[0]).toMatchObject({ type: 'condition', then: 'e' });
  });
});