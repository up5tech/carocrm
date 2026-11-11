import { describe, expect, it } from 'vitest';

import { oidcStartUrl, readOidcCallbackParams, stripOidcCallbackParams } from './login-oidc.js';

/**
 * Phase 23.3 (PLAN §17.3): the sign-in screen's external-identity part.
 *
 * These are the pieces that decide what the browser does — where it goes to start a sign-in, and
 * what it keeps of what the callback left in the address bar. They are pure, so they are asserted
 * here rather than through a DOM (the SPA's test project runs in the `node` environment).
 */
describe('the external sign-in on the sign-in screen', () => {
  it('sends the browser to the provider with the profile key', () => {
    expect(oidcStartUrl('google')).toBe('/api/v1/Oidc/start?profile=google');
  });

  it('encodes a profile key, so a key cannot smuggle another query parameter', () => {
    const url = oidcStartUrl('evil&next=https://attacker.test');
    expect(url).toBe('/api/v1/Oidc/start?profile=evil%26next%3Dhttps%3A%2F%2Fattacker.test');
    // The key is one parameter's value, and the URL carries exactly one parameter.
    expect(new URL(url, 'http://localhost').searchParams.get('profile')).toBe('evil&next=https://attacker.test');
    expect(Array.from(new URL(url, 'http://localhost').searchParams.keys())).toEqual(['profile']);
  });

  it('reads the challenge the callback left behind', () => {
    const params = new URLSearchParams('oidc_challenge=abc123');
    expect(readOidcCallbackParams(params).challenge).toBe('abc123');
    expect(readOidcCallbackParams(params).error).toBeNull();
  });

  it('reads the failure code the callback left behind', () => {
    const params = new URLSearchParams('oidc_error=refused');
    expect(readOidcCallbackParams(params).error).toBe('refused');
    expect(readOidcCallbackParams(params).challenge).toBeNull();
  });

  it('treats an empty value as no value', () => {
    const params = new URLSearchParams('oidc_challenge=&oidc_error=');
    expect(readOidcCallbackParams(params)).toEqual({ challenge: null, error: null });
  });

  it('drops the challenge id from the address bar, so it cannot survive a reload', () => {
    const params = new URLSearchParams('oidc_challenge=abc123&oidc_error=refused');
    expect(stripOidcCallbackParams(params)).toBe('');
  });

  it('keeps the parameters it does not own', () => {
    const params = new URLSearchParams('oidc_challenge=abc123&returnTo=%2Fhome');
    expect(stripOidcCallbackParams(params)).toBe('?returnTo=%2Fhome');
  });
});
