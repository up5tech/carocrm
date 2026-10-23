/**
 * Phase 19-ES.1 — the `ESignature` domain vocabulary
 * (`PLAN_Phase_19_ESignature.md` §4.7, §6.1, §6.6, §12; `19-ES.1`).
 *
 * This file declares names, not behaviour: the ACL resources every route is evaluated against, the
 * normalized lifecycle the schema (ES.2) will persist, the secret kinds the vault (ES.4) will hold,
 * and the audit actions (ES.1 task list) the lifecycle services will append. A later sub-phase may
 * extend the vocabulary; nothing here may be renamed after envelopes exist, because a stored
 * `provider_status_raw` or a recorded event must keep its meaning.
 *
 * The identifiers carry **no `Ua` prefix** and never a vendor name: `ESignature`, `esignature`,
 * `ESignatureModule` (plan §0).
 */

import { SIGNATURE_PROVIDER_KEYS } from './providers/signature-provider.keys.js';

/** The module key as it appears in settings, events (`esignature.*`), jobs and i18n namespace text. */
export const ESIGNATURE_MODULE_KEY = 'ESignature';

/**
 * Synthetic ACL resources (plan §12).
 *
 * The platform has one authorization engine, so a module right is an entity/action pair evaluated by
 * `AclApiService` — the pattern `AIAgentsPermissionService` established. No role is created here:
 * `sysAdmin` holds the platform wildcard `*` and therefore every capability; the default user role
 * holds `{}` and therefore none, and an unconfigured installation refuses every call for exactly
 * that reason.
 */
export const SIGNATURE_REQUEST_PERMISSION_ENTITY = 'SignatureRequest';
export const SIGNATURE_SEND_PERMISSION_ENTITY = 'SignatureSend';
export const SIGNATURE_APPROVE_PERMISSION_ENTITY = 'SignatureApprove';
export const SIGNATURE_VOID_PERMISSION_ENTITY = 'SignatureVoid';
export const SIGNATURE_CORRECT_PERMISSION_ENTITY = 'SignatureCorrect';
export const SIGNATURE_DOWNLOAD_PERMISSION_ENTITY = 'SignatureCompletedDocument';
export const SIGNATURE_CONNECTION_PERMISSION_ENTITY = 'SignatureConnection';
export const SIGNATURE_TEMPLATE_PERMISSION_ENTITY = 'SignatureTemplateMapping';
export const SIGNATURE_AUDIT_PERMISSION_ENTITY = 'SignatureAudit';

/**
 * The provider keys this module knows (plan §1, §6.1).
 *
 * The names live in `providers/signature-provider.keys.ts` and the descriptors in
 * `providers/signature-provider.catalog.ts`; this file re-exports the vocabulary so domain code does
 * not depend on the catalog and the catalog does not depend back on the domain. A stored connection,
 * request, event or webhook row names one of these values, and nothing above the adapter boundary
 * assumes a particular vendor.
 */
export type { SignatureProviderKey } from './providers/signature-provider.keys.js';
export { PROVIDER_KEY_DOCUSIGN, PROVIDER_KEY_DROPBOX_SIGN, SIGNATURE_PROVIDER_KEYS } from './providers/signature-provider.keys.js';

/** @deprecated Prefer `SIGNATURE_PROVIDER_KEYS`; kept as the domain's own list for existing callers. */
export const PROVIDER_KEYS: readonly string[] = [...SIGNATURE_PROVIDER_KEYS];

/** Connection lifecycle (plan §6.1 `ESignatureConnection.status`). */
export const CONNECTION_STATUSES = [
  'not_connected',
  'connected',
  'reauthorization_required',
  'disabled',
  'error',
] as const;
export type ESignatureConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** Only this state permits provider operations, and only with the capability (plan §4.1, §8.1). */
export const CONNECTED_STATUS: ESignatureConnectionStatus = 'connected';

/** DocuSign environments, kept unmistakably separate (plan §9.2). There is no implicit default. */
export const CONNECTION_ENVIRONMENTS = ['demo', 'production'] as const;
export type ESignatureConnectionEnvironment = (typeof CONNECTION_ENVIRONMENTS)[number];

/**
 * The normalized local request states (plan §4.7).
 *
 * The provider is the signing authority: `completed`, `declined` and `voided` are reachable only
 * from a verified Connect event or a reconciliation result (audit §5.2), and `send_unknown` exists
 * so a lost response after submission is never answered with a blind retry.
 */
export const REQUEST_STATUSES = [
  'draft',
  'pending_approval',
  'ready_to_send',
  'sending',
  'send_unknown',
  'sent',
  'delivered',
  'partially_signed',
  'completed',
  'declined',
  'voided',
  'expired',
  'provider_error',
  'reconciliation_required',
] as const;
export type SignatureRequestStatus = (typeof REQUEST_STATUSES)[number];

