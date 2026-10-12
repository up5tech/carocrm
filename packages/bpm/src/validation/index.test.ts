import { describe, expect, it } from 'vitest';

import type { ProcessIssue } from '../errors/index.js';
import { ProcessValidationError } from '../errors/index.js';
import { definitionIssues, MAX_PROCESS_TIMER_SECONDS, validateProcess } from './index.js';

/** Typed element access that fails loudly when a fixture is shorter than the test assumes. */
function at<T>(list: readonly T[], index: number): T {
  const item = list[index];
  if (item === undefined) throw new Error(`expected item at ${index}, list has ${list.length}`);
  return item;
}

function approval(): Record<string, unknown> {
  return {
    entityType: 'Opportunity',
    start: 'review',
    nodes: [
      {
        id: 'review',
        type: 'userTask',
        name: 'Manager review',
        assignee: { type: 'role', value: 'Sales Manager' },
        dueSeconds: 86_400,
        outcomes: [
          { value: 'approved', label: 'Approve', next: 'notify' },
          { value: 'rejected', label: 'Reject', next: 'stop' },
        ],
      },
      { id: 'notify', type: 'serviceTask', name: 'Notify finance', action: 'createNotification', params: { userId: 'u1', message: 'Approved' }, next: 'done' },
      { id: 'done', type: 'end', name: 'Approved', outcome: 'approved' },
      { id: 'stop', type: 'end', name: 'Rejected', outcome: 'rejected' },
    ],
  };
}

