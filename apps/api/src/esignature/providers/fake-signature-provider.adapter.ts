import { createHash } from 'node:crypto';

import { canonicalJson } from '../esignature-snapshot.js';
import { SendOutcomeUnknownError } from './signature-provider.errors.js';
import {
  adapterSupports,
  BASE_SIGNATURE_PROVIDER_CAPABILITIES,
  type PreparedEnvelope,
  type PrepareEnvelopeInput,
  type ProviderAccountContext,
  type ProviderArtifact,
  type ProviderConnectionStatus,
  type ProviderEnvelopeStatus,
  type ProviderRecipientStatus,
  type ProviderWebhookNotification,
  type SendEnvelopeInput,
  type SentEnvelope,
  type SignatureProviderAdapter,
  type SignatureProviderCapabilities,
  type SignatureProviderContext,
  type VerifyWebhookInput,
} from './signature-provider.port.js';
import {
  connectSignature,
  rawBodyHash,
  readSignatureHeader,
  verifyConnectSignature,
} from './signature-provider-signature.js';

/**
 * Phase 19-ES.3 — the fake signature provider
 * (`PLAN_Phase_19_ESignature.md` §17, §18 `19-ES.3`; audit §5.1 "the only adapter used by automated
 * tests"; mirrors `advanced-integrations/connectors/fake/fake-provider.adapter.ts`).
 *
 * It is a **contract implementation**, not a simulator of DocuSign's behaviour: it answers every
 * operation of `SignatureProviderAdapter` with deterministic, scripted state, so a test can assert the
 * domain's reaction to a provider answer without credentials, a network call or a clock. The real
 * adapter (ES.4) must satisfy the same contract and the same refusals; that is the point of writing the
 * fake first (plan §18: the adapter contract is validated by the DocuSign implementation, not the
 * other way round).
 *
 * Three behaviours exist specifically for the scenarios plan §17.2 requires:
 *
 * - **Idempotent preparation.** The same `idempotencyKey` returns the same envelope, so a retried
 *   prepare cannot create uncontrolled provider drafts.
 * - **A lost send response.** `loseNextSendResponse()` makes `sendEnvelope` throw
 *   `SendOutcomeUnknownError` *after* the envelope has been accepted, which is the only way to test the
 *   `send_unknown` path honestly: a blind retry would see a second, different envelope.
 * - **Scripted progression.** `advance()` and `recipientAction()` move state on command, so an
 *   out-of-order or duplicate event can be produced deliberately rather than waited for.
 *
 * The webhook verification here exercises the **contract**, not DocuSign's wire format: the exact
 * header and payload shape are captured from a demo account in ES.11 and the real adapter implements
 * that. The fake signs with HMAC-SHA-256 over the raw bytes, which is the mechanism both share.
 */

/** A fixed start, so every timestamp in a run is reproducible. */
const FAKE_EPOCH_MS = Date.UTC(2026, 0, 1, 9, 0, 0);

/** The envelope states a test may script the provider into. */
export const FAKE_ENVELOPE_STATES = ['draft', 'sent', 'delivered', 'partially_signed', 'completed', 'declined', 'voided', 'expired'] as const;
type FakeEnvelopeState = (typeof FAKE_ENVELOPE_STATES)[number];

/** The recipient states a test may script, including the ones only a provider can produce. */
export const FAKE_RECIPIENT_STATES = ['pending', 'sent', 'delivered', 'viewed', 'signed', 'completed', 'declined', 'canceled', 'expired'] as const;
type FakeRecipientState = (typeof FAKE_RECIPIENT_STATES)[number];

interface FakeRecipient {
  providerRecipientId: string;
  recipientId: string;
  name: string;
  email: string;
  recipientType: 'signer' | 'carbon_copy';
  routingOrder: number;
  roleName: string | null;
  status: FakeRecipientState;
  occurredAt: string | null;
  declineReasonSafe: string | null;
}

interface FakeEnvelope {
  id: string;
  signatureRequestId: string;
  idempotencyKey: string;
  state: FakeEnvelopeState;
  createdAt: string;
  sentAt: string | null;
  recipients: FakeRecipient[];
  /** Provider document ids, keyed by our snapshot id (plan §4.5). */
  documentIds: Record<string, string>;
  documents: { displayName: string; mimeType: string; contentHashSha256: string }[];
}

export interface FakeProviderOptions {
  readonly providerKey?: string;
  readonly capabilities?: SignatureProviderCapabilities;
  /** The account the fake reports as authorized. */
  readonly accountId?: string;
  readonly baseUri?: string;
  readonly environment?: SignatureProviderContext['environment'];
}

