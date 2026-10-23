import { PROVIDER_KEY_DOCUSIGN, PROVIDER_KEY_DROPBOX_SIGN, type SignatureProviderKey } from './signature-provider.keys.js';
import { BASE_SIGNATURE_PROVIDER_CAPABILITIES, type SignatureProviderCapabilities } from './signature-provider.port.js';

/**
 * Multi-provider follow-on — the signature provider catalog
 * (`PLAN_Phase_19_ESignature.md` §1.2, §5.2, §6.1, §9.4).
 *
 * DocuSign is the reference integration, not the product. This catalog is the one place that says
 * *which* e-signature providers this installation understands, how each one authenticates, what it
 * can do, and whether its adapter is actually installed in this build. Everything above it reads
 * these descriptors instead of assuming a vendor:
 *
 *  - the settings document holds OAuth client ids **per provider** (`provider.clients.<key>`);
 *  - a connection row names a provider key, and the connection service refuses one without a
 *    strategy that can authorize it;
 *  - the gate asks the descriptor (or the bound adapter) whether the provider supports an operation;
 *  - the admin UI renders its picker from `GET /api/v1/ESignature/action/provider-catalog`.
 *
 * Two ideas are kept deliberately apart, because conflating them is how an admin screen starts lying:
 *
 *  - **`integrationStatus: 'available'`** — this build can talk to the provider: an auth strategy
 *    exists and an adapter is bound (or the in-process fake answers outside production).
 *  - **`integrationStatus: 'declared'`** — the provider is a planned integration. It appears in the
 *    catalog so the architecture, picker and storage are provider-neutral, but it cannot be
 *    connected and its capability flags are all `false`. Creating a connection for it is refused
 *    with a stated reason rather than failing later at the first send.
 *
 * Nothing here is a credential. An OAuth **client id** is public and may be stored in settings; the
 * matching secret lives only in the encrypted vault, and an API-key provider's key would too.
 */

/** How a provider authenticates an installation. A provider has exactly one primary style. */
export type SignatureProviderAuthStyle = 'oauth2_authorization_code' | 'api_key';

/** Whether this build can connect to the provider, or the integration is only planned. */
export type SignatureProviderIntegrationStatus = 'available' | 'declared';

/** The format and size ceiling the provider itself imposes on a signature document. */
export interface SignatureProviderDocumentLimits {
  readonly maxDocumentBytes: number;
  readonly supportedExtensions: readonly string[];
}

export interface SignatureProviderDescriptor {
  readonly key: SignatureProviderKey;
  /** The name an administrator sees. Never used as a storage key. */
  readonly label: string;
  readonly description: string;
  readonly authStyle: SignatureProviderAuthStyle;
  readonly integrationStatus: SignatureProviderIntegrationStatus;
  /**
   * The descriptor's declared capabilities.
   *
   * A bound adapter is authoritative once one exists (a declaration that drifts from an
   * implementation is exactly the silent no-op the plan forbids); the descriptor answers when no
   * adapter is bound. A declared provider declares nothing as supported.
   */
  readonly capabilities: SignatureProviderCapabilities;
  /**
   * Whether the provider can prepare an unsent draft, or sends at creation time.
   *
   * The bound adapter is authoritative, exactly as for capabilities; the descriptor answers when no
   * adapter is installed. `direct` providers skip the provider-draft step in the request workspace.
   */
  readonly envelopeDrafting: 'draft' | 'direct';
  /**
   * The vault credential that verifies this provider's deliveries.
   *
   * DocuSign Connect uses a dedicated signing secret. Dropbox Sign derives its `event_hash` from the
   * account's API key, so asserting a webhook secret there would report a configuration gap that does
   * not exist. `null` means this build has no verified delivery mechanism.
   */
  readonly webhookSecretKind: 'webhook_secret' | 'api_key' | null;
  /**
   * The HTTP acknowledgement the provider requires, when it is not a generic 2xx.
   *
   * Dropbox Sign retries (and eventually disables) a callback whose response body is not exactly
   * `Hello API Event Received`; recording it in the catalog keeps that vendor rule out of the
   * controller.
   */
  readonly webhookAcknowledgement: { readonly status: 200 | 202; readonly body: string } | null;
  /** The provider's own per-document ceiling, or `null` when it has not been verified yet. */
  readonly documentLimits: SignatureProviderDocumentLimits | null;
  /** Environment variable names that may carry the public OAuth client id, by environment. */
  readonly oauthClientIdEnvVars: readonly string[];
  /** Where the admin screen finds this provider's public client ids. Dotted settings path. */
  readonly oauthClientIdSettingsPath: string | null;
  /** The provider's public developer documentation, for an operator setting it up. */
  readonly documentationUrl: string;
}

