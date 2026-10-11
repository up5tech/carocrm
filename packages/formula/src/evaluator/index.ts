import type { AstNode } from '../ast/index.js';
import { FormulaEvaluationError, FormulaLimitError } from '../errors/index.js';
import type { EvaluationContext, FunctionRegistry } from '../functions/index.js';
import type { FormulaLimits } from '../limits/index.js';
import type { FormulaValue } from '../value/index.js';
import { compareValues, describeValue, isFormulaRecord, toBool, toNumber, toStringValue, valuesEqual } from '../value/index.js';

const BANNED_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Tree-walking interpreter. It can only read the values handed to it in the context and call
 * registered functions — there is no property chain that reaches a host object, no `new`, no
 * dynamic import and no statement that can loop forever (PLAN §22.1).
 */
export class Evaluator {
  private steps = 0;

  constructor(private readonly registry: FunctionRegistry, private readonly limits: FormulaLimits) {}

  evaluate(node: AstNode, context: EvaluationContext): FormulaValue {
    this.steps = 0;
    return this.visit(node, context);
  }

  private visit(node: AstNode, context: EvaluationContext): FormulaValue {
    this.steps += 1;
    if (this.steps > this.limits.maxSteps) throw new FormulaLimitError('Formula exceeded its evaluation budget.');
    switch (node.kind) {
      case 'literal':
        return node.value;
      case 'identifier':
        throw new FormulaEvaluationError(`Unknown variable "${node.name}". Use field('name') to read a record attribute.`);
      case 'array': {
        const values = node.elements.map((element) => this.visit(element, context));
        if (values.length > context.limits.maxArrayLength) throw new FormulaLimitError('Array is too long.');
        return values;
      }
      case 'unary':
        return this.applyUnary(node.operator, this.visit(node.operand, context));
      case 'binary':
        return this.applyBinary(node.operator, this.visit(node.left, context), this.visit(node.right, context), context);
      case 'logical': {
        const left = this.visit(node.left, context);
        if (node.operator === '&&') return toBool(left) ? toBool(this.visit(node.right, context)) : false;
        return toBool(left) ? true : toBool(this.visit(node.right, context));
      }
      case 'conditional':
        return toBool(this.visit(node.test, context)) ? this.visit(node.consequent, context) : this.visit(node.alternate, context);
      case 'call':
        return this.applyCall(node.name, node.args, context);
      case 'member':
        return this.applyMember(this.visit(node.object, context), node.property);
      case 'index':
        return this.applyIndex(this.visit(node.object, context), this.visit(node.index, context));
    }
  }

  private applyUnary(operator: string, value: FormulaValue): FormulaValue {
    if (operator === '!') return !toBool(value);
    const numeric = toNumber(value);
    if (operator === '-') return -numeric;
    return numeric;
  }

  private applyBinary(operator: string, left: FormulaValue, right: FormulaValue, context: EvaluationContext): FormulaValue {
    switch (operator) {
      case '+': {
        if (typeof left === 'string' || typeof right === 'string') {
          const text = toStringValue(left) + toStringValue(right);
          if (text.length > context.limits.maxStringLength) throw new FormulaLimitError('Resulting string is too long.');
          return text;
        }
        const sum = toNumber(left) + toNumber(right);
        return requireFiniteResult(sum);
      }
      case '-':
        return requireFiniteResult(toNumber(left) - toNumber(right));
      case '*':
        return requireFiniteResult(toNumber(left) * toNumber(right));
      case '/': {
        const divisor = toNumber(right);
        if (divisor === 0) throw new FormulaEvaluationError('Division by zero.');
        return requireFiniteResult(toNumber(left) / divisor);
      }
      case '%': {
        const divisor = toNumber(right);
        if (divisor === 0) throw new FormulaEvaluationError('Division by zero.');
        return requireFiniteResult(toNumber(left) % divisor);
      }
      case '==':
        return valuesEqual(left, right);
      case '!=':
        return !valuesEqual(left, right);
      case '<':
        return compareValues(left, right) < 0;
      case '<=':
        return compareValues(left, right) <= 0;
      case '>':
        return compareValues(left, right) > 0;
      case '>=':
        return compareValues(left, right) >= 0;
      default:
        throw new FormulaEvaluationError(`Unsupported operator "${operator}".`);
    }
  }

  private applyCall(name: string, args: AstNode[], context: EvaluationContext): FormulaValue {
    const fn = this.registry.get(name);
    if (!fn) throw new FormulaEvaluationError(`Unknown function "${name}".`);
    if (args.length < fn.minArgs || args.length > fn.maxArgs) {
      throw new FormulaEvaluationError(`"${name}" expects ${fn.minArgs === fn.maxArgs ? String(fn.minArgs) : `${fn.minArgs}..${fn.maxArgs}`} arguments.`);
    }
    const values = args.map((arg) => this.visit(arg, context));
    return fn.apply(values, context);
  }

  private applyMember(object: FormulaValue, property: string): FormulaValue {
    if (BANNED_KEYS.has(property)) throw new FormulaEvaluationError(`Property "${property}" is not accessible.`);
    if (Array.isArray(object)) {
      if (property === 'length') return object.length;
      throw new FormulaEvaluationError('Only "length" is readable on an array.');
    }
    if (isFormulaRecord(object)) {
      if (!Object.prototype.hasOwnProperty.call(object, property)) return null;
      return object[property] ?? null;
    }
    throw new FormulaEvaluationError(`Cannot read "${property}" of ${describeValue(object)}.`);
  }

  private applyIndex(object: FormulaValue, index: FormulaValue): FormulaValue {
    if (Array.isArray(object)) {
      const position = toNumber(index);
      if (!Number.isInteger(position)) throw new FormulaEvaluationError('Array index must be an integer.');
      if (position < 0) return null;
      if (position > this.limits.maxArrayLength) throw new FormulaLimitError('Array index is out of range.');
      return object[position] ?? null;
    }
    if (isFormulaRecord(object)) {
      const key = toStringValue(index);
      if (BANNED_KEYS.has(key)) throw new FormulaEvaluationError(`Property "${key}" is not accessible.`);
      if (!Object.prototype.hasOwnProperty.call(object, key)) return null;
      return object[key] ?? null;
    }
    throw new FormulaEvaluationError(`Cannot index into ${describeValue(object)}.`);
  }
}

function requireFiniteResult(value: number): number {
  if (!Number.isFinite(value)) throw new FormulaEvaluationError('Formula produced a non-finite number.');
  return value;
}