export class FakeSignatureProviderAdapter implements SignatureProviderAdapter {
  readonly providerKey: string;
  readonly adapterVersion = 'fake-1.0.0';
  readonly providerApiVersion = 'fake-v2.1';
  readonly mode = 'fake' as const;
  readonly capabilities: SignatureProviderCapabilities;

  private readonly envelopes = new Map<string, FakeEnvelope>();
  private readonly byIdempotencyKey = new Map<string, string>();
  private readonly accountId: string;
  private readonly baseUri: string;
  private sequence = 0;
  private loseNextSend: { readonly correlationId: string | null } | null = null;
  /** Every call the domain made, for assertions that a draft or a preview performed no send. */
  readonly calls: { operation: string; at: string; detail: Record<string, unknown> }[] = [];

  constructor(options: FakeProviderOptions = {}) {
    this.providerKey = options.providerKey ?? 'docusign';
    this.capabilities = options.capabilities ?? { ...BASE_SIGNATURE_PROVIDER_CAPABILITIES };
    this.accountId = options.accountId ?? 'fake-account-1';
    this.baseUri = options.baseUri ?? 'https://fake.docusign.invalid';
  }

  /** Wipe all state. Tests call this between scenarios on a shared instance. */
  reset(): void {
    this.envelopes.clear();
    this.byIdempotencyKey.clear();
    this.calls.length = 0;
    this.sequence = 0;
    this.loseNextSend = null;
  }

  /** Make the next `sendEnvelope` lose its response after the provider accepted the envelope. */
  loseNextSendResponse(): void {
    this.loseNextSend = { correlationId: null };
  }

  /** The stored envelope, for a test that wants to inspect provider-side state directly. */
  envelope(providerEnvelopeId: string): FakeEnvelope | undefined {
    return this.envelopes.get(providerEnvelopeId);
  }

  envelopesFor(signatureRequestId: string): FakeEnvelope[] {
    return [...this.envelopes.values()].filter((envelope) => envelope.signatureRequestId === signatureRequestId);
  }

  /** Move an envelope, as the provider would. No validation: a test may create an odd sequence on purpose. */
  advance(providerEnvelopeId: string, state: FakeEnvelopeState): void {
    const envelope = this.requireEnvelope(providerEnvelopeId);
    envelope.state = state;
    for (const recipient of envelope.recipients) {
      if (state === 'sent' && recipient.status === 'pending') this.setRecipient(recipient, 'sent');
      if (state === 'delivered' && recipient.recipientType === 'signer' && recipient.status === 'sent') this.setRecipient(recipient, 'delivered');
      if (state === 'completed' && recipient.recipientType === 'signer' && recipient.status !== 'completed') this.setRecipient(recipient, 'completed');
      if (state === 'voided' && recipient.status !== 'completed') this.setRecipient(recipient, 'canceled');
      if (state === 'expired' && recipient.status !== 'completed') this.setRecipient(recipient, 'expired');
    }
  }

  /** One signer's action, so a partially-signed envelope can be produced exactly. */
  recipientAction(
    providerEnvelopeId: string,
    recipientId: string,
    action: { status: FakeRecipientState; declineReasonSafe?: string },
  ): void {
    const envelope = this.requireEnvelope(providerEnvelopeId);
    const recipient = envelope.recipients.find((entry) => entry.recipientId === recipientId);
    if (recipient === undefined) throw new Error(`The fake has no recipient "${recipientId}".`);
    this.setRecipient(recipient, action.status, action.declineReasonSafe ?? null);
    const signers = envelope.recipients.filter((entry) => entry.recipientType === 'signer');
    const done = signers.filter((entry) => entry.status === 'completed').length;
    if (action.status === 'declined') envelope.state = 'declined';
    else if (signers.length > 0 && done === signers.length) envelope.state = 'completed';
    else if (done > 0) envelope.state = 'partially_signed';
  }

  async connectionStatus(context: SignatureProviderContext): Promise<ProviderConnectionStatus> {
    this.record('connectionStatus', context, {});
    return { reachable: true, checkedAt: this.stamp(), detailCode: null };
  }

  async accountContext(context: SignatureProviderContext): Promise<ProviderAccountContext> {
    this.record('accountContext', context, {});
    return {
      accountId: this.accountId,
      accountName: 'Fake Account',
      baseUri: this.baseUri,
      userId: 'fake-user-1',
      grantedScopes: context.grantedScopes.length > 0 ? [...context.grantedScopes] : ['signature'],
    };
  }

