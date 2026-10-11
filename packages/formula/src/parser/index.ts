import type { AstNode, BinaryOperator, LiteralValue, LogicalOperator, UnaryOperator } from '../ast/index.js';
import { FormulaLimitError,FormulaParseError } from '../errors/index.js';
import type { FormulaLimits } from '../limits/index.js';

type TokenKind = 'number' | 'string' | 'identifier' | 'operator' | 'punct' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
  start: number;
}

const OPERATORS: readonly string[] = ['<=', '>=', '==', '!=', '&&', '||', '+', '-', '*', '/', '%', '<', '>'];
const PUNCTUATION: readonly string[] = ['(', ')', '[', ']', ',', '.', ':', '?'];
const BANNED_PROPERTIES: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = { '\\': '\\', '"': '"', "'": "'", n: '\n', t: '\t', r: '\r' };

function tokenize(source: string, limits: FormulaLimits): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] ?? '';
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      index += 1;
      continue;
    }
    if (char === '#') {
      // Comment to end of line; comments are inert text, never part of the AST.
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (/[0-9]/.test(char)) {
      const start = index;
      while (index < source.length && /[0-9]/.test(source[index] ?? '')) index += 1;
      if (source[index] === '.' && /[0-9]/.test(source[index + 1] ?? '')) {
        index += 1;
        while (index < source.length && /[0-9]/.test(source[index] ?? '')) index += 1;
      }
      if (source[index] === 'e' || source[index] === 'E') {
        const save = index;
        index += 1;
        if (source[index] === '+' || source[index] === '-') index += 1;
        if (!/[0-9]/.test(source[index] ?? '')) index = save;
        else while (index < source.length && /[0-9]/.test(source[index] ?? '')) index += 1;
      }
      tokens.push({ kind: 'number', value: source.slice(start, index), start });
      continue;
    }
    if (char === "'" || char === '"') {
      const start = index;
      index += 1;
      let value = '';
      let closed = false;
      while (index < source.length) {
        const current = source[index] ?? '';
        if (current === '\\') {
          const escape = source[index + 1];
          const mapped = escape !== undefined ? SIMPLE_ESCAPES[escape] : undefined;
          if (mapped === undefined) throw new FormulaParseError(`Unknown escape sequence "\\${escape ?? ''}".`, index);
          value += mapped;
          index += 2;
          continue;
        }
        if (current === char) {
          closed = true;
          index += 1;
          break;
        }
        value += current;
        index += 1;
      }
      if (!closed) throw new FormulaParseError('Unterminated string literal.', start);
      if (value.length > limits.maxStringLength) throw new FormulaLimitError('String literal is too long.', start);
      tokens.push({ kind: 'string', value, start });
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const start = index;
      while (index < source.length && /[A-Za-z0-9_]/.test(source[index] ?? '')) index += 1;
      tokens.push({ kind: 'identifier', value: source.slice(start, index), start });
      continue;
    }
    const two = source.slice(index, index + 2);
    if (OPERATORS.includes(two)) {
      tokens.push({ kind: 'operator', value: two, start: index });
      index += 2;
      continue;
    }
    if (OPERATORS.includes(char) || char === '!') {
      tokens.push({ kind: 'operator', value: char, start: index });
      index += 1;
      continue;
    }
    if (char === '=') throw new FormulaParseError('Assignment is not allowed in formulas.', index);
    if (char === '&' || char === '|') throw new FormulaParseError('Use "&&" and "||" for logical operators.', index);
    if (PUNCTUATION.includes(char)) {
      tokens.push({ kind: 'punct', value: char, start: index });
      index += 1;
      continue;
    }
    throw new FormulaParseError(`Unexpected character "${char}".`, index);
  }
  tokens.push({ kind: 'eof', value: '', start: source.length });
  return tokens;
}

export interface ParsedFormula {
  readonly source: string;
  readonly ast: AstNode;
  readonly nodeCount: number;
}

class Parser {
  private cursor = 0;
  private nodes = 0;
  private depth = 0;

  constructor(private readonly source: string, private readonly tokens: Token[], private readonly limits: FormulaLimits) {}

  parse(): ParsedFormula {
    const ast = this.parseExpression();
    const rest = this.peek();
    if (rest.kind !== 'eof') throw new FormulaParseError(`Unexpected "${rest.value || rest.kind}".`, rest.start);
    return { source: this.source, ast, nodeCount: this.nodes };
  }

  private peek(offset = 0): Token {
    return this.tokens[this.cursor + offset] ?? { kind: 'eof', value: '', start: this.source.length };
  }

