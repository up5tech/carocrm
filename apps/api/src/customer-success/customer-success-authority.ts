import type { AuthenticatedPrincipal, RequestScope } from "../common/request-scope.js";

/**
 * Phase 19-CS.11 — the documented service-authority model for background work
 * (PLAN_Phase_19_Customer_Success.md §11.1, §9.2).
 *
 * A scheduled job has no user session, and PLAN §11.1 is explicit that system jobs "use the
 * documented service-authority model, not a user context". The platform's own capability is the
 * built-in `sysAdmin` role (`acl-api.service.ts` treats it as an administrator), so a worker-triggered
 * recalculation runs under a `system` principal holding exactly that role — full read/write on the
 * module's own entities, with audit rows still attributed to a recognisable actor.
 */

export const SYSTEM_PRINCIPAL: AuthenticatedPrincipal = {
  userId: "system",
  userName: "system",
  userType: "system",
  roles: ["sysAdmin"],
  teams: [],
};

/** Run `work` as the service principal, with a request id that identifies the calling job. */
export function runAsSystem<T>(scope: RequestScope, requestId: string, work: () => Promise<T>): Promise<T> {
  return scope.runAs(SYSTEM_PRINCIPAL, work, `customerSuccess:${requestId}`);
}
