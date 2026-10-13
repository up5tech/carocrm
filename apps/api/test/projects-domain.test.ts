import { describe, expect, it } from 'vitest';

import {
  cloneDateOffset,
  datesAreConsistent,
  dayDifference,
  dependencyBlockFor,
  rankBetween,
  ranksFor,
  roleGrants,
  shiftDay,
  statusOfStage,
  subtasksAllowCompletion,
  validateStageSet,
  wouldCreateCycle,
  wouldCreateHierarchyCycle,
} from '../src/projects/project-domain.js';

/**
 * Phase 19 unit tests (PLAN_Phase_19_Projects.md §12.1) — the rules that must hold regardless of
 * what the database or the UI does. No Nest, no database.
 */

const OWNER_ROLE = {
  taskCreate: 'yes', assignmentScope: 'all', taskReadScope: 'all', taskStreamScope: 'all', taskEditScope: 'all',
  stageMoveScope: 'all', taskDeleteScope: 'all', projectStreamAccess: 'yes', groupManage: 'yes', memberManage: 'yes', projectEdit: 'yes',
};
const MEMBER_ROLE = {
  taskCreate: 'yes', assignmentScope: 'all', taskReadScope: 'own', taskStreamScope: 'own', taskEditScope: 'own',
  stageMoveScope: 'assigned', taskDeleteScope: 'no', projectStreamAccess: 'yes', groupManage: 'no', memberManage: 'no', projectEdit: 'no',
};

describe('board stage → status mapping', () => {
  it('derives the task status from the stage, including several stages on one status', () => {
    expect(statusOfStage({ id: 'a', key: 'inProgress', name: 'In Progress', statusValue: 'Started', sortOrder: 1 })).toBe('Started');
    expect(statusOfStage({ id: 'b', key: 'review', name: 'Review', statusValue: 'Started', sortOrder: 2 })).toBe('Started');
    expect(statusOfStage({ id: 'c', key: 'done', name: 'Done', statusValue: 'Completed', sortOrder: 3 })).toBe('Completed');
  });

  it('refuses a stage that maps to a status outside the supported set', () => {
    expect(statusOfStage({ id: 'x', key: 'weird', name: 'Weird', statusValue: 'Archived', sortOrder: 0 })).toBeUndefined();
  });

  it('rejects duplicate stage keys and unknown statuses in one board', () => {
    const issues = validateStageSet([
      { key: 'new', name: 'New', statusValue: 'Not Started' },
      { key: 'new', name: 'Again', statusValue: 'Started' },
      { key: 'Nope', name: 'Nope', statusValue: 'Started' },
      { key: 'gone', name: 'Gone', statusValue: 'Archived' },
    ]);
    expect(issues.some((issue) => issue.includes('Duplicate stage key'))).toBe(true);
    expect(issues.some((issue) => issue.includes('lower-case'))).toBe(true);
    expect(issues.some((issue) => issue.includes('unknown status'))).toBe(true);
  });
});

describe('dependency types', () => {
  const started = { status: 'Started' };
  const notStarted = { status: 'Not Started' };
  const completed = { status: 'Completed' };

  it('FinishToStart blocks starting the successor until the predecessor is completed', () => {
    expect(dependencyBlockFor({ dependencyType: 'FinishToStart', transition: 'start', predecessor: started })).toEqual({
      blocked: true,
      dependencyType: 'FinishToStart',
      reason: 'The predecessor task must be completed first.',
    });
    expect(dependencyBlockFor({ dependencyType: 'FinishToStart', transition: 'start', predecessor: completed })).toBeUndefined();
    // the same edge does not care about completion of the successor
    expect(dependencyBlockFor({ dependencyType: 'FinishToStart', transition: 'complete', predecessor: started })).toBeUndefined();
  });

  it('FinishToFinish blocks only completion', () => {
    expect(dependencyBlockFor({ dependencyType: 'FinishToFinish', transition: 'complete', predecessor: started })).toBeDefined();
    expect(dependencyBlockFor({ dependencyType: 'FinishToFinish', transition: 'start', predecessor: notStarted })).toBeUndefined();
    expect(dependencyBlockFor({ dependencyType: 'FinishToFinish', transition: 'complete', predecessor: completed })).toBeUndefined();
  });

  it('StartToStart needs the predecessor to have started, not to have finished', () => {
    expect(dependencyBlockFor({ dependencyType: 'StartToStart', transition: 'start', predecessor: notStarted })).toBeDefined();
    expect(dependencyBlockFor({ dependencyType: 'StartToStart', transition: 'start', predecessor: started })).toBeUndefined();
    expect(dependencyBlockFor({ dependencyType: 'StartToStart', transition: 'complete', predecessor: notStarted })).toBeUndefined();
  });

  it('StartToFinish needs the predecessor started before the successor can finish', () => {
    expect(dependencyBlockFor({ dependencyType: 'StartToFinish', transition: 'complete', predecessor: notStarted })).toBeDefined();
    expect(dependencyBlockFor({ dependencyType: 'StartToFinish', transition: 'complete', predecessor: started })).toBeUndefined();
  });

  it('an untyped dependency never blocks, and cancelling is never blocked', () => {
    for (const transition of ['start', 'complete', 'cancel'] as const) {
      expect(dependencyBlockFor({ dependencyType: null, transition, predecessor: notStarted })).toBeUndefined();
    }
    expect(dependencyBlockFor({ dependencyType: 'FinishToStart', transition: 'cancel', predecessor: notStarted })).toBeUndefined();
  });
});

