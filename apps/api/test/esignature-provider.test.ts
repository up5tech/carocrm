import { describe, expect, it } from 'vitest';

import { isProviderError,ProviderError  } from '../src/advanced-integrations/provider-error.js';
import { ESignatureError } from '../src/esignature/esignature-errors.js';
import { createFakeSignatureProviderAdapter,FakeSignatureProviderAdapter } from '../src/esignature/providers/fake-signature-provider.adapter.js';
import {
  classifyAdapterError,
  isSendOutcomeUnknownError,
  NotSupportedByProviderError,
  redactAdapterError,
  SendOutcomeUnknownError,
  toModuleError,
} from '../src/esignature/providers/signature-provider.errors.js';
import {
  artifactIdentity,
  idempotencyKey,
  prepareIdentity,
  sendIdentity,
} from '../src/esignature/providers/signature-provider.idempotency.js';
import {
  adapterSupports,
  assertAdapterContract,
  BASE_SIGNATURE_PROVIDER_CAPABILITIES,
  FUTURE_SIGNATURE_PROVIDER_OPERATIONS,
  redactContext,
  SIGNATURE_PROVIDER_OPERATIONS,
  type SignatureProviderAdapter,
  type SignatureProviderContext,
} from '../src/esignature/providers/signature-provider.port.js';
import { SignatureProviderRegistry } from '../src/esignature/providers/signature-provider.registry.js';
import {
  connectSignature,
  rawBodyHash,
  readSignatureHeader,
  valueHash,
  verifyConnectSignature,
} from '../src/esignature/providers/signature-provider-signature.js';

/**
 * Phase 19-ES.3 — the provider contract, the registry and the fake adapter
 * (`PLAN_Phase_19_ESignature.md` §5.2, §4.3, §9.1, §10, §17, §18 `19-ES.3`).
 *
 * Acceptance covered here:
 *   - an end-to-end domain workflow runs against the fake provider (the flow suite below);
 *   - no test needs provider credentials — the adapter is reached with a bearer token the OAuth
 *     service would resolve, and the fake ignores it, so there is nothing to leak;
 *   - an unsupported capability is an explicit refusal, never a silent no-op.
 *
 * Pure unit tests: no database, no HTTP, no clock. The fake is deterministic by construction, so
 * every assertion below is a fact about the contract rather than a race.
 */

const FAKE_TOKEN = 'fake-access-token-never-returned';

function contextFor(overrides: Partial<SignatureProviderContext> = {}): SignatureProviderContext {
  return {
    connectionId: 'conn-1',
    providerKey: 'docusign',
    environment: 'demo',
    accountId: 'acct-1',
    baseUri: 'https://fake.docusign.invalid',
    grantedScopes: ['signature'],
    accessToken: FAKE_TOKEN,
    correlationId: 'req-test-1',
    timeoutMs: 10_000,
    ...overrides,
  };
}

function prepareInput(overrides: { idempotencyKey?: string; signatureRequestId?: string } = {}) {
  return {
    signatureRequestId: overrides.signatureRequestId ?? 'esr-1',
    idempotencyKey: overrides.idempotencyKey ?? 'key-prepare-1',
    correlationId: 'req-test-1',
    templateId: null,
    subject: 'Please sign',
    emailBlurb: 'Hello',
    expiresAt: null,
    documents: [
      {
        documentSnapshotId: 'doc-1',
        displayName: 'agreement.pdf',
        mimeType: 'application/pdf',
        documentOrder: 1,
        bytes: new TextEncoder().encode('%PDF-1.4 fake source'),
        contentHashSha256: 'a'.repeat(64),
      },
    ],
    recipients: [
      {
        recipientId: 'rec-1',
        name: 'Agent Test Signer',
        email: 'signer@example.invalid',
        recipientType: 'signer' as const,
        routingOrder: 1,
        roleName: null,
        authenticationMethod: null,
      },
    ],
  };
}