  /**
   * Create the provider-side draft, idempotently.
   *
   * The same `idempotencyKey` returns the *same* envelope, including its document ids: plan §17.2
   * scenario 5 ("verify exactly one provider send operation") and §9's "retrying preparation cannot
   * create uncontrolled duplicate provider drafts" both rest on this being a lookup, not a creation.
   */
  async prepareEnvelope(context: SignatureProviderContext, input: PrepareEnvelopeInput): Promise<PreparedEnvelope> {
    this.record('prepareEnvelope', context, { signatureRequestId: input.signatureRequestId, documents: input.documents.length });
    const existing = this.byIdempotencyKey.get(input.idempotencyKey);
    if (existing !== undefined) {
      const envelope = this.requireEnvelope(existing);
      return toPrepared(envelope);
    }

    const id = `fake-env-${String(++this.sequence)}`;
    const envelope: FakeEnvelope = {
      id,
      signatureRequestId: input.signatureRequestId,
      idempotencyKey: input.idempotencyKey,
      state: 'draft',
      createdAt: this.stamp(),
      sentAt: null,
      documentIds: Object.fromEntries(
        input.documents.map((document) => [document.documentSnapshotId, `fake-doc-${stableSuffix(document.contentHashSha256)}`]),
      ),
      documents: input.documents.map((document) => ({
        displayName: document.displayName,
        mimeType: document.mimeType,
        contentHashSha256: document.contentHashSha256,
      })),
      recipients: input.recipients.map((recipient, index) => ({
        providerRecipientId: `fake-rec-${stableSuffix(`${id}:${recipient.recipientId}:${String(index)}`)}`,
        recipientId: recipient.recipientId,
        name: recipient.name,
        email: recipient.email,
        recipientType: recipient.recipientType,
        routingOrder: recipient.routingOrder,
        roleName: recipient.roleName,
        status: 'pending',
        occurredAt: null,
        declineReasonSafe: null,
      })),
    };
    this.envelopes.set(id, envelope);
    this.byIdempotencyKey.set(input.idempotencyKey, id);
    return toPrepared(envelope);
  }

  /**
   * Send the draft.
   *
   * Idempotent on the caller's key: a retry of a send whose response was lost returns the envelope as
   * already sent rather than sending it again — but the domain must not get there by retrying; it goes
   * there by reconciling (plan §4.3). `loseNextSendResponse()` is how a test produces that state.
   */
  async sendEnvelope(context: SignatureProviderContext, input: SendEnvelopeInput): Promise<SentEnvelope> {
    this.record('sendEnvelope', context, { providerEnvelopeId: input.providerEnvelopeId });
    const envelope = this.requireEnvelope(input.providerEnvelopeId);
    const wasAlreadySent = envelope.state !== 'draft';

    if (this.loseNextSend !== null && !wasAlreadySent) {
      this.loseNextSend = null;
      // The provider accepted it: the state changes, and the caller is told nothing about the answer.
      this.markSent(envelope);
      throw new SendOutcomeUnknownError({
        correlationId: context.correlationId ?? 'unknown',
        idempotencyKey: input.idempotencyKey,
        providerEnvelopeId: envelope.id,
      });
    }

    this.markSent(envelope);
    return {
      providerEnvelopeId: envelope.id,
      status: 'sent',
      providerStatusRaw: 'sent',
      sentAt: envelope.sentAt ?? this.stamp(),
      recipients: envelope.recipients.map(toRecipientStatus),
    };
  }

  async envelopeStatus(context: SignatureProviderContext, providerEnvelopeId: string): Promise<ProviderEnvelopeStatus> {
    this.record('envelopeStatus', context, { providerEnvelopeId });
    const envelope = this.envelopes.get(providerEnvelopeId);
    if (envelope === undefined) {
      return {
        providerEnvelopeId,
        status: 'unknown',
        providerStatusRaw: 'not_found',
        occurredAt: null,
        recipients: [],
      };
    }
    return {
      providerEnvelopeId: envelope.id,
      status: envelope.state,
      providerStatusRaw: envelope.state,
      occurredAt: envelope.sentAt ?? envelope.createdAt,
      recipients: envelope.recipients.map(toRecipientStatus),
    };
  }

  async listRecipients(context: SignatureProviderContext, providerEnvelopeId: string): Promise<readonly ProviderRecipientStatus[]> {
    this.record('listRecipients', context, { providerEnvelopeId });
    return this.requireEnvelope(providerEnvelopeId).recipients.map(toRecipientStatus);
  }

