import { describe, expect, it } from 'vitest';

import { FormulaLimitError, FormulaParseError } from '../errors/index.js';
import { DEFAULT_LIMITS, resolveLimits } from '../limits/index.js';
import { parseFormula } from './index.js';

function parse(source: string, overrides = {}): ReturnType<typeof parseFormula> {
  return parseFormula(source, resolveLimits(overrides));
}

describe('parseFormula', () => {
  it('parses literals, calls and operators into an AST', () => {
    const { ast } = parse("concat(field('firstName'), ' ', field('lastName'))");
    expect(ast).toMatchObject({ kind: 'call', name: 'concat' });
  });

  it('respects operator precedence', () => {
    expect(parse('1 + 2 * 3').nodeCount).toBe(5);
    const nested = parse('(1 + 2) * 3').ast;
    expect(nested).toMatchObject({ kind: 'binary', operator: '*', left: { kind: 'binary', operator: '+' } });
  });

  it('treats && and || as short-circuit nodes', () => {
    expect(parse('true || false && true').ast).toMatchObject({ kind: 'logical', operator: '||' });
    expect(parse('a && b || c').ast).toMatchObject({ kind: 'logical', operator: '||', left: { kind: 'logical', operator: '&&' } });
  });

  it('parses ternary with the loosest binding', () => {
    expect(parse('1 > 2 ? 3 : 4').ast).toMatchObject({ kind: 'conditional', test: { kind: 'binary', operator: '>' } });
  });

  it('rejects assignment', () => {
    expect(() => parse('a = 1')).toThrowError(FormulaParseError);
  });

  it('rejects prototype-reaching identifiers and properties', () => {
    expect(() => parse('a.__proto__')).toThrowError(FormulaParseError);
    expect(() => parse('a.constructor')).toThrowError(FormulaParseError);
    expect(() => parse('a["prototype"]')).not.toThrow();
    expect(() => parse('constructor()')).toThrowError(FormulaParseError);
  });

  it('rejects unknown characters and template strings', () => {
    expect(() => parse('`abc`')).toThrowError(FormulaParseError);
    expect(() => parse('a; b')).toThrowError(FormulaParseError);
    expect(() => parse('${x}')).toThrowError(FormulaParseError);
  });

  it('rejects trailing garbage', () => {
    expect(() => parse('1 2')).toThrowError(FormulaParseError);
    expect(() => parse('concat(1,')).toThrowError(FormulaParseError);
  });

  it('enforces the source length and complexity budgets', () => {
    expect(() => parse('1 + 1', { maxSourceLength: 3 })).toThrowError(FormulaLimitError);
    expect(() => parse('1+1+1+1+1+1+1+1+1+1', { maxNodes: 6 })).toThrowError(FormulaLimitError);
    expect(() => parse('((((((1))))))', { maxDepth: 3 })).toThrowError(FormulaLimitError);
    expect(() => parse('f(1, 2, 3)', { maxCallArgs: 2 })).toThrowError(FormulaLimitError);
  });

  it('keeps the DEFAULT_LIMITS sane', () => {
    expect(DEFAULT_LIMITS.maxSteps).toBeGreaterThan(0);
    expect(resolveLimits({ maxNodes: -1 }).maxNodes).toBe(DEFAULT_LIMITS.maxNodes);
  });

  it('supports line comments', () => {
    expect(parse("1 + 1 # trailing note").nodeCount).toBe(3);
  });
});
