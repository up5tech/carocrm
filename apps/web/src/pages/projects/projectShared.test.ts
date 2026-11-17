import { describe, expect, it } from 'vitest';

import type { ProjectBoardView, ProjectPlanView, ProjectTaskRow } from '../../api/types.js';
import { boardWithTaskMove, planWithTaskMove, planWithTaskStatus } from './projectShared.js';

/**
 * 24.10.2/24.10.7 — the optimistic-write contract, tested at the cache-transform level: a predicted
 * write must place the card/status where the drop intended, carry the target grouping so nothing
 * renders under the wrong heading, and leave every untouched row alone. The rollback half is the
 * mutation snapshot in `useOptimisticProjectMutation`; these tests pin what the snapshot restores.
 */

function task(id: string, overrides: Partial<ProjectTaskRow> = {}): ProjectTaskRow {
  return {
    id,
    name: id,
    status: 'Not Started',
    stageId: null,
    groupId: null,
    parentTaskId: null,
    taskType: 'Task',
    assigneeUserId: null,
    ownerUserId: null,
    priority: null,
    dateStart: null,
    dateEnd: null,
    points: null,
    estimateHours: null,
    sortOrder: 0,
    version: 1,
    ...overrides,
  };
}

function plan(groups: { id: string; tasks: ProjectTaskRow[] }[]): ProjectPlanView {
  return {
    project: {},
    stages: [],
    groups: groups.map((entry) => ({ group: { id: entry.id }, tasks: entry.tasks })),
    truncated: false,
  };
}

describe('planWithTaskMove', () => {
  it('moves a root task into the target group in the dropped order', () => {
    const view = plan([
      { id: 'g1', tasks: [task('a'), task('b')] },
      { id: 'g2', tasks: [task('c'), task('d')] },
    ]);
    const next = planWithTaskMove(view, 'a', 'g2', ['c', 'a', 'd']);
    expect(next?.groups[0]?.tasks.map((t) => t.id)).toEqual(['b']);
    expect(next?.groups[1]?.tasks.map((t) => t.id)).toEqual(['c', 'a', 'd']);
    expect(next?.groups[1]?.tasks[1]?.groupId).toBe('g2');
  });

  it('takes descendants with the card so a subtask is not orphaned in the old group', () => {
    const view = plan([
      { id: 'g1', tasks: [task('p'), task('child', { parentTaskId: 'p' }), task('grand', { parentTaskId: 'child' })] },
      { id: 'g2', tasks: [task('x')] },
    ]);
    const next = planWithTaskMove(view, 'p', 'g2', ['x', 'p']);
    expect(next?.groups[0]?.tasks).toEqual([]);
    const movedIds = next?.groups[1]?.tasks.map((t) => t.id) ?? [];
    expect(movedIds).toEqual(expect.arrayContaining(['x', 'p', 'child', 'grand']));
    expect(next?.groups[1]?.tasks.find((t) => t.id === 'child')?.groupId).toBe('g2');
  });

  it('reorders within the same group without losing the card', () => {
    const view = plan([{ id: 'g1', tasks: [task('a'), task('b'), task('c')] }]);
    const next = planWithTaskMove(view, 'a', 'g1', ['b', 'a', 'c']);
    expect(next?.groups[0]?.tasks.map((t) => t.id)).toEqual(['b', 'a', 'c']);
  });

  it('returns undefined for an empty cache and the same plan for an unknown task', () => {
    expect(planWithTaskMove(undefined, 'a', 'g', ['a'])).toBeUndefined();
    const view = plan([{ id: 'g1', tasks: [task('a')] }]);
    expect(planWithTaskMove(view, 'missing', 'g1', ['missing'])).toBe(view);
  });
});

describe('planWithTaskStatus', () => {
  it('flips only the transitioned task status', () => {
    const view = plan([
      { id: 'g1', tasks: [task('a'), task('b', { status: 'Started' })] },
      { id: 'g2', tasks: [task('c')] },
    ]);
    const next = planWithTaskStatus(view, 'a', 'Completed');
    expect(next?.groups[0]?.tasks[0]?.status).toBe('Completed');
    expect(next?.groups[0]?.tasks[1]?.status).toBe('Started');
    expect(next?.groups[1]?.tasks[0]?.status).toBe('Not Started');
  });
});

describe('boardWithTaskMove', () => {
  function board(): ProjectBoardView {
    return {
      project: {},
      group: null,
      columns: [
        { stage: { id: 's1' }, tasks: [task('a'), task('b')] },
        { stage: { id: 's2' }, tasks: [task('c')] },
      ],
      truncated: false,
    };
  }

  it('moves the card into the target column in the dropped order with the new stageId', () => {
    const next = boardWithTaskMove(board(), 'a', 's2', ['c', 'a']);
    expect(next?.columns[0]?.tasks.map((t) => t.id)).toEqual(['b']);
    expect(next?.columns[1]?.tasks.map((t) => t.id)).toEqual(['c', 'a']);
    expect(next?.columns[1]?.tasks[1]?.stageId).toBe('s2');
  });

  it('reorders inside one column', () => {
    const next = boardWithTaskMove(board(), 'a', 's1', ['b', 'a']);
    expect(next?.columns[0]?.tasks.map((t) => t.id)).toEqual(['b', 'a']);
    expect(next?.columns[1]?.tasks.map((t) => t.id)).toEqual(['c']);
  });

  it('returns the same board for an unknown task and undefined for an empty cache', () => {
    const view = board();
    expect(boardWithTaskMove(view, 'missing', 's1', ['missing'])).toBe(view);
    expect(boardWithTaskMove(undefined, 'a', 's1', ['a'])).toBeUndefined();
  });
});
