import type { AuthenticatedPrincipal, RequestScope } from '../common/request-scope.js';

/**
 * Phase 19-INT.5 — the documented service-authority model for the module's background work
 * (`PLAN_Phase_19_Advanced_Integrations.md` §7.2).
 *
 * Two paths in this module have **no human session**:
 *
 *  - the OAuth callback, which the provider redirects the administrator's browser to;
 *  - the credential refresh, which a background job performs.
 *
 * Both run under the platform's built-in `sysAdmin` capability, attributed to a recognisable
 * system actor — the same model Voice & Communications uses for its webhook processor
 * (`apps/api/src/voice-communications/voice-communications-authority.ts`).
 *
 * The authority is deliberately narrow. It exists so that the work is **attributable** and so that
 * the platform's own authorization engine is not bypassed by a special case; it is not permission
 * to read or mutate an arbitrary CRM record. The callback's real defences are elsewhere: the
 * single-use state, the connection binding and the ownership check.
 */

export const ADVANCED_INTEGRATIONS_SYSTEM_PRINCIPAL: AuthenticatedPrincipal = {
  userId: 'system',
  userName: 'system',
  userType: 'system',
  roles: ['sysAdmin'],
  teams: [],
};

export function runAsAdvancedIntegrationsSystem<T>(
  scope: RequestScope,
  requestId: string,
  work: () => Promise<T>,
): Promise<T> {
  return scope.runAs(ADVANCED_INTEGRATIONS_SYSTEM_PRINCIPAL, work, `advancedIntegrations:${requestId}`);
}
