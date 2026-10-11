import { describe, expect, it } from 'vitest';

import { FormulaEvaluationError, FormulaLimitError } from '../errors/index.js';
import { FormulaEngine } from './index.js';

const clock = new Date('2026-03-05T10:20:30Z');

function engine(options = {}): FormulaEngine {
  return new FormulaEngine(options);
}

function value(source: string, record: Readonly<Record<string, unknown>> = {}, timezone = 'UTC'): unknown {
  return engine().evaluate(source, { record, now: clock, timezone });
}

describe('FormulaEngine — arithmetic and logic', () => {
  it('evaluates numbers, comparisons and boolean operators', () => {
    expect(value('1 + 2 * 3')).toBe(7);
    expect(value('10 / 4')).toBe(2.5);
    expect(value('10 % 3')).toBe(1);
    expect(value('2 > 1 && 1 < 2')).toBe(true);
    expect(value('!(1 == 2)')).toBe(true);
    expect(value('1 > 2 ? 3 : 4')).toBe(4);
    expect(value('-4 + 2')).toBe(-2);
  });

  it('concatenates when either operand is text', () => {
    expect(value("'a' + 1")).toBe('a1');
    expect(value("1 + 'a'")).toBe('1a');
    expect(value('1 + 2')).toBe(3);
  });

  it('compares values with numeric coercion only when both sides are numeric', () => {
    expect(value("'7' == 7")).toBe(true);
    expect(value("'abc' == 0")).toBe(false);
    expect(value("null == null")).toBe(true);
    expect(value("'a' < 'b'")).toBe(true);
  });

  it('fails on division by zero and non-finite results', () => {
    expect(() => value('1 / 0')).toThrowError(FormulaEvaluationError);
    expect(() => value('power(10, 1000)')).toThrowError(FormulaEvaluationError);
  });
});

describe('FormulaEngine — whitelisted functions', () => {
  it('provides string functions', () => {
    expect(value("concat('a', 'b', 1)")).toBe('ab1');
    expect(value("upper('abc')")).toBe('ABC');
    expect(value("lower('ABC')")).toBe('abc');
    expect(value("trim('  x  ')")).toBe('x');
    expect(value("substring('abcdef', 1, 3)")).toBe('bcd');
    expect(value("contains('hello world', 'world')")).toBe(true);
    expect(value("startsWith('hello', 'he')")).toBe(true);
    expect(value("endsWith('hello', 'lo')")).toBe(true);
    expect(value("replace('a-b-c', '-', '_')")).toBe('a_b_c');
    expect(value("length('abcd')")).toBe(4);
    expect(value("join(split('a,b,c', ','), '|')")).toBe('a|b|c');
  });

  it('provides math and numeric functions', () => {
    expect(value('round(1.2345, 2)')).toBe(1.23);
    expect(value('round(-1.25, 1)')).toBe(-1.3);
    expect(value('floor(1.9)')).toBe(1);
    expect(value('ceil(1.1)')).toBe(2);
    expect(value('abs(-3)')).toBe(3);
    expect(value('min(3, 1, 2)')).toBe(1);
    expect(value('max([3, 9, 2])')).toBe(9);
    expect(value('sum(1, 2, 3)')).toBe(6);
    expect(value('avg([2, 4])')).toBe(3);
    expect(value('sqrt(9)')).toBe(3);
    expect(value('power(2, 10)')).toBe(1024);
    expect(value("numberFormat(1234.5, 2, ',', ' ')")).toBe('1 234,50');
  });

  it('provides collection functions', () => {
    expect(value('count([1, 2, 3])')).toBe(3);
    expect(value("inArray('b', ['a', 'b'])")).toBe(true);
    expect(value('arrayAdd([1], 2)')).toEqual([1, 2]);
    expect(value('arrayAddUnique([1, 2], 2, 3)')).toEqual([1, 2, 3]);
    expect(value("arrayRemove(['a', 'b'], 'a')")).toEqual(['b']);
    expect(value('first([5, 6])')).toBe(5);
    expect(value('last([5, 6])')).toBe(6);
    expect(value('[1, 2, 3][1]')).toBe(2);
    expect(value('[1, 2, 3].length')).toBe(3);
  });

  it('provides conditional and type functions', () => {
    expect(value("ifThen(1 > 2, 'yes', 'no')")).toBe('no');
    expect(value("coalesce(null, '', 'fallback')")).toBe('fallback');
    expect(value("isEmpty('')")).toBe(true);
    expect(value('isEmpty([])')).toBe(true);
    expect(value('isNotEmpty([1])')).toBe(true);
    expect(value('isNull(null)')).toBe(true);
    expect(value("number('42')")).toBe(42);
    expect(value('string(42)')).toBe('42');
    expect(value('bool(0)')).toBe(false);
    expect(value('not(true)')).toBe(false);
  });

  it('provides deterministic date functions driven by the context clock', () => {
    expect(value('currentDate()')).toBe('2026-03-05');
    expect(value('now()')).toBe('2026-03-05T10:20:30');
    expect(value('currentTimestamp()')).toBe(Math.floor(clock.getTime() / 1000));
    expect(value("addDays('2026-03-05', 10)")).toBe('2026-03-15');
    expect(value("subDays('2026-03-05', 5)")).toBe('2026-02-28');
    expect(value("addMonths('2026-01-31', 1)")).toBe('2026-02-28');
    expect(value("diffDays('2026-03-01', '2026-03-05')")).toBe(4);
    expect(value("yearOf('2026-03-05')")).toBe(2026);
    expect(value("monthOf('2026-03-05')")).toBe(3);
    expect(value("dayOfMonth('2026-03-05')")).toBe(5);
    expect(value("weekdayOf('2026-03-05')")).toBe(4);
    expect(value("formatDate('2026-03-05T10:20:30', 'DD/MM/YYYY HH:mm')")).toBe('05/03/2026 10:20');
    expect(value("formatDate('2026-03-05', 'EEEE D MMMM YYYY')")).toBe('Thursday 5 March 2026');
    expect(value("startOfMonth('2026-03-17')")).toBe('2026-03-01');
  });

  it('honours the context timezone', () => {
    expect(value('currentDate()', {}, 'Asia/Ho_Chi_Minh')).toBe('2026-03-05T17:20:30'.slice(0, 10));
    expect(value("formatDate('2026-03-05T20:00:00Z', 'HH:mm')", {}, 'Asia/Tokyo')).toBe('05:00');
    expect(() => value('now()', {}, 'Not/AZone')).toThrowError(FormulaEvaluationError);
  });

  it('provides record access functions', () => {
    expect(value("field('name')", { name: 'Acme' })).toBe('Acme');
    expect(value("field('name')", {})).toBeNull();
    expect(value("hasField('name')", { name: 'Acme' })).toBe(true);
    expect(value("ifThen(isEmpty(field('missing')), 'empty', 'set')", { missing: null })).toBe('empty');
    expect(value('recordId()', { id: 'abc' })).toBe('abc');
    expect(() => engine().evaluate("field('name')")).toThrowError(FormulaEvaluationError);
  });
});

