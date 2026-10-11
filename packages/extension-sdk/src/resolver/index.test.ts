import { describe, expect, it } from 'vitest';

import { ExtensionError } from '../errors/index.js';
import type { ResolvableExtension } from './index.js';
import { platformProblem, resolveExtensions } from './index.js';

function ext(id: string, overrides: Partial<ResolvableExtension> = {}): ResolvableExtension {
  return { id, version: '1.0.0', order: 100, dependencies: [], ...overrides };
}

describe('extension resolver', () => {
  it('orders by ascending `order` so a higher value overrides (PLAN §39)', () => {
    const report = resolveExtensions([ext('third', { order: 300 }), ext('first', { order: 50 }), ext('second', { order: 100 })]);
    expect(report.order).toEqual(['first', 'second', 'third']);
    expect(report.skipped).toEqual([]);
  });

  it('breaks equal `order` values by id so the result is deterministic', () => {
    const report = resolveExtensions([ext('b'), ext('a')]);
    expect(report.order).toEqual(['a', 'b']);
  });

  it('loads a dependency before its dependent even when the order says otherwise', () => {
    const report = resolveExtensions([
      ext('dependent', { order: 10, dependencies: [{ id: 'library' }] }),
      ext('library', { order: 900 }),
    ]);
    expect(report.order).toEqual(['library', 'dependent']);
  });

  it('fails fast on a missing dependency', () => {
    expect(() => resolveExtensions([ext('dependent', { dependencies: [{ id: 'missing' }] })])).toThrowError(ExtensionError);
    try {
      resolveExtensions([ext('dependent', { dependencies: [{ id: 'missing' }] })]);
      expect.unreachable('should have thrown');
    } catch (error: unknown) {
      expect((error as ExtensionError).code).toBe('EXTENSION_DEPENDENCY_MISSING');
    }
  });

  it('explains that a present-but-unusable dependency must be fixed first', () => {
    expect(() =>
      resolveExtensions([ext('dependent', { dependencies: [{ id: 'library' }] }), ext('library', { minPlatformVersion: '9.0.0' })]),
    ).toThrowError(/incompatible/);
  });

  it('skips a disabled package and refuses the extension that needs it', () => {
    const report = resolveExtensions([ext('library'), ext('standalone')], { inactiveIds: new Set(['library']) });
    expect(report.order).toEqual(['standalone']);
    expect(report.skipped).toEqual([{ id: 'library', reason: 'disabled' }]);
    expect(() =>
      resolveExtensions([ext('dependent', { dependencies: [{ id: 'library' }] }), ext('library')], {
        inactiveIds: new Set(['library']),
      }),
    ).toThrowError(/not enabled/);
  });

  it('detects a dependency cycle instead of looping', () => {
    expect(() =>
      resolveExtensions([ext('a', { dependencies: [{ id: 'b' }] }), ext('b', { dependencies: [{ id: 'a' }] })]),
    ).toThrowError(/cycle/);
  });

  it('rejects two packages claiming the same id', () => {
    expect(() => resolveExtensions([ext('a'), ext('a')])).toThrowError(/declare the id/);
  });

  it('refuses an unsatisfied dependency version', () => {
    try {
      resolveExtensions([ext('a', { dependencies: [{ id: 'b', version: '2.0.0' }] }), ext('b', { version: '1.4.0' })]);
      expect.unreachable('should have thrown');
    } catch (error: unknown) {
      expect((error as ExtensionError).code).toBe('EXTENSION_VERSION_INCOMPATIBLE');
    }
  });

  it('skips (rather than aborts on) a package outside its platform window', () => {
    const report = resolveExtensions(
      [ext('future', { minPlatformVersion: '2.0.0' }), ext('legacy', { maxPlatformVersion: '0.9.0' }), ext('current')],
      { platformVersion: '1.0.0' },
    );
    expect(report.order).toEqual(['current']);
    expect(report.skipped).toEqual([
      { id: 'future', reason: 'requires platform 2.0.0 or newer, running 1.0.0' },
      { id: 'legacy', reason: 'supports platform up to 0.9.0, running 1.0.0' },
    ]);
  });

  it('blocks a dependent whose dependency was skipped for incompatibility', () => {
    expect(() =>
      resolveExtensions([ext('a', { dependencies: [{ id: 'future' }] }), ext('future', { minPlatformVersion: '9.0.0' })], {
        platformVersion: '1.0.0',
      }),
    ).toThrowError(ExtensionError);
  });

  it('reports a compatible package with no window as fine', () => {
    expect(platformProblem(ext('a'), '1.0.0')).toBeUndefined();
  });
});