import { describe, expect, it } from 'vitest';

import {
  changedKeys,
  formatCaseNumber,
  hasRequesterReference,
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