  private next(): Token {
    const token = this.peek();
    this.cursor += 1;
    return token;
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  private expectPunct(value: string): Token {
    if (!this.isPunct(value)) {
      const token = this.peek();
      throw new FormulaParseError(`Expected "${value}" but found "${token.value || token.kind}".`, token.start);
    }
    return this.next();
  }

  private enter(): void {
    this.depth += 1;
    if (this.depth > this.limits.maxDepth) throw new FormulaLimitError('Formula nesting is too deep.');
  }

  private leave(): void {
    this.depth -= 1;
  }

  private node(node: AstNode): AstNode {
    this.nodes += 1;
    if (this.nodes > this.limits.maxNodes) throw new FormulaLimitError('Formula is too complex.');
    return node;
  }

  private parseExpression(): AstNode {
    return this.parseConditional();
  }

  private parseConditional(): AstNode {
    this.enter();
    try {
      const test = this.parseBinary(0);
      if (!this.isPunct('?')) return test;
      this.next();
      const consequent = this.parseExpression();
      this.expectPunct(':');
      const alternate = this.parseConditional();
      return this.node({ kind: 'conditional', test, consequent, alternate });
    } finally {
      this.leave();
    }
  }

  /** `||` binds loosest, then `&&`, equality, comparison, additive, multiplicative. */
  private parseBinary(level: number): AstNode {
    return this.parsePrecedence(level);
  }

  private parsePrecedence(level: number): AstNode {
    const levels: readonly string[][] = [
      ['||'],
      ['&&'],
      ['==', '!='],
      ['<', '<=', '>', '>='],
      ['+', '-'],
      ['*', '/', '%'],
    ];
    this.enter();
    try {
      let left = level + 1 >= levels.length ? this.parseUnary() : this.parsePrecedence(level + 1);
      while (true) {
        const token = this.peek();
        const matched = token.kind === 'operator' && levels[level]?.includes(token.value);
        if (!matched) return left;
        this.next();
        const right = level + 1 >= levels.length ? this.parseUnary() : this.parsePrecedence(level + 1);
        if (token.value === '&&' || token.value === '||') {
          left = this.node({ kind: 'logical', operator: token.value as LogicalOperator, left, right });
        } else {
          left = this.node({ kind: 'binary', operator: token.value as BinaryOperator, left, right });
        }
      }
    } finally {
      this.leave();
    }
  }

  private parseUnary(): AstNode {
    const token = this.peek();
    if (token.kind === 'operator' && (token.value === '-' || token.value === '+' || token.value === '!')) {
      this.next();
      const operand = this.parseUnary();
      return this.node({ kind: 'unary', operator: token.value as UnaryOperator, operand });
    }
    return this.parsePostfix();
  }

  private parsePostfix(): AstNode {
    let node = this.parsePrimary();
    while (true) {
      if (this.isPunct('.')) {
        this.next();
        const token = this.peek();
        if (token.kind !== 'identifier') throw new FormulaParseError('Expected a property name after ".".', token.start);
        if (BANNED_PROPERTIES.has(token.value)) throw new FormulaParseError(`Property "${token.value}" is not accessible.`, token.start);
        this.next();
        node = this.node({ kind: 'member', object: node, property: token.value });
        continue;
      }
      if (this.isPunct('[')) {
        this.next();
        const index = this.parseExpression();
        this.expectPunct(']');
        node = this.node({ kind: 'index', object: node, index });
        continue;
      }
      return node;
    }
  }

  private parsePrimary(): AstNode {
    const token = this.next();
    if (token.kind === 'number') {
      const value = Number(token.value);
      if (!Number.isFinite(value)) throw new FormulaParseError(`Invalid number "${token.value}".`, token.start);
      return this.node({ kind: 'literal', value });
    }
    if (token.kind === 'string') return this.node({ kind: 'literal', value: token.value });
    if (token.kind === 'identifier') {
      if (token.value === 'true') return this.node({ kind: 'literal', value: true });
      if (token.value === 'false') return this.node({ kind: 'literal', value: false });
      if (token.value === 'null') return this.node({ kind: 'literal', value: null });
      if (BANNED_PROPERTIES.has(token.value)) throw new FormulaParseError(`Identifier "${token.value}" is not accessible.`, token.start);
      if (this.isPunct('(')) {
        this.next();
        const args: AstNode[] = [];
        if (!this.isPunct(')')) {
          while (true) {
            args.push(this.parseExpression());
            if (this.isPunct(',')) {
              this.next();
              continue;
            }
            break;
          }
        }
        this.expectPunct(')');
        if (args.length > this.limits.maxCallArgs) throw new FormulaLimitError(`"${token.value}" takes too many arguments.`, token.start);
        return this.node({ kind: 'call', name: token.value, args });
      }
      return this.node({ kind: 'identifier', name: token.value });
    }
    if (token.kind === 'punct' && token.value === '(') {
      this.enter();
      try {
        const inner = this.parseExpression();
        this.expectPunct(')');
        return inner;
      } finally {
        this.leave();
      }
    }
    if (token.kind === 'punct' && token.value === '[') {
      this.enter();
      try {
        const elements: AstNode[] = [];
        if (!this.isPunct(']')) {
          while (true) {
            elements.push(this.parseExpression());
            if (this.isPunct(',')) {
              this.next();
              continue;
            }
            break;
          }
        }
        this.expectPunct(']');
        if (elements.length > this.limits.maxArrayLength) throw new FormulaLimitError('Array literal is too long.', token.start);
        return this.node({ kind: 'array', elements });
      } finally {
        this.leave();
      }
    }
    if (token.kind === 'punct' && token.value === '-') {
      const operand = this.parsePostfix();
      return this.node({ kind: 'unary', operator: '-', operand });
    }
    throw new FormulaParseError(`Unexpected ${token.kind === 'eof' ? 'end of formula' : `"${token.value}"`}.`, token.start);
  }
}

export function parseFormula(source: string, limits: FormulaLimits): ParsedFormula {
  const text = source.trim();
  if (text === '') throw new FormulaParseError('Formula is empty.');
  if (text.length > limits.maxSourceLength) throw new FormulaLimitError(`Formula is longer than ${limits.maxSourceLength} characters.`);
  const tokens = tokenize(text, limits);
  return new Parser(text, tokens, limits).parse();
}

export function literalValueOf(node: AstNode): LiteralValue | undefined {
  return node.kind === 'literal' ? node.value : undefined;
}
