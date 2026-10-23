import type { ESignatureConnectionEnvironment } from '../esignature-domain.js';

/**
 * Phase 19-ES.3 — the provider adapter contract
 * (`PLAN_Phase_19_ESignature.md` §5.2, §9.1; audit §5.1; `19-ES.3`).
 *
 * This is the **only** vocabulary a signature provider is allowed to speak inside the CRM. Nothing
 * above this file may see a DocuSign type, a DocuSign status string or a DocuSign payload — the
 * domain, the application commands, the API and the SPA all speak these names, and `docusign/*` is
 * where vendor shapes are translated (plan §1.2 "provider-neutral domain, provider-specific
 * adapter").
 *
 * Three deliberate choices, each traceable to the plan:
 *
 * 1. **Method-per-need, not a full vendor mirror.** The nine operations below are the initial
 *    end-to-end slice agreed in the audit (connect → one document → one signer → send → remote
 *    signing → status events → signed PDF + certificate). Templates, embedded signing, reminders,
 *    void and correction are *declared* as capability flags and have **no method yet** — plan §5.2
 *    forbids empty no-op methods, and the registry answers an unsupported request with a refusal
 *    instead of a silent success. When ES.7/ES.14/ES.16 deliver those operations, they add the method
 *    and flip the flag; nothing else changes.
 * 2. **`context` is the authenticated account, not a credential bag.** The bearer token arrives as a
 *    short-lived value the OAuth service (ES.4) resolves per call. It is never a settings field, never
 *    returned by an API and never a log line; `SignatureProviderContext.redact()` exists so an
 *    implementation has one honest way to keep it out of diagnostics.
 * 3. **Every mutation takes an idempotency key and a correlation id.** `prepare` and `send` are keyed
 *    by the request's own send-attempt token, so a retry of the *same action* is the same call to the
 *    provider and a retry of a *different* action is a different key. `sendEnvelope` may additionally
 *    fail with `SignatureSendOutcomeUnknownError` — the response was lost after the provider may have
 *    accepted it — and that error is defined as non-retryable by construction (see
 *    `signature-provider-errors.ts`), which is the whole of plan §4.3's ambiguous-send rule.
 *
 * The optional-method convention (`verifyAndParseWebhook?`) follows `ConnectorAdapter` in
 * `apps/api/src/advanced-integrations/connector-adapter.port.ts`: an adapter that cannot do something
 * does not claim it can, and the caller asks `capabilities` before dispatching.
 */

/** The operations this contract defines, in the order the initial slice needs them. */
export const SIGNATURE_PROVIDER_OPERATIONS = [
  'connectionStatus',
  'accountContext',
  // ES.7 — the template catalog. Read-only by design: plan §6.7 forbids updating a provider template.
  'listTemplates',
  'templateDetails',
  'prepareEnvelope',
  'sendEnvelope',
  'envelopeStatus',
  'listRecipients',
  // ES.14 — a short-lived embedded signing URL for one matched recipient.
  'recipientView',
  // ES.16 — reminders/resends and withdrawal. Correction stays a future operation.
  'downloadCompletedDocuments',
  'downloadCompletionEvidence',
  'verifyWebhook',
] as const;
export type SignatureProviderOperation = (typeof SIGNATURE_PROVIDER_OPERATIONS)[number];

/**
 * The operations a later sub-phase will add. Declared here so "not supported yet" is a stated fact
 * rather than an absent key an operator has to interpret.
 */
export const FUTURE_SIGNATURE_PROVIDER_OPERATIONS = [
  'recipientView',
  'resendNotifications',
  'voidEnvelope',
  'correctEnvelope',
] as const;
export type FutureSignatureProviderOperation = (typeof FUTURE_SIGNATURE_PROVIDER_OPERATIONS)[number];

/** What one adapter can actually do, per operation. */
export type SignatureProviderCapabilities = Readonly<
  Record<SignatureProviderOperation | FutureSignatureProviderOperation, boolean>
>;

/**
 * The authenticated account an operation runs against.
 *
 * Resolved by ES.4 from the stored connection plus the vault: the base URI comes from the OAuth
 * account context and is never a hard-coded host (plan §3.2). `accessToken` is the only secret-shaped
 * field on this type, and it is a short-lived bearer value the adapter passes in a header — nothing
 * here may store it, return it, or log it.
 */
