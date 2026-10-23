import { createHash } from 'node:crypto';

import { ProviderError } from '../../../advanced-integrations/provider-error.js';
import { PROVIDER_KEY_DOCUSIGN } from '../../esignature-domain.js';
import { normalizeEnvelopeStatus, normalizeProviderEventType, normalizeRecipientStatus } from '../../esignature-status-mapper.js';
import { SendOutcomeUnknownError } from '../signature-provider.errors.js';
import {
  BASE_SIGNATURE_PROVIDER_CAPABILITIES,
  type PreparedEnvelope,
  type PrepareEnvelopeInput,
  type ProviderAccountContext,
  type ProviderArtifact,
  type ProviderConnectionStatus,
  type ProviderEnvelopeStatus,
  type ProviderRecipientStatus,
  type ProviderTemplateDetail,
  type ProviderTemplateField,
  type ProviderTemplateRole,
  type ProviderTemplateSummary,
  type ProviderWebhookNotification,
  type RecipientView,
  type RecipientViewInput,
  type ResendNotificationsInput,
  type ResendResult,
  type SendEnvelopeInput,
  type SentEnvelope,
  type SignatureProviderAdapter,
  type SignatureProviderCapabilities,
  type SignatureProviderContext,
  type VerifyWebhookInput,
  type VoidEnvelopeInput,
  type VoidResult,
} from '../signature-provider.port.js';
import { rawBodyHash, readSignatureHeaders, verifyConnectSignature } from '../signature-provider-signature.js';
import { parseDocuSignUserinfo, selectDocuSignAccount } from './docusign-oauth.js';
import { type DocuSignTransport,parseJson } from './docusign-transport.js';

/**
 * Phase 19-ES.4 — the DocuSign adapter that answers in production
 * (`PLAN_Phase_19_ESignature.md` §5.1, §5.2, §6.1, §9.3, §18 `19-ES.4`).
 *
 * This is the **first real adapter**, and it is deliberately partial. ES.4's task list is the
 * connection: prove the credential, resolve the account, report health. Envelope creation, sending,
 * recipient status, artifact download and Connect verification are the operations ES.9, ES.11 and ES.15
 * deliver, and until they exist this adapter declares them `false`.
 *
 * That distinction is load-bearing in two places:
 *
 * 1. `capabilities` is the honest answer the gate reads (`ESignatureConnectionGate.supportedOnProvider`
 *    asks the *bound* adapter), so a production installation refuses a send with
 *    `NOT_SUPPORTED_BY_PROVIDER` rather than admitting an operation whose code does not exist yet
 *    (plan §5.2: no silent no-op).
 * 2. The unimplemented methods are present because the port requires them, and every one throws
 *    `NotSupportedByProviderError`. It is a fence, not a door: the registry refuses before dispatch, so
 *    reaching that body means a caller bypassed the gate — and a caller that did gets a refusal, not a
 *    request that half-happened.
 *
 * Nothing in this file knows what a CRM request, a recipient row or a permission is. It receives a
 * `SignatureProviderContext` — account id, base URI, short-lived bearer — and returns normalized
 * results. Vendor payload shapes stop here (plan §1.2).
 */

/** The eSignature REST version the adapter speaks (audit §4: v2.1 only). */
export const DOCUSIGN_REST_VERSION = 'v2.1';

/** What this adapter can do today: the whole initial slice except correction. */
export const DOCUSIGN_ES4_CAPABILITIES: SignatureProviderCapabilities = Object.freeze({
  ...BASE_SIGNATURE_PROVIDER_CAPABILITIES,
  // ES.7 — the template catalog, read-only (plan §6.7 forbids updating a provider template).
  listTemplates: true,
  templateDetails: true,
  // ES.9 — envelope preparation. ES.10 — the deliberate send of that draft.
  prepareEnvelope: true,
  sendEnvelope: true,
  // ES.11/ES.12 — status and event synchronization.
  envelopeStatus: true,
  listRecipients: true,
  verifyWebhook: true,
  // ES.14 — embedded signing. ES.16 — reminder/resend and void.
  recipientView: true,
  resendNotifications: true,
  voidEnvelope: true,
  // ES.15 — completed documents and the certificate of completion.
  downloadCompletedDocuments: true,
  downloadCompletionEvidence: true,
  // Plan §5.2/§16: correction is an exception path whose live behaviour is verified in ES.22.
  correctEnvelope: false,
});

/** A stable code for the health view. Never a provider body, never a token. */
export const DOCUSIGN_DETAIL_CODES = [
  'ok',
  'token_expired',
  'access_denied',
  'account_not_found',
  'rate_limited',
  'provider_outage',
  'unreachable',
  'destination_refused',
  'response_invalid',
] as const;
export type DocuSignDetailCode = (typeof DOCUSIGN_DETAIL_CODES)[number];

export class DocuSignAdapter implements SignatureProviderAdapter {
  readonly providerKey = PROVIDER_KEY_DOCUSIGN;
  readonly adapterVersion = '1.0.0';
  readonly providerApiVersion = DOCUSIGN_REST_VERSION;
  /** A live integration. It can only act on a credential the platform resolved from the vault. */
  readonly mode = 'live' as const;
  readonly capabilities = DOCUSIGN_ES4_CAPABILITIES;
  /** DocuSign creates an unsent envelope first; sending it is a separate, deliberate call. */
  readonly envelopeDrafting = 'draft' as const;

  constructor(private readonly transport: DocuSignTransport) {}

