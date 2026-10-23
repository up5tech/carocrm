import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PROVIDER_KEY_DOCUSIGN } from '../src/esignature/esignature-domain.js';
import { DEFAULT_ESIGNATURE_SETTINGS } from '../src/esignature/esignature-settings.service.js';
import { buildSnapshot, type OutgoingSnapshotData, type SnapshotEnvelope } from '../src/esignature/esignature-snapshot.js';
import { createFakeSignatureProviderAdapter,FakeSignatureProviderAdapter } from '../src/esignature/providers/fake-signature-provider.adapter.js';
import { isSendOutcomeUnknownError } from '../src/esignature/providers/signature-provider.errors.js';
import { artifactIdentity, prepareIdentity, sendIdentity } from '../src/esignature/providers/signature-provider.idempotency.js';
import type { SignatureProviderContext } from '../src/esignature/providers/signature-provider.port.js';
import { SignatureProviderRegistry } from '../src/esignature/providers/signature-provider.registry.js';
import { SignatureAuditRepository } from '../src/esignature/signature-audit.repository.js';
import { type SignatureConnection,SignatureConnectionRepository } from '../src/esignature/signature-connection.repository.js';
import { type SignatureDocumentSnapshot,SignatureDocumentSnapshotRepository } from '../src/esignature/signature-document-snapshot.repository.js';
import { SignatureProviderEventRepository } from '../src/esignature/signature-provider-event.repository.js';
import { type SignatureRecipient,SignatureRecipientRepository } from '../src/esignature/signature-recipient.repository.js';
import { type SignatureRequest,SignatureRequestRepository } from '../src/esignature/signature-request.repository.js';
import type { ApiContext } from './support/boot-api.js';
import { bootApi, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-ES.3 — the initial end-to-end slice, driven by the fake provider
 * (`PLAN_Phase_19_ESignature.md` §17.2, §18 `19-ES.3` acceptance: "end-to-end domain workflow can
 * run with the fake provider"; the slice agreed in `docs/implementation/esignature-audit.md` §8).
 *
 * One signed request, start to finish, with no credentials and no network: a connection, a synthetic
 * draft, one PDF snapshot, one signer, prepare, send, Connect-style deliveries, the signed copy and
 * the completion certificate stored as **new** artifacts, and the trail that is left behind. The lost
 * send is run as a second scenario, because that is the case the contract exists to make impossible
 * to get wrong: one envelope, no second send, and reconciliation as the only way forward.
 *
 * It drives the repositories and the port together, which is what both were written for; the guarded
 * command services (ES.6–ES.10) will call the same operations in the same order. Nothing here sends a
 * real invitation — the adapter is the fake, so no email leaves the process (plan §17.3) — and the
 * rows are removed by their exact ids afterwards.
 */

let ctx: ApiContext;
let app: NestFastifyApplication;
const runId = `es3${Date.now().toString(36)}`;
const marker = (suffix: string) => `AGENT_TEST_${runId}_${suffix}`;
const SOURCE_HASH = 'c'.repeat(64);

const created = {
  connections: [] as string[],
  requests: [] as string[],
};

/** A stored row is expected; say so rather than asserting a non-null away. */
function one<T>(rows: readonly T[], what: string): T {
  const [first] = rows;
  if (first === undefined) throw new Error(`Expected one ${what}.`);
  return first;
}

function providerContext(connectionId: string): SignatureProviderContext {
  return {
    connectionId,
    providerKey: PROVIDER_KEY_DOCUSIGN,
    environment: 'demo',
    accountId: 'fake-account-1',
    baseUri: 'https://fake.docusign.invalid',
    grantedScopes: ['signature'],
    accessToken: 'fake-token-never-stored',
    correlationId: marker('correlation'),
    timeoutMs: 10_000,
  };
}

function services() {
  return {
    connections: app.get(SignatureConnectionRepository),
    requests: app.get(SignatureRequestRepository),
    recipients: app.get(SignatureRecipientRepository),
    documents: app.get(SignatureDocumentSnapshotRepository),
    events: app.get(SignatureProviderEventRepository),
    audit: app.get(SignatureAuditRepository),
    providers: app.get(SignatureProviderRegistry),
  };
}

interface FlowFixture {
  connection: SignatureConnection;
  request: SignatureRequest;
  recipient: SignatureRecipient;
  source: SignatureDocumentSnapshot;
  envelope: SnapshotEnvelope<OutgoingSnapshotData>;
  context: SignatureProviderContext;
  providerEnvelopeId: string;
  idempotencyKey: string;
}

/**
 * Build the request as far as the send confirmation: an authorized connection, a draft with one
 * signer and one document, and the immutable snapshot claimed as the send attempt.
 */
async function preparedRequest(fake: FakeSignatureProviderAdapter, suffix: string): Promise<FlowFixture> {
  const { connections, requests, recipients, documents } = services();
  const connection = await connections.create({ name: marker(`conn_${suffix}`), environment: 'demo' });
  created.connections.push(connection.id);
  await connections.recordAuthorized(connection.id, {
    accountId: 'fake-account-1',
    baseUri: 'https://fake.docusign.invalid',
    grantedScopes: ['signature'],
    subjectUserId: 'fake-user-1',
  });

  const draft = await requests.createDraft({
    name: marker(`req_${suffix}`),
    connectionId: connection.id,
    sourceEntityType: 'Account',
    sourceRecordId: 'acc-1',
    subject: 'Please sign the agreement',
    emailBlurb: 'Take a look',
    createdById: 'admin',
  });
  created.requests.push(draft.id);

  const recipient = one(
    await recipients.replaceForDraft(draft.id, [{ name: 'Agent Test Signer', email: 'signer@example.invalid', routingOrder: 1 }], 'admin'),
    'stored recipient',
  );
  const recorded = await documents.record({
    requestId: draft.id,
    artifactKind: 'source_snapshot',
    displayName: 'agreement.pdf',
    mimeType: 'application/pdf',
    byteSize: 24,
    contentHashSha256: SOURCE_HASH,
    documentOrder: 1,
    createdById: 'admin',
    settings: DEFAULT_ESIGNATURE_SETTINGS,
  });
  const source = recorded.snapshot;

  const current = await requests.requireById(draft.id);
  const snapshotData: OutgoingSnapshotData = {
    providerKey: PROVIDER_KEY_DOCUSIGN,
    connectionId: connection.id,
    environment: 'demo',
    accountId: 'fake-account-1',
    templateId: null,
    subject: current.subject,
    message: current.message,
    emailBlurb: current.emailBlurb,
    expiresAt: null,
    documents: [
      {
        documentSnapshotId: source.id,
        displayName: source.displayName,
        mimeType: source.mimeType,
        byteSize: source.byteSize,
        contentHashSha256: source.contentHashSha256,
        documentOrder: 1,
        sourceAttachmentId: null,
      },
    ],
    recipients: [
      {
        recipientId: recipient.id,
        name: recipient.name,
        email: recipient.email,
        recipientType: 'signer',
        routingOrder: 1,
        roleName: null,
        authenticationMethod: null,
      },
    ],
    policy: { embeddedSigning: false, approvalRequired: false },
  };
  const envelope = buildSnapshot(`SignatureRequest:${draft.id}`, snapshotData);
  const request = await requests.claimSendAttempt(draft.id, current.version, marker(`attempt_${suffix}`), envelope);

  const context = providerContext(connection.id);
  const prepare = prepareIdentity({
    connectionId: connection.id,
    signatureRequestId: request.id,
    snapshotDigest: envelope.digest,
  });
  const prepared = await fake.prepareEnvelope(context, {
    signatureRequestId: request.id,
    idempotencyKey: prepare.idempotencyKey,
    correlationId: prepare.correlationId,
    templateId: null,
    subject: request.subject,
    emailBlurb: request.emailBlurb,
    expiresAt: null,
    documents: [
      {
        documentSnapshotId: source.id,
        displayName: source.displayName,
        mimeType: source.mimeType,
        documentOrder: 1,
        bytes: new TextEncoder().encode('%PDF-1.4 fake source'),
        contentHashSha256: source.contentHashSha256,
      },
    ],
    recipients: [
      {
        recipientId: recipient.id,
        name: recipient.name,
        email: recipient.email,
        recipientType: 'signer',
        routingOrder: 1,
        roleName: null,
        authenticationMethod: null,
      },
    ],
  });

  return {
    connection,
    request,
    recipient,
    source,
    envelope,
    context,
    providerEnvelopeId: prepared.providerEnvelopeId,
    idempotencyKey: prepare.idempotencyKey,
  };
}

beforeAll(async () => {
  ctx = await bootApi();
  app = ctx.app;
});

afterAll(async () => {
  const db = ctx.database.db;
  if (created.requests.length > 0) {
    await db.deleteFrom('signature_provider_events').where('request_id', 'in', created.requests).execute();
    await db.deleteFrom('signature_audit_entries').where('request_id', 'in', created.requests).execute();
    await db.deleteFrom('signature_recipients').where('request_id', 'in', created.requests).execute();
    await db.deleteFrom('signature_document_snapshots').where('request_id', 'in', created.requests).execute();
    await db.deleteFrom('signature_requests').where('id', 'in', created.requests).execute();
  }
  if (created.connections.length > 0) {
    await db.deleteFrom('signature_provider_events').where('connection_id', 'in', created.connections).execute();
    await db.deleteFrom('signature_audit_entries').where('connection_id', 'in', created.connections).execute();
    await db.deleteFrom('esignature_connections').where('id', 'in', created.connections).execute();
  }
  await shutdownApi();
});

describe('the initial slice, end to end with the fake provider', () => {
  it('prepares, sends, tracks the signer, completes and stores the artifacts as new rows', async () => {
    const fake = createFakeSignatureProviderAdapter();
    const { requests, recipients, documents, events, audit } = services();
    const flow = await preparedRequest(fake, 'flow');
    const { connection, request, recipient, source, envelope, context, providerEnvelopeId } = flow;

    await audit.append({ action: 'request.prepared', requestId: request.id, connectionId: connection.id, actor: { type: 'user', id: 'admin' } });
    // A prepared request still has no envelope: only a send gives it one (plan §4.3).
    expect(request.providerEnvelopeId).toBeNull();

    const sending = await requests.transition(request.id, { expectedVersion: request.version, to: 'sending', origin: 'local', actorId: 'admin' });
    const identity = sendIdentity({
      connectionId: connection.id,
      signatureRequestId: request.id,
      sendAttemptId: sending.sendAttemptId ?? '',
      providerEnvelopeId,
    });
    const sent = await fake.sendEnvelope(context, {
      signatureRequestId: request.id,
      providerEnvelopeId,
      idempotencyKey: identity.idempotencyKey,
      correlationId: identity.correlationId,
    });
    const withEnvelope = await requests.attachProviderEnvelope(sending.id, sending.version, sent.providerEnvelopeId, sent.providerStatusRaw);
    const markedSent = await requests.transition(withEnvelope.id, {
      expectedVersion: withEnvelope.version,
      to: 'sent',
      origin: 'provider',
      providerStatusRaw: sent.providerStatusRaw,
    });
    expect(markedSent.sentAt).not.toBeNull();
    expect(markedSent.providerEnvelopeId).toBe(providerEnvelopeId);

    // The signer's status is projected onto the local row, and a replayed event changes nothing.
    const providerStatus = await fake.envelopeStatus(context, providerEnvelopeId);
    const applied = await recipients.applyStatus(recipient.id, {
      status: 'sent',
      providerStatusRaw: one(providerStatus.recipients, 'provider recipient').providerStatusRaw,
      eventId: 'evt-sent-1',
    });
    expect(applied.changed).toBe(true);
    expect((await recipients.applyStatus(recipient.id, { status: 'sent', eventId: 'evt-sent-1' })).changed).toBe(false);

    // A verified Connect delivery becomes exactly one normalized event.
    const delivery = FakeSignatureProviderAdapter.signWebhookPayload('connect-secret', {
      event_id: 'evt-delivered-1',
      envelope_id: providerEnvelopeId,
      account_id: 'fake-account-1',
      event_type: 'delivered',
      recipient_id: one(providerStatus.recipients, 'provider recipient').providerRecipientId,
      recipient_status: 'delivered',
      occurred_at: '2026-01-01T09:05:00.000Z',
    });
    const parsed = await fake.verifyAndParseWebhook({
      providerKey: PROVIDER_KEY_DOCUSIGN,
      connectionId: connection.id,
      rawBody: delivery.rawBody,
      headers: delivery.headers,
      contentType: delivery.contentType,
      signingSecret: 'connect-secret',
      requireSignature: true,
      maxPayloadBytes: 262_144,
    });
    expect(parsed.verified).toBe(true);
    const appendInput = {
      connectionId: connection.id,
      requestId: request.id,
      providerKey: PROVIDER_KEY_DOCUSIGN,
      providerAccountId: parsed.providerAccountId,
      providerEnvelopeId: parsed.providerEnvelopeId,
      providerEventId: parsed.providerEventId,
      eventTypeNormalized: parsed.eventTypeNormalized,
      providerEventTypeRaw: parsed.eventTypeRaw,
      recipientProviderId: parsed.recipientProviderId,
      providerOccurredAt: parsed.occurredAt === null ? null : new Date(parsed.occurredAt),
      eventData: parsed.minimized,
      signatureVerificationStatus: 'verified' as const,
      correlationId: parsed.payloadHash.slice(0, 16),
    };
    const appended = await events.append(appendInput);
    expect(appended.created).toBe(true);
    const duplicate = await events.append(appendInput);
    expect(duplicate.created).toBe(false);
    expect(duplicate.event.id).toBe(appended.event.id);
    await events.markProcessed(appended.event.id, 'applied');

    const delivered = await recipients.applyStatus(recipient.id, { status: 'delivered', providerStatusRaw: 'delivered', eventId: parsed.providerEventId });
    expect(delivered.recipient.deliveredAt).not.toBeNull();

    // Completion needs provider evidence; a local edit cannot declare a contract signed.
    await expect(requests.transition(markedSent.id, { expectedVersion: markedSent.version, to: 'completed', origin: 'local' })).rejects.toThrow(
      /only a verified provider event/,
    );
    fake.advance(providerEnvelopeId, 'completed');
    const completed = await requests.transition(markedSent.id, {
      expectedVersion: markedSent.version,
      to: 'completed',
      origin: 'provider',
      providerStatusRaw: 'completed',
    });
    expect(completed.completedAt).not.toBeNull();

    // The signed copy and the certificate are new artifacts; the source row still says what it said.
    const signedArtifacts = await fake.downloadCompletedDocuments(context, providerEnvelopeId);
    const evidence = await fake.downloadCompletionEvidence(context, providerEnvelopeId);
    for (const artifact of [...signedArtifacts, ...evidence]) {
      await documents.record({
        requestId: request.id,
        artifactKind: artifact.artifactKind,
        displayName: artifact.displayName,
        mimeType: artifact.mimeType,
        byteSize: artifact.bytes.byteLength,
        contentHashSha256: artifact.contentHashSha256,
        providerDocumentId: artifact.providerDocumentId,
        settings: DEFAULT_ESIGNATURE_SETTINGS,
      });
    }
    const stored = await documents.listForRequest(request.id);
    expect(new Set(stored.map((entry) => entry.artifactKind))).toEqual(new Set(['source_snapshot', 'provider_signed_document', 'completion_evidence']));
    expect(one(stored.filter((entry) => entry.artifactKind === 'source_snapshot'), 'source row').contentHashSha256).toBe(source.contentHashSha256);
    expect(
      stored
        .filter((entry) => entry.artifactKind === 'completion_evidence')
        .every((entry) => entry.retentionClass === 'evidence'),
    ).toBe(true);

    // The retrieval identity is stable, so a re-run of the job maps to the same artifact and stores
    // nothing new (plan §16).
    const first = one(signedArtifacts, 'signed artifact');
    const retrievalKey = artifactIdentity({
      connectionId: connection.id,
      providerEnvelopeId,
      artifactKind: 'provider_signed_document',
    });
    expect(retrievalKey.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    await documents.record({
      requestId: request.id,
      artifactKind: 'provider_signed_document',
      displayName: first.displayName,
      mimeType: first.mimeType,
      byteSize: first.bytes.byteLength,
      contentHashSha256: first.contentHashSha256,
      providerDocumentId: first.providerDocumentId,
      settings: DEFAULT_ESIGNATURE_SETTINGS,
    });
    expect((await documents.listForRequest(request.id)).filter((entry) => entry.artifactKind === 'provider_signed_document')).toHaveLength(1);

    await audit.append({ action: 'artifact.downloaded', requestId: request.id, actor: { type: 'user', id: 'admin' }, detail: { kind: 'signed' } });
    expect((await audit.listForRequest(request.id)).map((entry) => entry.action)).toEqual(
      expect.arrayContaining(['request.prepared', 'artifact.downloaded']),
    );

    const final = await requests.requireById(request.id);
    expect(final.outgoingDigest).toBe(envelope.digest);
    expect(one(final.outgoingSnapshot?.data.recipients ?? [], 'snapshotted recipient').email).toBe('signer@example.invalid');
    expect(final.version).toBeGreaterThan(request.version);
  });

  it('holds a lost send at send_unknown and reconciles it instead of sending twice', async () => {
    const fake = createFakeSignatureProviderAdapter();
    const { requests, audit } = services();
    const flow = await preparedRequest(fake, 'lost');
    const { connection, request, context, providerEnvelopeId } = flow;

    const sending = await requests.transition(request.id, { expectedVersion: request.version, to: 'sending', origin: 'local', actorId: 'admin' });
    fake.loseNextSendResponse();
    const identity = sendIdentity({
      connectionId: connection.id,
      signatureRequestId: request.id,
      sendAttemptId: sending.sendAttemptId ?? '',
      providerEnvelopeId,
    });
    const failure = await fake
      .sendEnvelope(context, {
        signatureRequestId: request.id,
        providerEnvelopeId,
        idempotencyKey: identity.idempotencyKey,
        correlationId: identity.correlationId,
      })
      .catch((error: unknown) => error);
    expect(isSendOutcomeUnknownError(failure)).toBe(true);
    await audit.append({
      action: 'send.outcome_unknown',
      requestId: request.id,
      outcome: 'refused',
      reasonSafe: 'No response to the send; the envelope was not sent again.',
      correlationId: identity.correlationId,
    });

    const unknown = await requests.transition(sending.id, {
      expectedVersion: sending.version,
      to: 'send_unknown',
      origin: 'local',
      failure: { category: 'unknown_outcome', code: 'PROVIDER_OUTCOME_UNKNOWN', messageSafe: 'No response to the send.' },
    });
    expect(unknown.status).toBe('send_unknown');
    // The attempt token is already claimed, so a second send of the same action is refused at the
    // repository before any provider is contacted.
    const reviewed = unknown.outgoingSnapshot;
    if (reviewed === null) throw new Error('The request lost its outgoing snapshot.');
    await expect(requests.claimSendAttempt(unknown.id, unknown.version, marker('attempt_lost_second'), reviewed)).rejects.toThrow(
      /already carries a send attempt/,
    );
    expect(unknown.failureCategory).toBe('unknown_outcome');

    const reconciling = await requests.transition(unknown.id, {
      expectedVersion: unknown.version,
      to: 'reconciliation_required',
      origin: 'reconciliation',
    });
    const providerTruth = await fake.envelopeStatus(context, providerEnvelopeId);
    expect(providerTruth.status).toBe('sent');
    // The reconciliation result is what records the envelope: the send never gave the platform an
    // answer, so the id arrives here and nowhere else (plan §4.3).
    const attached = await requests.attachProviderEnvelope(reconciling.id, reconciling.version, providerEnvelopeId, providerTruth.providerStatusRaw);
    const resolved = await requests.transition(attached.id, {
      expectedVersion: attached.version,
      to: 'sent',
      origin: 'reconciliation',
      providerStatusRaw: providerTruth.providerStatusRaw,
    });
    expect(resolved.status).toBe('sent');
    expect(resolved.providerEnvelopeId).toBe(providerEnvelopeId);
    // One envelope, one send call: the provider was asked what happened, not told to do it again.
    expect(fake.envelopesFor(request.id)).toHaveLength(1);
    expect(fake.calls.filter((call) => call.operation === 'sendEnvelope')).toHaveLength(1);
  });

  it('answers through the registry the operations this release does not offer', () => {
    const { providers } = services();
    expect(providers.supports(PROVIDER_KEY_DOCUSIGN, 'prepareEnvelope')).toBe(true);
    expect(providers.supports(PROVIDER_KEY_DOCUSIGN, 'voidEnvelope')).toBe(true);
    expect(providers.supports(PROVIDER_KEY_DOCUSIGN, 'recipientView')).toBe(true);
    expect(providers.supports(PROVIDER_KEY_DOCUSIGN, 'resendNotifications')).toBe(true);
    expect(providers.supports(PROVIDER_KEY_DOCUSIGN, 'correctEnvelope')).toBe(false);
    // The bound adapter is the fake, and a fake is never a live integration.
    expect(providers.report().every((descriptor) => descriptor.mode === 'fake')).toBe(true);
    expect(providers.hasLiveAdapter(PROVIDER_KEY_DOCUSIGN)).toBe(false);
  });
});