  /**
   * The signed documents, as derived artifacts.
   *
   * Bytes are deterministic from the source hash, so the same envelope yields the same artifact hash
   * across calls — which is what lets ES.15 dedupe a retried download by content hash and provider
   * document id rather than by a filename.
   */
  async downloadCompletedDocuments(context: SignatureProviderContext, providerEnvelopeId: string): Promise<readonly ProviderArtifact[]> {
    this.record('downloadCompletedDocuments', context, { providerEnvelopeId });
    const envelope = this.requireEnvelope(providerEnvelopeId);
    return envelope.documents.map((document, index) => ({
      artifactKind: 'provider_signed_document' as const,
      providerDocumentId: `fake-signed-${stableSuffix(`${envelope.id}:${document.contentHashSha256}`)}`,
      displayName: `${document.displayName.replace(/\.pdf$/i, '')}-signed.pdf`,
      mimeType: 'application/pdf',
      bytes: fakeBytes(`signed:${envelope.id}:${document.contentHashSha256}`),
      contentHashSha256: hashOf(`signed:${envelope.id}:${document.contentHashSha256}:${String(index)}`),
      retrievedAt: this.stamp(),
    }));
  }

  async downloadCompletionEvidence(context: SignatureProviderContext, providerEnvelopeId: string): Promise<readonly ProviderArtifact[]> {
    this.record('downloadCompletionEvidence', context, { providerEnvelopeId });
    const envelope = this.requireEnvelope(providerEnvelopeId);
    return [
      {
        artifactKind: 'completion_evidence',
        providerDocumentId: `fake-cert-${stableSuffix(envelope.id)}`,
        displayName: 'certificate-of-completion.pdf',
        mimeType: 'application/pdf',
        bytes: fakeBytes(`certificate:${envelope.id}`),
        contentHashSha256: hashOf(`certificate:${envelope.id}`),
        retrievedAt: this.stamp(),
      },
    ];
  }

  /**
   * Verify and normalize one Connect-style delivery.
   *
   * Verification precedes trust: a refused delivery returns `verified: false` with **no** envelope id
   * and no event fields, so a caller cannot route an unverified `envelopeId` to a request even by
   * accident (plan §10.2). The signature mechanism is the platform's shared kit, not a second
   * implementation of a constant-time comparison.
   */
  async verifyAndParseWebhook(input: VerifyWebhookInput): Promise<ProviderWebhookNotification> {
    const receivedAt = new Date(FAKE_EPOCH_MS + this.sequence * 1000).toISOString();
    const rawText = new TextDecoder().decode(input.rawBody);
    const payloadHash = rawBodyHash(input.rawBody);
    if (input.rawBody.byteLength > input.maxPayloadBytes) {
      return unverified('too_large', payloadHash, receivedAt);
    }


    let parsed: Record<string, unknown> = {};
    try {
      const decoded: unknown = JSON.parse(rawText);
      if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) return unverified('malformed', payloadHash, receivedAt);
      parsed = decoded as Record<string, unknown>;
    } catch {
      return unverified('malformed', payloadHash, receivedAt);
    }

    if (input.requireSignature) {
      const check = verifyConnectSignature({
        secret: input.signingSecret,
        rawBody: input.rawBody,
        signature: readSignatureHeader(input.headers),
        maxPayloadBytes: input.maxPayloadBytes,
      });
      if (!check.valid) {
        // A `null` reason means the bytes did not match the signature: the only outcome that is the
        // sender's fault rather than this installation's.
        return unverified(check.reason ?? 'invalid_signature', payloadHash, receivedAt);
      }
    }

