import { describe, expect, it } from 'vitest';

import {
  allowedCaseCommands,
  changedKeys,
  checkCaseTransition,
  checkResolutionRequirement,
  checkRoutingCondition,
  checkRoutingConditions,
  commandTargetStatus,
  formatCaseNumber,
  hasRequesterReference,
  leastBusyMember,
  nextRoundRobinMember,
  routingConditionsMatch,
} from '../src/service-desk/service-desk-domain.js';

/**
 * Phase 19-SD — pure Service Desk domain helpers (PLAN_Phase_19_ServiceDesk.md §5.1, §7.5).
 *
 * No database, no HTTP: these are the rules the numbering service, the write guard and the metadata
 * seed all agree on, so they are worth pinning directly.
 */
describe('formatCaseNumber', () => {
  it('prefixes and zero-pads to the configured width', () => {
    expect(formatCaseNumber('C', 1, 6)).toBe('C000001');
    expect(formatCaseNumber('SD', 42, 4)).toBe('SD0042');
  });

  it('does not truncate a value wider than the padding', () => {
    expect(formatCaseNumber('C', 1234567, 6)).toBe('C1234567');
  });

  it('accepts the string and bigint forms a sequence driver returns', () => {
    expect(formatCaseNumber('C', '7', 3)).toBe('C007');
    expect(formatCaseNumber('C', 7n, 3)).toBe('C007');
  });
});

describe('hasRequesterReference', () => {
  it('accepts any CRM link or channel-supplied identity', () => {
    expect(hasRequesterReference({ contactId: 'c1' })).toBe(true);
    expect(hasRequesterReference({ accountId: 'a1' })).toBe(true);
    expect(hasRequesterReference({ leadId: 'l1' })).toBe(true);
    expect(hasRequesterReference({ requesterEmail: 'someone@example.com' })).toBe(true);
    expect(hasRequesterReference({ requesterName: 'Walk-in' })).toBe(true);
  });

  it('rejects an empty, blank or absent requester', () => {
    expect(hasRequesterReference({})).toBe(false);
    expect(hasRequesterReference({ contactId: null })).toBe(false);
    expect(hasRequesterReference({ requesterEmail: '   ' })).toBe(false);
    expect(hasRequesterReference({ name: 'A subject alone is not a requester' })).toBe(false);
  });
});

describe('changedKeys', () => {
  const previous = { status: 'New', priority: 'Normal', isEscalated: false };

  it('returns only the keys whose value actually differs', () => {
    expect(changedKeys({ ...previous, status: 'Open' }, previous)).toEqual(['status']);
    expect(changedKeys(previous, previous)).toEqual([]);
  });

  it('compares dates and nested objects by value', () => {
    expect(changedKeys({ at: new Date(1000) }, { at: new Date(1000) })).toEqual([]);
    expect(changedKeys({ tags: ['a'] }, { tags: ['a'] })).toEqual([]);
    expect(changedKeys({ tags: ['a'] }, { tags: ['b'] })).toEqual(['tags']);
  });
});

describe('case state machine (§5.2, 19-SD.4)', () => {
  it('maps each named command to its target status', () => {
    expect(commandTargetStatus('resolve')).toBe('Resolved');
    expect(commandTargetStatus('close')).toBe('Closed');
    expect(commandTargetStatus('reopen')).toBe('Open');
    expect(commandTargetStatus('escalate')).toBe('Escalated');
    expect(commandTargetStatus('deEscalate')).toBe('Open');
    expect(commandTargetStatus('cancel')).toBe('Cancelled');
  });

  it('allows the declared edges and refuses the rest, with a stable code', () => {
    expect(checkCaseTransition({ from: 'New', to: 'Open', command: 'start' }).allowed).toBe(true);
    expect(checkCaseTransition({ from: 'Open', to: 'Resolved', command: 'resolve' }).allowed).toBe(true);
    expect(checkCaseTransition({ from: 'Resolved', to: 'Closed', command: 'close' }).allowed).toBe(true);
    // Closing from a working state is refused: a case must be resolved first.
    const refused = checkCaseTransition({ from: 'Open', to: 'Closed', command: 'close' });
    expect(refused.allowed).toBe(false);
    expect(refused.code).toBe('CASE_TRANSITION_NOT_ALLOWED');
    // `start` cannot reopen a resolved case; `reopen` can.
    expect(checkCaseTransition({ from: 'Resolved', to: 'Open', command: 'start' }).allowed).toBe(false);
    expect(checkCaseTransition({ from: 'Resolved', to: 'Open', command: 'reopen' }).allowed).toBe(true);
    expect(checkCaseTransition({ from: 'Closed', to: 'Open', command: 'reopen' }).allowed).toBe(true);
  });

  it('refuses a command whose declared target disagrees with the requested one', () => {
    const check = checkCaseTransition({ from: 'Open', to: 'Closed', command: 'resolve' });
    expect(check.allowed).toBe(false);
    expect(check.message).toContain('Resolved');
  });

  it('treats a no-op transition as allowed and changes nothing', () => {
    expect(checkCaseTransition({ from: 'Open', to: 'Open' }).allowed).toBe(true);
  });

  it('lists the commands available from a status', () => {
    expect(allowedCaseCommands('New')).toContain('start');
    expect(allowedCaseCommands('New')).toContain('cancel');
    expect(allowedCaseCommands('Resolved')).toEqual(['close', 'reopen', 'cancel']);
    expect(allowedCaseCommands('Closed')).toEqual(['reopen']);
  });
});