/** A provider that has not been implemented declares no capability at all. */
export const NO_SIGNATURE_PROVIDER_CAPABILITIES: SignatureProviderCapabilities = Object.freeze({
  connectionStatus: false,
  accountContext: false,
  listTemplates: false,
  templateDetails: false,
  prepareEnvelope: false,
  sendEnvelope: false,
  sendNewEnvelope: false,
  envelopeStatus: false,
  listRecipients: false,
  recipientView: false,
  resendNotifications: false,
  voidEnvelope: false,
  downloadCompletedDocuments: false,
  downloadCompletionEvidence: false,
  verifyWebhook: false,
  correctEnvelope: false,
});

/**
 * DocuSign's documented eSignature envelope constraints, as far as the audit established them
 * (`docs/implementation/esignature-audit.md` §4). This is a **ceiling the settings cannot lift**, not
 * a policy: the effective limit is the tighter of this table and the settings document (plan §4.5).
 * ES.22 re-verifies the numbers against a live demo account; a correction lands here and nowhere else.
 */
export const DOCUSIGN_DOCUMENT_LIMITS: SignatureProviderDocumentLimits = Object.freeze({
  /** The documented per-document size ceiling, in bytes (25 MiB). */
  maxDocumentBytes: 26_214_400,
  /** Formats DocuSign accepts for an eSignature envelope, lower-case and without the dot. */
  supportedExtensions: Object.freeze([
    'pdf',
    'doc',
    'docx',
    'rtf',
    'txt',
    'xls',
    'xlsx',
    'htm',
    'html',
    'xml',
    'bmp',
    'gif',
    'jpg',
    'jpeg',
    'png',
  ]),
});

/**
 * What Dropbox Sign's adapter declares in this build.
 *
 * Two deliberate exclusions, both verified against the API v3 reference rather than guessed:
 *
 * - **No provider draft.** `signature_request/send` creates and notifies in one call, so preparation
 *   is skipped for this provider and the workspace sends directly.
 * - **No embedded signing.** Dropbox Sign requires *every* signer of a request to use the same flow
 *   (all embedded or none), and its embedded request is a different endpoint. The domain's per-recipient
 *   embedded mode cannot be expressed honestly on top of that, so the capability is `false` and the
 *   service refuses the configuration instead of producing a broken mixed request.
 *
 * Completion evidence is `false` as well: Dropbox Sign exposes the audit trail only inside the ZIP
 * archive, and this adapter does not unpack archives. The signed documents themselves are retrievable.
 */
export const DROPBOX_SIGN_CAPABILITIES: SignatureProviderCapabilities = Object.freeze({
  connectionStatus: true,
  accountContext: true,
  listTemplates: true,
  templateDetails: true,
  prepareEnvelope: false,
  sendEnvelope: false,
  sendNewEnvelope: true,
  envelopeStatus: true,
  listRecipients: true,
  recipientView: false,
  resendNotifications: true,
  voidEnvelope: true,
  downloadCompletedDocuments: true,
  downloadCompletionEvidence: false,
  verifyWebhook: true,
  correctEnvelope: false,
});

const DESCRIPTORS: readonly SignatureProviderDescriptor[] = [
  {
    key: PROVIDER_KEY_DOCUSIGN,
    label: 'DocuSign',
    description:
      'DocuSign eSignature REST API v2.1. Confidential authorization-code OAuth, per-account base URI resolved from userinfo, eSignature envelopes, templates, embedded signing and Connect status events.',
    authStyle: 'oauth2_authorization_code',
    integrationStatus: 'available',
    capabilities: BASE_SIGNATURE_PROVIDER_CAPABILITIES,
    envelopeDrafting: 'draft',
    webhookSecretKind: 'webhook_secret',
    webhookAcknowledgement: null,
    documentLimits: DOCUSIGN_DOCUMENT_LIMITS,
    oauthClientIdEnvVars: ['DOCUSIGN_DEMO_INTEGRATION_KEY', 'DOCUSIGN_PRODUCTION_INTEGRATION_KEY'],
    oauthClientIdSettingsPath: 'provider.clients.docusign',
    documentationUrl: 'https://developers.docusign.com/docs/esign-rest-api/',
  },
  {
    key: PROVIDER_KEY_DROPBOX_SIGN,
    label: 'Dropbox Sign',
    description:
      'Dropbox Sign (formerly HelloSign) API v3. API-key authentication, create-and-send signature requests, templates, reminders, cancellation, signed-document downloads and callback events. It has no unsent provider draft, so a request is created at the moment it is sent.',
    authStyle: 'api_key',
    integrationStatus: 'available',
    capabilities: DROPBOX_SIGN_CAPABILITIES,
    // API v3 has no "create without sending": `signature_request/send` is the send.
    envelopeDrafting: 'direct',
    // The callback's `event_hash` is derived from the account's API key, which the vault already holds.
    webhookSecretKind: 'api_key',
    // Dropbox Sign retries, then disables, a callback that does not return this exact body.
    webhookAcknowledgement: { status: 200, body: 'Hello API Event Received' },
    documentLimits: null,
    oauthClientIdEnvVars: [],
    oauthClientIdSettingsPath: 'provider.clients.dropbox_sign',
    documentationUrl: 'https://developers.hellosign.com/',
  },
];