export interface SignatureProviderContext {
  readonly connectionId: string;
  readonly providerKey: string;
  readonly environment: ESignatureConnectionEnvironment;
  readonly accountId: string;
  readonly baseUri: string;
  readonly grantedScopes: readonly string[];
  readonly accessToken: string;
  /** A per-call correlation id, from the platform's request context. Never a secret. */
  readonly correlationId: string | null;
  /** An implementation-owned timeout bound; the adapter must not wait forever. */
  readonly timeoutMs: number;
}

/** The credential-free view an adapter may put into a diagnostic. */
export function redactContext(context: SignatureProviderContext): {
  readonly connectionId: string;
  readonly providerKey: string;
  readonly environment: string;
  readonly accountId: string;
  readonly scopeCount: number;
} {
  return {
    connectionId: context.connectionId,
    providerKey: context.providerKey,
    environment: context.environment,
    accountId: context.accountId,
    scopeCount: context.grantedScopes.length,
  };
}

// ---------------------------------------------------------------------------
// results
// ---------------------------------------------------------------------------

export interface ProviderConnectionStatus {
  readonly reachable: boolean;
  readonly checkedAt: string;
  /** A stable safe code when unreachable, e.g. `token_expired`. Never a provider body. */
  readonly detailCode: string | null;
}

export interface ProviderAccountContext {
  readonly accountId: string;
  readonly accountName: string | null;
  readonly baseUri: string;
  readonly userId: string | null;
  readonly grantedScopes: readonly string[];
}

/** A document to be signed, handed to the provider as bytes the platform already authorized. */
export interface PrepareEnvelopeDocument {
  readonly documentSnapshotId: string;
  readonly displayName: string;
  readonly mimeType: string;
  readonly documentOrder: number;
  /** The authorized bytes; the adapter never re-reads a CRM attachment itself. */
  readonly bytes: Uint8Array;
  readonly contentHashSha256: string;
}

export interface PrepareEnvelopeRecipient {
  readonly recipientId: string;
  readonly name: string;
  readonly email: string;
  readonly recipientType: 'signer' | 'carbon_copy';
  readonly routingOrder: number;
  readonly roleName: string | null;
  readonly authenticationMethod: string | null;
  /**
   * The provider's embedded-recipient id, when this signer signs inside the CRM (ES.14).
   *
   * A recipient with a client user id is not emailed by the provider — the sender must ask for a
   * recipient view — which is why it is only set for a recipient the draft marked as embedded.
   */
  readonly clientUserId: string | null;
}

/**
 * One tab value, with the template role it belongs to.
 *
 * The role is on the field rather than inferred at send time: a template's tabs belong to specific
 * recipients, and sending a value to the wrong role is a contract signed by the wrong person. The role
 * comes from the reviewed mapping (ES.7) and is carried in the snapshot (ES.8), so ES.9 sends exactly
 * what was reviewed.
 */
export interface MappedFieldInput {
  readonly tabLabel: string;
  /** `null` when the mapping did not name one: the adapter may only place such a tab on a single-role template. */
  readonly roleName: string | null;
  readonly value: string;
}

export interface PrepareEnvelopeInput {
  readonly signatureRequestId: string;
  /** The caller's own stable key: the same key twice must not create a second provider object. */
  readonly idempotencyKey: string;
  readonly correlationId: string | null;
  readonly templateId: string | null;
  readonly subject: string | null;
  readonly emailBlurb: string | null;
  readonly expiresAt: string | null;
  readonly documents: readonly PrepareEnvelopeDocument[];
  readonly recipients: readonly PrepareEnvelopeRecipient[];
  /** The tab values the mapping resolved, already frozen in the snapshot. */
  readonly mappedFields?: readonly MappedFieldInput[] | undefined;
}

export interface PreparedEnvelope {
  readonly providerEnvelopeId: string;
  /** The provider's own state, translated: a prepared draft is not yet sent. */
  readonly status: 'draft';
  readonly preparedAt: string;
  readonly idempotencyKey: string;
  /** The document ids the provider assigned, keyed by our snapshot id (plan §4.5). */
  readonly providerDocumentIds: Readonly<Record<string, string>>;
}

export interface SendEnvelopeInput {
  readonly signatureRequestId: string;
  readonly providerEnvelopeId: string;
  /** The request's `send_attempt_id`: one deliberate send action, one key. */
  readonly idempotencyKey: string;
  readonly correlationId: string | null;
}

export interface SentEnvelope {
  readonly providerEnvelopeId: string;
  readonly status: 'sent';
  readonly providerStatusRaw: string;
  readonly sentAt: string;
  readonly recipients: readonly ProviderRecipientStatus[];
}