describe('resolution requirement (§5.2, 19-SD.4)', () => {
  const base = { requireCode: true, requireSummary: false, codes: ['Solved', 'Duplicate'] };

  it('requires a code when configured, and accepts a configured value', () => {
    expect(checkResolutionRequirement({ ...base, resolutionCode: undefined })).toBeDefined();
    expect(checkResolutionRequirement({ ...base, resolutionCode: 'Solved' })).toBeUndefined();
  });

  it('refuses a code that is not configured', () => {
    expect(checkResolutionRequirement({ ...base, resolutionCode: 'MadeUp' })).toContain('not a configured');
  });

  it('honours the summary requirement and an empty code list (any non-empty value)', () => {
    expect(
      checkResolutionRequirement({ requireCode: false, requireSummary: true, codes: [], resolutionSummary: ' ' }),
    ).toBeDefined();
    expect(
      checkResolutionRequirement({ requireCode: true, requireSummary: false, codes: [], resolutionCode: 'Anything' }),
    ).toBeUndefined();
  });
});

describe('routing conditions (§5.3, 19-SD.5)', () => {
  it('accepts only allow-listed fields, operators and shapes', () => {
    expect(checkRoutingCondition({ field: 'priority', operator: 'equals', value: 'High' }).ok).toBe(true);
    expect(checkRoutingCondition({ field: 'category', operator: 'equals', value: 'x' }).ok).toBe(false);
    expect(checkRoutingCondition({ field: 'priority', operator: 'regex', value: 'x' }).ok).toBe(false);
    expect(checkRoutingCondition({ field: 'source', operator: 'in', value: 'Email' }).ok).toBe(false);
    expect(checkRoutingCondition({ field: 'source', operator: 'in', value: ['Email'] }).ok).toBe(true);
    expect(checkRoutingConditions([{ field: 'type', operator: 'notEquals', value: 'Question' }]).ok).toBe(true);
  });

  it('matches a case when every condition holds', () => {
    const conditions = [
      { field: 'priority', operator: 'equals', value: 'High' } as const,
      { field: 'source', operator: 'in', value: ['Email', 'Portal'] } as const,
    ];
    expect(routingConditionsMatch(conditions, { priority: 'High', source: 'Email' })).toBe(true);
    expect(routingConditionsMatch(conditions, { priority: 'High', source: 'Web' })).toBe(false);
    expect(routingConditionsMatch(conditions, { source: 'Email' })).toBe(false);
  });
});

describe('assignment strategies (§5.3, 19-SD.5)', () => {
  it('advances the round-robin ring and wraps, restarting when the cursor is unknown', () => {
    const ring = ['u1', 'u2', 'u3'];
    expect(nextRoundRobinMember(ring, undefined)).toBe('u1');
    expect(nextRoundRobinMember(ring, 'u1')).toBe('u2');
    expect(nextRoundRobinMember(ring, 'u3')).toBe('u1');
    expect(nextRoundRobinMember(ring, 'gone')).toBe('u1');
    expect(nextRoundRobinMember([], 'u1')).toBeUndefined();
  });

  it('picks the least-busy member, breaking ties by the given order', () => {
    const ring = ['u1', 'u2', 'u3'];
    const counts = new Map([['u1', 3], ['u2', 1], ['u3', 1]]);
    // u2 and u3 tie at 1; the first in order wins, deterministically.
    expect(leastBusyMember(ring, counts)).toBe('u2');
    expect(leastBusyMember(ring, new Map())).toBe('u1');
    expect(leastBusyMember([], counts)).toBeUndefined();
  });
});