    const eventTypeRaw = typeof parsed['event_type'] === 'string' ? parsed['event_type'] : null;
    const normalized = normalizeEventType(eventTypeRaw);
    return {
      verified: true,
      refusalReason: null,
      providerEventId: typeof parsed['event_id'] === 'string' ? parsed['event_id'] : null,
      providerEnvelopeId: typeof parsed['envelope_id'] === 'string' ? parsed['envelope_id'] : null,
      providerAccountId: typeof parsed['account_id'] === 'string' ? parsed['account_id'] : null,
      eventTypeRaw,
      eventTypeNormalized: normalized,
      recipientProviderId: typeof parsed['recipient_id'] === 'string' ? parsed['recipient_id'] : null,
      recipientStatusRaw: typeof parsed['recipient_status'] === 'string' ? parsed['recipient_status'] : null,
      occurredAt: typeof parsed['occurred_at'] === 'string' ? parsed['occurred_at'] : null,
      // The minimized event: identity and status only, never a document or a name (plan §12.1).
      minimized: {
        envelopeId: parsed['envelope_id'] ?? null,
        eventType: eventTypeRaw,
        recipientId: parsed['recipient_id'] ?? null,
        recipientStatus: parsed['recipient_status'] ?? null,
      },
      payloadHash,
      receivedAt,
    };
  }

  /**
   * A signed delivery body, so a test can produce both a valid and a tampered event without knowing
   * the HMAC layout (plan §17.1's webhook test list).
   */
  static signWebhookPayload(secret: string, body: unknown): { rawBody: Uint8Array; headers: Record<string, string>; contentType: string } {
    const rawBody = new TextEncoder().encode(canonicalJson(body));
    return {
      rawBody,
      headers: { 'x-fake-signature': connectSignature(secret, rawBody), 'content-type': 'application/json' },
      contentType: 'application/json',
    };
  }

  /** Whether an operation is declared, for a test asserting the fake matches the real contract. */
  supports(operation: Parameters<typeof adapterSupports>[1]): boolean {
    return adapterSupports(this, operation);
  }

  private markSent(envelope: FakeEnvelope): void {
    if (envelope.state === 'draft') {
      envelope.state = 'sent';
      envelope.sentAt = this.stamp();
      for (const recipient of envelope.recipients) if (recipient.status === 'pending') this.setRecipient(recipient, 'sent');
    }
  }

  private setRecipient(recipient: FakeRecipient, status: FakeRecipientState, declineReasonSafe: string | null = null): void {
    recipient.status = status;
    recipient.occurredAt = this.stamp();
    if (declineReasonSafe !== null) recipient.declineReasonSafe = declineReasonSafe.slice(0, 500);
  }

  private requireEnvelope(id: string): FakeEnvelope {
    const found = this.envelopes.get(id);
    if (found === undefined) throw new Error(`The fake has no envelope "${id}".`);
    return found;
  }

  private record(operation: string, context: SignatureProviderContext, detail: Record<string, unknown>): void {
    this.calls.push({ operation, at: this.stamp(), detail: { connectionId: context.connectionId, ...detail } });
  }

  private stamp(): string {
    return new Date(FAKE_EPOCH_MS + this.sequence++ * 1000).toISOString();
  }
}

/**
 * The factory a test or a development boot uses.
 *
 * A fresh instance by default: shared mutable state between suites is how a test starts passing
 * because of the one that ran before it.
 */
export function createFakeSignatureProviderAdapter(options: FakeProviderOptions = {}): FakeSignatureProviderAdapter {
  return new FakeSignatureProviderAdapter(options);
}

function toPrepared(envelope: FakeEnvelope): PreparedEnvelope {
  return {
    providerEnvelopeId: envelope.id,
    status: 'draft',
    preparedAt: envelope.createdAt,
    idempotencyKey: envelope.idempotencyKey,
    providerDocumentIds: { ...envelope.documentIds },
  };
}

function toRecipientStatus(recipient: FakeRecipient): ProviderRecipientStatus {
  return {
    providerRecipientId: recipient.providerRecipientId,
    recipientId: recipient.recipientId,
    status: recipient.status,
    providerStatusRaw: recipient.status,
    name: recipient.name,
    email: recipient.email,
    routingOrder: recipient.routingOrder,
    roleName: recipient.roleName,
    occurredAt: recipient.occurredAt,
    declineReasonSafe: recipient.declineReasonSafe,
  };
}

function unverified(reason: NonNullable<ProviderWebhookNotification['refusalReason']>, payloadHash: string, receivedAt: string): ProviderWebhookNotification {
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

function normalizeEventType(value: string | null): string {
  switch (value) {
    case 'sent':
    case 'delivered':
    case 'completed':
    case 'declined':
    case 'voided':
    case 'expired':
      return value;
    case 'sent_to_recipient_1':
      return 'sent';
    case 'recipient_viewed':
      return 'delivered';
    case 'recipient_completed':
      return 'partially_signed';
    default:
      return 'unmapped';
  }
}

function hashOf(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableSuffix(value: string): string {
  return hashOf(value).slice(0, 12);
}

/** A deterministic, valid-enough PDF body: the bytes are a fixture, never real document content. */
function fakeBytes(seed: string): Uint8Array {
  const digest = hashOf(seed);
  const body = `%PDF-1.4\n% fake signature artifact ${digest}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}