/** One signer's embedded signing session (ES.14). The URL is a bearer credential. */
export interface RecipientViewInput {
  readonly providerEnvelopeId: string;
  /** The provider's id for the recipient row. */
  readonly recipientProviderId: string;
  /** Our local recipient id; the provider knows it as the `clientUserId` set at preparation. */
  readonly recipientId: string;
  readonly email: string;
  readonly name: string;
  readonly returnUrl: string;
  readonly cancelUrl: string | null;
  readonly correlationId: string | null;
}

export interface RecipientView {
  /** Short-lived and never stored, logged or audited. */
  readonly url: string;
  readonly expiresAt: string | null;
}

export interface ResendNotificationsInput {
  readonly providerEnvelopeId: string;
  /**
   * The provider recipient ids to remind. Empty means every outstanding recipient, which is the
   * provider's own "resend envelope" action rather than a per-person reminder.
   */
  readonly recipientProviderIds: readonly string[];
  readonly idempotencyKey: string;
  readonly correlationId: string | null;
}

export interface ResendResult {
  readonly resentAt: string;
  readonly providerStatusRaw: string;
}

export interface VoidEnvelopeInput {
  readonly providerEnvelopeId: string;
  /** A safe human reason, recorded in the audit trail and sent to the provider. */
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly correlationId: string | null;
}

export interface VoidResult {
  readonly voidedAt: string;
  readonly providerStatusRaw: string;
}

/** The normalized envelope state. `providerStatusRaw` is preserved for troubleshooting (plan §4.7). */
export interface ProviderEnvelopeStatus {
  readonly providerEnvelopeId: string;
  readonly status: 'draft' | 'sent' | 'delivered' | 'partially_signed' | 'completed' | 'declined' | 'voided' | 'expired' | 'unknown';
  readonly providerStatusRaw: string;
  readonly occurredAt: string | null;
  readonly recipients: readonly ProviderRecipientStatus[];
}

/** One signer's normalized state, with the raw value kept beside it. */
export interface ProviderRecipientStatus {
  readonly providerRecipientId: string;
  /** Our recipient id, as echoed back from `prepareEnvelope`; the join key to the local row. */
  readonly recipientId: string;
  readonly status: 'pending' | 'sent' | 'delivered' | 'viewed' | 'signed' | 'completed' | 'declined' | 'canceled' | 'expired' | 'unknown';
  readonly providerStatusRaw: string;
  readonly name: string;
  readonly email: string;
  readonly routingOrder: number;
  readonly roleName: string | null;
  readonly occurredAt: string | null;
  /** Sanitized by the adapter: a decline reason is user text, not a provider body. */
  readonly declineReasonSafe: string | null;
}

/** A document the provider produced, in memory, before it is stored as a new artifact. */
export interface ProviderArtifact {
  readonly artifactKind: 'provider_signed_document' | 'completion_evidence';
  readonly providerDocumentId: string | null;
  readonly displayName: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly contentHashSha256: string;
  readonly retrievedAt: string;
}

/** One template in the provider's catalog, as much as a picker needs. */
export interface ProviderTemplateSummary {
  readonly templateId: string;
  readonly name: string;
  readonly description: string | null;
  /** The provider marks an account-shared template; it belongs to the account, not to the CRM user. */
  readonly shared: boolean;
  /** The provider's own state word, preserved for troubleshooting (plan §4.7). Never interpreted here. */
  readonly status: string | null;
}

/** A recipient role a template expects to be filled. */
export interface ProviderTemplateRole {
  readonly roleName: string;
  readonly recipientType: 'signer' | 'carbon_copy' | 'other';
  /** The routing order the template assigns; a mapping may restate it but not silently drop the role. */
  readonly routingOrder: number | null;
  readonly required: boolean;
}

/** One tab a template exposes, with the role that fills it when the provider says so. */
export interface ProviderTemplateField {
  readonly tabLabel: string;
  readonly roleName: string | null;
  readonly documentId: string | null;
  readonly fieldType: string | null;
  readonly required: boolean;
}

/** A template and the two things a mapping is built from: its roles and its tabs (plan §6.7). */
export interface ProviderTemplateDetail extends ProviderTemplateSummary {
  readonly roles: readonly ProviderTemplateRole[];
  readonly fields: readonly ProviderTemplateField[];
}