function codes(issues: ProcessIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

describe('process definition validation', () => {
  it('accepts a well-formed approval process', () => {
    expect(definitionIssues(approval())).toEqual([]);
  });

  it('rejects a non-object definition', () => {
    expect(codes(definitionIssues('nope'))).toEqual(['PROCESS_INVALID']);
  });

  it('requires a start node and at least one node', () => {
    expect(codes(definitionIssues({ start: '', nodes: [] }))).toEqual(['PROCESS_INVALID', 'PROCESS_INVALID']);
  });

  it('rejects a start node that does not exist', () => {
    const definition = approval();
    definition['start'] = 'ghost';
    expect(codes(definitionIssues(definition))).toEqual(['PROCESS_NODE_NOT_FOUND']);
  });

  it('rejects duplicate node ids and unknown node types', () => {
    const definition = approval();
    (definition['nodes'] as Record<string, unknown>[]).push({ id: 'review', type: 'userTask' });
    (definition['nodes'] as Record<string, unknown>[]).push({ id: 'weird', type: 'script' });
    const issues = definitionIssues(definition);
    expect(codes(issues)).toContain('PROCESS_INVALID');
    expect(issues.map((issue) => issue.message).join(' ')).toContain('not a node type');
  });

  it('rejects an outcome pointing at a node that does not exist', () => {
    const definition = approval();
    at(definition['nodes'] as Record<string, unknown>[], 0)['outcomes'] = [{ value: 'approved', label: 'Approve', next: 'ghost' }];
    expect(codes(definitionIssues(definition))).toContain('PROCESS_NODE_NOT_FOUND');
  });

  it('rejects nodes that are never reached from the start', () => {
    const definition = approval();
    (definition['nodes'] as Record<string, unknown>[]).push({ id: 'orphan', type: 'end', name: 'Orphan' });
    expect(codes(definitionIssues(definition))).toEqual(['PROCESS_UNREACHABLE_NODE']);
  });

  it('allows a loop that contains a user task (request changes, back to review)', () => {
    const definition = approval();
    const nodes = definition['nodes'] as Record<string, unknown>[];
    // "changes" now loops back into review instead of ending — a legal approval revision cycle.
    at(nodes, 0)['outcomes'] = [
      { value: 'approved', label: 'Approve', next: 'notify' },
      { value: 'changes', label: 'Request changes', next: 'review' },
      { value: 'rejected', label: 'Reject', next: 'stop' },
    ];
    expect(definitionIssues(definition)).toEqual([]);
  });

  it('rejects a loop with no user task — a token would spin through it', () => {
    const definition = {
      start: 'a',
      nodes: [
        { id: 'a', type: 'serviceTask', name: 'A', action: 'updateRecord', params: { fields: {} }, next: 'b' },
        { id: 'b', type: 'gateway', name: 'B', branches: [{ when: 'true', next: 'a' }], default: 'a' },
      ],
    };
    const issues = definitionIssues(definition);
    expect(codes(issues)).toContain('PROCESS_HOT_LOOP');
    // …and the loop also has no way out.
    expect(codes(issues)).toContain('PROCESS_DEAD_END');
  });

  it('rejects a loop whose only exit is unreachable from the loop itself', () => {
    const definition = approval();
    const nodes = definition['nodes'] as Record<string, unknown>[];
    // review -> notify -> done, but "stop" is only reachable from an outcome we removed, and the
    // "done" end is fine; make the flow loop without ever ending.
    at(nodes, 1)['next'] = 'review';
    at(nodes, 0)['outcomes'] = [{ value: 'changes', label: 'Request changes', next: 'review' }];
    const issues = definitionIssues(definition);
    expect(codes(issues)).toContain('PROCESS_DEAD_END');
  });

  it('rejects an unknown action and invalid action parameters', () => {
    const definition = approval();
    (definition['nodes'] as Record<string, unknown>[])[1] = { id: 'notify', type: 'serviceTask', name: 'Notify', action: 'launchRockets', params: {}, next: 'done' };
    expect(codes(definitionIssues(definition))).toContain('PROCESS_UNKNOWN_ACTION');

    const badParams = approval();
    (badParams['nodes'] as Record<string, unknown>[])[1] = { id: 'notify', type: 'serviceTask', name: 'Notify', action: 'createNotification', params: { userId: 42 }, next: 'done' };
    const issues = definitionIssues(badParams);
    expect(codes(issues)).toContain('PROCESS_INVALID');
    expect(issues.some((issue) => issue.message.includes('createNotification'))).toBe(true);
  });

  it('requires outcomes on a user task and rejects duplicate outcome values', () => {
    const noOutcomes = approval();
    at(noOutcomes['nodes'] as Record<string, unknown>[], 0)['outcomes'] = [];
    expect(codes(definitionIssues(noOutcomes))).toContain('PROCESS_INVALID_OUTCOME');

    const duplicates = approval();
    at(duplicates['nodes'] as Record<string, unknown>[], 0)['outcomes'] = [
      { value: 'ok', label: 'OK', next: 'done' },
      { value: 'ok', label: 'Fine', next: 'stop' },
    ];
    expect(codes(definitionIssues(duplicates))).toContain('PROCESS_INVALID_OUTCOME');
  });

  it('validates assignee specs', () => {
    for (const assignee of [
      {},
      { type: 'team', value: 't1' },
      { type: 'user', value: '' },
      { type: 'recordField', value: 'assigned user' },
    ]) {
      const definition = approval();
      at(definition['nodes'] as Record<string, unknown>[], 0)['assignee'] = assignee;
      expect(codes(definitionIssues(definition))).toContain('PROCESS_INVALID_ASSIGNEE');
    }
  });

  it('validates task timers', () => {
    for (const dueSeconds of [0, -5, 'soon', MAX_PROCESS_TIMER_SECONDS + 1]) {
      const definition = approval();
      at(definition['nodes'] as Record<string, unknown>[], 0)['dueSeconds'] = dueSeconds;
      expect(codes(definitionIssues(definition))).toContain('PROCESS_INVALID');
    }
  });

  it('requires a gateway default and valid branch formulas', () => {
    const noDefault = approval();
    const nodes = noDefault['nodes'] as Record<string, unknown>[];
    nodes.splice(1, 0, { id: 'gate', type: 'gateway', name: 'Gate', branches: [{ when: 'true', next: 'done' }] });
    at(nodes, 0)['outcomes'] = [{ value: 'approved', label: 'Approve', next: 'gate' }, { value: 'rejected', label: 'Reject', next: 'stop' }];
    expect(codes(definitionIssues(noDefault))).toContain('PROCESS_INVALID');

    const badFormula = approval();
    const badNodes = badFormula['nodes'] as Record<string, unknown>[];
    badNodes.splice(1, 0, { id: 'gate', type: 'gateway', name: 'Gate', branches: [{ when: 'field(', next: 'done' }], default: 'stop' });
    at(badNodes, 0)['outcomes'] = [{ value: 'approved', label: 'Approve', next: 'gate' }, { value: 'rejected', label: 'Reject', next: 'stop' }];
    expect(codes(definitionIssues(badFormula))).toContain('PROCESS_INVALID_FORMULA');
  });

  it('validateProcess throws with every issue listed', () => {
    const definition = approval();
    definition['entityType'] = 'opportunities';
    try {
      validateProcess(definition);
      expect.unreachable('validateProcess must throw');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ProcessValidationError);
      expect((error as ProcessValidationError).issues).toHaveLength(1);
    }
  });

  it('restricts the record entity to a PascalCase name or "*"', () => {
    const definition = approval();
    definition['entityType'] = 'opportunities';
    expect(codes(definitionIssues(definition))).toEqual(['PROCESS_INVALID']);
  });
});