describe('the adapter contract', () => {
  it('covers the initial end-to-end slice and declares the later operations as future work', () => {
    expect(SIGNATURE_PROVIDER_OPERATIONS).toEqual([
      'connectionStatus',
      'accountContext',
      // ES.7 moved the read-only catalog into the contract; nothing writes a provider template.
      'listTemplates',
      'templateDetails',
      'prepareEnvelope',
      'sendEnvelope',
      // A provider with no unsent draft creates and sends in one call.
      'sendNewEnvelope',
      'envelopeStatus',
      'listRecipients',
      'recipientView',
      'resendNotifications',
      'voidEnvelope',
      'downloadCompletedDocuments',
      'downloadCompletionEvidence',
      'verifyWebhook',
    ]);
    // Correction is listed as future work but stays declared unsupported: plan §5.2 and §16 keep it an
    // exception path until the live behaviour is verified, so it must be refused rather than
    // optimistically admitted.
    expect(FUTURE_SIGNATURE_PROVIDER_OPERATIONS).toEqual(['correctEnvelope']);
    expect(FUTURE_SIGNATURE_PROVIDER_OPERATIONS).not.toContain('listTemplates');
    expect(BASE_SIGNATURE_PROVIDER_CAPABILITIES.correctEnvelope).toBe(false);
  });

  it('refuses an adapter that declares an operation it cannot perform', () => {
    const incomplete = {
      ...new FakeSignatureProviderAdapter(),
      sendEnvelope: undefined,
    } as unknown as SignatureProviderAdapter;
    expect(() => assertAdapterContract(incomplete)).toThrow(/capabilities.sendEnvelope without sendEnvelope/);
    expect(() => assertAdapterContract(new FakeSignatureProviderAdapter())).not.toThrow();
  });

  it('refuses an adapter that claims webhook verification without the method', () => {
    const claimer = {
      ...new FakeSignatureProviderAdapter(),
      verifyAndParseWebhook: undefined,
      capabilities: { ...BASE_SIGNATURE_PROVIDER_CAPABILITIES, verifyWebhook: true },
    } as unknown as SignatureProviderAdapter;
    expect(() => assertAdapterContract(claimer)).toThrow(/verifyAndParseWebhook/);
  });
});

