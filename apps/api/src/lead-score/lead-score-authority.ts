import type { AuthenticatedPrincipal, RequestScope } from '../common/request-scope.js';

/**
 * Phase 19-LS.6 — the service authority for background score work
 * (`PLAN_Phase_19_LeadScore.md` §9.2, §10.2; audit §5.4).
 *
 * A queued job has no user session, and the platform's documented answer is the one Customer Success
 * established (`customer-success-authority.ts`): run the job under a `system` principal carrying the built-in
 * `sysAdmin` role rather than inventing a second authorization model for background work or sneaking past ACL
 * with a flag. That keeps every guarantee LS.5 already relies on true on the job path too — record scope,
 * field masking, validation, hooks, audit attribution to a recognisable actor, and the LS.2 write guard,
 * which is what separates "the engine may write these fields" from "anybody may".
 *
 * It also means a worker route is never a wider door than the admin route behind it: the principal is an
 * administrator, so a job can do what an administrator could ask for, and nothing more.
 */
export const LEADSCORE_SYSTEM_PRINCIPAL: AuthenticatedPrincipal = {
  userId: 'system',
  userName: 'system',
  userType: 'system',
  roles: ['sysAdmin'],
  teams: [],
};

/** Run `work` as the service principal, with a request id that identifies the calling job. */
export function runAsLeadScoreSystem<T>(scope: RequestScope, requestId: string, work: () => Promise<T>): Promise<T> {
  return scope.runAs(LEADSCORE_SYSTEM_PRINCIPAL, work, `leadScore:${requestId}`);
}
