import { ValidationError } from '@carocrm/core/errors/index.js';
import { describe, expect, it } from 'vitest';

import {
  compileFieldMappings,
  compileTransform,
  compileTransformSafe,
  type FieldMappingInput,
  readPath,
  type TransformSpec,
  validateTransformSpec,
} from '../src/advanced-integrations/transformation-compiler.js';

/**
 * Phase 19-INT.8 — the transformation compiler (§9.2).
 *
 * A pure suite: no Nest, no database, no network. The compiler is the piece of the module that
 * decides what a provider payload is allowed to become, so it is tested as a closed allowlist —
 * every kind, every null path, and every way a spec can be wrong.
 */

function apply(spec: TransformSpec, value: unknown): unknown {
  return compileTransform(spec)(value);
}

describe('validateTransformSpec', () => {
  it('accepts every allowlisted kind', () => {
    const specs: unknown[] = [
      { type: 'direct' },
      { type: 'toString' },
      { type: 'toNumber' },
      { type: 'toBoolean' },
      { type: 'toDate' },
      { type: 'toDate', options: { format: 'epochMillis' } },
      { type: 'trim' },
      { type: 'default', options: { value: 'x' } },
      { type: 'constant', options: { value: 7 } },
      { type: 'split', options: { separator: ',' } },
      { type: 'join', options: { separator: ', ' } },
      { type: 'redact' },
      { type: 'redact', options: { keep: 2 } },
    ];
    for (const spec of specs) {
      expect(() => validateTransformSpec(spec)).not.toThrow();
    }
  });

  it('rejects a non-object spec', () => {
    expect(() => validateTransformSpec(null)).toThrow(ValidationError);
    expect(() => validateTransformSpec('trim')).toThrow(ValidationError);
    expect(() => validateTransformSpec(undefined)).toThrow(ValidationError);
  });

  it('rejects an unknown type', () => {
    expect(() => validateTransformSpec({ type: 'exec' })).toThrow(ValidationError);
    expect(() => validateTransformSpec({ type: 42 })).toThrow(ValidationError);
    expect(() => validateTransformSpec({})).toThrow(ValidationError);
  });

  it('rejects an unknown key rather than ignoring it', () => {
    expect(() => validateTransformSpec({ type: 'trim', script: 'rm -rf /' })).toThrow(ValidationError);
    expect(() => validateTransformSpec({ type: 'toDate', options: { format: 'iso', tz: 'UTC' } })).toThrow(
      ValidationError,
    );
  });

  it('rejects missing or malformed options', () => {
    expect(() => validateTransformSpec({ type: 'default' })).toThrow(ValidationError);
    expect(() => validateTransformSpec({ type: 'default', options: 'nope' })).toThrow(ValidationError);
    expect(() => validateTransformSpec({ type: 'constant', options: {} })).toThrow(ValidationError);
    expect(() => validateTransformSpec({ type: 'split' })).toThrow(ValidationError);
    expect(() => validateTransformSpec({ type: 'join', options: {} })).toThrow(ValidationError);
  });

  it('rejects a bad separator', () => {
    expect(() => validateTransformSpec({ type: 'split', options: { separator: 1 } })).toThrow(ValidationError);
    expect(() => validateTransformSpec({ type: 'split', options: { separator: '' } })).toThrow(ValidationError);
    expect(() => validateTransformSpec({ type: 'join', options: { separator: '' } })).toThrow(ValidationError);
  });

  it('rejects a non-positive limit', () => {
    expect(() => validateTransformSpec({ type: 'split', options: { separator: ',', limit: 0 } })).toThrow(
      ValidationError,
    );
    expect(() => validateTransformSpec({ type: 'split', options: { separator: ',', limit: -2 } })).toThrow(
      ValidationError,
    );
    expect(() => validateTransformSpec({ type: 'split', options: { separator: ',', limit: 1.5 } })).toThrow(
      ValidationError,
    );
  });

  it('rejects a negative or fractional keep', () => {
    expect(() => validateTransformSpec({ type: 'redact', options: { keep: -1 } })).toThrow(ValidationError);
    expect(() => validateTransformSpec({ type: 'redact', options: { keep: 1.5 } })).toThrow(ValidationError);
  });

  it('rejects an unknown date format', () => {
    expect(() => validateTransformSpec({ type: 'toDate', options: { format: 'dd/MM/yyyy' } })).toThrow(
      ValidationError,
    );
  });

  it('returns a usable spec', () => {
    expect(validateTransformSpec({ type: 'toDate', options: { format: 'epochMillis' } })).toEqual({
      type: 'toDate',
      options: { format: 'epochMillis' },
    });
  });
});