describe('graph cycles', () => {
  it('refuses a self edge and a closed loop of dependencies', () => {
    expect(wouldCreateCycle([], { from: 'a', to: 'a' })).toBe(true);
    expect(wouldCreateCycle([{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }], { from: 'c', to: 'a' })).toBe(true);
    expect(wouldCreateCycle([{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }], { from: 'a', to: 'c' })).toBe(false);
  });

  it('refuses a parent that is one of the task own descendants', () => {
    const children = new Map<string, string[]>([['a', ['b']], ['b', ['c']]]);
    expect(wouldCreateHierarchyCycle(children, 'a', 'c')).toBe(true);
    expect(wouldCreateHierarchyCycle(children, 'a', 'a')).toBe(true);
    expect(wouldCreateHierarchyCycle(children, 'c', 'a')).toBe(false);
  });
});

describe('subtasks and completion', () => {
  it('a parent completes only when every subtask is completed or cancelled', () => {
    expect(subtasksAllowCompletion(['Completed', 'Canceled'])).toBe(true);
    expect(subtasksAllowCompletion([])).toBe(true);
    expect(subtasksAllowCompletion(['Started'])).toBe(false);
    expect(subtasksAllowCompletion(['Completed', 'Deferred'])).toBe(false);
  });
});

describe('project role policy', () => {
  it('all / assigned / own / no tiers of a member role', () => {
    expect(roleGrants(OWNER_ROLE, 'taskEditScope', { userId: 'u1' })).toBe(true);
    expect(roleGrants(MEMBER_ROLE, 'taskEditScope', { userId: 'u1', ownerUserId: 'u1' })).toBe(true);
    expect(roleGrants(MEMBER_ROLE, 'taskEditScope', { userId: 'u1', assigneeUserId: 'u2' })).toBe(false);
    expect(roleGrants(MEMBER_ROLE, 'taskEditScope', { userId: 'u1', ownerUserId: 'u2', assigneeUserId: 'u2' })).toBe(false);
    expect(roleGrants(MEMBER_ROLE, 'stageMoveScope', { userId: 'u1', assigneeUserId: 'u1' })).toBe(true);
    expect(roleGrants(MEMBER_ROLE, 'taskDeleteScope', { userId: 'u1', ownerUserId: 'u1' })).toBe(false);
    expect(roleGrants(MEMBER_ROLE, 'groupManage', { userId: 'u1' })).toBe(false);
    expect(roleGrants(OWNER_ROLE, 'memberManage', { userId: 'u1' })).toBe(true);
  });

  it('a collaborator widens the `own` tier only', () => {
    expect(roleGrants(MEMBER_ROLE, 'taskReadScope', { userId: 'u1', isCollaborator: true })).toBe(true);
    expect(roleGrants(MEMBER_ROLE, 'taskDeleteScope', { userId: 'u1', isCollaborator: true })).toBe(false);
    expect(roleGrants(MEMBER_ROLE, 'groupManage', { userId: 'u1', isCollaborator: true })).toBe(false);
  });

  it('an unknown or missing role grants nothing', () => {
    expect(roleGrants(undefined, 'taskCreate', { userId: 'u1' })).toBe(false);
    expect(roleGrants({ ...MEMBER_ROLE, taskCreate: 'no' }, 'taskCreate', { userId: 'u1' })).toBe(false);
  });
});

describe('dates and cloning offsets', () => {
  it('an end date never precedes its start date', () => {
    expect(datesAreConsistent('2026-03-05', '2026-03-01')).toBe(false);
    expect(datesAreConsistent('2026-03-05', '2026-03-05')).toBe(true);
    expect(datesAreConsistent('2026-03-05', undefined)).toBe(true);
  });

  it('shifts calendar days without drifting across a month or year boundary', () => {
    expect(shiftDay('2026-01-30', 3)).toBe('2026-02-02');
    expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDay(undefined, 10)).toBeNull();
    expect(dayDifference('2026-03-01', '2026-03-11')).toBe(10);
  });

  it('the clone offset is the distance between the two project start dates', () => {
    expect(cloneDateOffset('2026-03-01', '2026-04-01')).toBe(31);
    expect(cloneDateOffset(undefined, '2026-04-01')).toBe(0);
    expect(cloneDateOffset('2026-03-01', undefined)).toBe(0);
  });
});

describe('ordering', () => {
  it('assigns spaced, deterministic ranks', () => {
    const ranks = ranksFor(['a', 'b', 'c']);
    expect([...ranks.values()]).toEqual([1000, 2000, 3000]);
  });

  it('places a row strictly between its new neighbours', () => {
    expect(rankBetween(1000, 2000)).toBe(1500);
    expect(rankBetween(1000, 1001)).toBe(1001);
    expect(rankBetween(undefined, 1000)).toBe(0);
    expect(rankBetween(1000, undefined)).toBe(2000);
    expect(rankBetween(undefined, undefined)).toBe(1000);
  });
});
