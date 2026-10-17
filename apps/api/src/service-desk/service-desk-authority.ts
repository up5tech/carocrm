import type { AuthenticatedPrincipal, RequestScope } from "../common/request-scope.js";

/**
 * Phase 19-SD.4/SD.5 — the documented service-authority model for Service Desk internals
 * (PLAN_Phase_19_ServiceDesk.md §7.3, §10.1; AGENTS.md §5.5).
 *
 * Two writes are structural rather than user commands: a transition/assignment history row, and the
 * round-robin cursor on a queue. Neither is something a client may forge, and neither should be
 * denied to an agent who legitimately triggered the transition just because their role has no
 * "create history" grant. They run under the platform's built-in `sysAdmin` capability — the same
 * mechanism Customer Success uses — so the history rows are written inside the caller's transaction,
 * attributed to a recognisable system actor, and can never become a way to bypass the actor's own
 * ACL on the `Case` itself (that check has already passed).
 */

export const SERVICE_DESK_SYSTEM_PRINCIPAL: AuthenticatedPrincipal = {
  userId: "system",
  userName: "system",
  userType: "system",
  roles: ["sysAdmin"],
  teams: [],
};

/** Run `work` as the Service Desk service principal, with a request id that names the caller. */
export function runAsServiceDeskSystem<T>(
  scope: RequestScope,
  requestId: string,
  work: () => Promise<T>,
): Promise<T> {
  return scope.runAs(SERVICE_DESK_SYSTEM_PRINCIPAL, work, `serviceDesk:${requestId}`);
}
