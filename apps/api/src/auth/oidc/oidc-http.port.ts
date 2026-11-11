/**
 * Phase 23.3 (PLAN §17.3) — the outbound HTTP the identity service needs, behind a port.
 *
 * The identity service never calls `fetch` directly. It talks to this port, so a test can supply a
 * fake provider (PLAN: "Use a fake OIDC provider in tests") without a live token endpoint, and the
 * URL policy lives in exactly one place.
 */

import { ValidationError } from '@carocrm/core/errors/index.js';

import { assertOidcEndpointUrl } from './oidc-profile.js';

export interface OidcHttpResponse {
  readonly status: number;
  readonly json: unknown;
}

export interface OidcHttpPort {
  /** POST an `application/x-www-form-urlencoded` body (the token endpoint). */
  postForm(url: string, form: Readonly<Record<string, string>>): Promise<OidcHttpResponse>;
  /** GET a JSON document (the JWKS). */
  getJson(url: string): Promise<OidcHttpResponse>;
}

export const OIDC_HTTP_PORT = Symbol('OIDC_HTTP_PORT');

/** The default implementation: `fetch`, with the endpoint policy applied on every call. */
export class FetchOidcHttp implements OidcHttpPort {
  constructor(private readonly timeoutMs = 10_000) {}

  async postForm(url: string, form: Readonly<Record<string, string>>): Promise<OidcHttpResponse> {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(form)) body.set(key, value);
    return this.send(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
    });
  }

  async getJson(url: string): Promise<OidcHttpResponse> {
    return this.send(url, { method: 'GET', headers: { accept: 'application/json' } });
  }

  private async send(url: string, init: RequestInit): Promise<OidcHttpResponse> {
    assertOidcEndpointUrl(url, 'endpoint');
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error' });
    } catch {
      // The provider's answer never reaches the caller: a network failure is a failed sign-in.
      throw new ValidationError('The identity provider could not be reached.');
    }
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    return { status: response.status, json };
  }
}