  /**
   * Test Connection (plan §13.4 "verify the connection, selected account, environment").
   *
   * The cheapest authenticated read that proves all three things at once: the bearer token is accepted,
   * the account id resolves, and the account-specific base URI actually answers. A one-item envelope
   * listing is used rather than `GET /accounts/{id}` because the account record requires administrator
   * rights, and the `signature` scope this module requests does not grant them.
   *
   * It performs **no write**. A failed test is a result, not an exception, so the admin screen can show
   * which link in the chain broke.
   */
  async connectionStatus(context: SignatureProviderContext): Promise<ProviderConnectionStatus> {
    const url = `${restBase(context.baseUri)}/accounts/${encodeURIComponent(context.accountId)}/envelopes?count=1`;
    const checkedAt = new Date().toISOString();
    try {
      const response = await this.transport.request({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${context.accessToken}` },
        timeoutMs: context.timeoutMs,
      });
      if (response.status >= 400) {
        return { reachable: false, checkedAt: checkedAt, detailCode: detailCodeForStatus(response.status) };
      }
      // A 2xx whose body is not a JSON object is not a healthy answer: an HTML error page served by a
      // proxy would otherwise look like success to a caller that only read the status.
      const body = parseJson(response.body);
      const shaped = Object.keys(body).length > 0;
      return { reachable: shaped, checkedAt: checkedAt, detailCode: shaped ? 'ok' : 'response_invalid' };
    } catch (error) {
      return { reachable: false, checkedAt: checkedAt, detailCode: detailCodeForError(error) };
    }
  }

  /**
   * Re-read the account context through the REST host.
   *
   * `GET /restapi/v2.1/userinfo` returns the accounts the token reaches, each with its own
   * `base_uri`. That is what lets an operator see that a connection's stored account still exists, and
   * it is the same call that resolved the account at authorization time — so a drift between the two is
   * a `reauthorization_required` signal, not a silent success (plan §9.2).
   */
  async accountContext(context: SignatureProviderContext): Promise<ProviderAccountContext> {
    const response = await this.transport.request({
      method: 'GET',
      url: `${restBase(context.baseUri)}/userinfo`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      timeoutMs: context.timeoutMs,
    });
    if (response.status >= 400) throw providerErrorForStatus(response.status);
    const info = parseDocuSignUserinfo(parseJson(response.body));
    // The connection already named an account; re-reading must not silently move it to another one.
    const account = selectDocuSignAccount(info, context.accountId);
    return {
      accountId: account.accountId,
      accountName: account.accountName,
      baseUri: account.baseUri,
      userId: info.subjectUserId,
      // DocuSign's userinfo does not echo scopes; the granted set the connection recorded stands.
      grantedScopes: context.grantedScopes,
    };
  }

  /**
   * The account's template catalog.
   *
   * `count=100` is the page size the plan's admin screen can use; DocuSign caps a single page and
   * reports `totalSetSize`, which this method returns nothing about on purpose — the screen refreshes
   * the first page and ES.7 keeps the catalog read-only, so pagination is a later concern, not a
   * silent truncation of a mapping (this method never decides *which* template is valid; the detail
   * call does).
   */
  async listTemplates(context: SignatureProviderContext): Promise<readonly ProviderTemplateSummary[]> {
    const response = await this.transport.request({
      method: 'GET',
      url: `${restBase(context.baseUri)}/accounts/${encodeURIComponent(context.accountId)}/templates?count=100&order_by=name&order=asc`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      timeoutMs: context.timeoutMs,
    });
    if (response.status >= 400) throw providerErrorForStatus(response.status);
    const body = parseJson(response.body);
    const entries = Array.isArray(body['templates']) ? body['templates'] : [];
    const templates: ProviderTemplateSummary[] = [];
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const template = entry as Record<string, unknown>;
      const templateId = stringOf(template['templateId']);
      if (templateId === null) continue;
      templates.push({
        templateId,
        name: stringOf(template['name']) ?? templateId,
        description: stringOf(template['description']),
        shared: template['shared'] === 'true' || template['shared'] === true,
        status: stringOf(template['status']),
      });
    }
    return templates;
  }

  /**
   * One template's roles and tabs.
   *
   * A mapping is validated against this answer, so it is read as data and never as instructions: roles
   * come from `recipients.signers` / `recipients.carbonCopies`, and tabs from each document's
   * `tabs.<kind>Tabs` collection, with the role resolved through the tab's `recipientId`. A tab whose
   * recipient is unknown keeps `roleName: null` rather than being guessed into a role.
   */
  async templateDetails(context: SignatureProviderContext, templateId: string): Promise<ProviderTemplateDetail> {
    const id = templateId.trim();
    if (id === '') {
      throw new ProviderError('INVALID_REQUEST', 'A template id is required.', { category: 'permanent_validation', retryable: false });
    }
    const response = await this.transport.request({
      method: 'GET',
      url: `${restBase(context.baseUri)}/accounts/${encodeURIComponent(context.accountId)}/templates/${encodeURIComponent(id)}`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      timeoutMs: context.timeoutMs,
    });
    if (response.status >= 400) {
      if (response.status === 404) {
        throw new ProviderError('NOT_FOUND', 'The signature provider has no such template in this account.', {
          category: 'not_found',
          retryable: false,
          detail: 'template_not_found',
          status: 404,
        });
      }
      throw providerErrorForStatus(response.status);
    }
    const body = parseJson(response.body);
    const recipients = asObject(body['recipients']);
    const roles: ProviderTemplateRole[] = [];
    const roleByRecipientId = new Map<string, string>();
    for (const [key, recipientType] of [
      ['signers', 'signer'],
      ['carbonCopies', 'carbon_copy'],
    ] as const) {
      const list = Array.isArray(recipients[key]) ? (recipients[key] as unknown[]) : [];
      for (const entry of list) {
        const recipient = asObject(entry);
        const roleName = stringOf(recipient['roleName']);
        if (roleName === null) continue;
        const routingOrder = Number(recipient['routingOrder']);
        roles.push({
          roleName,
          recipientType,
          routingOrder: Number.isFinite(routingOrder) && routingOrder > 0 ? routingOrder : null,
          // A template role is a slot the sender must fill; DocuSign has no "optional role" flag.
          required: true,
        });
        const recipientId = stringOf(recipient['recipientId']);
        if (recipientId !== null) roleByRecipientId.set(recipientId, roleName);
      }
    }

    const fields: ProviderTemplateField[] = [];
    const documents = Array.isArray(body['documents']) ? (body['documents'] as unknown[]) : [];
    for (const entry of documents) {
      const document = asObject(entry);
      const documentId = stringOf(document['documentId']);
      const tabs = asObject(document['tabs']);
      for (const kind of DOCUSIGN_TAB_KINDS) {
        const list = Array.isArray(tabs[kind]) ? (tabs[kind] as unknown[]) : [];
        for (const raw of list) {
          const tab = asObject(raw);
          const tabLabel = stringOf(tab['tabLabel']) ?? stringOf(tab['name']);
          if (tabLabel === null) continue;
          const recipientId = stringOf(tab['recipientId']);
          fields.push({
            tabLabel,
            roleName: recipientId === null ? null : roleByRecipientId.get(recipientId) ?? null,
            documentId,
            fieldType: kind.replace(/Tabs$/, ''),
            required: tab['required'] === 'true' || tab['required'] === true,
          });
        }
      }
    }

    return {
      templateId: stringOf(body['templateId']) ?? id,
      name: stringOf(body['name']) ?? id,
      description: stringOf(body['description']),
      shared: body['shared'] === 'true' || body['shared'] === true,
      status: stringOf(body['status']),
      roles,
      fields,
    };
  }

  /**
   * Create the provider-side **draft** envelope (plan §4.3, §18 `19-ES.9`).
   *
   * `status: 'created'` is DocuSign's "draft": nothing is emailed, no signer is invited, and the
   * envelope can still be replaced or deleted. The local request is not marked sent here — ES.10's
   * send is the only thing that moves it to `sending`.
   *
   * Two shapes, chosen by whether the request carries a template:
   *
   *  - **template** — `templateId` + `templateRoles` (name, email, role, routing) with the mapped tab
   *    values nested under the role they belong to. The template supplies the documents.
   *  - **documents** — the snapshotted bytes as base64 with a name and extension, and `recipients`
   *    with the same routing and the same tab placement.
   *
   * The idempotency key and the request id travel as text custom fields, so a human looking at the
   * DocuSign account can tell which CRM request an envelope belongs to even after a lost response.
   */
  async prepareEnvelope(context: SignatureProviderContext, input: PrepareEnvelopeInput): Promise<PreparedEnvelope> {
    const customFields = {
      textCustomFields: [
        { name: 'CRMRequestId', value: input.signatureRequestId, required: 'false', show: 'true' },
        { name: 'CRMPrepareKey', value: input.idempotencyKey, required: 'false', show: 'true' },
      ],
    };
    const body =
      input.templateId !== null
        ? {
            status: 'created',
            emailSubject: input.subject ?? 'Please sign',
            ...(input.emailBlurb === null ? {} : { emailBlurb: input.emailBlurb }),
            templateId: input.templateId,
            // Only a template envelope has template roles; a document envelope addresses recipients by id.
            templateRoles: templateRolesFor(input),
            customFields,
          }
        : {
            status: 'created',
            emailSubject: input.subject ?? 'Please sign',
            ...(input.emailBlurb === null ? {} : { emailBlurb: input.emailBlurb }),
            documents: input.documents.map((document, index) => ({
              documentId: String(index + 1),
              name: document.displayName,
              fileExtension: extensionOfName(document.displayName),
              documentBase64: Buffer.from(document.bytes).toString('base64'),
            })),
            recipients: documentRecipientsFor(input),
            customFields,
          };

    const response = await this.transport.request({
      method: 'POST',
      url: `${restBase(context.baseUri)}/accounts/${encodeURIComponent(context.accountId)}/envelopes`,
      headers: { authorization: `Bearer ${context.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: context.timeoutMs,
    });
    if (response.status >= 400) throw providerErrorForStatus(response.status);
    const parsed = parseJson(response.body);
    const providerEnvelopeId = stringOf(parsed['envelopeId']);
    if (providerEnvelopeId === null) {
      throw new ProviderError('UNKNOWN', 'DocuSign accepted the envelope request but returned no envelope id.', {
        category: 'permanent_validation',
        retryable: false,
        detail: 'envelope_id_missing',
        status: response.status,
      });
    }
    return {
      providerEnvelopeId,
      status: 'draft',
      preparedAt: stringOf(parsed['statusDateTime']) ?? new Date().toISOString(),
      idempotencyKey: input.idempotencyKey,
      // Our snapshot id → the provider's document id, so later phases can name a document unambiguously.
      providerDocumentIds: Object.fromEntries(input.documents.map((document, index) => [document.documentSnapshotId, String(index + 1)])),
    };
  }

  /**
   * Delete a draft envelope.
   *
   * DocuSign permits deleting an envelope that has not been sent; that is exactly the recovery the
   * plan's ES.9 task asks for. A 404 means it is already gone, which the caller treats as success; a
   * sent envelope is not deleted here (DocuSign refuses, and voiding is ES.16's deliberate action).
   */
  async abandonDraftEnvelope(context: SignatureProviderContext, providerEnvelopeId: string): Promise<{ deleted: boolean }> {
    const id = providerEnvelopeId.trim();
    if (id === '') return { deleted: false };
    const response = await this.transport.request({
      method: 'DELETE',
      url: `${restBase(context.baseUri)}/accounts/${encodeURIComponent(context.accountId)}/envelopes/${encodeURIComponent(id)}`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      timeoutMs: context.timeoutMs,
    });
    if (response.status === 404) return { deleted: false };
    if (response.status >= 400) throw providerErrorForStatus(response.status);
    return { deleted: true };
  }

  /**
   * Send the prepared draft (plan §4.3, §18 `19-ES.10`).
   *
   * DocuSign's send is `PUT /envelopes/{id}` with `status: 'sent'`; that is the one irreversible act in
   * this module, so its failure handling is asymmetric on purpose:
   *
   *  - a **4xx** is a definite refusal — the envelope was not sent, and the request may be corrected and
   *    tried again;
   *  - a **transport failure or a 5xx** means the provider may have accepted the request and only the
   *    answer was lost, so it is raised as `SendOutcomeUnknownError` and the platform never retries it;
   *  - a **429** is a definite refusal with the provider's own guidance attached.
   *
   * The recipients are returned as the provider reported them so the local projection can start from
   * facts rather than from an assumption that "sent" means "everyone was notified".
   */
  async sendEnvelope(context: SignatureProviderContext, input: SendEnvelopeInput): Promise<SentEnvelope> {
    let response;
    try {
      response = await this.transport.request({
        method: 'PUT',
        url: `${restBase(context.baseUri)}/accounts/${encodeURIComponent(context.accountId)}/envelopes/${encodeURIComponent(input.providerEnvelopeId)}`,
        headers: { authorization: `Bearer ${context.accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'sent' }),
        timeoutMs: context.timeoutMs,
      });
    } catch (error) {
      // The request may have reached DocuSign. Never let a lost answer become a retry.
      if (error instanceof ProviderError && (error.category === 'authorization' || error.category === 'rate_limited')) throw error;
      throw new SendOutcomeUnknownError({
        correlationId: input.correlationId ?? 'unknown',
        idempotencyKey: input.idempotencyKey,
        providerEnvelopeId: input.providerEnvelopeId,
      });
    }
    if (response.status >= 500) {
      throw new SendOutcomeUnknownError({
        correlationId: input.correlationId ?? 'unknown',
        idempotencyKey: input.idempotencyKey,
        providerEnvelopeId: input.providerEnvelopeId,
      });
    }
    if (response.status >= 400) throw providerErrorForStatus(response.status);

    const body = parseJson(response.body);
    const recipients = Array.isArray(body['recipients'])
      ? (body['recipients'] as unknown[]).flatMap((entry) => parseSentRecipient(entry))
      : [];
    return {
      providerEnvelopeId: stringOf(body['envelopeId']) ?? input.providerEnvelopeId,
      status: 'sent',
      providerStatusRaw: stringOf(body['status']) ?? 'sent',
      sentAt: stringOf(body['statusDateTime']) ?? new Date().toISOString(),
      recipients,
    };
  }

  /**
   * The provider's current view of the envelope, for reconciliation (ES.12).
   *
   * A read. It returns the normalized state and the raw word beside it, plus the recipients the
   * provider reports, so a reconciliation can project both without a second call.
   */
  async envelopeStatus(context: SignatureProviderContext, providerEnvelopeId: string): Promise<ProviderEnvelopeStatus> {
    const id = providerEnvelopeId.trim();
    if (id === '') throw invalidEnvelopeId();
    const response = await this.transport.request({
      method: 'GET',
      url: `${restBase(context.baseUri)}/accounts/${encodeURIComponent(context.accountId)}/envelopes/${encodeURIComponent(id)}`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      timeoutMs: context.timeoutMs,
    });
    if (response.status >= 400) throw providerErrorForStatus(response.status);
    const body = parseJson(response.body);
    const statusRaw = stringOf(body['status']);
    const recipients = parseRecipientCollections(body['recipients']);
    return {
      providerEnvelopeId: id,
      status: normalizeEnvelopeStatus(statusRaw) ?? 'unknown',
      providerStatusRaw: statusRaw ?? 'unknown',
      occurredAt: stringOf(body['statusDateTime']),
      recipients,
    };
  }

  async listRecipients(context: SignatureProviderContext, providerEnvelopeId: string): Promise<readonly ProviderRecipientStatus[]> {
    const id = providerEnvelopeId.trim();
    if (id === '') throw invalidEnvelopeId();
    const response = await this.transport.request({
      method: 'GET',
      url: `${restBase(context.baseUri)}/accounts/${encodeURIComponent(context.accountId)}/envelopes/${encodeURIComponent(id)}/recipients`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      timeoutMs: context.timeoutMs,
    });
    if (response.status >= 400) throw providerErrorForStatus(response.status);
    return parseRecipientCollections(parseJson(response.body));
  }

  /**
   * Ask DocuSign for one signer's embedded signing URL (ES.14).
   *
   * The recipient must have been created with the same `clientUserId` this module uses locally (its
   * recipient row id), which is why only a draft marked `embedded` sets one at preparation. The
   * answer's URL is a bearer credential: it is returned to the caller and never written anywhere.
   */
  async recipientView(context: SignatureProviderContext, input: RecipientViewInput): Promise<RecipientView> {
    const response = await this.transport.request({
      method: 'POST',
      url: `${restBase(context.baseUri)}/accounts/${encodeURIComponent(context.accountId)}/envelopes/${encodeURIComponent(input.providerEnvelopeId)}/views/recipient`,
      headers: { authorization: `Bearer ${context.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        returnUrl: input.returnUrl,
        authenticationMethod: 'none',
        email: input.email,
        userName: input.name,
        recipientId: input.recipientProviderId,
        clientUserId: input.recipientId,
        ...(input.cancelUrl === null ? {} : { cancelUrl: input.cancelUrl }),
      }),
      timeoutMs: context.timeoutMs,
    });
    if (response.status >= 400) throw providerErrorForStatus(response.status);
    const url = stringOf(parseJson(response.body)['url']);
    if (url === null) {
      throw new ProviderError('UNKNOWN', 'DocuSign returned no signing URL.', {
        category: 'permanent_validation',
        retryable: false,
        detail: 'recipient_view_url_missing',
      });
    }
    // DocuSign's recipient-view URLs are short-lived; five minutes is the conservative answer a caller
    // may show, not an expiry the provider promised. The URL itself is never stored.
    return { url, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() };
  }

  /** Resend the invitation to the outstanding recipients (ES.16). */
  async resendNotifications(context: SignatureProviderContext, input: ResendNotificationsInput): Promise<ResendResult> {
    const ids = input.recipientProviderIds.map((id) => id.trim()).filter((id) => id !== '');
    const response = await this.transport.request({
      method: 'PUT',
      url: `${restBase(context.baseUri)}/accounts/${encodeURIComponent(context.accountId)}/envelopes/${encodeURIComponent(input.providerEnvelopeId)}/recipients`,
      headers: { authorization: `Bearer ${context.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        resend_envelope: 'true',
        ...(ids.length === 0 ? {} : { signers: ids.map((recipientId) => ({ recipientId })) }),
      }),
      timeoutMs: context.timeoutMs,
    });
    if (response.status >= 400) throw providerErrorForStatus(response.status);
    const body = parseJson(response.body);
    return {
      resentAt: stringOf(body['statusDateTime']) ?? new Date().toISOString(),
      providerStatusRaw: stringOf(body['status']) ?? 'sent',
    };
  }

  /** Withdraw a sent envelope with a recorded reason (ES.16). */
  async voidEnvelope(context: SignatureProviderContext, input: VoidEnvelopeInput): Promise<VoidResult> {
    const response = await this.transport.request({
      method: 'PUT',
      url: `${restBase(context.baseUri)}/accounts/${encodeURIComponent(context.accountId)}/envelopes/${encodeURIComponent(input.providerEnvelopeId)}`,
      headers: { authorization: `Bearer ${context.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'voided', voidedReason: input.reason.slice(0, 500) }),
      timeoutMs: context.timeoutMs,
    });
    if (response.status >= 400) throw providerErrorForStatus(response.status);
    const body = parseJson(response.body);
    return {
      voidedAt: stringOf(body['statusDateTime']) ?? new Date().toISOString(),
      providerStatusRaw: stringOf(body['status']) ?? 'voided',
    };
  }

  /**
   * The signed documents as new artifacts (ES.15).
   *
   * The list call names each document; the bytes are fetched one by one and hashed locally, because
   * the content hash is what makes a retried retrieval a no-op. A certificate in the list is skipped:
   * it is completion evidence, not a signed document.
   */
  async downloadCompletedDocuments(context: SignatureProviderContext, providerEnvelopeId: string): Promise<readonly ProviderArtifact[]> {
    const id = providerEnvelopeId.trim();
    if (id === '') throw invalidEnvelopeId();
    const list = await this.transport.request({
      method: 'GET',
      url: `${restBase(context.baseUri)}/accounts/${encodeURIComponent(context.accountId)}/envelopes/${encodeURIComponent(id)}/documents`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      timeoutMs: context.timeoutMs,
    });
    if (list.status >= 400) throw providerErrorForStatus(list.status);
    const body = parseJson(list.body);
    const entries = Array.isArray(body['envelopeDocuments']) ? (body['envelopeDocuments'] as unknown[]) : [];
    const documents = entries
      .map((entry) => parseEnvelopeDocument(entry))
      .filter((entry): entry is { documentId: string; name: string; mimeType: string } => entry !== null)
      .filter((entry) => entry.documentId !== 'certificate');

    const artifacts: ProviderArtifact[] = [];
    for (const document of documents) {
      const bytes = await this.downloadDocumentBytes(context, id, document.documentId);
      artifacts.push({
        artifactKind: 'provider_signed_document',
        providerDocumentId: document.documentId,
        displayName: document.name,
        mimeType: document.mimeType,
        bytes,
        contentHashSha256: sha256(bytes),
        retrievedAt: new Date().toISOString(),
      });
    }
    if (artifacts.length > 0) return artifacts;

    // No list (an older account, or a response shape this adapter does not know): the combined PDF is
    // the provider's own single signed document, and it is better than losing the evidence.
    const combined = await this.downloadDocumentBytes(context, id, 'combined');
    return [
      {
        artifactKind: 'provider_signed_document',
        providerDocumentId: 'combined',
        displayName: 'signed-document.pdf',
        mimeType: 'application/pdf',
        bytes: combined,
        contentHashSha256: sha256(combined),
        retrievedAt: new Date().toISOString(),
      },
    ];
  }

  /** The provider's certificate of completion, as a derived artifact (ES.15). */
  async downloadCompletionEvidence(context: SignatureProviderContext, providerEnvelopeId: string): Promise<readonly ProviderArtifact[]> {
    const id = providerEnvelopeId.trim();
    if (id === '') throw invalidEnvelopeId();
    const bytes = await this.downloadDocumentBytes(context, id, 'certificate');
    return [
      {
        artifactKind: 'completion_evidence',
        providerDocumentId: 'certificate',
        displayName: 'certificate-of-completion.pdf',
        mimeType: 'application/pdf',
        bytes,
        contentHashSha256: sha256(bytes),
        retrievedAt: new Date().toISOString(),
      },
    ];
  }

  /**
   * Verify and normalize one Connect delivery (ES.11).
   *
   * Verification happens before a single payload field is trusted. Both the modern Connect JSON shape
   * (`event` + `data.*`) and the simplified shape the fake and older configurations use are read;
   * the exact fixture is confirmed against a demo account in ES.22, and this parser is the one place
   * a correction belongs.
   */
  async verifyAndParseWebhook(input: VerifyWebhookInput): Promise<ProviderWebhookNotification> {
    const payloadHash = rawBodyHash(input.rawBody);
    const receivedAt = new Date().toISOString();
    if (input.rawBody.byteLength > input.maxPayloadBytes) return unverifiedWebhook('too_large', payloadHash, receivedAt);

    if (input.requireSignature) {
      const check = verifyConnectSignature({
        secret: input.signingSecret,
        rawBody: input.rawBody,
        signature: readSignatureHeaders(input.headers),
        maxPayloadBytes: input.maxPayloadBytes,
      });
      if (!check.valid) return unverifiedWebhook(check.reason ?? 'invalid_signature', payloadHash, receivedAt);
    }

    if (input.contentType !== null && input.contentType.trim() !== '' && !input.contentType.toLowerCase().includes('json')) {
      return unverifiedWebhook('malformed', payloadHash, receivedAt);
    }

    let parsed: Record<string, unknown>;
    try {
      const decoded: unknown = JSON.parse(new TextDecoder().decode(input.rawBody));
      if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) return unverifiedWebhook('malformed', payloadHash, receivedAt);
      parsed = decoded as Record<string, unknown>;
    } catch {
      return unverifiedWebhook('malformed', payloadHash, receivedAt);
    }

    const connect = asObject(parsed['data']);
    const providerAccountId = stringOf(connect['accountId']) ?? stringOf(parsed['account_id']);
    if (input.expectedAccountId !== null && input.expectedAccountId !== undefined && providerAccountId !== null && providerAccountId !== input.expectedAccountId) {
      return unverifiedWebhook('account_mismatch', payloadHash, receivedAt);
    }

    const eventTypeRaw = stringOf(parsed['event']) ?? stringOf(parsed['event_type']);
    const providerEnvelopeId = stringOf(connect['envelopeId']) ?? stringOf(parsed['envelope_id']);
    const providerEventId = stringOf(parsed['event_id']) ?? stringOf(connect['eventId']);
    const recipient = connectRecipient(connect);
    const recipientStatusRaw =
      recipient.status ?? stringOf(connect['recipientStatus']) ?? stringOf(parsed['recipient_status']);
    const recipientProviderId = stringOf(connect['recipientId']) ?? stringOf(parsed['recipient_id']);
    const occurredAt =
      stringOf(parsed['generatedDateTime']) ?? stringOf(connect['occurredAt']) ?? stringOf(parsed['occurred_at']);
    const eventTypeNormalized = normalizeProviderEventType(eventTypeRaw);

    return {
      verified: true,
      refusalReason: null,
      providerEventId,
      providerEnvelopeId,
      providerAccountId,
      eventTypeRaw,
      eventTypeNormalized,
      recipientProviderId,
      recipientStatusRaw,
      occurredAt,
      // Minimized on purpose: identity and status, never a document, an email or a name (plan §12.1).
      minimized: {
        envelopeId: providerEnvelopeId,
        eventType: eventTypeRaw,
        recipientId: recipientProviderId,
        recipientStatus: recipientStatusRaw,
      },
      payloadHash,
      receivedAt,
    };
  }

  private async downloadDocumentBytes(context: SignatureProviderContext, envelopeId: string, documentId: string): Promise<Uint8Array> {
    const response = await this.transport.request({
      method: 'GET',
      url: `${restBase(context.baseUri)}/accounts/${encodeURIComponent(context.accountId)}/envelopes/${encodeURIComponent(envelopeId)}/documents/${encodeURIComponent(documentId)}`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      timeoutMs: context.timeoutMs,
      binary: true,
    });
    if (response.status >= 400) throw providerErrorForStatus(response.status);
    if (response.bytes !== undefined) return response.bytes;
    return new TextEncoder().encode(response.body);
  }
}

/**
 * The DocuSign REST root for a connection.
 *
 * `base_uri` comes from `userinfo` and already names the data center, so nothing here infers a host
 * (audit §4: "never hard-code a data center host"). A trailing slash is normalized away rather than
 * producing `//restapi`.
 */
export function restBase(baseUri: string): string {
  const trimmed = baseUri.trim().replace(/\/+$/, '');
  return `${trimmed}/restapi/${DOCUSIGN_REST_VERSION}`;
}

/** The safe one-word reason a health check failed, for the connection view and the audit detail. */
export function detailCodeForStatus(status: number): DocuSignDetailCode {
  if (status === 401) return 'token_expired';
  if (status === 403) return 'access_denied';
  if (status === 404) return 'account_not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_outage';
  return 'response_invalid';
}

/** A recipient DocuSign reported back after the send, normalized to the contract's vocabulary. */
function parseSentRecipient(entry: unknown): ProviderRecipientStatus[] {
  const recipient = asObject(entry);
  const providerRecipientId = stringOf(recipient['recipientId']);
  const status = stringOf(recipient['status']);
  if (providerRecipientId === null || status === null) return [];
  return [
    {
      providerRecipientId,
      recipientId: stringOf(recipient['clientUserId']) ?? providerRecipientId,
      status: normalizeRecipientStatus(status) ?? 'unknown',
      providerStatusRaw: status,
      name: stringOf(recipient['name']) ?? '',
      email: stringOf(recipient['email']) ?? '',
      routingOrder: Number(recipient['routingOrder']) || 0,
      roleName: stringOf(recipient['roleName']),
      occurredAt: stringOf(recipient['statusDateTime']),
      declineReasonSafe: null,
    },
  ];
}

/** Every recipient collection DocuSign may use on an envelope or a recipient listing. */
function parseRecipientCollections(value: unknown): ProviderRecipientStatus[] {
  const collections = asObject(value);
  const out: ProviderRecipientStatus[] = [];
  for (const key of ['signers', 'carbonCopies', 'inPersonSigners', 'certifiedDeliveries'] as const) {
    const list = Array.isArray(collections[key]) ? (collections[key] as unknown[]) : [];
    for (const entry of list) out.push(...parseSentRecipient(entry));
  }
  return out;
}

/** One entry of `GET /envelopes/{id}/documents`. */
function parseEnvelopeDocument(entry: unknown): { documentId: string; name: string; mimeType: string } | null {
  const document = asObject(entry);
  const documentId = stringOf(document['documentId']);
  if (documentId === null) return null;
  const name = stringOf(document['name']) ?? stringOf(document['documentName']) ?? `document-${documentId}.pdf`;
  return {
    documentId,
    name: name.slice(0, 250),
    mimeType: name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream',
  };
}

/** The recipient a Connect payload names, when it names one. */
function connectRecipient(connect: Record<string, unknown>): { status: string | null } {
  const recipients = asObject(connect['recipients']);
  const recipientId = stringOf(connect['recipientId']);
  for (const key of ['signers', 'carbonCopies', 'inPersonSigners'] as const) {
    const list = Array.isArray(recipients[key]) ? (recipients[key] as unknown[]) : [];
    for (const entry of list) {
      const recipient = asObject(entry);
      if (recipientId === null || stringOf(recipient['recipientId']) === recipientId) {
        return { status: stringOf(recipient['status']) };
      }
    }
  }
  return { status: null };
}

function invalidEnvelopeId(): ProviderError {
  return new ProviderError('INVALID_REQUEST', 'A provider envelope id is required.', {
    category: 'permanent_validation',
    retryable: false,
    detail: 'envelope_id_missing',
  });
}

function unverifiedWebhook(
  reason: NonNullable<ProviderWebhookNotification['refusalReason']>,
  payloadHash: string,
  receivedAt: string,
): ProviderWebhookNotification {
  return {
    verified: false,
    refusalReason: reason,
    providerEventId: null,
    providerEnvelopeId: null,
    providerAccountId: null,
    eventTypeRaw: null,
    eventTypeNormalized: 'unmapped',
    recipientProviderId: null,
    recipientStatusRaw: null,
    occurredAt: null,
    minimized: {},
    payloadHash,
    receivedAt,
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The lower-case extension DocuSign expects for a document, defaulting to `pdf` when a name has none. */
function extensionOfName(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '') : '';
  return ext === '' ? 'pdf' : ext;
}

/** Group the mapped tab values by the role that fills them. */
function tabsByRole(input: PrepareEnvelopeInput): Map<string | null, { tabLabel: string; value: string }[]> {
  const grouped = new Map<string | null, { tabLabel: string; value: string }[]>();
  for (const field of input.mappedFields ?? []) {
    const list = grouped.get(field.roleName) ?? [];
    list.push({ tabLabel: field.tabLabel, value: field.value });
    grouped.set(field.roleName, list);
  }
  return grouped;
}

/** How a tab with no role is placed: only allowed when the envelope has exactly one role to put it on. */
function soleRole(input: PrepareEnvelopeInput): string | null {
  const roles = [...new Set(input.recipients.map((recipient) => recipient.roleName).filter((role): role is string => role !== null))];
  return roles.length === 1 ? roles[0] ?? null : null;
}

function tabsForRole(input: PrepareEnvelopeInput, roleName: string | null): { textTabs: { tabLabel: string; value: string }[] } | undefined {
  const grouped = tabsByRole(input);
  const unresolvable = grouped.get(null) ?? [];
  const own = grouped.get(roleName) ?? [];
  if (roleName === null) return own.length === 0 ? undefined : { textTabs: own };
  const fallback = soleRole(input) === roleName ? unresolvable : [];
  const tabs = [...own, ...fallback];
  return tabs.length === 0 ? undefined : { textTabs: tabs };
}

/**
 * The `templateRoles` DocuSign expects: one entry per recipient that names a template role, with the
 * mapped tabs nested under it. A recipient without a role cannot fill a template role, and an
 * unresolvable tab (no role, several roles in the template) is refused rather than guessed.
 */
function templateRolesFor(input: PrepareEnvelopeInput): {
  email: string;
  name: string;
  roleName: string;
  routingOrder: number;
  clientUserId?: string;
  tabs?: { textTabs: { tabLabel: string; value: string }[] };
}[] {
  const grouped = tabsByRole(input);
  if ((grouped.get(null) ?? []).length > 0 && soleRole(input) === null) {
    throw new ProviderError('INVALID_REQUEST', 'A mapped tab has no role, and this template has more than one role to choose from.', {
      category: 'permanent_validation',
      retryable: false,
      detail: 'tab_role_required',
    });
  }
  const roles = input.recipients.filter((recipient) => recipient.roleName !== null);
  if (roles.length !== input.recipients.length) {
    throw new ProviderError('INVALID_REQUEST', 'Every recipient of a template envelope must name its template role.', {
      category: 'permanent_validation',
      retryable: false,
      detail: 'template_role_missing',
    });
  }
  return roles.map((recipient) => {
    const tabs = tabsForRole(input, recipient.roleName);
    return {
      email: recipient.email,
      name: recipient.name,
      roleName: recipient.roleName ?? '',
      routingOrder: recipient.routingOrder,
      ...(recipient.clientUserId === null ? {} : { clientUserId: recipient.clientUserId }),
      ...(tabs === undefined ? {} : { tabs }),
    };
  });
}

/** The `recipients` DocuSign expects for a document envelope, with the same tab placement. */
function documentRecipientsFor(input: PrepareEnvelopeInput): {
  signers: { email: string; name: string; recipientId: string; routingOrder: number; clientUserId?: string; tabs?: { textTabs: { tabLabel: string; value: string }[] } }[];
  carbonCopies: { email: string; name: string; recipientId: string; routingOrder: number; clientUserId?: string }[];
} {
  const grouped = tabsByRole(input);
  if ((grouped.get(null) ?? []).length > 0 && soleRole(input) === null) {
    throw new ProviderError('INVALID_REQUEST', 'A mapped tab has no role, and this request has more than one role to choose from.', {
      category: 'permanent_validation',
      retryable: false,
      detail: 'tab_role_required',
    });
  }
  const toSigner = (recipient: PrepareEnvelopeInput['recipients'][number]): { email: string; name: string; recipientId: string; routingOrder: number; clientUserId?: string; tabs?: { textTabs: { tabLabel: string; value: string }[] } } => {
    const tabs = tabsForRole(input, recipient.roleName);
    return {
      email: recipient.email,
      name: recipient.name,
      recipientId: recipient.recipientId,
      routingOrder: recipient.routingOrder,
      ...(recipient.clientUserId === null ? {} : { clientUserId: recipient.clientUserId }),
      ...(tabs === undefined ? {} : { tabs }),
    };
  };
  return {
    signers: input.recipients.filter((recipient) => recipient.recipientType === 'signer').map(toSigner),
    carbonCopies: input.recipients
      .filter((recipient) => recipient.recipientType === 'carbon_copy')
      .map((recipient) => ({
        email: recipient.email,
        name: recipient.name,
        recipientId: recipient.recipientId,
        routingOrder: recipient.routingOrder,
        ...(recipient.clientUserId === null ? {} : { clientUserId: recipient.clientUserId }),
      })),
  };
}

/** The DocuSign tab collections a template can carry, as they appear in `documents[].tabs`. */
const DOCUSIGN_TAB_KINDS = [
  'textTabs',
  'fullNameTabs',
  'emailTabs',
  'dateTabs',
  'dateSignedTabs',
  'numberTabs',
  'ssnTabs',
  'zipTabs',
  'companyTabs',
  'titleTabs',
  'checkboxTabs',
  'radioGroupTabs',
  'listTabs',
  'noteTabs',
  'signHereTabs',
  'initialHereTabs',
] as const;

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function providerErrorForStatus(status: number): ProviderError {
  const code = status === 401 || status === 403 ? 'TOKEN_EXPIRED' : status === 404 ? 'NOT_FOUND' : status === 429 ? 'RATE_LIMITED' : 'UNKNOWN';
  const category = status === 401 || status === 403 ? 'authorization' : status === 404 ? 'not_found' : status === 429 ? 'rate_limited' : status >= 500 ? 'provider_outage' : 'permanent_validation';
  return new ProviderError(code, `DocuSign answered the account request with HTTP ${String(status)}.`, {
    category,
    retryable: status === 429 || status >= 500,
    detail: detailCodeForStatus(status),
    status,
  });
}

function detailCodeForError(error: unknown): DocuSignDetailCode {
  if (error instanceof ProviderError) {
    if (error.code === 'TIMEOUT' || error.code === 'NETWORK_ERROR') return 'unreachable';
    if (error.category === 'authorization') return 'token_expired';
    if (error.category === 'rate_limited') return 'rate_limited';
    if (error.category === 'provider_outage') return 'provider_outage';
    return 'unreachable';
  }
  // The SSRF gate refused the destination before any socket opened. That is a configuration fact about
  // the stored base URI, and it is reported as itself.
  if (error instanceof Error && error.name === 'DocuSignDestinationError') return 'destination_refused';
  return 'unreachable';
}
