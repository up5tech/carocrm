/** Errors raised by the formula sandbox (PLAN §22). Never carries source internals beyond a position. */
export class FormulaError extends Error {
  readonly code: string;
  readonly position?: number | undefined;

  constructor(code: string, message: string, position?: number | undefined) {
    super(message);
    this.name = 'FormulaError';
    this.code = code;
    if (position !== undefined) this.position = position;
  }
}

export class FormulaParseError extends FormulaError {
  constructor(message: string, position?: number | undefined) {
    super('FORMULA_PARSE_FAILED', message, position);
    this.name = 'FormulaParseError';
  }
}

export class FormulaLimitError extends FormulaError {
  constructor(message: string, position?: number | undefined) {
    super('FORMULA_LIMIT_EXCEEDED', message, position);
    this.name = 'FormulaLimitError';
  }
}

/** Unknown function/identifier, wrong argument count, or a value the sandbox refuses to expose. */
export class FormulaEvaluationError extends FormulaError {
  constructor(message: string, position?: number | undefined) {
    super('FORMULA_EVALUATION_FAILED', message, position);
    this.name = 'FormulaEvaluationError';
  }
}

export class FormulaDefinitionError extends FormulaError {
  constructor(message: string) {
    super('FORMULA_DEFINITION_INVALID', message);
    this.name = 'FormulaDefinitionError';
  }
}
