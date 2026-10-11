import { AuthorizationDeniedError, ValidationError } from '@carocrm/core/errors/index.js';
import type { FormulaValidationResult } from '@carocrm/formula/engine/index.js';
import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import { FormulaService } from './formula.service.js';

/**
 * Formula tools API (PLAN §22). Admin-only: `validate` checks an expression against the sandbox
 * without running it, `evaluate` runs it against a caller-supplied attribute object so an admin can
 * debug a rule before storing it in metadata.
 *
 * Mounted on the static `Formula` prefix, so it must be registered before the generic record
 * controller, exactly like `Metadata`.
 */
@Controller('api/v1/Formula')
export class FormulaController {
  constructor(
    @Inject(FormulaService) private readonly formulas: FormulaService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  @HttpCode(200)
  @Post('validate')
  validate(@Body() body: unknown): FormulaValidationResult {
    this.requireAdmin();
    return this.formulas.engine.validate(expressionOf(body));
  }

  @HttpCode(200)
  @Post('evaluate')
  evaluate(@Body() body: unknown): { value: unknown } | { error: string } {
    this.requireAdmin();
    const request = asRecord(body);
    const expression = expressionOf(request);
    const attrs = isRecord(request['attrs']) ? (request['attrs'] as Record<string, unknown>) : {};
    try {
      const value = this.formulas.engine.evaluate(expression, {
        record: attrs,
        now: new Date(),
        ...(typeof request['timezone'] === 'string' ? { timezone: request['timezone'] } : {}),
      });
      return { value };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Formula failed.' };
    }
  }

  private requireAdmin(): void {
    if (!this.scope.isAdmin) {
      throw new AuthorizationDeniedError('Administrator access is required to run the formula tools.');
    }
  }
}

function expressionOf(body: unknown): string {
  const expression = asRecord(body)['expression'];
  if (typeof expression !== 'string' || expression.trim() === '') {
    throw new ValidationError('Request body must carry an "expression" string.');
  }
  return expression;
}

function asRecord(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) throw new ValidationError('Request body must be a JSON object.');
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
