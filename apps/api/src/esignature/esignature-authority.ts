import type { AuthenticatedPrincipal, RequestScope } from '../common/request-scope.js';

/**
 * Phase 19-ES.4 — the service authority for the paths with no human session
 * (`PLAN_Phase_19_ESignature.md` §8.1, §9.2; the model ADR 0003 establishes for Advanced
 * Integrations and Voice & Communications).
 *
 * Two ESignature paths run without a logged-in user:
 *
 *  - the DocuSign OAuth callback, which the provider redirects the administrator's browser to, so the
 *    route carries no session;
 *  - a token refresh from a background job, which has no user at all.
 *
 * Both run under the platform's built-in `sysAdmin` capability, attributed to a recognisable system
 * actor, so the work is **attributable** rather than performed by a bypass. That distinction matters
 * here more than anywhere else in this module: the callback writes a credential into the vault.
 *
 * The authority is deliberately narrow. It is not permission to read or mutate an arbitrary CRM
 * record; the callback's real defences are the single-use hashed state, the connection derived from
 * that state, and the environment binding — none of which depends on who the caller is.
 */

export const ESIGNATURE_SYSTEM_PRINCIPAL: AuthenticatedPrincipal = {
  userId: 'system',
  userName: 'system',
  userType: 'system',
  roles: ['sysAdmin'],
  teams: [],
};

export function runAsESignatureSystem<T>(scope: RequestScope, requestId: string, work: () => Promise<T>): Promise<T> {
  return scope.runAs(ESIGNATURE_SYSTEM_PRINCIPAL, work, `eSignature:${requestId}`);
}
