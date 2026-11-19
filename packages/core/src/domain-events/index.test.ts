import { describe, expect, it } from 'vitest';

import { changedEventValues } from './index.js';

describe('changedEventValues (25.6)', () => {
  it('captures only changed fields and keeps both sides of each transition', () => {
    const before = { status: 'New', name: 'Old', untouched: 'same' };
    const after = { status: 'Qualified', name: 'Old', untouched: 'same' };
    expect(changedEventValues(after, before)).toEqual({
      before: { status: 'New' },
      after: { status: 'Qualified' },
    });
  });

  it('has an empty before side for a create', () => {
    expect(changedEventValues({ status: 'New' })).toEqual({ before: {}, after: { status: 'New' } });
  });

  it('omits objects, bounds strings and caps the field count', () => {
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (let index = 0; index < 19; index += 1) {
      before[`field_${String(index)}`] = 'before';
      after[`field_${String(index)}`] = 'after';
    }
    before['long'] = 'b'.repeat(700);
    after['long'] = 'a'.repeat(700);
    before['nested'] = { secret: true };
    after['nested'] = { secret: false };

    const snapshot = changedEventValues(after, before);
    expect(Object.keys(snapshot.after)).toHaveLength(20);
    expect(snapshot.before['long']).toBe('b'.repeat(500));
    expect(snapshot.after['long']).toBe('a'.repeat(500));
    expect(snapshot.before['nested']).toBeUndefined();
    expect(snapshot.after['nested']).toBeUndefined();
  });

  it('accepts arrays of scalars but drops nested arrays', () => {
    const snapshot = changedEventValues(
      { tags: ['a', 2, true], nested: [['x']] },
      { tags: ['b'], nested: [] },
    );
    expect(snapshot.after['tags']).toEqual(['a', 2, true]);
    expect(snapshot.before['tags']).toEqual(['b']);
    expect(snapshot.after['nested']).toBeUndefined();
  });
});