describe('compileTransform — direct', () => {
  it('passes the value through unchanged', () => {
    expect(apply({ type: 'direct' }, 'x')).toBe('x');
    expect(apply({ type: 'direct' }, null)).toBeNull();
    expect(apply({ type: 'direct' }, 5)).toBe(5);
  });
});

describe('compileTransform — toString', () => {
  it('stringifies primitives', () => {
    expect(apply({ type: 'toString' }, 42)).toBe('42');
    expect(apply({ type: 'toString' }, true)).toBe('true');
    expect(apply({ type: 'toString' }, false)).toBe('false');
  });

  it('serializes objects as JSON', () => {
    expect(apply({ type: 'toString' }, { a: 1 })).toBe('{"a":1}');
    expect(apply({ type: 'toString' }, [1, 2])).toBe('[1,2]');
  });

  it('maps null and undefined to null', () => {
    expect(apply({ type: 'toString' }, null)).toBeNull();
    expect(apply({ type: 'toString' }, undefined)).toBeNull();
  });
});

describe('compileTransform — toNumber', () => {
  it('keeps a finite number and parses a numeric string', () => {
    expect(apply({ type: 'toNumber' }, 7)).toBe(7);
    expect(apply({ type: 'toNumber' }, '7')).toBe(7);
    expect(apply({ type: 'toNumber' }, '-3.5')).toBe(-3.5);
    expect(apply({ type: 'toNumber' }, ' 12 ')).toBe(12);
  });

  it('never returns NaN', () => {
    expect(apply({ type: 'toNumber' }, 'abc')).toBeNull();
    expect(apply({ type: 'toNumber' }, '')).toBeNull();
    expect(apply({ type: 'toNumber' }, Number.NaN)).toBeNull();
    expect(apply({ type: 'toNumber' }, Number.POSITIVE_INFINITY)).toBeNull();
    expect(apply({ type: 'toNumber' }, {})).toBeNull();
  });

  it('maps null and undefined to null', () => {
    expect(apply({ type: 'toNumber' }, null)).toBeNull();
    expect(apply({ type: 'toNumber' }, undefined)).toBeNull();
  });
});

describe('compileTransform — toBoolean', () => {
  it('reads the well-known words and digits, case-insensitively', () => {
    expect(apply({ type: 'toBoolean' }, 'true')).toBe(true);
    expect(apply({ type: 'toBoolean' }, 'TRUE')).toBe(true);
    expect(apply({ type: 'toBoolean' }, '1')).toBe(true);
    expect(apply({ type: 'toBoolean' }, 'Yes')).toBe(true);
    expect(apply({ type: 'toBoolean' }, 'false')).toBe(false);
    expect(apply({ type: 'toBoolean' }, '0')).toBe(false);
    expect(apply({ type: 'toBoolean' }, 'no')).toBe(false);
  });

  it('keeps a boolean and reads a number as non-zero', () => {
    expect(apply({ type: 'toBoolean' }, true)).toBe(true);
    expect(apply({ type: 'toBoolean' }, false)).toBe(false);
    expect(apply({ type: 'toBoolean' }, 2)).toBe(true);
    expect(apply({ type: 'toBoolean' }, 0)).toBe(false);
  });

  it('maps anything else to null', () => {
    expect(apply({ type: 'toBoolean' }, 'maybe')).toBeNull();
    expect(apply({ type: 'toBoolean' }, null)).toBeNull();
    expect(apply({ type: 'toBoolean' }, undefined)).toBeNull();
  });
});

describe('compileTransform — toDate', () => {
  it('reads an ISO string', () => {
    expect(apply({ type: 'toDate' }, '2026-01-02T03:04:05.000Z')).toBe('2026-01-02T03:04:05.000Z');
    expect(apply({ type: 'toDate', options: { format: 'iso' } }, '2026-01-02T03:04:05.000Z')).toBe(
      '2026-01-02T03:04:05.000Z',
    );
  });

  it('reads epoch seconds by default', () => {
    expect(apply({ type: 'toDate' }, 1767322845)).toBe('2026-01-02T03:00:45.000Z');
    expect(apply({ type: 'toDate', options: { format: 'epochSeconds' } }, 1767322845)).toBe(
      '2026-01-02T03:00:45.000Z',
    );
    expect(apply({ type: 'toDate' }, '1767322845')).toBe('2026-01-02T03:00:45.000Z');
  });

  it('reads epoch milliseconds when asked to', () => {
    expect(apply({ type: 'toDate', options: { format: 'epochMillis' } }, 1767322845000)).toBe(
      '2026-01-02T03:00:45.000Z',
    );
  });

  it('reads a Date instance', () => {
    expect(apply({ type: 'toDate' }, new Date('2026-01-02T03:04:05.000Z'))).toBe('2026-01-02T03:04:05.000Z');
  });

  it('maps an unparsable value to null', () => {
    expect(apply({ type: 'toDate' }, 'not a date')).toBeNull();
    expect(apply({ type: 'toDate' }, {})).toBeNull();
    expect(apply({ type: 'toDate' }, null)).toBeNull();
    expect(apply({ type: 'toDate' }, undefined)).toBeNull();
  });

  it('refuses a number under the iso format rather than guessing the epoch unit', () => {
    expect(apply({ type: 'toDate', options: { format: 'iso' } }, 1767322845)).toBeNull();
  });
});

