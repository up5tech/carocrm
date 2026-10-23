import type { Logger } from '@carocrm/core/logger/index.js';
import type { JobContext, JobHandler, JobRegistry } from '@carocrm/jobs';

/**
 * Phase 19-ES.11 / 19-ES.15 — ESignature's background work, registered in the worker composition root
 * (`PLAN_Phase_19_ESignature.md` §10.1, §16, §18).
 *
 * Like every other module handler, it does not touch the module's tables itself. Applying a provider
 * event and retrieving completed artifacts are domain operations that go through the state machine,
 * the audit trail and the file store — and the only place those are correct is the application layer.
 * The worker calls the API's worker-authorised endpoints with the shared capability.
 *
 * Both jobs are idempotent by construction: the webhook job carries the durable inbox id (already
 * unique), and the artifact job's retrieval dedupes on the provider document id and content hash.
 */
export const ESIGNATURE_JOB_NAMES = {
  processProviderWebhook: 'esignature.processProviderWebhook',
  retrieveCompletedArtifacts: 'esignature.retrieveCompletedArtifacts',
} as const;

export interface ESignatureJobDeps {
  readonly apiBaseUrl: string;
  /** The shared worker→API capability. Empty means the job is inert, not broken. */
  readonly secret: string;
  readonly log: Logger;
  /** Injectable for tests, so a job test never opens a socket. */
  readonly fetcher?: typeof fetch;
}

const PROCESS_WEBHOOK_PATH = '/api/v1/ESignature/action/process-provider-webhook';
const RETRIEVE_ARTIFACTS_PATH = '/api/v1/ESignature/action/retrieve-artifacts';

async function post(
  deps: ESignatureJobDeps,
  path: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; payload: Record<string, unknown> }> {
  const fetcher = deps.fetcher ?? fetch;
  const response = await fetcher(`${deps.apiBaseUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { 'x-worker-secret': deps.secret, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: response.ok, status: response.status, payload: body };
}

function processProviderWebhookJob(deps: ESignatureJobDeps): JobHandler {
  return async (context: JobContext) => {
    if (deps.secret.trim() === '') {
      return { status: 'completed', message: 'No worker capability is configured; the event was not processed.' };
    }
    if (await context.shouldStop()) return { status: 'cancelled', message: 'Cancelled before the API was called.' };
    context.progress(40, 'Applying the provider event');
    const result = await post(deps, PROCESS_WEBHOOK_PATH, { inboxId: context.data?.['inboxId'] });
    if (!result.ok) {
      deps.log.warn({ status: result.status }, 'signature webhook processing refused');
      return { status: 'failed', message: `The API refused the event (${String(result.status)}).` };
    }
    context.progress(100, 'Event applied');
    return { status: 'completed', message: 'The provider event was processed.', result: result.payload };
  };
}

function retrieveCompletedArtifactsJob(deps: ESignatureJobDeps): JobHandler {
  return async (context: JobContext) => {
    if (deps.secret.trim() === '') {
      return { status: 'completed', message: 'No worker capability is configured; artifacts were not retrieved.' };
    }
    if (await context.shouldStop()) return { status: 'cancelled', message: 'Cancelled before the API was called.' };
    context.progress(40, 'Retrieving completed documents');
    const result = await post(deps, RETRIEVE_ARTIFACTS_PATH, { requestId: context.data?.['requestId'] });
    if (!result.ok) {
      deps.log.warn({ status: result.status }, 'signature artifact retrieval refused');
      return { status: 'failed', message: `The API refused the retrieval (${String(result.status)}).` };
    }
    context.progress(100, 'Artifacts stored');
    return { status: 'completed', message: 'The completed documents were stored.', result: result.payload };
  };
}

export function registerESignatureJobs(registry: JobRegistry, deps: ESignatureJobDeps): void {
  registry.register(ESIGNATURE_JOB_NAMES.processProviderWebhook, processProviderWebhookJob(deps));
  registry.register(ESIGNATURE_JOB_NAMES.retrieveCompletedArtifacts, retrieveCompletedArtifactsJob(deps));
}
