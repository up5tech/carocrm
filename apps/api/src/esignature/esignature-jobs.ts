/**
 * The job names ESignature enqueues (plan §16, §18 `19-ES.11`/`19-ES.15`).
 *
 * Declared once so the API producer, the worker handler and the admin runbook cannot drift. The
 * prefix is the module key, lower-cased, and the names match the worker's `<module>.<action>` rule.
 */
export const ESIGNATURE_WEBHOOK_PROCESS_JOB = 'esignature.processProviderWebhook';
export const ESIGNATURE_ARTIFACT_JOB = 'esignature.retrieveCompletedArtifacts';