export interface VerifyWebhookInput {
  readonly providerKey: string;
  readonly connectionId: string | null;
  /**
   * The account the addressed connection belongs to. A verified payload that names a different
   * account is authentic but misrouted, and must not change this connection's requests (plan §10.2).
   */
  readonly expectedAccountId: string | null;
  readonly rawBody: Uint8Array;
  readonly headers: Readonly<Record<string, string>>;
  readonly contentType: string | null;
  /** The account's Connect secret, resolved from the vault. Never stored or logged. */
  readonly signingSecret: string | null;
  readonly requireSignature: boolean;
  readonly maxPayloadBytes: number;
}

/** The normalized notification, with the fields the projection needs and nothing more. */
export interface ProviderWebhookNotification {
  readonly verified: boolean;
  /**
   * Why a delivery was refused, when it was. A stable code, never the secret or the body — and the
   * codes are separated deliberately: `no_secret` is an administrator's configuration gap, while
   * `invalid_signature` is somebody forging or mangling a delivery. The operator queue has to tell
   * those two apart (plan §8.3, §10.2).
   */
  readonly refusalReason: 'invalid_signature' | 'missing_signature' | 'no_secret' | 'too_large' | 'malformed' | 'account_mismatch' | null;
  readonly providerEventId: string | null;
  readonly providerEnvelopeId: string | null;
  readonly providerAccountId: string | null;
  readonly eventTypeRaw: string | null;
  readonly eventTypeNormalized: string;
  readonly recipientProviderId: string | null;
  readonly recipientStatusRaw: string | null;
  readonly occurredAt: string | null;
  /** The minimized fields for the event row (plan §12.1). */
  readonly minimized: Readonly<Record<string, unknown>>;
  readonly payloadHash: string;
  readonly receivedAt: string;
}

// ---------------------------------------------------------------------------
// the port
// ---------------------------------------------------------------------------

/**
 * The contract every signature provider adapter implements.
 *
 * `providerKey` is the identity the registry dispatches on; `mode` distinguishes a real integration
 * from the in-process fake so an operator can always see which one is answering (plan §9.4: the
 * active environment must be unmistakable). `capabilities` is declared data the registry checks
 * **before** a call, which is what makes an unsupported operation a precise refusal instead of a
 * "not implemented" thrown from inside an adapter.
 */
export interface SignatureProviderAdapter {
  readonly providerKey: string;
  readonly adapterVersion: string;
  readonly providerApiVersion: string;
  readonly mode: 'live' | 'fake' | 'disabled';
  readonly capabilities: SignatureProviderCapabilities;

  connectionStatus(context: SignatureProviderContext): Promise<ProviderConnectionStatus>;
  accountContext(context: SignatureProviderContext): Promise<ProviderAccountContext>;

  /** The account's template catalog. Read-only: this module never writes a provider template. */
  listTemplates(context: SignatureProviderContext): Promise<readonly ProviderTemplateSummary[]>;
  /** One template's roles and tabs — what a mapping is validated against (plan §6.7). */
  templateDetails(context: SignatureProviderContext, templateId: string): Promise<ProviderTemplateDetail>;

  prepareEnvelope(context: SignatureProviderContext, input: PrepareEnvelopeInput): Promise<PreparedEnvelope>;
  sendEnvelope(context: SignatureProviderContext, input: SendEnvelopeInput): Promise<SentEnvelope>;
  envelopeStatus(context: SignatureProviderContext, providerEnvelopeId: string): Promise<ProviderEnvelopeStatus>;
  listRecipients(context: SignatureProviderContext, providerEnvelopeId: string): Promise<readonly ProviderRecipientStatus[]>;

  /** One short-lived embedded signing URL for a matched recipient (ES.14). */
  recipientView(context: SignatureProviderContext, input: RecipientViewInput): Promise<RecipientView>;
  /** Remind the outstanding recipients (ES.16). A no-op is never claimed: the provider is asked. */
  resendNotifications(context: SignatureProviderContext, input: ResendNotificationsInput): Promise<ResendResult>;
  /** Withdraw a sent envelope (ES.16). */
  voidEnvelope(context: SignatureProviderContext, input: VoidEnvelopeInput): Promise<VoidResult>;

  /**
   * Delete an unsent provider draft.
   *
   * The plan asks for "safe cleanup/abandonment of unsent provider drafts where the provider permits
   * it" (ES.9): a draft envelope invites nobody, so removing it is the correct recovery from a
   * preparation that was made against the wrong request or superseded by an edit. `deleted: false`
   * means the provider no longer has it — which is the outcome the caller wanted either way.
   */
  abandonDraftEnvelope(context: SignatureProviderContext, providerEnvelopeId: string): Promise<{ readonly deleted: boolean }>;

