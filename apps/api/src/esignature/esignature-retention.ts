import type { ESignatureSettings } from './esignature-settings.service.js';

/**
 * Phase 19-ES.2 — retention and data-minimization rules
 * (`PLAN_Phase_19_ESignature.md` §6.3, §6.5, §12.1; `19-ES.2` task "define retention/data-minimization
 * behavior and soft-delete rules").
 *
 * The rule the plan is emphatic about is a tension, and this file resolves it in one direction only:
 * **a contract's evidence outlives its telemetry.** What may be thrown away is the bulk — raw webhook
 * bodies, event payloads kept for debugging. What may not be thrown away by a default is the proof:
 * the normalized event history, the lifecycle audit, the signed documents and the completion
 * certificate. Deleting the evidence of a signed contract is a decision someone makes on purpose,
 * with the legal owner in the room (plan §12.1) — it is never what a `NULL` means.
 *
 * So every date computed here is *either* a purge deadline on the noisy column *or* `null`, and `null`
 * always means "kept". No function here returns a date for an evidence row, and the repository
 * refuses to write one.
 *
 * The deletion itself is a later phase's job (`ESignature.CleanupExpiredTemporaryArtifacts`, plan
 * §16): ES.2 stamps the deadlines so that job has something honest to read, and the retention policy
 * is reported by the health endpoint so an operator can see what this installation has chosen.
 */

/** The retention classes a snapshot or artifact row carries (plan §6.3). */
export const RETENTION_CLASSES = ['transient', 'business', 'evidence'] as const;
export type ESignatureRetentionClass = (typeof RETENTION_CLASSES)[number];

/** Which stored things the policy speaks about. */
export const RETENTION_SUBJECTS = [
  'webhookInboxPayload',
  'providerEventPayload',
  'signedDocument',
  'completionEvidence',
  'eventHistory',
  'auditTrail',
] as const;
export type ESignatureRetentionSubject = (typeof RETENTION_SUBJECTS)[number];

export interface RetentionDecision {
  readonly subject: ESignatureRetentionSubject;
  /** The deadline, or `null` when the row is kept indefinitely. */
  readonly purgeAfter: string | null;
  /** Why, in one line, for the admin screen and the runbook. */
  readonly reason: string;
  /** Whether an operator can change it through the settings document. */
  readonly configurable: boolean;
}

/**
 * A day count from the settings document, turned into a deadline.
 *
 * `0` and a negative value are **not** "delete immediately": for the payload columns the plan's
 * wording is "no automatic deletion", and for the artifacts it is explicitly the no-retention choice
 * (plan §12.1). Callers that want immediate minimization pass `days` and get a date, never `null`, by
 * choosing a positive number.
 */
function deadline(days: number, from: Date): string | null {
  if (!Number.isInteger(days) || days <= 0) return null;
  const after = new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
  return after.toISOString();
}

/**
 * What the settings as they stand decide about each subject.
 *
 * `eventHistory` and `auditTrail` are listed so the report is honest about what is *not* on a timer:
 * a reviewer asking "how long do we keep the proof?" gets an answer from the same screen that shows
 * the webhook retention.
 */
export function retentionPolicy(settings: ESignatureSettings, from: Date = new Date()): readonly RetentionDecision[] {
  const payloadDays = settings.retention.webhookPayloadDays;
  const artifactDays = settings.retention.completedArtifactDays;
  return [
    {
      subject: 'webhookInboxPayload',
      purgeAfter: deadline(payloadDays, from),
      reason:
        payloadDays > 0
          ? `The minimized webhook body is kept for ${String(payloadDays)} day(s); the dedup key and the verification result are kept.`
          : 'The minimized webhook body is kept until an operator decides otherwise.',
      configurable: true,
    },
    {
      subject: 'providerEventPayload',
      purgeAfter: deadline(payloadDays, from),
      reason:
        payloadDays > 0
          ? `An event's minimized payload is trimmed after ${String(payloadDays)} day(s); the event itself remains as history.`
          : 'An event payload is trimmed only when an operator decides so; the event remains as history.',
      configurable: true,
    },
    {
      subject: 'signedDocument',
      purgeAfter: deadline(artifactDays, from),
      reason:
        artifactDays > 0
          ? `Signed documents are purged after ${String(artifactDays)} day(s). Confirm this with the contract-retention owner.`
          : 'Signed documents are never purged automatically.',
      configurable: true,
    },
    {
      subject: 'completionEvidence',
      // Plan §12.1: the completion certificate is the evidence a signature happened. The settings
      // document's artifact retention is about the signed PDF, and the certificate stays regardless.
      purgeAfter: null,
      reason: 'The completion certificate is evidence and is never purged by the retention setting.',
      configurable: false,
    },
    {
      subject: 'eventHistory',
      purgeAfter: null,
      reason: 'The normalized provider event history is append-only evidence; it is not on a timer.',
      configurable: false,
    },
    {
      subject: 'auditTrail',
      purgeAfter: null,
      reason: 'The lifecycle audit trail is append-only evidence; it is not on a timer.',
      configurable: false,
    },
  ];
}

/** The deadline to stamp on a new row of this kind, or `null` to keep it. */
export function purgeAfterFor(
  subject: 'webhookInboxPayload' | 'providerEventPayload',
  settings: ESignatureSettings,
  from: Date = new Date(),
): Date | null {
  const days = settings.retention.webhookPayloadDays;
  if (!Number.isInteger(days) || days <= 0) return null;
  void subject;
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * The artifact row's class and deadline.
 *
 * `completion_evidence` is forced to `evidence` with no deadline even if a caller asks otherwise,
 * because the plan's §12.1 warning is specifically about dropping completion proof.
 */
export function artifactRetentionFor(
  artifactKind: 'source_snapshot' | 'provider_signed_document' | 'completion_evidence' | 'supporting_document',
  settings: ESignatureSettings,
  from: Date = new Date(),
): { readonly retentionClass: ESignatureRetentionClass; readonly purgeAfter: Date | null } {
  if (artifactKind === 'completion_evidence') return { retentionClass: 'evidence', purgeAfter: null };
  if (artifactKind === 'provider_signed_document') {
    const days = settings.retention.completedArtifactDays;
    return {
      retentionClass: 'evidence',
      purgeAfter: Number.isInteger(days) && days > 0 ? new Date(from.getTime() + days * 24 * 60 * 60 * 1000) : null,
    };
  }
  if (artifactKind === 'source_snapshot') return { retentionClass: 'business', purgeAfter: null };
  return { retentionClass: 'transient', purgeAfter: null };
}

/**
 * What a soft delete means for each table (plan §21.12: disable without deleting history).
 *
 * Nothing here is hard-deleted by application code. The distinction matters for the later phases:
 * an operator disconnecting a connection, or a user deleting a draft, sets `deleted_at` and the row
 * keeps answering "who was asked to sign, and what did they do".
 */
export const SOFT_DELETE_RULES = {
  esignature_connections: 'soft',
  signature_requests: 'soft',
  signature_recipients: 'soft',
  signature_document_snapshots: 'soft',
  signature_provider_events: 'append_only',
  signature_webhook_inbox: 'append_only',
  signature_template_mappings: 'soft',
  signature_audit_entries: 'append_only',
} as const;

export type ESignatureTableDiscipline = (typeof SOFT_DELETE_RULES)[keyof typeof SOFT_DELETE_RULES];

/** Whether a row may be removed at all by application code. */
export function isAppendOnly(table: keyof typeof SOFT_DELETE_RULES): boolean {
  return SOFT_DELETE_RULES[table] === 'append_only';
}
