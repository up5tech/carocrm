import { createHash, randomUUID } from 'node:crypto';

import { hmacSha256Hex, timingSafeEquals } from '../../../advanced-integrations/connectors/kit/webhook-signatures.js';
import { ProviderError } from '../../../advanced-integrations/provider-error.js';
import type { ProviderEventType } from '../../esignature-status-mapper.js';
import { DROPBOX_SIGN_CAPABILITIES } from '../signature-provider.catalog.js';
import { NotSupportedByProviderError, SendOutcomeUnknownError } from '../signature-provider.errors.js';
import { PROVIDER_KEY_DROPBOX_SIGN } from '../signature-provider.keys.js';
import {
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
  type SentNewEnvelope,
  type SignatureProviderAdapter,
  type SignatureProviderCapabilities,
  type SignatureProviderContext,
  type VerifyWebhookInput,
  type VoidEnvelopeInput,
  type VoidResult,
} from '../signature-provider.port.js';
import { rawBodyHash } from '../signature-provider-signature.js';
import { DROPBOX_SIGN_API_BASE,DropboxSignApi } from './dropbox-sign-api.js';
import {
  type DropboxSignHttpResponse,
  type DropboxSignTransport,
  encodeMultipart,
  type MultipartPart,
  parseJsonText,
} from './dropbox-sign-transport.js';

/**
 * Phase 19-ES multi-provider follow-on — the Dropbox Sign adapter
 * (`PLAN_Phase_19_ESignature.md` §1.2, §5.2, §9.3, §10).
 *
 * The second live adapter, and the one that proves the provider boundary is real: it speaks a
 * different authentication model (API key, not OAuth), a different request encoding (multipart files,
 * not JSON base64), a different status vocabulary and a different callback format (a `json` field in a
 * multipart POST, verified by an `event_hash` over `event_time + event_type`).
 *
 * **No unsent draft.** API v3's `signature_request/send` creates and notifies in one call, and there
 * is no create-without-send endpoint for email signers. The adapter therefore declares
 * `envelopeDrafting: 'direct'`, refuses `prepareEnvelope` with the contract's stable
 * `NotSupportedByProviderError`, and implements `sendNewEnvelope` — the one call that is the send.
 * The request service checks the flag, so a Dropbox Sign request never shows a "create draft" step
 * that the provider cannot honour.
 *
 * **Two capabilities are deliberately absent**, because their absence is a fact about the API rather
 * than an unfinished method:
 *
 * - `recipientView`: Dropbox Sign requires every signer of a request to use the same flow (all
 *   embedded or none), and embedded requests use a different endpoint. The domain models embedded
 *   signing per recipient, so this adapter refuses an embedded recipient instead of silently sending
 *   an email-only request to someone the CRM promised an in-app session.
 * - `downloadCompletionEvidence`: the audit trail is only inside the downloaded ZIP, and this adapter
 *   does not unpack archives. Signed documents themselves are downloadable.
 *
 * Vendor payloads stop here. Nothing above this file may see a Dropbox Sign field name, status word
 * or error message.
 */

export const DROPBOX_SIGN_ADAPTER_VERSION = '1.0.0';
export const DROPBOX_SIGN_API_VERSION = 'v3';

/** The metadata keys a request carries, so an operator can find it in the Dropbox Sign console. */
const METADATA_REQUEST_ID = 'crm_signature_request_id';
const METADATA_IDEMPOTENCY_KEY = 'crm_idempotency_key';
const METADATA_PROVIDER_KEY = 'crm_provider_key';