describe('FormulaEngine — sandbox boundary (PLAN §22.1)', () => {
  const hostile = [
    'eval("1")',
    'require("fs")',
    'import("fs")',
    'process.exit()',
    'globalThis.x',
    'constructor("x")',
    'Function("return 1")()',
    'toString()',
    "field('constructor')",
    'unknownFunction(1)',
    'this',
  ];

  it.each(hostile)('refuses %s', (source) => {
    expect(() => value(source, { name: 'x' })).toThrowError();
  });

  it('never exposes prototype-ish keys held in record data', () => {
    const record = JSON.parse('{"__proto__": {"evil": 1}, "constructor": "x", "name": "ok"}') as Record<string, unknown>;
    expect(value("field('name')", record)).toBe('ok');
    expect(() => value("field('__proto__')", record)).toThrowError(FormulaEvaluationError);
    expect(() => value("field('constructor')", record)).toThrowError(FormulaEvaluationError);
  });

  it('does not leak host objects from record attributes', () => {
    const leaked = engine().evaluate('field("secret")', { record: { secret: () => 'nope' } as unknown as Record<string, unknown> });
    expect(typeof leaked).toBe('string');
    expect(typeof leaked === 'string' ? leaked : '').not.toBe('nope');
  });

  it('stops runaway evaluation through the step budget', () => {
    expect(() => new FormulaEngine({ limits: { maxSteps: 3 } }).evaluate('1 + 2 * 3')).toThrowError(FormulaLimitError);
  });

  it('bounds produced strings and arrays', () => {
    expect(value("concat('aaaa', 'aaaa')")).toBe('aaaaaaaa');
    expect(() => new FormulaEngine({ limits: { maxStringLength: 4 } }).evaluate("concat('aaaaa', 'b')")).toThrowError(FormulaLimitError);
    expect(() => new FormulaEngine({ limits: { maxArrayLength: 2 } }).evaluate('arrayAdd([1, 2], 3)')).toThrowError(FormulaLimitError);
  });

  it('cannot be extended with an arbitrary function at runtime', () => {
    const custom = engine();
    custom.functions.register({
      name: 'double',
      minArgs: 1,
      maxArgs: 1,
      description: 'double(n)',
      apply: ([input]) => Number(input) * 2,
    });
    expect(custom.evaluate('double(21)')).toBe(42);
    expect(() => custom.evaluate('eval(1)')).toThrowError(FormulaEvaluationError);
  });
});

describe('FormulaEngine — validation and caching', () => {
  it('reports parse problems without throwing', () => {
    expect(engine().validate('1 + 1')).toMatchObject({ valid: true });
    expect(engine().validate('1 +')).toMatchObject({ valid: false });
    expect(engine().validate("concat('a'").valid).toBe(false);
    expect(engine().validate('unknownFn(1)')).toMatchObject({ valid: false, error: 'Unknown function "unknownFn".' });
    expect(engine().validate('someVariable')).toMatchObject({ valid: false });
  });

  it('caches compiled formulas', () => {
    const instance = engine();
    expect(instance.compile('1 + 1')).toBe(instance.compile('1 + 1'));
  });
});