describe('compileTransform — trim', () => {
  it('trims a string', () => {
    expect(apply({ type: 'trim' }, '  padded  ')).toBe('padded');
  });

  it('maps anything that is not a string to null', () => {
    expect(apply({ type: 'trim' }, 42)).toBeNull();
    expect(apply({ type: 'trim' }, null)).toBeNull();
    expect(apply({ type: 'trim' }, undefined)).toBeNull();
  });
});

describe('compileTransform — default', () => {
  it('replaces a missing value', () => {
    expect(apply({ type: 'default', options: { value: 'fallback' } }, null)).toBe('fallback');
    expect(apply({ type: 'default', options: { value: 'fallback' } }, undefined)).toBe('fallback');
  });

  it('keeps an empty string, which is not missing', () => {
    expect(apply({ type: 'default', options: { value: 'fallback' } }, '')).toBe('');
  });

  it('keeps any other value unchanged', () => {
    expect(apply({ type: 'default', options: { value: 'fallback' } }, 'kept')).toBe('kept');
    expect(apply({ type: 'default', options: { value: 'fallback' } }, 0)).toBe(0);
    expect(apply({ type: 'default', options: { value: 'fallback' } }, false)).toBe(false);
  });
});

describe('compileTransform — constant', () => {
  it('always returns the constant, whatever the input', () => {
    expect(apply({ type: 'constant', options: { value: 'crm' } }, 'provider')).toBe('crm');
    expect(apply({ type: 'constant', options: { value: 'crm' } }, null)).toBe('crm');
    expect(apply({ type: 'constant', options: { value: 'crm' } }, undefined)).toBe('crm');
  });
});