/** A stable code for the health view. Never a provider body. */
export const DROPBOX_SIGN_DETAIL_CODES = [
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

export class DropboxSignAdapter implements SignatureProviderAdapter {
  readonly providerKey = PROVIDER_KEY_DROPBOX_SIGN;
  readonly adapterVersion = DROPBOX_SIGN_ADAPTER_VERSION;
  readonly providerApiVersion = DROPBOX_SIGN_API_VERSION;
  readonly mode = 'live' as const;
  readonly capabilities: SignatureProviderCapabilities = DROPBOX_SIGN_CAPABILITIES;
  /** API v3 has no unsent draft: the create call is the send. */
  readonly envelopeDrafting = 'direct' as const;

  constructor(private readonly transport: DropboxSignTransport) {}

  /**
   * Test Connection: `GET /account`, the cheapest authenticated read that proves the key and the
   * account. A failure is a result, not an exception, so the admin screen can show which link broke.
   */
  async connectionStatus(context: SignatureProviderContext): Promise<ProviderConnectionStatus> {
    const checkedAt = new Date().toISOString();
    try {
      const account = await this.api(context).account(context.timeoutMs);
      return {
        reachable: account.accountId === context.accountId,
        checkedAt,
        detailCode: account.accountId === context.accountId ? 'ok' : 'account_not_found',
      };
    } catch (error) {
      return { reachable: false, checkedAt, detailCode: detailCodeFor(error) };
    }
  }

  /** Re-read the account identity; a key that now names a different account is not this connection. */
  async accountContext(context: SignatureProviderContext): Promise<ProviderAccountContext> {
    const account = await this.api(context).account(context.timeoutMs);
    if (account.accountId !== context.accountId) {
      throw new ProviderError('ACCOUNT_MISMATCH', 'The API key belongs to a different Dropbox Sign account.', {
        category: 'account_mismatch',
        retryable: false,
        detail: 'account_mismatch',
      });
    }
    return {
      accountId: account.accountId,
      accountName: account.accountName,
      baseUri: DROPBOX_SIGN_API_BASE,
      userId: null,
      grantedScopes: [],
    };
  }

  /** The account's template catalog, first page (100 is the API's maximum page size). */
  async listTemplates(context: SignatureProviderContext): Promise<readonly ProviderTemplateSummary[]> {
    const response = await this.request(context, {
      method: 'GET',
      path: '/template/list',
      query: { account_id: context.accountId, page_size: '100' },
    });
    const body = this.bodyOrThrow(response);
    const entries = Array.isArray(body['templates']) ? body['templates'] : [];
    return entries.filter(isRecord).flatMap((template) => {
      const templateId = stringOf(template['template_id']);
      if (templateId === null) return [];
      return [
        {
          templateId,
          name: stringOf(template['title']) ?? 'Untitled template',
          description: stringOf(template['message']),
          // The API marks a template the caller did not create as one shared by a team member.
          shared: template['is_creator'] === false,
          status: template['is_locked'] === true ? 'locked' : null,
        },
      ];
    });
  }

  /**
   * One template's roles and fields, validated by a mapping before a send.
   *
   * Roles come from `signer_roles` + `cc_roles`; fields come from each document's `form_fields` and
   * `custom_fields`. A field's `signer` is the role that fills it, when the API reports one.
   */
  async templateDetails(context: SignatureProviderContext, templateId: string): Promise<ProviderTemplateDetail> {
    const id = templateId.trim();
    if (id === '') throw new ProviderError('INVALID_REQUEST', 'A template id is required.', { category: 'permanent_validation', retryable: false, detail: 'template_id_missing' });
    const response = await this.request(context, {
      method: 'GET',
      path: `/template/${encodeURIComponent(id)}`,
      query: { account_id: context.accountId },
    });
    const body = this.bodyOrThrow(response);
    const template = isRecord(body['template']) ? body['template'] : null;
    if (template === null) {
      throw new ProviderError('NOT_FOUND', 'Dropbox Sign has no such template.', { category: 'not_found', retryable: false, detail: 'template_not_found' });
    }
    const summary = await this.listTemplates(context).catch(() => [] as readonly ProviderTemplateSummary[]);
    const known = summary.find((entry) => entry.templateId === id);
    return {
      templateId: id,
      name: stringOf(template['title']) ?? known?.name ?? 'Untitled template',
      description: stringOf(template['message']),
      shared: template['is_creator'] === false,
      status: template['is_locked'] === true ? 'locked' : null,
      roles: templateRoles(template),
      fields: templateFields(template),
    };
  }

  /**
   * No provider draft exists, so there is nothing to prepare.
   *
   * The fence is honest: `capabilities.prepareEnvelope` is `false`, the registry refuses before
   * dispatch, and a caller that bypassed it gets the contract's stable refusal rather than a fake
   * envelope id that no provider has ever seen.
   */
  async prepareEnvelope(_context: SignatureProviderContext, _input: PrepareEnvelopeInput): Promise<PreparedEnvelope> {
    throw new NotSupportedByProviderError('prepareEnvelope', PROVIDER_KEY_DROPBOX_SIGN);
  }

  /** No draft exists, so the draft-send operation has nothing to address. */
  async sendEnvelope(_context: SignatureProviderContext, _input: SendEnvelopeInput): Promise<SentEnvelope> {
    throw new NotSupportedByProviderError('sendEnvelope', PROVIDER_KEY_DROPBOX_SIGN);
  }

  /**
   * Create and send the signature request in one call.
   *
   * Documents are uploaded as `multipart/form-data` (the API's file form); a template request is JSON
   * with roles mapped to recipients. The attempt's idempotency key and our request id travel as
   * metadata, so an operator can find a request whose response was lost, and a duplicate is
   * recognisable in the provider console.
   *
   * Every refusal is classified before anything is sent; a 2xx without a `signature_request_id` is
   * *not* treated as success — the provider may have sent it, so the result is the contract's
   * `SendOutcomeUnknownError` and the request goes to reconciliation, never a second attempt.
   */
  async sendNewEnvelope(context: SignatureProviderContext, input: PrepareEnvelopeInput): Promise<SentNewEnvelope> {
    if (input.recipients.length === 0) {
      throw new ProviderError('INVALID_REQUEST', 'A signature request needs at least one recipient.', {
        category: 'permanent_validation',
        retryable: false,
        detail: 'no_recipients',
      });
    }
    const embedded = input.recipients.find((recipient) => recipient.clientUserId !== null || recipient.authenticationMethod === 'embedded');
    if (embedded !== undefined) {
      throw new ProviderError('INVALID_REQUEST', 'Dropbox Sign embedded signing is not supported by this integration.', {
        category: 'permanent_validation',
        retryable: false,
        detail: 'embedded_signing_unsupported',
      });
    }

    const metadata: Record<string, string> = {
      [METADATA_REQUEST_ID]: input.signatureRequestId,
      [METADATA_IDEMPOTENCY_KEY]: input.idempotencyKey,
      [METADATA_PROVIDER_KEY]: PROVIDER_KEY_DROPBOX_SIGN,
    };
    const common: Record<string, unknown> = {
      title: input.subject ?? 'Signature request',
      ...(input.subject === null ? {} : { subject: input.subject }),
      ...(input.emailBlurb === null ? {} : { message: input.emailBlurb }),
      ...(expiresAtUnix(input.expiresAt) === null ? {} : { expires_at: expiresAtUnix(input.expiresAt) }),
      // A signer may decline; the domain has a declined state and the provider must be allowed to say so.
      allow_decline: true,
      test_mode: context.environment === 'demo',
      metadata,
      ...(context.clientId === null ? {} : { client_id: context.clientId }),
    };

    const response =
      input.templateId !== null
        ? await this.sendWithTemplate(context, input, common)
        : await this.sendDocuments(context, input, common);
    const body = parseJsonText(response.text);
    if (response.status >= 400) {
      throw this.errorFor(response);
    }
    const signatureRequest = isRecord(body['signature_request']) ? body['signature_request'] : null;
    const providerEnvelopeId = signatureRequest === null ? null : stringOf(signatureRequest['signature_request_id']);
    if (providerEnvelopeId === null) {
      // The provider accepted something, but not an answer this platform can address. That is the
      // ambiguous outcome, not a success and not a clean failure.
      throw new SendOutcomeUnknownError({
        correlationId: input.correlationId ?? 'unknown',
        idempotencyKey: input.idempotencyKey,
        providerEnvelopeId: null,
      });
    }
    const recipients = toRecipientStatuses(signatureRequest ?? {}, input.recipients);
    return {
      providerEnvelopeId,
      status: 'sent',
      providerStatusRaw: envelopeStatusOf(signatureRequest ?? {}),
      sentAt: unixToIso(signatureRequest?.['created_at']) ?? new Date().toISOString(),
      recipients,
      // API v3 does not return its per-document ids on create; the merged download is bound to the
      // envelope id instead, which is what the artifact store dedupes on.
      providerDocumentIds: {},
    };
  }

  async envelopeStatus(context: SignatureProviderContext, providerEnvelopeId: string): Promise<ProviderEnvelopeStatus> {
    const id = providerEnvelopeId.trim();
    const response = await this.request(context, { method: 'GET', path: `/signature_request/${encodeURIComponent(id)}` });
    if (response.status === 404) {
      return { providerEnvelopeId: id, status: 'unknown', providerStatusRaw: 'not_found', occurredAt: null, recipients: [] };
    }
    const body = this.bodyOrThrow(response);
    const request = isRecord(body['signature_request']) ? body['signature_request'] : {};
    return {
      providerEnvelopeId: id,
      status: envelopeStatusOf(request),
      providerStatusRaw: envelopeStatusOf(request),
      occurredAt: envelopeOccurredAt(request),
      recipients: toRecipientStatuses(request, []),
    };
  }

  async listRecipients(context: SignatureProviderContext, providerEnvelopeId: string): Promise<readonly ProviderRecipientStatus[]> {
    const status = await this.envelopeStatus(context, providerEnvelopeId);
    return status.recipients;
  }

  /** No embedded-signing capability: this adapter never produces a signing URL. */
  async recipientView(_context: SignatureProviderContext, _input: RecipientViewInput): Promise<RecipientView> {
    throw new NotSupportedByProviderError('recipientView', PROVIDER_KEY_DROPBOX_SIGN);
  }

  /**
   * Remind the outstanding recipients.
   *
   * With no named recipients this is the API's envelope-wide reminder. With named signature ids it
   * looks up their email addresses first (the remind endpoint addresses a person by email), and a
   * signature id that is not on this request is refused rather than skipped.
   */
  async resendNotifications(context: SignatureProviderContext, input: ResendNotificationsInput): Promise<ResendResult> {
    const id = input.providerEnvelopeId.trim();
    if (input.recipientProviderIds.length === 0) {
      await this.postOrThrow(context, `/signature_request/remind/${encodeURIComponent(id)}`, {});
      return { resentAt: new Date().toISOString(), providerStatusRaw: 'reminded' };
    }
    const current = await this.envelopeStatus(context, id);
    const emails: string[] = [];
    for (const signatureId of input.recipientProviderIds) {
      const match = current.recipients.find((recipient) => recipient.providerRecipientId === signatureId);
      if (match === undefined) {
        throw new ProviderError('NOT_FOUND', 'Dropbox Sign has no such recipient on this request.', {
          category: 'not_found',
          retryable: false,
          detail: 'recipient_not_found',
        });
      }
      if (match.email.trim() !== '') emails.push(match.email);
    }
    for (const email of emails) {
      await this.postOrThrow(context, `/signature_request/remind/${encodeURIComponent(id)}`, { signer_email_address: email });
    }
    return { resentAt: new Date().toISOString(), providerStatusRaw: current.providerStatusRaw };
  }

  /** Withdraw the request. The provider keeps the record; the CRM projects the cancellation. */
  async voidEnvelope(context: SignatureProviderContext, input: VoidEnvelopeInput): Promise<VoidResult> {
    const id = input.providerEnvelopeId.trim();
    await this.postOrThrow(context, `/signature_request/cancel/${encodeURIComponent(id)}`, { reason: input.reason.slice(0, 500) });
    return { voidedAt: new Date().toISOString(), providerStatusRaw: 'canceled' };
  }

  /** No draft exists, so there is nothing to abandon; answering is more honest than throwing. */
  async abandonDraftEnvelope(_context: SignatureProviderContext, _providerEnvelopeId: string): Promise<{ readonly deleted: boolean }> {
    return { deleted: false };
  }

  /**
   * The signed documents, as one PDF.
   *
   * `file_type=pdf` is the API's merged copy of every document in the request, which is the artifact a
   * CRM record needs. The provider's own document ids are not exposed by this endpoint, so the
   * artifact is bound to the envelope id and deduped by content hash.
   */
  async downloadCompletedDocuments(context: SignatureProviderContext, providerEnvelopeId: string): Promise<readonly ProviderArtifact[]> {
    const id = providerEnvelopeId.trim();
    const response = await this.request(context, {
      method: 'GET',
      path: `/signature_request/files/${encodeURIComponent(id)}`,
      query: { file_type: 'pdf' },
      binary: true,
    });
    if (response.status >= 400) throw this.errorFor(response);
    const status = await this.envelopeStatus(context, id).catch(() => null);
    return [
      {
        artifactKind: 'provider_signed_document',
        providerDocumentId: id,
        displayName: `${safeFileStem(status?.providerStatusRaw === 'completed' ? 'signed-documents' : 'documents')}.pdf`,
        mimeType: 'application/pdf',
        bytes: response.body,
        contentHashSha256: createHash('sha256').update(response.body).digest('hex'),
        retrievedAt: new Date().toISOString(),
      },
    ];
  }

  /** The audit trail is only inside the provider's ZIP, which this adapter does not unpack. */
  async downloadCompletionEvidence(_context: SignatureProviderContext, _providerEnvelopeId: string): Promise<readonly ProviderArtifact[]> {
    throw new NotSupportedByProviderError('downloadCompletionEvidence', PROVIDER_KEY_DROPBOX_SIGN);
  }

  /**
   * Verify and normalize one callback.
   *
   * Dropbox Sign posts `multipart/form-data` with the event JSON in a field named `json` (or the JSON
   * itself, for a caller that posts it directly). Verification uses the documented `event_hash`: an
   * HMAC-SHA-256, in hex, over the concatenation of `event_time` and `event_type`, keyed by the
   * account's API key — the same key the vault already holds, which is why the catalog names
   * `api_key` as this provider's webhook credential.
   *
   * The hash lives *inside* the payload rather than in a header, so the JSON must be parsed before it
   * can be checked. That is the provider's design, not a choice made here; what this adapter still
   * guarantees is that **nothing is trusted until the hash matches**, and that an unverified delivery
   * returns no envelope id and no event fields at all.
   */
  async verifyAndParseWebhook(input: VerifyWebhookInput): Promise<ProviderWebhookNotification> {
    const receivedAt = new Date().toISOString();
    const payloadHash = rawBodyHash(input.rawBody);
    if (input.rawBody.byteLength > input.maxPayloadBytes) return unverified('too_large', payloadHash, receivedAt);

    const jsonText = extractJsonPayload(input.rawBody, input.contentType);
    if (jsonText === null) return unverified('malformed', payloadHash, receivedAt);
    let decoded: unknown;
    try {
      decoded = JSON.parse(jsonText);
    } catch {
      return unverified('malformed', payloadHash, receivedAt);
    }
    if (!isRecord(decoded)) return unverified('malformed', payloadHash, receivedAt);
    const event = isRecord(decoded['event']) ? decoded['event'] : {};
    const eventTime = stringOf(event['event_time']);
    const eventTypeRaw = stringOf(event['event_type']);
    const eventHash = stringOf(event['event_hash']);

    if (input.requireSignature) {
      if (input.signingSecret === null || input.signingSecret.trim() === '') {
        return unverified('no_secret', payloadHash, receivedAt);
      }
      if (eventTime === null || eventTypeRaw === null) return unverified('malformed', payloadHash, receivedAt);
      if (eventHash === null) return unverified('missing_signature', payloadHash, receivedAt);
      const expected = hmacSha256Hex(input.signingSecret, `${eventTime}${eventTypeRaw}`);
      if (!timingSafeEquals(expected, eventHash.toLowerCase())) return unverified('invalid_signature', payloadHash, receivedAt);
    }

    const metadata = isRecord(event['event_metadata']) ? event['event_metadata'] : {};
    const account = isRecord(decoded['account']) ? decoded['account'] : {};
    const providerAccountId = stringOf(metadata['reported_for_account_id']) ?? stringOf(account['account_id']);
    if (
      input.expectedAccountId !== null &&
      input.expectedAccountId !== undefined &&
      providerAccountId !== null &&
      providerAccountId !== input.expectedAccountId
    ) {
      return unverified('account_mismatch', payloadHash, receivedAt);
    }

    const signatureRequest = isRecord(decoded['signature_request']) ? decoded['signature_request'] : {};
    const providerEnvelopeId = stringOf(signatureRequest['signature_request_id']);
    const recipientProviderId = stringOf(metadata['related_signature_id']);
    const normalized = normalizeDropboxEvent(eventTypeRaw);
    const recipientStatusRaw = recipientStatusWordForEvent(eventTypeRaw);
    return {
      verified: true,
      refusalReason: null,
      // Dropbox Sign sends no delivery id; the event's own identity is its type, time and signature.
      providerEventId: eventTypeRaw === null || eventTime === null ? null : `${eventTypeRaw}:${eventTime}:${recipientProviderId ?? 'envelope'}`,
      providerEnvelopeId,
      providerAccountId,
      eventTypeRaw,
      eventTypeNormalized: normalized,
      recipientProviderId,
      recipientStatusRaw,
      occurredAt: unixToIso(eventTime),
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

  // -------------------------------------------------------------------------
  // request helpers
  // -------------------------------------------------------------------------

  private api(context: SignatureProviderContext): DropboxSignApi {
    return new DropboxSignApi(this.transport, context.accessToken);
  }

  private request(
    context: SignatureProviderContext,
    input: Parameters<DropboxSignApi['request']>[0],
  ): Promise<DropboxSignHttpResponse> {
    return this.api(context).request({ ...input, timeoutMs: input.timeoutMs ?? context.timeoutMs });
  }

  private bodyOrThrow(response: DropboxSignHttpResponse): Record<string, unknown> {
    if (response.status >= 400) throw this.errorFor(response);
    const body = parseJsonText(response.text);
    if (Object.keys(body).length === 0) {
      throw new ProviderError('PROVIDER_UNAVAILABLE', 'Dropbox Sign answered with an unreadable body.', {
        category: 'provider_outage',
        retryable: true,
        detail: 'response_invalid',
        status: response.status,
      });
    }
    return body;
  }

  private async postOrThrow(context: SignatureProviderContext, path: string, json: unknown): Promise<Record<string, unknown>> {
    const response = await this.request(context, { method: 'POST', path, json });
    return this.bodyOrThrow(response);
  }

  /** Classify a refused write. The one place a Dropbox Sign status becomes a platform category. */
  private errorFor(response: DropboxSignHttpResponse): ProviderError {
    const body = parseJsonText(response.text);
    const error = isRecord(body['error']) ? body['error'] : {};
    const name = stringOf(error['error_name'])?.slice(0, 64) ?? null;
    if (response.status === 401 || response.status === 403) {
      return new ProviderError('TOKEN_EXPIRED', 'Dropbox Sign refused the API key.', {
        category: 'authorization',
        retryable: false,
        status: response.status,
        detail: name ?? 'invalid_auth',
      });
    }
    if (response.status === 404) {
      return new ProviderError('NOT_FOUND', 'Dropbox Sign has no such record.', { category: 'not_found', retryable: false, status: 404, detail: name });
    }
    if (response.status === 429) {
      return new ProviderError('RATE_LIMITED', 'Dropbox Sign is rate limiting this installation.', {
        category: 'rate_limited',
        retryable: true,
        status: 429,
        detail: name,
      });
    }
    if (response.status >= 500) {
      return new ProviderError('PROVIDER_UNAVAILABLE', 'Dropbox Sign is unavailable.', {
        category: 'provider_outage',
        retryable: true,
        status: response.status,
        detail: name,
      });
    }
    return new ProviderError('INVALID_REQUEST', 'Dropbox Sign refused the request.', {
      category: 'permanent_validation',
      retryable: false,
      status: response.status,
      detail: name,
    });
  }

  /**
   * The document form of the send call.
   *
   * Files must travel as multipart parts; every other parameter uses the API's bracketed field names
   * (`signers[0][email_address]`, `metadata[key]`), which is how the v3 form parser addresses arrays
   * and maps.
   */
  private async sendDocuments(
    context: SignatureProviderContext,
    input: PrepareEnvelopeInput,
    common: Record<string, unknown>,
  ): Promise<DropboxSignHttpResponse> {
    const parts: MultipartPart[] = [];
    input.documents.forEach((document, index) => {
      parts.push({
        name: `files[${String(index)}]`,
        filename: document.displayName,
        contentType: document.mimeType,
        value: document.bytes,
      });
    });
    const signers = input.recipients.filter((recipient) => recipient.recipientType === 'signer');
    const copies = input.recipients.filter((recipient) => recipient.recipientType === 'carbon_copy');
    signers.forEach((recipient, index) => {
      parts.push({ name: `signers[${String(index)}][name]`, value: recipient.name });
      parts.push({ name: `signers[${String(index)}][email_address]`, value: recipient.email });
      parts.push({ name: `signers[${String(index)}][order]`, value: String(recipient.routingOrder) });
    });
    copies.forEach((recipient, index) => {
      parts.push({ name: `cc_email_addresses[${String(index)}]`, value: recipient.email });
    });
    for (const [key, value] of Object.entries(common)) {
      if (key === 'metadata') {
        for (const [metaKey, metaValue] of Object.entries(value as Record<string, string>)) {
          parts.push({ name: `metadata[${metaKey}]`, value: metaValue });
        }
      } else if (typeof value === 'boolean' || typeof value === 'number') {
        parts.push({ name: key, value: String(value) });
      } else if (typeof value === 'string') {
        parts.push({ name: key, value });
      }
    }
    const boundary = `----CaroCRMBoundary${randomUUID().replaceAll('-', '')}`;
    const body = encodeMultipart(parts, boundary);
    return this.request(context, {
      method: 'POST',
      path: '/signature_request/send',
      raw: { body, contentType: `multipart/form-data; boundary=${boundary}` },
    });
  }

  /**
   * The template form of the send call: JSON, roles mapped to people, mapped values as custom fields.
   *
   * A template recipient without a role name cannot be placed: the API addresses signers by role, and
   * guessing one would send the contract to the wrong signer. That is a validation refusal, never a
   * silent default.
   */
  private async sendWithTemplate(
    context: SignatureProviderContext,
    input: PrepareEnvelopeInput,
    common: Record<string, unknown>,
  ): Promise<DropboxSignHttpResponse> {
    const signers: Record<string, unknown>[] = [];
    const ccs: Record<string, unknown>[] = [];
    for (const recipient of input.recipients) {
      const role = recipient.roleName?.trim() ?? '';
      if (role === '') {
        throw new ProviderError('INVALID_REQUEST', 'A template recipient needs the template role it fills.', {
          category: 'permanent_validation',
          retryable: false,
          detail: 'template_role_required',
        });
      }
      if (recipient.recipientType === 'carbon_copy') {
        ccs.push({ role, email_address: recipient.email });
      } else {
        signers.push({ role, name: recipient.name, email_address: recipient.email });
      }
    }
    const customFields = (input.mappedFields ?? [])
      .filter((field) => field.tabLabel.trim() !== '')
      .map((field) => ({ name: field.tabLabel.trim(), value: field.value }));
    const response = await this.request(context, {
      method: 'POST',
      path: '/signature_request/send_with_template',
      json: {
        template_ids: [input.templateId],
        signers,
        ...(ccs.length === 0 ? {} : { ccs }),
        ...(customFields.length === 0 ? {} : { custom_fields: customFields }),
        ...common,
      },
    });
    return response;
  }
}

export function createDropboxSignAdapter(transport: DropboxSignTransport): SignatureProviderAdapter {
  return new DropboxSignAdapter(transport);
}

// ---------------------------------------------------------------------------
// pure translation helpers
// ---------------------------------------------------------------------------

function templateRoles(template: Record<string, unknown>): ProviderTemplateRole[] {
  const roles: ProviderTemplateRole[] = [];
  const signerRoles = Array.isArray(template['signer_roles']) ? template['signer_roles'] : [];
  for (const role of signerRoles) {
    if (!isRecord(role)) continue;
    const name = stringOf(role['name']);
    if (name === null) continue;
    // The API reports a 0-based order; the domain's routing order starts at 1.
    const order = integerOf(role['order']);
    roles.push({ roleName: name, recipientType: 'signer', routingOrder: order === null ? null : order + 1, required: true });
  }
  const ccRoles = Array.isArray(template['cc_roles']) ? template['cc_roles'] : [];
  for (const role of ccRoles) {
    if (!isRecord(role)) continue;
    const name = stringOf(role['name']);
    if (name === null || roles.some((entry) => entry.roleName === name)) continue;
    roles.push({ roleName: name, recipientType: 'carbon_copy', routingOrder: null, required: false });
  }
  return roles;
}

function templateFields(template: Record<string, unknown>): ProviderTemplateField[] {
  const fields: ProviderTemplateField[] = [];
  const documents = Array.isArray(template['documents']) ? template['documents'] : [];
  for (const document of documents) {
    if (!isRecord(document)) continue;
    const index = integerOf(document['index']);
    const documentId = index === null ? stringOf(document['name']) : String(index);
    for (const listName of ['form_fields', 'custom_fields'] as const) {
      const list = Array.isArray(document[listName]) ? document[listName] : [];
      for (const field of list) {
        if (!isRecord(field)) continue;
        const label = stringOf(field['name']) ?? stringOf(field['api_id']);
        if (label === null) continue;
        fields.push({
          tabLabel: label,
          roleName: stringOf(field['signer']),
          documentId,
          fieldType: stringOf(field['type']),
          required: field['required'] === true,
        });
      }
    }
  }
  return fields;
}

/** The provider's status vocabulary translated once. */
function envelopeStatusOf(request: Record<string, unknown>): ProviderEnvelopeStatus['status'] {
  if (request['is_complete'] === true) return 'completed';
  if (request['is_declined'] === true) return 'declined';
  const signatures = signatureRows(request);
  const statuses = signatures.map((signature) => (stringOf(signature['status_code']) ?? '').toLowerCase());
  const finished = statuses.filter((code) => code === 'signed' || code === 'completed').length;
  if (statuses.length > 0 && statuses.every((code) => code === 'canceled' || code === 'cancelled')) return 'voided';
  if (statuses.some((code) => code === 'expired')) return 'expired';
  if (finished > 0) return 'partially_signed';
  if (signatures.some((signature) => signature['last_viewed_at'] !== null && signature['last_viewed_at'] !== undefined)) return 'delivered';
  return 'sent';
}

function toRecipientStatuses(
  request: Record<string, unknown>,
  localRecipients: readonly { readonly recipientId: string; readonly email: string }[],
): ProviderRecipientStatus[] {
  const envelopeStatus = envelopeStatusOf(request);
  return signatureRows(request).flatMap((signature) => {
    const providerRecipientId = stringOf(signature['signature_id']);
    if (providerRecipientId === null) return [];
    const email = stringOf(signature['signer_email_address']) ?? '';
    const name = stringOf(signature['signer_name']) ?? email;
    const local = localRecipients.find((recipient) => recipient.email.trim().toLowerCase() === email.trim().toLowerCase());
    const code = (stringOf(signature['status_code']) ?? '').toLowerCase();
    const status =
      code === 'declined'
        ? 'declined'
        : code === 'canceled' || code === 'cancelled'
          ? 'canceled'
          : code === 'expired'
            ? 'expired'
            : code === 'signed' || code === 'completed'
              ? envelopeStatus === 'completed'
                ? 'completed'
                : 'signed'
              : signature['last_viewed_at'] !== null && signature['last_viewed_at'] !== undefined
                ? 'viewed'
                : 'sent';
    return [
      {
        providerRecipientId,
        recipientId: local?.recipientId ?? '',
        status,
        providerStatusRaw: code === '' ? 'awaiting_signature' : code,
        name,
        email,
        routingOrder: (integerOf(signature['order']) ?? 0) + 1,
        roleName: stringOf(signature['signer_role']),
        occurredAt: unixToIso(signature['signed_at']) ?? unixToIso(signature['last_viewed_at']) ?? unixToIso(request['created_at']),
        declineReasonSafe: sanitizeDeclineReason(stringOf(signature['decline_reason'])),
      },
    ];
  });
}

function signatureRows(request: Record<string, unknown>): Record<string, unknown>[] {
  const rows = Array.isArray(request['signatures']) ? request['signatures'] : [];
  return rows.filter(isRecord);
}

/** The latest provider timestamp that describes where the request is. */
function envelopeOccurredAt(request: Record<string, unknown>): string | null {
  let latest: number | null = null;
  const consider = (value: unknown): void => {
    const seconds = integerOf(value);
    if (seconds === null) return;
    if (latest === null || seconds > latest) latest = seconds;
  };
  consider(request['created_at']);
  for (const signature of signatureRows(request)) {
    consider(signature['signed_at']);
    consider(signature['last_viewed_at']);
    consider(signature['last_reminded_at']);
  }
  return latest === null ? null : new Date(latest * 1000).toISOString();
}

/** The provider's callback names mapped to the module's event vocabulary. */
function normalizeDropboxEvent(raw: string | null): ProviderEventType {
  if (raw === null) return 'unmapped';
  switch (raw.trim().toLowerCase()) {
    case 'signature_request_sent':
      return 'sent';
    case 'signature_request_viewed':
      return 'viewed';
    case 'signature_request_signed':
      return 'partially_signed';
    case 'signature_request_all_signed':
    case 'signature_request_downloadable':
      return 'completed';
    case 'signature_request_declined':
      return 'declined';
    case 'signature_request_canceled':
      return 'voided';
    case 'signature_request_expired':
      return 'expired';
    case 'signature_request_email_bounced':
    case 'signature_request_invalid':
      return 'failed';
    default:
      return 'unmapped';
  }
}

/** The recipient word an event implies, when the event is recipient-level. */
function recipientStatusWordForEvent(raw: string | null): string | null {
  switch (raw?.trim().toLowerCase()) {
    case 'signature_request_viewed':
      return 'viewed';
    case 'signature_request_signed':
      return 'signed';
    case 'signature_request_declined':
      return 'declined';
    case 'signature_request_canceled':
      return 'canceled';
    case 'signature_request_expired':
      return 'expired';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// callback body parsing
// ---------------------------------------------------------------------------

/**
 * The event JSON out of the request body.
 *
 * Three shapes are accepted because all three are documented or produced by the provider's own
 * tooling: `multipart/form-data` with a `json` field (the default), a raw `application/json` body, and
 * a form-encoded `json=` field. The multipart scan works on bytes, so a document-sized binary part
 * cannot make the JSON part unreadable.
 */
function extractJsonPayload(rawBody: Uint8Array, contentType: string | null): string | null {
  const type = (contentType ?? '').toLowerCase();
  if (type.includes('application/json')) return Buffer.from(rawBody).toString('utf8');
  if (type.includes('application/x-www-form-urlencoded')) {
    const value = new URLSearchParams(Buffer.from(rawBody).toString('utf8')).get('json');
    return value === null || value.trim() === '' ? null : value;
  }
  if (type.includes('multipart/form-data')) {
    const boundary = boundaryOf(contentType ?? '');
    if (boundary === null) return null;
    return readMultipartField(rawBody, boundary, 'json');
  }
  // No content type at all: treat the bytes as JSON, which is what a test harness posts.
  const text = Buffer.from(rawBody).toString('utf8').trim();
  return text.startsWith('{') ? text : null;
}

function boundaryOf(contentType: string): string | null {
  const match = /boundary="?([^";]+)"?/i.exec(contentType);
  return match?.[1]?.trim() ?? null;
}

function readMultipartField(rawBody: Uint8Array, boundary: string, fieldName: string): string | null {
  const delimiter = Buffer.from(`--${boundary}`, 'utf8');
  const body = Buffer.from(rawBody);
  let cursor = 0;
  for (;;) {
    const start = body.indexOf(delimiter, cursor);
    if (start === -1) return null;
    const afterStart = start + delimiter.byteLength;
    // The closing delimiter is followed by `--`; a part begins after CRLF.
    if (body.subarray(afterStart, afterStart + 2).toString('utf8') === '--') return null;
    const headersStart = body.subarray(afterStart, afterStart + 2).toString('utf8') === '\r\n' ? afterStart + 2 : afterStart;
    const headersEnd = body.indexOf(Buffer.from('\r\n\r\n', 'utf8'), headersStart);
    if (headersEnd === -1) return null;
    const headers = body.subarray(headersStart, headersEnd).toString('utf8');
    const valueStart = headersEnd + 4;
    const next = body.indexOf(delimiter, valueStart);
    if (next === -1) return null;
    const nameMatch = /name="([^"]+)"/i.exec(headers);
    if (nameMatch?.[1] === fieldName) {
      // The value ends before the CRLF that precedes the next delimiter.
      let valueEnd = next;
      if (body.subarray(valueEnd - 2, valueEnd).toString('utf8') === '\r\n') valueEnd -= 2;
      return body.subarray(valueStart, valueEnd).toString('utf8');
    }
    cursor = next;
  }
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function unverified(
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

function detailCodeFor(error: unknown): string {
  if (error instanceof ProviderError) {
    if (error.category === 'authorization') return 'token_expired';
    if (error.category === 'rate_limited') return 'rate_limited';
    if (error.category === 'provider_outage') return 'provider_outage';
    if (error.category === 'not_found') return 'account_not_found';
    if (error.code === 'TIMEOUT' || error.code === 'NETWORK_ERROR') return 'unreachable';
  }
  if (error instanceof Error && error.name === 'DropboxSignDestinationError') return 'destination_refused';
  return 'unreachable';
}

function expiresAtUnix(value: string | null): number | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

function unixToIso(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value * 1000).toISOString();
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return new Date(Number(value) * 1000).toISOString();
  return null;
}

function sanitizeDeclineReason(value: string | null): string | null {
  if (value === null) return null;
  // Control characters are stripped by code point rather than a regex range, so the file carries no
  // invisible characters a reader (or a linter) could mistake for text.
  const cleaned = Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f ? ' ' : character;
  })
    .join('')
    .trim()
    .slice(0, 500);
  return cleaned === '' ? null : cleaned;
}

function safeFileStem(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'signed-documents';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function integerOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value);
  return null;
}
