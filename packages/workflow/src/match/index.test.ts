import { describe, expect, it } from 'vitest';

import { asEventType, matchWorkflows } from './index.js';

const accountCreate = {
  trigger: { eventType: 'entity.created', entityType: 'Account' },
  start: 'e',
  nodes: [{ id: 'e', type: 'end', name: 'End' }],
};

describe('trigger matching', () => {
  it('matches on event type and entity type', () => {
    const matches = matchWorkflows({ eventType: 'entity.created', entityType: 'Account', entityId: 'a1' }, [
      { id: 'w1', versionId: 'v1', definition: accountCreate },
    ]);
    expect(matches.map((match) => match.workflowId)).toEqual(['w1']);
  });

  it('does not match another event type or another entity', () => {
    const workflows = [{ id: 'w1', versionId: 'v1', definition: accountCreate }];
    expect(matchWorkflows({ eventType: 'entity.updated', entityType: 'Account', entityId: 'a1' }, workflows)).toEqual([]);
    expect(matchWorkflows({ eventType: 'entity.created', entityType: 'Contact', entityId: 'c1' }, workflows)).toEqual([]);
  });

  it('matches a wildcard entity type', () => {
    const workflows = [
      { id: 'any', versionId: 'v1', definition: { ...accountCreate, trigger: { eventType: 'entity.deleted', entityType: '*' } } },
    ];
    expect(matchWorkflows({ eventType: 'entity.deleted', entityType: 'Anything', entityId: 'x' }, workflows)).toHaveLength(1);
  });

  it('returns matches in a stable order and skips malformed definitions', () => {
    const matches = matchWorkflows({ eventType: 'entity.created', entityType: 'Account', entityId: 'a1' }, [
      { id: 'zeta', versionId: 'v1', definition: accountCreate },
      { id: 'alpha', versionId: 'v2', definition: accountCreate },
      { id: 'broken', versionId: 'v3', definition: { trigger: 'nope' } },
      { id: 'empty', versionId: 'v4', definition: {} },
    ]);
    expect(matches.map((match) => match.workflowId)).toEqual(['alpha', 'zeta']);
  });

  it('only accepts known entity event types', () => {
    expect(asEventType('entity.created')).toBe('entity.created');
    expect(asEventType('workflow.started')).toBeUndefined();
  });
});