import type { Logger } from '@carocrm/core/logger/index.js';
import type { JobContext, JobHandler, JobRegistry } from '@carocrm/jobs';

/**
 * Phase 19-INT.5 — the Advanced Integrations module's scheduled work, registered in the worker
 * composition root (`PLAN_Phase_19_Advanced_Integrations.md` §7.2).
 *
 * Like `registerCustomerSuccessJobs`, a handler deliberately does **not** touch the module's tables
 * itself. Warning an operator that a credential expires is a domain operation: it reads the
 * settings, decides which credentials are near expiry, writes a notification and moves a
 * connection that has already expired into `reauthorization_required` — and the only place that
 * happens correctly is the application layer. So the job calls the API's worker-authorised endpoint
 * with the shared capability (`x-worker-secret`), and that endpoint runs exactly the operation an
 * administrator would.
 *
 * The sweep is idempotent by construction: a notification carries a deterministic id, so a retry
 * adds nothing, and a credential that is already expired is moved once.
 */

export const ADVANCED_INTEGRATIONS_JOB_NAMES = {
  notifyExpiringCredentials: 'advancedIntegrations.notifyExpiringCredentials',
} as const;

export interface AdvancedIntegrationsJobDeps {
  readonly apiBaseUrl: string;
  /** The shared worker→API capability. Empty means the job is inert, not broken. */
  readonly secret: string;
  readonly log: Logger;
  /** Injectable for tests, so a job test never opens a socket. */
  readonly fetcher?: typeof fetch;
}

/**
 * The endpoint the job calls. It mirrors the route declared in
 * `apps/api/src/advanced-integrations/advanced-integrations.controller.ts`.
 */
const NOTIFY_EXPIRING_CREDENTIALS_PATH = '/api/v1/AdvancedIntegrations/action/notify-expiring-credentials';

/** Internal signal: the run was cancelled before the API was called. Never escapes a handler. */
class CancelledBeforeCall extends Error {}

function notifyExpiringCredentialsJob(deps: AdvancedIntegrationsJobDeps): JobHandler {
  return async (context: JobContext) => {
    if (deps.secret.trim() === '') {
      return { status: 'completed', message: 'No worker capability is configured; the sweep did not run.' };
    }
    if (await context.shouldStop()) throw new CancelledBeforeCall();
    context.progress(20, 'Checking expiring credentials');
    const fetcher = deps.fetcher ?? fetch;
    const response = await fetcher(`${deps.apiBaseUrl.replace(/\/$/, '')}${NOTIFY_EXPIRING_CREDENTIALS_PATH}`, {
      method: 'POST',
      headers: { 'x-worker-secret': deps.secret, 'content-type': 'application/json' },
      body: '{}',
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      deps.log.warn({ status: response.status, detail }, 'expiring-credential sweep refused');
      return { status: 'failed', message: `The API refused the sweep (${String(response.status)}).` };
    }
    const payload = (await response.json().catch(() => ({}))) as {
      notified?: number;
      expired?: number;
      purgedStates?: number;
    };
    context.progress(100, 'Sweep complete');
    return {
      status: 'completed',
      message: `Notified ${String(payload.notified ?? 0)}, expired ${String(payload.expired ?? 0)}.`,
      result: {
        notified: payload.notified ?? 0,
        expired: payload.expired ?? 0,
        purgedStates: payload.purgedStates ?? 0,
      },
    };
  };
}

export function registerAdvancedIntegrationsJobs(registry: JobRegistry, deps: AdvancedIntegrationsJobDeps): void {
  registry.register(
    ADVANCED_INTEGRATIONS_JOB_NAMES.notifyExpiringCredentials,
    notifyExpiringCredentialsJob(deps),
  );
}
