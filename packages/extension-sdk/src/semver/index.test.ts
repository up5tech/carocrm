import { describe, expect, it } from 'vitest';

import { ExtensionError } from '../errors/index.js';
import { compareVersions, isVersion, parseVersion, satisfiesMinimum } from './index.js';

describe('semver', () => {
  it('accepts the EspoCRM-style version strings a manifest may carry', () => {
    expect(isVersion('1.0.0')).toBe(true);
    expect(isVersion('2.4')).toBe(true);
    expect(isVersion('1.0.0-beta.1')).toBe(true);
    expect(isVersion('1.0.0+build.7')).toBe(true);
    expect(isVersion('v1.0.0')).toBe(false);
    expect(isVersion('latest')).toBe(false);
    expect(isVersion('1')).toBe(false);
  });

  it('raises an actionable error for a non-version', () => {
    expect(() => parseVersion('nope', { id: 'demo' })).toThrowError(ExtensionError);
    try {
      parseVersion('nope', { id: 'demo' });
      expect.unreachable('should have thrown');
    } catch (error: unknown) {
      expect((error as ExtensionError).code).toBe('EXTENSION_VERSION_INCOMPATIBLE');
      expect((error as ExtensionError).details).toMatchObject({ version: 'nope', id: 'demo' });
    }
  });

  it('orders by major, minor then patch', () => {
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
    expect(compareVersions('1.1.0', '1.0.9')).toBe(1);
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
  });

  it('sorts a prerelease before its release and compares identifiers per spec', () => {
    expect(compareVersions('1.0.0-alpha', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.2')).toBe(-1);
    expect(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10')).toBe(-1);
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1);
  });

  it('ignores build metadata when comparing', () => {
    expect(compareVersions('1.0.0+a', '1.0.0+b')).toBe(0);
  });

  it('treats a missing patch component as zero', () => {
    expect(parseVersion('3.1').patch).toBe(0);
    expect(satisfiesMinimum('3.1', '3.0.9')).toBe(true);
    expect(satisfiesMinimum('3.0.0', '3.1')).toBe(false);
    expect(satisfiesMinimum('1.4.0', '1.4.0')).toBe(true);
  });
});