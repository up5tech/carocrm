import type { AstNode } from '../ast/index.js';
import { countNodes, forEachNode } from '../ast/index.js';
import { FormulaError } from '../errors/index.js';
import { Evaluator } from '../evaluator/index.js';
import type { EvaluationContext, FormulaFunction, FunctionRegistry } from '../functions/index.js';
import { FunctionRegistry as FunctionRegistryClass, normalizeContextRecord } from '../functions/index.js';
import type { FormulaLimits } from '../limits/index.js';
import { resolveLimits } from '../limits/index.js';
import { parseFormula } from '../parser/index.js';
import type { FormulaValue } from '../value/index.js';
import { toBool } from '../value/index.js';

export interface FormulaContext {
  /** Attributes of the record the formula runs on; read through `field('name')`. */
  readonly record?: Readonly<Record<string, unknown>> | undefined;
  /** Frozen instant used by `now()`/`currentDate()` — inject a fixed clock in tests, jobs and API writes. */
  readonly now?: Date | undefined;
  /** IANA zone the context user works in; defaults to UTC. */
  readonly timezone?: string | undefined;
}

export interface FormulaEngineOptions {
  readonly limits?: Partial<FormulaLimits> | undefined;
  readonly functions?: Iterable<FormulaFunction> | undefined;
  readonly registry?: FunctionRegistry | undefined;
  readonly timezone?: string | undefined;
}

export interface FormulaValidationResult {
  valid: boolean;
  error?: string | undefined;
  position?: number | undefined;
  nodeCount?: number | undefined;
}

/** Parsed, budget-checked expression that can be evaluated repeatedly against different records. */
export class CompiledFormula {
  constructor(
    readonly source: string,
    readonly ast: AstNode,
    private readonly engine: FormulaEngine,
  ) {}

  get nodeCount(): number {
    return countNodes(this.ast);
  }

  evaluate(context: FormulaContext = {}): FormulaValue {
    return this.engine.evaluateAst(this.ast, context);
  }
}

/**
 * Sandboxed expression engine (PLAN §22). Source text is parsed into an AST and cached; only the
 * AST is ever executed, against an explicit function allowlist with node/step budgets and a
 * context-provided clock.
 */
export class FormulaEngine {
  readonly limits: FormulaLimits;
  readonly functions: FunctionRegistry;
  private readonly evaluator: Evaluator;
  private readonly defaultTimezone: string;
  private readonly cache = new Map<string, CompiledFormula>();

  constructor(options: FormulaEngineOptions = {}) {
    this.limits = resolveLimits(options.limits);
    this.functions = options.registry ?? new FunctionRegistryClass(options.functions ?? []);
    this.evaluator = new Evaluator(this.functions, this.limits);
    this.defaultTimezone = options.timezone ?? 'UTC';
  }

  /** Parse (and cache) without evaluating. Throws FormulaParseError/FormulaLimitError. */
  compile(source: string): CompiledFormula {
    const cached = this.cache.get(source);
    if (cached) return cached;
    const parsed = parseFormula(source, this.limits);
    const compiled = new CompiledFormula(parsed.source, parsed.ast, this);
    if (this.cache.size > 500) this.cache.clear();
    this.cache.set(source, compiled);
    return compiled;
  }

  evaluate(source: string, context: FormulaContext = {}): FormulaValue {
    return this.compile(source).evaluate(context);
  }

  evaluateAst(ast: AstNode, context: FormulaContext): FormulaValue {
    const evaluationContext: EvaluationContext = {
      record: normalizeContextRecord(context.record),
      nowMs: context.now?.getTime() ?? Date.now(),
      timeZone: context.timezone ?? this.defaultTimezone,
      limits: { maxStringLength: this.limits.maxStringLength, maxArrayLength: this.limits.maxArrayLength },
    };
    return this.evaluator.evaluate(ast, evaluationContext);
  }

  /** Non-throwing check used by the metadata API before a formula is stored. */
  validate(source: string): FormulaValidationResult {
    try {
      const parsed = parseFormula(source, this.limits);
      const problem = this.findUnknownReference(parsed.ast);
      if (problem) return { valid: false, error: problem };
      return { valid: true, nodeCount: parsed.nodeCount };
    } catch (error) {
      if (error instanceof FormulaError) {
        const result: FormulaValidationResult = { valid: false, error: error.message };
        if (error.position !== undefined) result.position = error.position;
        return result;
      }
      return { valid: false, error: 'Formula is not a valid expression.' };
    }
  }

  /** Calls must hit the allowlist and bare identifiers are always rejected — catch it at save time. */
  findUnknownReference(ast: AstNode): string | undefined {
    let found: string | undefined;
    forEachNode(ast, (node) => {
      if (found) return;
      if (node.kind === 'call' && !this.functions.has(node.name)) found = `Unknown function "${node.name}".`;
      if (node.kind === 'identifier') found = `Unknown variable "${node.name}". Use field('name') to read a record attribute.`;
    });
    return found;
  }

  /** Truthiness used by dynamic-logic conditions; callers catch evaluation errors and fail closed. */
  evaluateCondition(source: string, context: FormulaContext = {}): boolean {
    return toBool(this.evaluate(source, context));
  }
}