describe('compileTransform — split', () => {
  it('splits a delimited string into a list', () => {
    expect(apply({ type: 'split', options: { separator: ',' } }, 'a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('honours the limit', () => {
    expect(apply({ type: 'split', options: { separator: ',', limit: 2 } }, 'a,b,c')).toEqual(['a', 'b']);
  });

  it('returns a list unchanged', () => {
    expect(apply({ type: 'split', options: { separator: ',' } }, ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('maps null, undefined and other types to null', () => {
    expect(apply({ type: 'split', options: { separator: ',' } }, null)).toBeNull();
    expect(apply({ type: 'split', options: { separator: ',' } }, undefined)).toBeNull();
    expect(apply({ type: 'split', options: { separator: ',' } }, 42)).toBeNull();
  });
});

describe('compileTransform — join', () => {
  it('joins a list with the separator', () => {
    expect(apply({ type: 'join', options: { separator: ', ' } }, ['a', 'b'])).toBe('a, b');
  });

  it('stringifies each element', () => {
    expect(apply({ type: 'join', options: { separator: '|' } }, [1, true])).toBe('1|true');
  });

  it('returns a string unchanged', () => {
    expect(apply({ type: 'join', options: { separator: ',' } }, 'a,b')).toBe('a,b');
  });

  it('maps null, undefined and other types to null', () => {
    expect(apply({ type: 'join', options: { separator: ',' } }, null)).toBeNull();
    expect(apply({ type: 'join', options: { separator: ',' } }, undefined)).toBeNull();
    expect(apply({ type: 'join', options: { separator: ',' } }, 42)).toBeNull();
  });
});

describe('compileTransform — redact', () => {
  it('keeps exactly the requested number of characters', () => {
    expect(apply({ type: 'redact', options: { keep: 3 } }, 'abcdefgh')).toBe('abc*****');
  });

  it('keeps nothing by default', () => {
    expect(apply({ type: 'redact' }, 'abcdefgh')).toBe('********');
  });

  it('never leaks the rest of the value', () => {
    const redacted = apply({ type: 'redact', options: { keep: 2 } }, 'super-secret') as string;
    expect(redacted).not.toContain('secret');
    expect(redacted.startsWith('su')).toBe(true);
  });

  it('masks a number completely', () => {
    expect(apply({ type: 'redact' }, 1234)).toBe('****');
    expect(apply({ type: 'redact', options: { keep: 2 } }, 1234)).toBe('****');
  });

  it('maps null, undefined and other types to null', () => {
    expect(apply({ type: 'redact' }, null)).toBeNull();
    expect(apply({ type: 'redact' }, undefined)).toBeNull();
    expect(apply({ type: 'redact' }, {})).toBeNull();
  });
});

describe('compileTransformSafe', () => {
  it('validates before compiling', () => {
    expect(() => compileTransformSafe({ type: 'nope' })).toThrow(ValidationError);
    expect(compileTransformSafe({ type: 'trim' })('  x  ')).toBe('x');
  });
});

describe('readPath', () => {
  it('resolves a nested path', () => {
    expect(readPath({ organizer: { email: 'a@b.c' } }, 'organizer.email')).toBe('a@b.c');
    expect(readPath({ summary: 'hello' }, 'summary')).toBe('hello');
  });

  it('returns undefined for a missing segment without throwing', () => {
    expect(readPath({ organizer: { email: 'a@b.c' } }, 'organizer.phone')).toBeUndefined();
    expect(readPath({ organizer: { email: 'a@b.c' } }, 'missing.email')).toBeUndefined();
    expect(readPath({}, 'a.b.c')).toBeUndefined();
    expect(readPath({ a: 'text' }, 'a.b')).toBeUndefined();
  });

  it('keeps a present-but-null value null', () => {
    expect(readPath({ organizer: { email: null } }, 'organizer.email')).toBeNull();
  });
});

describe('compileFieldMappings', () => {
  const base = (overrides: Partial<FieldMappingInput> = {}): FieldMappingInput => ({
    sourcePath: 'summary',
    targetField: 'description',
    transform: null,
    required: false,
    ...overrides,
  });

  it('compiles a mapping and reads the source path', () => {
    const [mapping] = compileFieldMappings([base()]);
    expect(mapping?.targetField).toBe('description');
    expect(mapping?.required).toBe(false);
    expect(mapping?.apply({ summary: 'hello' })).toBe('hello');
  });

  it('applies the transformation to the read value', () => {
    const [mapping] = compileFieldMappings([
      base({ sourcePath: 'organizer.email', targetField: 'emailAddress', transform: { type: 'trim' } }),
    ]);
    expect(mapping?.apply({ organizer: { email: '  a@b.c  ' } })).toBe('a@b.c');
  });

  it('returns undefined for an absent path', () => {
    const [mapping] = compileFieldMappings([base()]);
    expect(mapping?.apply({})).toBeUndefined();
  });

  it('keeps a present-but-null value null', () => {
    const [mapping] = compileFieldMappings([base()]);
    expect(mapping?.apply({ summary: null })).toBeNull();
  });

  it('rejects a duplicate target field', () => {
    expect(() =>
      compileFieldMappings([base(), base({ sourcePath: 'other' })]),
    ).toThrow(ValidationError);
  });

  it('rejects a malformed source path', () => {
    expect(() => compileFieldMappings([base({ sourcePath: '' })])).toThrow(ValidationError);
    expect(() => compileFieldMappings([base({ sourcePath: 'a..b' })])).toThrow(ValidationError);
    expect(() => compileFieldMappings([base({ sourcePath: 'a.b!' })])).toThrow(ValidationError);
    expect(() => compileFieldMappings([base({ sourcePath: 'a.b-c' })])).toThrow(ValidationError);
  });

  it('rejects a malformed target field', () => {
    expect(() => compileFieldMappings([base({ targetField: '' })])).toThrow(ValidationError);
    expect(() => compileFieldMappings([base({ targetField: 'not a field' })])).toThrow(ValidationError);
    expect(() => compileFieldMappings([base({ targetField: '1field' })])).toThrow(ValidationError);
  });

  it('rejects an invalid transformation', () => {
    expect(() =>
      compileFieldMappings([base({ transform: { type: 'exec' } as unknown as TransformSpec })]),
    ).toThrow(ValidationError);
  });

  it('carries the required flag through', () => {
    const [mapping] = compileFieldMappings([base({ required: true })]);
    expect(mapping?.required).toBe(true);
  });
});
