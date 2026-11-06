import { describe, expect, it } from 'vitest';

import type { CalendarEvent } from '../../api/client.js';
import type { ProcessTaskView } from '../../api/types.js';
import { briefingSignals } from './home-model.js';

function task(partial: Partial<ProcessTaskView> & { name: string }): ProcessTaskView {
  return {
    id: partial.name,
    status: 'open',
    dueAt: null,
    escalationLevel: 0,
    stepName: null,
    processName: null,
    processInstanceId: null,
    definitionId: null,
    assigneeId: null,
    assigneeName: null,
    createdById: null,
    createdAt: '2026-11-06T00:00:00.000Z',
    updatedAt: '2026-11-06T00:00:00.000Z',
    description: null,
    priority: null,
    entityName: null,
    entityId: null,
    ...partial,
  } as ProcessTaskView;
}

function event(partial: Partial<CalendarEvent> & { name: string }): CalendarEvent {
  return {
    id: partial.name,
    activityType: 'Task',
    day: '2026-11-06',
    start: '2026-11-06T08:00:00.000Z',
    end: '2026-11-06T09:00:00.000Z',
    allDay: false,
    timezone: 'UTC',
    status: 'planned',
    direction: null,
    location: null,
    description: null,
    assignedUserId: null,
    createdAt: null,
    updatedAt: null,
    ...partial,
  } as CalendarEvent;
}

const NOW = new Date('2026-11-06T12:00:00.000Z');

describe('briefingSignals', () => {
  it('is empty when nothing needs attention', () => {
    expect(briefingSignals({ tasks: [], todayEvents: [], approvals: 0, now: NOW })).toEqual([]);
  });

  it('orders overdue first, then today, then due soon, then approvals', () => {
    const signals = briefingSignals({
      tasks: [
        task({ name: 'Old task', dueAt: '2026-11-05T00:00:00.000Z' }),
        task({ name: 'Soon task', dueAt: '2026-11-07T00:00:00.000Z' }),
      ],
      todayEvents: [event({ name: 'Standup' })],
      approvals: 2,
      now: NOW,
    });
    expect(signals.map((signal) => signal.key)).toEqual(['overdue', 'today', 'dueSoon', 'approvals']);
    expect(signals[0]?.count).toBe(1);
    expect(signals[0]?.examples).toEqual(['Old task']);
    expect(signals[1]?.examples).toEqual(['Standup']);
    expect(signals[3]?.count).toBe(2);
  });

  it('does not count completed tasks as overdue or due soon', () => {
    const signals = briefingSignals({
      tasks: [task({ name: 'Done', status: 'completed', dueAt: '2026-11-01T00:00:00.000Z' })],
      todayEvents: [],
      approvals: 0,
      now: NOW,
    });
    expect(signals).toEqual([]);
  });
});
