import { describe, expect, it } from 'vitest';

import { ApiError } from '../api/client.js';
import { serverFieldErrors } from './serverFieldErrors.js';

/**
 * §14 tasks 2 and 4: a rejected save must say *which input* is wrong. The shape of the answer is the
 * API's (`{error:{code,message,details}}`, see `apps/api/src/common/global-exception.filter.ts`), the
 * shape the form needs is antd's, and this helper is the only place where the two are reconciled.
 *
 * Pure logic, so it runs in the node test project with no DOM and no database.
 */
const FIELDS = ['name', 'emailAddress', 'website', 'assignedUserId'];

describe('serverFieldErrors (§14 task 4)', () => {
  it('maps the Entity Engine answer, where the refused fields sit beside a reason', () => {
    const error = new ApiError(422, 'VALIDATION_FAILED', 'Validation failed.', {
      emailAddress: 'Value must be a valid email address.',
      reason: 'Record validation failed.',
    });
    expect(serverFieldErrors(error, FIELDS)).toEqual({ emailAddress: 'Value must be a valid email address.' });
  });

  it('maps a module that nests its field errors under `errors`', () => {
    const error = new ApiError(422, 'VALIDATION_FAILED', 'Validation failed.', {
      errors: { name: 'A name is required.', website: 'Include the scheme.' },
      reason: 'Document validation failed.',
    });
    expect(serverFieldErrors(error, FIELDS)).toEqual({
      name: 'A name is required.',
      website: 'Include the scheme.',
    });
  });

  it('keeps the first source it found when both carry the same field', () => {
    const error = new ApiError(400, 'BAD_REQUEST', 'Bad request.', {
      errors: { name: 'Nested wording.' },
      name: 'Top-level wording.',
    });
    expect(serverFieldErrors(error, FIELDS)).toEqual({ name: 'Nested wording.' });
  });

  it('ignores anything that is not a field on this form', () => {
    const error = new ApiError(422, 'VALIDATION_FAILED', 'Validation failed.', {
      reason: 'Record validation failed.',
      field: 'ghost',
      secretValue: 'a value that is not a field',
      counts: { total: 3 },
      website: '',
    });
    expect(serverFieldErrors(error, FIELDS)).toEqual({});
  });

  it('reads nothing in a server failure or a refusal that is not about the form', () => {
    expect(serverFieldErrors(new ApiError(500, 'INTERNAL_ERROR', 'Internal server error.'), FIELDS)).toEqual({});
    expect(
      serverFieldErrors(new ApiError(403, 'AUTHORIZATION_DENIED', 'You do not have permission.', { field: 'name' }), FIELDS),
    ).toEqual({});
    // A 403 is not a field problem, and putting "name: forbidden" under an input would teach the user
    // that their typing is at fault when it is their rights that are.
    // A concurrency conflict is a decision the user has to make, not a field that is wrong.
    expect(
      serverFieldErrors(new ApiError(409, 'CONCURRENCY_CONFLICT', 'The record changed.', { name: 'stale' }), FIELDS),
    ).toEqual({});
  });

  it('says nothing at all for an error that is not the API’s', () => {
    expect(serverFieldErrors(new Error('network'), FIELDS)).toEqual({});
    expect(serverFieldErrors(undefined, FIELDS)).toEqual({});
  });
});