describe('the registry', () => {
  it('binds one adapter per provider key and refuses a duplicate', () => {
    const registry = new SignatureProviderRegistry([createFakeSignatureProviderAdapter()]);
    expect(registry.keys()).toEqual(['docusign']);
    expect(() => registry.register(createFakeSignatureProviderAdapter())).toThrow(/already registered/);
  });

  it('keeps the fake out of production', () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const registry = new SignatureProviderRegistry();
      expect(() => registry.register(createFakeSignatureProviderAdapter())).toThrow(/cannot be registered in production/);
      // With no adapter bound, an operation is refused with the same stable answer the gate gives
      // when there is no connection: nothing can reach a provider.
      expect(registry.resolve('docusign')).toBeUndefined();
      expect(() => registry.require('docusign')).toThrow(ESignatureError);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  it('refuses an unsupported capability before any call is made', () => {
    const registry = new SignatureProviderRegistry([createFakeSignatureProviderAdapter()]);
    expect(() => registry.assertOperation('docusign', 'correctEnvelope')).toThrow(NotSupportedByProviderError);
    expect(() => registry.assertOperation('docusign', 'voidEnvelope')).not.toThrow();
    expect(() => registry.assertOperation('docusign', 'sendEnvelope')).not.toThrow();
    expect(registry.supports('docusign', 'recipientView')).toBe(true);
    expect(registry.supports('unknown-provider', 'sendEnvelope')).toBe(false);
  });

  it('reports the bound adapter honestly, and a fake is never a live integration', () => {
    const registry = new SignatureProviderRegistry([createFakeSignatureProviderAdapter()]);
    const [descriptor] = registry.report();
    expect(descriptor?.mode).toBe('fake');
    expect(descriptor?.providerKey).toBe('docusign');
    expect(registry.hasLiveAdapter('docusign')).toBe(false);
  });
});

describe('idempotency keys and correlation', () => {
  it('derives the same key for the same intent and a different key for a different action', () => {
    const first = idempotencyKey({ purpose: 'sendEnvelope', connectionId: 'c1', signatureRequestId: 'r1', sendAttemptId: 'a1' });
    const again = idempotencyKey({ purpose: 'sendEnvelope', connectionId: 'c1', signatureRequestId: 'r1', sendAttemptId: 'a1' });
    const otherAttempt = idempotencyKey({ purpose: 'sendEnvelope', connectionId: 'c1', signatureRequestId: 'r1', sendAttemptId: 'a2' });
    expect(again).toBe(first);
    expect(otherAttempt).not.toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a send with no attempt token rather than keying it by the request alone', () => {
    expect(() =>
      sendIdentity({
        connectionId: 'c1',
        signatureRequestId: 'r1',
         
        sendAttemptId: '   ' as never,
      }),
    ).toThrow(/send attempt token/);
    const identity = sendIdentity({ connectionId: 'c1', signatureRequestId: 'r1', sendAttemptId: 'a1' });
    expect(identity.correlationId.length).toBeGreaterThan(0);
    expect(identity.idempotencyKey).toBe(
      idempotencyKey({ purpose: 'sendEnvelope', connectionId: 'c1', signatureRequestId: 'r1', sendAttemptId: 'a1' }),
    );
  });

  it('keys preparation on the snapshot digest, so a changed draft is a different intent', () => {
    const before = prepareIdentity({ connectionId: 'c1', signatureRequestId: 'r1', snapshotDigest: 'd1' });
    const after = prepareIdentity({ connectionId: 'c1', signatureRequestId: 'r1', snapshotDigest: 'd2' });
    expect(before.idempotencyKey).not.toBe(after.idempotencyKey);
  });

  it('keys artifact retrieval on the envelope and the kind, not on the job run', () => {
    const first = artifactIdentity({ connectionId: 'c1', providerEnvelopeId: 'e1', artifactKind: 'provider_signed_document' });
    const second = artifactIdentity({ connectionId: 'c1', providerEnvelopeId: 'e1', artifactKind: 'provider_signed_document' });
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
  });
});

describe('the fake adapter', () => {
  it('prepares once per idempotency key and never creates a second draft', async () => {
    const fake = createFakeSignatureProviderAdapter();
    const context = contextFor();
    const prepared = await fake.prepareEnvelope(context, prepareInput());
    const replay = await fake.prepareEnvelope(context, prepareInput({ idempotencyKey: prepared.idempotencyKey }));
    expect(replay.providerEnvelopeId).toBe(prepared.providerEnvelopeId);
    expect(fake.envelopesFor('esr-1')).toHaveLength(1);
    // The provider document ids are the caller's join key back to its own snapshot rows.
    expect(prepared.providerDocumentIds['doc-1']).toMatch(/^fake-doc-/);

    const changed = await fake.prepareEnvelope(context, prepareInput({ idempotencyKey: 'key-prepare-2' }));
    expect(changed.providerEnvelopeId).not.toBe(prepared.providerEnvelopeId);
  });

  it('sends once, and a retry of the same send does not notify the signer twice', async () => {
    const fake = createFakeSignatureProviderAdapter();
    const context = contextFor();
    const prepared = await fake.prepareEnvelope(context, prepareInput());
    const identity = sendIdentity({ connectionId: 'conn-1', signatureRequestId: 'esr-1', sendAttemptId: 'attempt-1' });
    const sent = await fake.sendEnvelope(context, {
      signatureRequestId: 'esr-1',
      providerEnvelopeId: prepared.providerEnvelopeId,
      idempotencyKey: identity.idempotencyKey,
      correlationId: identity.correlationId,
    });
    expect(sent.status).toBe('sent');
    expect(sent.recipients[0]?.status).toBe('sent');

    const retry = await fake.sendEnvelope(context, {
      signatureRequestId: 'esr-1',
      providerEnvelopeId: prepared.providerEnvelopeId,
      idempotencyKey: identity.idempotencyKey,
      correlationId: 'req-test-2',
    });
    expect(retry.sentAt).toBe(sent.sentAt);
    expect(fake.calls.filter((call) => call.operation === 'sendEnvelope')).toHaveLength(2);
  });

  it('reports a lost send response as an unknown outcome, with the envelope actually accepted', async () => {
    const fake = createFakeSignatureProviderAdapter();
    const context = contextFor();
    const prepared = await fake.prepareEnvelope(context, prepareInput());
    fake.loseNextSendResponse();
    const identity = sendIdentity({ connectionId: 'conn-1', signatureRequestId: 'esr-1', sendAttemptId: 'attempt-lost' });
    const failure = await fake
      .sendEnvelope(context, {
        signatureRequestId: 'esr-1',
        providerEnvelopeId: prepared.providerEnvelopeId,
        idempotencyKey: identity.idempotencyKey,
        correlationId: identity.correlationId,
      })
      .catch((error: unknown) => error);
    expect(isSendOutcomeUnknownError(failure)).toBe(true);
    const outcome = failure as SendOutcomeUnknownError;
    // The id the caller will be asked for when it reconciles: the platform's request id, carried on
    // the error, so an operator can join the audit row, the log line and the provider's answer.
    expect(outcome.correlationId).toBe('req-test-1');
    expect(outcome.idempotencyKey).toBe(identity.idempotencyKey);
    // The provider took it, so reconciliation finds it sent: the recovery path is a question to the
    // provider, not a second send (plan §4.3, §17.2 scenario 6).
    expect(outcome.providerEnvelopeId).toBe(prepared.providerEnvelopeId);
    const status = await fake.envelopeStatus(context, prepared.providerEnvelopeId);
    expect(status.status).toBe('sent');
    expect(fake.envelope(prepared.providerEnvelopeId)?.sentAt).not.toBeNull();
  });

  it('reports an unknown envelope as unknown rather than inventing a state', async () => {
    const fake = createFakeSignatureProviderAdapter();
    const status = await fake.envelopeStatus(contextFor(), 'never-existed');
    expect(status.status).toBe('unknown');
    expect(status.providerStatusRaw).toBe('not_found');
  });

  it('follows scripted signer actions, so a multi-recipient envelope cannot complete early', async () => {
    const fake = createFakeSignatureProviderAdapter();
    const context = contextFor();
    const base = prepareInput();
    const prepared = await fake.prepareEnvelope(context, {
      ...base,
      recipients: [
        { recipientId: 'rec-1', name: 'A', email: 'a@example.invalid', recipientType: 'signer', routingOrder: 1, roleName: null, authenticationMethod: null },
        { recipientId: 'rec-2', name: 'B', email: 'b@example.invalid', recipientType: 'signer', routingOrder: 2, roleName: null, authenticationMethod: null },
      ],
    });
    await fake.sendEnvelope(context, { signatureRequestId: 'esr-1', providerEnvelopeId: prepared.providerEnvelopeId, idempotencyKey: 'k', correlationId: 'c' });
    const first = prepared.providerDocumentIds;
    expect(first).toBeDefined();
    fake.recipientAction(prepared.providerEnvelopeId, 'rec-1', { status: 'completed' });
    let status = await fake.envelopeStatus(context, prepared.providerEnvelopeId);
    expect(status.status).toBe('partially_signed');
    fake.recipientAction(prepared.providerEnvelopeId, 'rec-2', { status: 'declined', declineReasonSafe: 'contract terms' });
    status = await fake.envelopeStatus(context, prepared.providerEnvelopeId);
    expect(status.status).toBe('declined');
    const declined = status.recipients.find((recipient) => recipient.recipientId === 'rec-2');
    expect(declined?.declineReasonSafe).toBe('contract terms');
  });

  it('yields deterministic artifacts and a distinct completion certificate', async () => {
    const fake = createFakeSignatureProviderAdapter();
    const context = contextFor();
    const prepared = await fake.prepareEnvelope(context, prepareInput());
    await fake.sendEnvelope(context, { signatureRequestId: 'esr-1', providerEnvelopeId: prepared.providerEnvelopeId, idempotencyKey: 'k', correlationId: 'c' });
    fake.advance(prepared.providerEnvelopeId, 'completed');

    const documents = await fake.downloadCompletedDocuments(context, prepared.providerEnvelopeId);
    const again = await fake.downloadCompletedDocuments(context, prepared.providerEnvelopeId);
    expect(documents).toHaveLength(1);
    expect(again[0]?.contentHashSha256).toBe(documents[0]?.contentHashSha256);
    expect(again[0]?.providerDocumentId).toBe(documents[0]?.providerDocumentId);

    const evidence = await fake.downloadCompletionEvidence(context, prepared.providerEnvelopeId);
    expect(evidence[0]?.artifactKind).toBe('completion_evidence');
    expect(evidence[0]?.contentHashSha256).not.toBe(documents[0]?.contentHashSha256);
  });

  it('verifies a delivery before trusting any field of it, and refuses the rest', async () => {
    const fake = createFakeSignatureProviderAdapter();
    const body = { event_id: 'evt-1', envelope_id: 'env-1', account_id: 'acct-1', event_type: 'sent', occurred_at: '2026-01-01T09:00:00.000Z' };
    const signed = FakeSignatureProviderAdapter.signWebhookPayload('connect-secret', body);

    const verified = await fake.verifyAndParseWebhook({
      providerKey: 'docusign',
      connectionId: 'conn-1',
      rawBody: signed.rawBody,
      headers: signed.headers,
      contentType: signed.contentType,
      signingSecret: 'connect-secret',
      requireSignature: true,
      maxPayloadBytes: 262_144,
    });
    expect(verified.verified).toBe(true);
    expect(verified.eventTypeNormalized).toBe('sent');
    expect(verified.providerEnvelopeId).toBe('env-1');
    expect(verified.payloadHash).toMatch(/^[0-9a-f]{64}$/);

    const tampered = new TextEncoder().encode(`${JSON.stringify(body)} `);
    const invalid = await fake.verifyAndParseWebhook({ ...signedToVerify(signed), rawBody: tampered });
    expect(invalid.verified).toBe(false);
    expect(invalid.refusalReason).toBe('invalid_signature');
    // A refused delivery carries no envelope id, so it cannot be routed to a request.
    expect(invalid.providerEnvelopeId).toBeNull();

    // A missing secret is an administrator's gap and a missing header is a sender's; the operator
    // queue has to be able to tell them apart.
    const noSecret = await fake.verifyAndParseWebhook({ ...signedToVerify(signed), signingSecret: null });
    expect(noSecret.refusalReason).toBe('no_secret');
    const noHeader = await fake.verifyAndParseWebhook({ ...signedToVerify(signed), headers: {} });
    expect(noHeader.refusalReason).toBe('missing_signature');
    const oversized = await fake.verifyAndParseWebhook({ ...signedToVerify(signed), maxPayloadBytes: 8 });
    expect(oversized.refusalReason).toBe('too_large');
    // A malformed body is refused as malformed only when it carries a valid signature over those
    // exact bytes; otherwise verification fails first, which is the correct order (plan §10.2).
    const malformedBody = new TextEncoder().encode('not json');
    const malformedSignature = connectSignature('connect-secret', malformedBody);
    const malformed = await fake.verifyAndParseWebhook({
      ...signedToVerify(signed),
      rawBody: malformedBody,
      headers: { 'x-fake-signature': malformedSignature },
    });
    expect(malformed.refusalReason).toBe('malformed');
    // An unsigned but policy-permitted delivery is still recorded, with the reason `not_required`
    // handled by the caller: the parse succeeds, the trust level is explicit.
    const permissive = await fake.verifyAndParseWebhook({ ...signedToVerify(signed), requireSignature: false });
    expect(permissive.verified).toBe(true);
  });

  it('normalizes an unknown event type as unmapped, never as success', async () => {
    const fake = createFakeSignatureProviderAdapter();
    const signed = FakeSignatureProviderAdapter.signWebhookPayload('s', { event_type: 'sent_to_recipient_1', envelope_id: 'e' });
    const parsed = await fake.verifyAndParseWebhook({
      providerKey: 'docusign',
      connectionId: null,
      rawBody: signed.rawBody,
      headers: signed.headers,
      contentType: signed.contentType,
      signingSecret: 's',
      requireSignature: true,
      maxPayloadBytes: 262_144,
    });
    expect(parsed.eventTypeNormalized).toBe('sent');
    const unknown = FakeSignatureProviderAdapter.signWebhookPayload('s', { event_type: 'something_new_in_2027' });
    const unparsed = await fake.verifyAndParseWebhook({
      providerKey: 'docusign',
      connectionId: null,
      rawBody: unknown.rawBody,
      headers: unknown.headers,
      contentType: unknown.contentType,
      signingSecret: 's',
      requireSignature: true,
      maxPayloadBytes: 262_144,
    });
    expect(unparsed.eventTypeNormalized).toBe('unmapped');
    expect(unparsed.eventTypeRaw).toBe('something_new_in_2027');
  });

  it('keeps the bearer token out of every result, call record and diagnostic', async () => {
    const fake = createFakeSignatureProviderAdapter();
    const context = contextFor();
    const prepared = await fake.prepareEnvelope(context, prepareInput());
    await fake.sendEnvelope(context, { signatureRequestId: 'esr-1', providerEnvelopeId: prepared.providerEnvelopeId, idempotencyKey: 'k', correlationId: 'c' });
    await fake.envelopeStatus(context, prepared.providerEnvelopeId);
    await fake.downloadCompletionEvidence(context, prepared.providerEnvelopeId);

    const serialized = JSON.stringify({ calls: fake.calls, prepared, redacted: redactContext(context) });
    expect(serialized).not.toContain(FAKE_TOKEN);
    expect(redactContext(context)).toEqual({
      connectionId: 'conn-1',
      providerKey: 'docusign',
      environment: 'demo',
      accountId: 'acct-1',
      scopeCount: 1,
    });
  });

  it('resets cleanly, so a shared instance cannot leak state between scenarios', async () => {
    const fake = createFakeSignatureProviderAdapter();
    const prepared = await fake.prepareEnvelope(contextFor(), prepareInput());
    expect(fake.envelopesFor('esr-1')).toHaveLength(1);
    fake.reset();
    expect(fake.envelopesFor('esr-1')).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
    expect(prepared.providerEnvelopeId).toBeDefined();
  });

  it('answers the capability declaration through the same helper the registry uses', () => {
    const fake = createFakeSignatureProviderAdapter();
    expect(adapterSupports(fake, 'sendEnvelope')).toBe(true);
    expect(adapterSupports(fake, 'voidEnvelope')).toBe(true);
    expect(fake.supports('recipientView')).toBe(true);
    expect(fake.supports('correctEnvelope')).toBe(false);
  });
});

describe('the shared webhook signature kit', () => {
  const secret = 'connect-secret';
  const body = new TextEncoder().encode('{"envelope_id":"env-1","event_type":"sent"}');

  it('signs the raw bytes, and matches nothing else', () => {
    const signature = connectSignature(secret, body);
    expect(verifyConnectSignature({ secret, rawBody: body, signature, maxPayloadBytes: 262_144 })).toEqual({ valid: true, reason: null });
    const altered = new TextEncoder().encode(`${new TextDecoder().decode(body)} `);
    expect(verifyConnectSignature({ secret, rawBody: altered, signature, maxPayloadBytes: 262_144 })).toEqual({ valid: false, reason: null });
    expect(signature).not.toContain('env-1');
  });

  it('fails closed on a missing secret, a missing header and an oversized body', () => {
    const signature = connectSignature(secret, body);
    expect(verifyConnectSignature({ secret: null, rawBody: body, signature, maxPayloadBytes: 262_144 }).reason).toBe('no_secret');
    expect(verifyConnectSignature({ secret: '  ', rawBody: body, signature, maxPayloadBytes: 262_144 }).reason).toBe('no_secret');
    expect(verifyConnectSignature({ secret, rawBody: body, signature: null, maxPayloadBytes: 262_144 }).reason).toBe('missing_signature');
    expect(verifyConnectSignature({ secret, rawBody: body, signature, maxPayloadBytes: 8 }).reason).toBe('too_large');
  });

  it('reads the provider header whatever case it arrives in, and nothing else', () => {
    const signature = connectSignature(secret, body);
    expect(readSignatureHeader({ 'x-fake-signature': signature })).toBe(signature);
    expect(readSignatureHeader({ 'X-DocuSign-Signature-1': signature })).toBe(signature);
    expect(readSignatureHeader({ 'X-DocuSign-Signature-256': signature })).toBe(signature);
    expect(readSignatureHeader({ 'x-fake-signature': '   ' })).toBeNull();
    expect(readSignatureHeader({ authorization: 'bearer something' })).toBeNull();
  });

  it('hashes raw bytes and parsed values in the way the event model expects', () => {
    expect(rawBodyHash(body)).toMatch(/^[0-9a-f]{64}$/);
    expect(valueHash({ b: 1, a: 2 })).toBe(valueHash({ a: 2, b: 1 }));
    expect(rawBodyHash(body)).not.toBe(valueHash(new TextDecoder().decode(body)));
  });
});

describe('the error taxonomy', () => {
  it('maps each adapter failure to one stable module code', () => {
    const unsupported = new NotSupportedByProviderError('voidEnvelope', 'docusign');
    expect(toModuleError(unsupported, 'docusign').code).toBe('NOT_SUPPORTED_BY_PROVIDER');
    expect(classifyAdapterError(unsupported)).toBe('configuration_invalid');

    const lost = new SendOutcomeUnknownError({ correlationId: 'corr-9', idempotencyKey: 'k9', providerEnvelopeId: 'e9' });
    const lostMapped = toModuleError(lost, 'docusign');
    expect(lostMapped.code).toBe('PROVIDER_OUTCOME_UNKNOWN');
    expect(lostMapped.details).toEqual({ correlationId: 'corr-9' });
    expect(classifyAdapterError(lost)).toBe('unknown_outcome');
    expect(redactAdapterError(lost).code).toBe('PROVIDER_OUTCOME_UNKNOWN');

    const authorization = new ProviderError('TOKEN_EXPIRED', 'The token expired.', { category: 'authorization', retryable: false });
    expect(toModuleError(authorization, 'docusign').code).toBe('SIGNATURE_CONNECTION_NOT_AVAILABLE');
    expect(classifyAdapterError(authorization)).toBe('authorization');
    expect(isProviderError(authorization)).toBe(true);

    const rateLimited = new ProviderError('RATE_LIMITED', 'Slow down.', { category: 'rate_limited', retryable: true, retryAfterMs: 5_000 });
    expect(toModuleError(rateLimited, 'docusign').statusCode).toBe(429);
  });

  it('never echoes an unexpected provider message to the caller', () => {
    const raw = new Error('upstream said: bearer abc123 leaked in this body');
    const mapped = toModuleError(raw, 'docusign');
    expect(mapped.code).toBe('SIGNATURE_CONNECTION_NOT_AVAILABLE');
    expect(mapped.message).not.toContain('abc123');
    expect(redactAdapterError(raw)).toEqual({ code: 'UNKNOWN', category: 'provider_outage', detail: null });
  });
});

function signedToVerify(signed: { rawBody: Uint8Array; headers: Record<string, string>; contentType: string }) {
  return {
    providerKey: 'docusign',
    connectionId: 'conn-1',
    rawBody: signed.rawBody,
    headers: signed.headers,
    contentType: signed.contentType,
    signingSecret: 'connect-secret',
    requireSignature: true,
    maxPayloadBytes: 262_144,
  };
}