/**
 * States from which the request is finished business-wise. ES.2 turns this into the guarded
 * transition table; declaring terminality here keeps a future state machine honest about the rule
 * that a terminal state never moves backwards without a validated reconciliation.
 */
export const TERMINAL_REQUEST_STATUSES: ReadonlySet<SignatureRequestStatus> = new Set([
  'completed',
  'declined',
  'voided',
  'expired',
]);

/** Recipient types addressed by the first adapter (plan §4.4). */
export const RECIPIENT_TYPES = ['signer', 'carbon_copy'] as const;
export type SignatureRecipientType = (typeof RECIPIENT_TYPES)[number];

/**
 * Per-connection secret kinds (plan §4.1, §6.1, §8; audit §6).
 *
 * These are the **only** values that may enter the credential vault, and the only ones that may be
 * named in an admin screen. A secret is never a settings field, never a column of a record table,
 * never in a response, and never in a log line.
 *
 * The names are the vault's own vocabulary, deliberately not invented again: the `kind` column of
 * `integration_credential_secrets` is a CHECK-constrained allowlist shared with Advanced Integrations,
 * and `esignature_credential_secrets` (ES.4, migration `065`) mirrors it. `api_key` and
 * `signing_secret` are excluded because no DocuSign credential has that shape. `oauth_access_token`
 * joins the module's list in ES.4, when the flow that produces it exists: a short-lived bearer value
 * is still a credential, so it is stored encrypted and never handed to the browser.
 *
 * ES.4 wires the vault to a connection; nothing here can read a value back.
 */
export const SECRET_KINDS = ['client_secret', 'oauth_access_token', 'oauth_refresh_token', 'webhook_secret'] as const;
export type ESignatureSecretKind = (typeof SECRET_KINDS)[number];

/** The plain-language meaning of each kind, for the admin screen and the runbook. */
export const SECRET_KIND_LABELS: Readonly<Record<ESignatureSecretKind, string>> = {
  client_secret: 'OAuth client secret',
  oauth_access_token: 'OAuth access token (short-lived)',
  oauth_refresh_token: 'OAuth refresh token',
  webhook_secret: 'Webhook signing secret',
};

/**
 * The generic names of the credentials an OAuth provider holds, so the connection service never has
 * to spell a vendor's prefix to reach its own vault.
 */
export const SECRET_KIND_OAUTH_ACCESS_TOKEN: ESignatureSecretKind = 'oauth_access_token';
export const SECRET_KIND_OAUTH_REFRESH_TOKEN: ESignatureSecretKind = 'oauth_refresh_token';
export const SECRET_KIND_CLIENT_SECRET: ESignatureSecretKind = 'client_secret';
export const SECRET_KIND_WEBHOOK_SECRET: ESignatureSecretKind = 'webhook_secret';

/**
 * Application-level audit actions (plan §6.6).
 *
 * `signature_audit_entries` (ES.2) is append-only to application code and records exactly these;
 * record edits stay on the kernel `audit_log`. An action that never carries a secret, a signing URL
 * or document content: the actor, the time, the correlation id, the target and a safe reason.
 */
export const AUDIT_ACTIONS = [
  'request.created',
  'request.updated',
  'request.prepared',
  'documents.changed',
  'recipients.changed',
  'approval.requested',
  'approval.granted',
  'approval.rejected',
  'send.confirmed',
  'send.outcome_unknown',
  'send.completed',
  'provider.event_accepted',
  'provider.event_rejected',
  // Added by ES.20: the recovery workbench retries an inbound delivery. It is an operator action on
  // evidence, never a resend; the trail says which receipt and which state was retried.
  'webhook.retryRequested',
  'embedded_view.created',
  'reminder.sent',
  'resend.requested',
  'void.requested',
  'void.completed',
  'correct.requested',
  'correct.completed',
  'artifact.downloaded',
  'artifact.viewed',
  'connection.created',
  'connection.updated',
  'connection.authorized',
  'connection.reauthorized',
  // Added by 19-ES.4, the phase that can perform them: a connection test is an outbound call and a
  // rotated client secret is an administrator action, so both belong in the trail. Neither may
  // record a value — the row keeps the outcome and a safe reason only.
  'connection.tested',
  'connection.secretRotated',
  // Added by 19-ES.7: a template mapping is configuration a provider call is built from, so creating,
  // editing or switching one is auditable. The detail carries the field/role *names*, never their values.
  'templateMapping.changed',
  'connection.enabled',
  'connection.disabled',
  'connection.disconnected',
  'reconciliation.started',
  'reconciliation.completed',
  'settings.updated',
] as const;
export type ESignatureAuditAction = (typeof AUDIT_ACTIONS)[number];