/** Every descriptor, in the order an admin picker should show them. */
export const SIGNATURE_PROVIDER_CATALOG: readonly SignatureProviderDescriptor[] = Object.freeze(DESCRIPTORS);

/** One provider's descriptor, or `undefined` when this build does not know the key. */
export function signatureProviderDescriptor(providerKey: string): SignatureProviderDescriptor | undefined {
  return SIGNATURE_PROVIDER_CATALOG.find((descriptor) => descriptor.key === providerKey);
}

/** The label to show for a provider, falling back to the key so a legacy row is still readable. */
export function signatureProviderLabel(providerKey: string): string {
  return signatureProviderDescriptor(providerKey)?.label ?? providerKey;
}

/** Whether a connection may be created for this provider in this build. */
export function isSignatureProviderAvailable(providerKey: string): boolean {
  return signatureProviderDescriptor(providerKey)?.integrationStatus === 'available';
}

/** The providers a picker may offer as connectable in this build. */
export function availableSignatureProviderKeys(): SignatureProviderKey[] {
  return SIGNATURE_PROVIDER_CATALOG.filter((descriptor) => descriptor.integrationStatus === 'available').map(
    (descriptor) => descriptor.key,
  );
}

/** The providers whose integration is declared but not installed. */
export function declaredSignatureProviderKeys(): SignatureProviderKey[] {
  return SIGNATURE_PROVIDER_CATALOG.filter((descriptor) => descriptor.integrationStatus === 'declared').map(
    (descriptor) => descriptor.key,
  );
}

/**
 * The provider's own document ceiling, or `null` when it has not been verified.
 *
 * `null` means the settings policy alone decides: inventing a limit for a provider whose documented
 * limits nobody checked would refuse documents for a reason a support engineer could not explain.
 */
export function signatureProviderDocumentLimits(providerKey: string): SignatureProviderDocumentLimits | null {
  return signatureProviderDescriptor(providerKey)?.documentLimits ?? null;
}

/**
 * The public OAuth client ids the catalog documents for a provider, aggregated for the settings view.
 * A provider that authenticates with an API key contributes nothing: its key is a secret.
 */
export function signatureProviderOAuthEnvVars(): string[] {
  return [
    ...new Set(
      SIGNATURE_PROVIDER_CATALOG.filter((descriptor) => descriptor.authStyle === 'oauth2_authorization_code').flatMap(
        (descriptor) => descriptor.oauthClientIdEnvVars,
      ),
    ),
  ];
}

/** Whether a provider authenticates with an OAuth authorization-code grant. */
export function isSignatureProviderOAuth(providerKey: string): boolean {
  return signatureProviderDescriptor(providerKey)?.authStyle === 'oauth2_authorization_code';
}

/** Whether a provider creates an unsent draft first, or creates and sends in one call. */
export function signatureProviderEnvelopeDrafting(providerKey: string): 'draft' | 'direct' {
  return signatureProviderDescriptor(providerKey)?.envelopeDrafting ?? 'draft';
}

/** The vault credential that verifies a provider's deliveries, or `null` when none is defined. */
export function signatureProviderWebhookSecretKind(providerKey: string): 'webhook_secret' | 'api_key' | null {
  return signatureProviderDescriptor(providerKey)?.webhookSecretKind ?? null;
}

/** The exact HTTP acknowledgement a provider requires, when a generic 2xx is not enough. */
export function signatureProviderWebhookAcknowledgement(
  providerKey: string,
): { readonly status: 200 | 202; readonly body: string } | null {
  return signatureProviderDescriptor(providerKey)?.webhookAcknowledgement ?? null;
}
