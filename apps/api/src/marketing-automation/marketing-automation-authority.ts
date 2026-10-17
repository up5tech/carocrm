import type { AuthenticatedPrincipal, RequestScope } from "../common/request-scope.js";
import { runAsMarketingInternal } from "./marketing-automation-internal.js";

/**
 * Phase 19-MA.3 — the documented service-authority model for Marketing Automation internals
 * (PLAN_Phase_19_Marketing_Automation.md §9.2, §7.2; AGENTS.md §5.5).
 *
 * §9.2 is explicit: "background jobs act under an explicit service identity and permission model; they must
 * not rely on an expired human session or silently become an all-powerful bypass". A campaign refresh, an
 * audience snapshot or a lifecycle stamp written by a job therefore runs under the platform's built-in
 * `sysAdmin` capability — the mechanism Service Desk and Customer Success use — attributed to a recognisable
 * system actor, and inside the caller's transaction.
 *
 * It is deliberately narrow. It never bypasses the *record's* ACL, because the command has already passed
 * that check; it exists so structural writes (history rows, derived stamps) are not refused to an actor who
 * legitimately triggered them, and so a scheduled job has an identity that survives a restarted worker
 * instead of a stale token.
 */

export const MARKETING_SYSTEM_PRINCIPAL: AuthenticatedPrincipal = {
  userId: "system",
  userName: "system",
  userType: "system",
  roles: ["sysAdmin"],
  teams: [],
};

/**
 * Run `work` as the Marketing Automation service principal, with a request id that names the caller.
 *
 * The write is also marked module-internal: a system-principal write is by definition a domain-service write,
 * so it must satisfy the same invariant the guard enforces. Without that, the history row a lifecycle command
 * appends inside its own transaction would be refused by the guard it is running under — one contract,
 * expressed once.
 */
export function runAsMarketingSystem<T>(
  scope: RequestScope,
  requestId: string,
  work: () => Promise<T>,
): Promise<T> {
  return runAsMarketingInternal(() => scope.runAs(MARKETING_SYSTEM_PRINCIPAL, work, `marketingAutomation:${requestId}`));
}