  downloadCompletedDocuments(context: SignatureProviderContext, providerEnvelopeId: string): Promise<readonly ProviderArtifact[]>;
  downloadCompletionEvidence(context: SignatureProviderContext, providerEnvelopeId: string): Promise<readonly ProviderArtifact[]>;

  /**
   * Verify and normalize a provider delivery. Optional, because the webhook endpoint is ES.11's; an
   * adapter that declares `verifyWebhook` must implement it. Verification always happens **before**
   * a payload field is trusted (plan §10.2), and an unverified result is returned as
   * `verified: false` with a reason rather than throwing, so the inbox can record the attempt.
   */
  verifyAndParseWebhook?(input: VerifyWebhookInput): Promise<ProviderWebhookNotification>;
}

/** Whether an adapter declares an operation. An unknown operation is not supported, never assumed. */
export function adapterSupports(
  adapter: Pick<SignatureProviderAdapter, 'capabilities'>,
  operation: SignatureProviderOperation | FutureSignatureProviderOperation,
): boolean {
  return adapter.capabilities[operation] === true;
}

/**
 * The capability set the first real adapter commits to: the initial slice, and nothing that has not
 * been verified against a live account (plan §5.2, `docs/compatibility/esignature.md` §3).
 */
export const BASE_SIGNATURE_PROVIDER_CAPABILITIES: SignatureProviderCapabilities = Object.freeze({
  connectionStatus: true,
  accountContext: true,
  prepareEnvelope: true,
  sendEnvelope: true,
  envelopeStatus: true,
  listRecipients: true,
  downloadCompletedDocuments: true,
  downloadCompletionEvidence: true,
  verifyWebhook: true,
  // The template catalog is read-only and arrived with ES.7.
  listTemplates: true,
  templateDetails: true,
  // ES.14 and ES.16 deliver these three.
  recipientView: true,
  resendNotifications: true,
  voidEnvelope: true,
  // Plan §5.2 and §16: correction is an exception path, off until the demo behaviour is verified.
  correctEnvelope: false,
});

/** The adapter every implementation must satisfy, checked at registration, not at first call. */
export function assertAdapterContract(adapter: SignatureProviderAdapter): void {
  const problems: string[] = [];
  if (adapter.providerKey.trim() === '') problems.push('providerKey');
  if (adapter.adapterVersion.trim() === '') problems.push('adapterVersion');
  if (adapter.providerApiVersion.trim() === '') problems.push('providerApiVersion');
  for (const operation of SIGNATURE_PROVIDER_OPERATIONS) {
    if (adapter.capabilities[operation] === true && typeof (adapter as unknown as Record<string, unknown>)[methodFor(operation)] !== 'function') {
      problems.push(`capabilities.${operation} without ${methodFor(operation)}()`);
    }
  }
  if (adapter.capabilities.verifyWebhook === true && typeof adapter.verifyAndParseWebhook !== 'function') {
    problems.push('capabilities.verifyWebhook without verifyAndParseWebhook()');
  }
  if (problems.length > 0) {
    throw new Error(`Signature provider adapter "${adapter.providerKey}" is incomplete: ${problems.join(', ')}.`);
  }
}

/** The method name the port uses for an operation, so the contract check and the message agree. */
function methodFor(operation: SignatureProviderOperation | FutureSignatureProviderOperation): string {
  switch (operation) {
    case 'connectionStatus':
      return 'connectionStatus';
    case 'accountContext':
      return 'accountContext';
    case 'listTemplates':
      return 'listTemplates';
    case 'templateDetails':
      return 'templateDetails';
    case 'prepareEnvelope':
      return 'prepareEnvelope';
    case 'sendEnvelope':
      return 'sendEnvelope';
    case 'envelopeStatus':
      return 'envelopeStatus';
    case 'listRecipients':
      return 'listRecipients';
    case 'recipientView':
      return 'recipientView';
    case 'resendNotifications':
      return 'resendNotifications';
    case 'voidEnvelope':
      return 'voidEnvelope';
    case 'downloadCompletedDocuments':
      return 'downloadCompletedDocuments';
    case 'downloadCompletionEvidence':
      return 'downloadCompletionEvidence';
    case 'verifyWebhook':
      return 'verifyAndParseWebhook';
    default:
      // A future operation's method does not exist on the port yet; the flag alone is the answer.
      return operation;
  }
}
