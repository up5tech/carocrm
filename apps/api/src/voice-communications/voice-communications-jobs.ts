/**
 * Phase 19-VC.5 — job names (`PLAN_Phase_19_Voice_Communications.md` §11.4, §15 `19-VC.5`).
 *
 * `JOB_NAME` allows 2–4 dot-separated alphanumeric segments, so `voiceCommunications.*` is valid and
 * matches the module's event namespace. The worker calls the API's processing endpoint with the
 * shared `x-worker-secret` capability; the job row is the durable record, Redis only carries it.
 */
export const VOICE_JOB_PROCESS_WEBHOOK = "voiceCommunications.processWebhookEvent";
export const VOICE_JOB_RETENTION_SWEEP = "voiceCommunications.retentionSweep";

/** How many processing attempts before a receipt is a dead letter an operator must inspect. */
export const WEBHOOK_MAX_ATTEMPTS = 3;
