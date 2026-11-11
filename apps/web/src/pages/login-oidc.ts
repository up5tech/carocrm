/**
 * Phase 23.3 (PLAN §17.3): the small, pure parts of the external sign-in on the sign-in screen.
 *
 * They live here rather than inside the component so they can be asserted without a DOM — the SPA's
 * test project runs in the `node` environment (see `vitest.web.config.ts`).
 */

/** The URL that sends the browser to the provider. The provider answers with a redirect. */
export function oidcStartUrl(profileKey: string): string {
  return `/api/v1/Oidc/start?profile=${encodeURIComponent(profileKey)}`;
}

/** What the platform's own callback left in the address bar. */
export interface OidcCallbackParams {
  /** A single-use challenge id — the account still has a second factor. */
  readonly challenge: string | null;
  /** A stable code, never the provider's own text. */
  readonly error: string | null;
}

/** Read the callback's parameters. An empty value is the same as no value. */
export function readOidcCallbackParams(params: URLSearchParams): OidcCallbackParams {
  const challenge = params.get('oidc_challenge');
  const error = params.get('oidc_error');
  return {
    challenge: challenge === null || challenge === '' ? null : challenge,
    error: error === null || error === '' ? null : error,
  };
}

/**
 * The query string the address bar is left with.
 *
 * The challenge id is a single-use credential and the error code is noise once it has been shown,
 * so both are removed: neither may survive a reload or leak through the browser's history or a
 * shared link.
 */
export function stripOidcCallbackParams(params: URLSearchParams): string {
  const next = new URLSearchParams(params);
  next.delete('oidc_challenge');
  next.delete('oidc_error');
  const query = next.toString();
  return query === '' ? '' : `?${query}`;
}
