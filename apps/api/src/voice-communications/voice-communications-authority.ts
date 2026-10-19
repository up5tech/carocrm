import type { AuthenticatedPrincipal, RequestScope } from "../common/request-scope.js";

/**
 * Phase 19-VC.5 — the documented service-authority model for module internals
 * (`PLAN_Phase_19_Voice_Communications.md` §9.2, §13.3).
 *
 * §9.2 is explicit: background work acts under an explicit service identity, never an expired human
 * session and never a silent all-powerful bypass. The webhook processor is the first such worker: it
 * has no logged-in principal, so it runs under the platform's built-in `sysAdmin` capability,
 * attributed to a recognisable system actor, exactly as Marketing Automation's provider webhook does.
 *
 * It is deliberately narrow: it exists so structural writes and the domain event a callback produces
 * are attributable, not so a callback can read or mutate an arbitrary CRM record. The processor never
 * touches `entity_records`; call/message materialization (19-VC.7/19-VC.10) must still pass the
 * acting user's ACL or the documented service scope.
 */

export const VOICE_SYSTEM_PRINCIPAL: AuthenticatedPrincipal = {
  userId: "system",
  userName: "system",
  userType: "system",
  roles: ["sysAdmin"],
  teams: [],
};

export function runAsVoiceSystem<T>(scope: RequestScope, requestId: string, work: () => Promise<T>): Promise<T> {
  return scope.runAs(VOICE_SYSTEM_PRINCIPAL, work, `voiceCommunications:${requestId}`);
}
