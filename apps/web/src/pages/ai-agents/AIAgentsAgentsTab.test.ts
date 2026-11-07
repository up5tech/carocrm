import { describe, expect, it } from 'vitest';

import { ApiError } from '../../api/client.js';
import { errorText } from './AIAgentsAgentsTab.js';

/**
 * The API answers a refusal with a localized category as `message` ("Validation failed.") and the
 * explanation in `details` (`reason` + `issues`). `errorText` is what the Agents tab shows instead
 * of the bare category, so a publish/save refusal names the field or check that blocked it.
 */
describe('errorText (AI agents tab)', () => {
  it('prefers the server reason over the generic category', () => {
    const error = new ApiError(422, 'VALIDATION_FAILED', 'Validation failed.', {
      reason: 'The agent cannot be published while its validation report has blocking findings.',
    });
    expect(errorText(error)).toBe('The agent cannot be published while its validation report has blocking findings.');
  });

  it('renders object issues as "path: message" after the reason', () => {
    const error = new ApiError(422, 'VALIDATION_FAILED', 'Validation failed.', {
      reason: 'The agent cannot be published while its validation report has blocking findings.',
      issues: [
        { code: 'provider-unavailable', path: 'provider', message: 'The provider is unavailable.', blocking: true },
        { code: 'model-not-allowed', path: 'provider.model', message: 'Model "gpt-4o-mini" is not on the connection\'s allowlist.', blocking: true },
      ],
    });
    expect(errorText(error)).toBe(
      [
        'The agent cannot be published while its validation report has blocking findings.',
        'provider: The provider is unavailable.',
        'provider.model: Model "gpt-4o-mini" is not on the connection\'s allowlist.',
      ].join('\n'),
    );
  });

  it('renders string issues (controller parse answers) as-is', () => {
    const error = new ApiError(400, 'INVALID_QUERY', 'The request is not valid.', {
      issues: ['config.provider.key: Required', 'name: String must contain at least 1 character(s)'],
    });
    expect(errorText(error)).toBe('config.provider.key: Required\nname: String must contain at least 1 character(s)');
  });

  it('falls back to the category message when details carry nothing usable', () => {
    expect(errorText(new ApiError(422, 'VALIDATION_FAILED', 'Validation failed.'))).toBe('Validation failed.');
    expect(errorText(new Error('boom'))).toBe('boom');
    expect(errorText('plain')).toBe('plain');
  });
});
