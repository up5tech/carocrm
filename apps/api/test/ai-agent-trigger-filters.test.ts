import { describe, expect, it } from 'vitest';

import { parseAgentConfig } from '../src/ai-agents/ai-agent-config.js';
import { evaluateEventTriggerFilter, type TriggerEventFilterInput } from '../src/ai-agents/runs/trigger-filters.js';

const NOW = new Date('2026-11-20T05:00:00.000Z');

function config(triggers: Record<string, unknown>) {
  const parsed = parseAgentConfig({
    input: { mode: 'record', entity: 'Account' },
    triggers: {
      event: true,
      eventTypes: ['entity.updated'],
      eventEntities: ['Account'],
      ...triggers,
    },
  });
  if (!parsed.ok) throw new Error(parsed.issues.map((issue) => issue.message).join('; '));
  return parsed.config;
}

function input(overrides: Partial<TriggerEventFilterInput> = {}): TriggerEventFilterInput {
  return {
    eventId: 'evt-1',
    eventType: 'entity.updated',
    entityType: 'Account',
    entityId: 'acc-1',
    changed: ['status'],
    values: { before: { status: 'New' }, after: { status: 'Qualified' } },
    now: NOW,
    ...overrides,
  };
}

describe('evaluateEventTriggerFilter (25.6)', () => {
  it('matches a watched transition and a condition on both values', () => {
    const agent = config({
      watchedFields: ['status'],
      condition: "field('status') == 'Qualified' && field('__previous_status') == 'New'",
    });
    expect(evaluateEventTriggerFilter(agent, input())).toEqual({ matched: true });
  });

  it('skips when no watched field changed, even if the condition would be true', () => {
    const agent = config({
      watchedFields: ['status'],
      condition: "field('status') == 'Qualified'",
    });
    expect(evaluateEventTriggerFilter(agent, input({ changed: ['name'] }))).toEqual({
      matched: false,
      reason: 'watched-field-unchanged',
    });
  });

  it('skips when the condition is false on the transition', () => {
    const agent = config({
      watchedFields: ['status'],
      condition: "field('__previous_status') == 'Qualified'",
    });
    expect(evaluateEventTriggerFilter(agent, input())).toEqual({ matched: false, reason: 'condition-false' });
  });

  it('skips create/delete/restore events when filters are configured', () => {
    const agent = config({ watchedFields: ['status'] });
    expect(
      evaluateEventTriggerFilter(agent, input({ eventType: 'entity.created', changed: [] })),
    ).toEqual({ matched: false, reason: 'watched-field-requires-update' });
  });

  it('fails closed on a missing previous value instead of guessing', () => {
    const agent = config({
      watchedFields: ['status'],
      condition: "field('__previous_status') == 'New'",
    });
    expect(evaluateEventTriggerFilter(agent, input({ values: { before: {}, after: { status: 'Qualified' } } }))).toEqual({
      matched: false,
      reason: 'condition-false',
    });
  });

  it('rejects a condition that reads an unwatched field at parse time', () => {
    expect(
      parseAgentConfig({
        input: { mode: 'record', entity: 'Account' },
        triggers: {
          event: true,
          eventTypes: ['entity.updated'],
          eventEntities: ['Account'],
          watchedFields: ['status'],
          condition: "field('secret') == 'x'",
        },
      }).ok,
    ).toBe(false);
  });
});
