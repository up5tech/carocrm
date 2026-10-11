/**
 * A minimal, dependency-free semantic version reader.
 *
 * The platform only ever needs three questions: "is this a version at all?", "which of two
 * versions is newer?" and "is the running platform at least `minPlatformVersion`?". EspoCRM-style
 * `x.y.z` / `x.y.z-tag` / `x.y` strings are enough, so no npm semver dependency is added.
 */

import { ExtensionError } from '../errors/index.js';

export interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Text after `-`, compared per identifier (numeric identifiers compare numerically). */
  readonly prerelease: string | undefined;
  /** Text after `+`; ignored for ordering, as the spec requires. */
  readonly build: string | undefined;
  readonly raw: string;
}

const VERSION_PATTERN = /^(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

export function isVersion(value: string): boolean {
  return VERSION_PATTERN.test(value.trim());
}

export function parseVersion(value: string, context: Record<string, unknown> = {}): ParsedVersion {
  const raw = value.trim();
  const match = VERSION_PATTERN.exec(raw);
  if (!match) {
    throw new ExtensionError('EXTENSION_VERSION_INCOMPATIBLE', `"${value}" is not a valid version (expected MAJOR.MINOR[.PATCH][-prerelease]).`, {
      version: value,
      ...context,
    });
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
    prerelease: match[4],
    build: match[5],
    raw,
  };
}

/** Standard semver ordering; a prerelease sorts *before* the matching release. */
export function compareVersions(left: string, right: string): number {
  return compareParsed(parseVersion(left), parseVersion(right));
}

export function compareParsed(left: ParsedVersion, right: ParsedVersion): number {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  return comparePrerelease(left.prerelease, right.prerelease);
}

/** `true` when `version` is greater than or equal to `minimum`. */
export function satisfiesMinimum(version: string, minimum: string): boolean {
  return compareVersions(version, minimum) >= 0;
}

function comparePrerelease(left: string | undefined, right: string | undefined): number {
  if (left === undefined && right === undefined) return 0;
  // A version without a prerelease outranks the same version with one.
  if (left === undefined) return 1;
  if (right === undefined) return -1;

  const leftParts = left.split('.');
  const rightParts = right.split('.');
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const a = leftParts[index];
    const b = rightParts[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return Number(a) < Number(b) ? -1 : 1;
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}