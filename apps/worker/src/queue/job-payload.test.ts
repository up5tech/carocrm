import { describe, expect, it } from 'vitest';

import { buildJobPayload, parseJobPayload, scheduledJobId } from './job-payload.js';

describe('parseJobPayload', () => {
  it('accepts the { job, data } contract', () => {
    expect(parseJobPayload({ job: 'system.noop', data: { a: 1 } })).toEqual({
      job: 'system.noop',
      data: { a: 1 },
    });
  });

  it('defaults missing data to an empty object', () => {
    expect(parseJobPayload({ job: 'system.noop' })).toEqual({ job: 'system.noop', data: {} });
  });

  it('keeps scheduler metadata', () => {
    const payload = parseJobPayload({
      job: 'system.cleanupOutbox',
      data: { retentionDays: 7 },
      scheduleId: 'cleanup',
      scheduledForMs: 1700000000000,
    });
    expect(payload).toEqual({
      job: 'system.cleanupOutbox',
      data: { retentionDays: 7 },
      scheduleId: 'cleanup',
      scheduledForMs: 1700000000000,
    });
  });

  it('rejects malformed payloads', () => {
    expect(parseJobPayload(undefined)).toBeUndefined();
    expect(parseJobPayload(null)).toBeUndefined();
    expect(parseJobPayload({})).toBeUndefined();
    expect(parseJobPayload({ job: '' })).toBeUndefined();
    expect(parseJobPayload({ job: 'x', data: 'nope' })).toBeUndefined();
    expect(parseJobPayload({ job: 'x', data: [1, 2] })).toBeUndefined();
    expect(parseJobPayload('system.noop')).toBeUndefined();
  });
});

describe('buildJobPayload', () => {
  it('omits undefined scheduler metadata instead of writing nulls', () => {
    expect(buildJobPayload({ job: 'system.noop' })).toEqual({ job: 'system.noop', data: {} });
    expect(
      buildJobPayload({ job: 'j', data: { n: 1 }, scheduleId: 's', scheduledForMs: 12 }),
    ).toEqual({ job: 'j', data: { n: 1 }, scheduleId: 's', scheduledForMs: 12 });
  });

  it('round-trips through the parser', () => {
    const payload = buildJobPayload({ job: 'a.b', data: { x: 'y' }, scheduleId: 'sc' });
    expect(parseJobPayload(payload)).toEqual(payload);
  });
});

describe('scheduledJobId', () => {
  it('is deterministic per schedule and cron boundary', () => {
    expect(scheduledJobId('cleanup', 1700000000000)).toBe('cleanup_1700000000000');
    expect(scheduledJobId('cleanup', 1700000000001)).not.toBe(scheduledJobId('cleanup', 1700000000000));
    // The millisecond suffix keeps the mapping one-to-one even for ids that contain "_".
    expect(scheduledJobId('cleanup_1700000000', 1)).toBe('cleanup_1700000000_1');
    expect(scheduledJobId('cleanup', 1700000000000)).not.toContain(':');
  });
});

describe('jobRowId (Jobs API row adoption, PLAN §24)', () => {
  it('builds and parses the row id symmetrically', () => {
    const payload = buildJobPayload({ job: 'system.noop', data: { a: 1 }, jobRowId: 'row-9' });
    expect(payload.jobRowId).toBe('row-9');
    expect(parseJobPayload(payload)?.jobRowId).toBe('row-9');
    expect(buildJobPayload({ job: 'system.noop' }).jobRowId).toBeUndefined();
  });

  it('rejects an over-long or empty row id', () => {
    expect(parseJobPayload({ job: 'system.noop', data: {}, jobRowId: '' })).toBeUndefined();
    expect(parseJobPayload({ job: 'system.noop', data: {}, jobRowId: 'x'.repeat(80) })).toBeUndefined();
  });
});
