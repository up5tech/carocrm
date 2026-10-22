import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ESignatureConnectionGate } from '../src/esignature/esignature-connection-gate.service.js';
import { DEFAULT_ESIGNATURE_SETTINGS } from '../src/esignature/esignature-settings.service.js';
import { buildSnapshot, type OutgoingSnapshotData } from '../src/esignature/esignature-snapshot.js';
import { SignatureAuditRepository } from '../src/esignature/signature-audit.repository.js';
import { SignatureConnectionRepository } from '../src/esignature/signature-connection.repository.js';
import { SignatureDocumentSnapshotRepository } from '../src/esignature/signature-document-snapshot.repository.js';
import { payloadDigest,SignatureProviderEventRepository } from '../src/esignature/signature-provider-event.repository.js';
import { SignatureRecipientRepository } from '../src/esignature/signature-recipient.repository.js';
import { SignatureRequestRepository } from '../src/esignature/signature-request.repository.js';
import { SignatureTemplateMappingRepository } from '../src/esignature/signature-template-mapping.repository.js';
import { SignatureWebhookInboxRepository } from '../src/esignature/signature-webhook-inbox.repository.js';
import type { ApiContext } from './support/boot-api.js';
import { bootApi, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-ES.2 — the persistence and the guarded lifecycle, against the configured database
 * (`PLAN_Phase_19_ESignature.md` §6, §7, §17.2; `19-ES.2` acceptance).
 *
 * Runs on the already-configured primary database (AGENTS.md §3.1). No database, schema, container or
 * copy is created; every row carries `AGENT_TEST_<runId>` and is removed by its exact id in
 * `afterAll`, children before parents (§3.3). Nothing here calls a provider — there is no adapter yet,
 * and these rows exist precisely to prove the database refuses what the plan says must be refused.
 *
 * The assertions worth reading are the refusals: a status a user cannot set, an envelope id already
 * taken in this connection, a stale version, a duplicate delivery, an audit value that looks like a
 * credential.
 */

let ctx: ApiContext;
let app: NestFastifyApplication;
const runId = `es2${Date.now().toString(36)}`;
const marker = (suffix: string) => `AGENT_TEST_${runId}_${suffix}`;

const created = {
  connections: [] as string[],
  requests: [] as string[],
  recipients: [] as string[],
  documents: [] as string[],
  events: [] as string[],
  inbox: [] as string[],
  mappings: [] as string[],
};

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function repositories() {
  return {
    connections: app.get(SignatureConnectionRepository),
    requests: app.get(SignatureRequestRepository),
    recipients: app.get(SignatureRecipientRepository),
    documents: app.get(SignatureDocumentSnapshotRepository),
    events: app.get(SignatureProviderEventRepository),
    inbox: app.get(SignatureWebhookInboxRepository),
    mappings: app.get(SignatureTemplateMappingRepository),
    audit: app.get(SignatureAuditRepository),
    gate: app.get(ESignatureConnectionGate),
  };
}

/** One recipient came back, or the fixture is wrong. */
function onlySigner(recipients: readonly { id: string; name: string }[]): { id: string; name: string } {
  const [first] = recipients;
  if (first === undefined) throw new Error('Expected exactly one stored recipient.');
  return first;
}

async function snapshotPayload(requestId: string, hash = HASH_A): Promise<OutgoingSnapshotData> {
  return {
    providerKey: 'docusign',
    connectionId: marker('conn'),
    environment: 'demo',
    accountId: 'acct-1',
    templateId: null,
    subject: 'Please sign',
    message: null,
    emailBlurb: null,
    expiresAt: null,
    documents: [
      {
        documentSnapshotId: 'doc-1',
        displayName: 'agreement.pdf',
        mimeType: 'application/pdf',
        byteSize: 1024,
        contentHashSha256: hash,
        documentOrder: 1,
        sourceAttachmentId: null,
      },
    ],
    recipients: [
      {
        recipientId: 'rec-1',
        name: 'Agent Test Signer',
        email: 'signer@example.invalid',
        recipientType: 'signer',
        routingOrder: 1,
        roleName: null,
        authenticationMethod: null,
      },
    ],
    policy: { requestId },
  };
}

beforeAll(async () => {
  ctx = await bootApi();
  app = ctx.app;
});

afterAll(async () => {
  const db = ctx.database.db;
  // Children first: the FKs are RESTRICT on purpose, so history outlives the rows that produced it.
  if (created.events.length > 0) await db.deleteFrom('signature_provider_events').where('id', 'in', created.events).execute();
  if (created.inbox.length > 0) await db.deleteFrom('signature_webhook_inbox').where('id', 'in', created.inbox).execute();
  if (created.recipients.length > 0) await db.deleteFrom('signature_recipients').where('id', 'in', created.recipients).execute();
  if (created.documents.length > 0) await db.deleteFrom('signature_document_snapshots').where('id', 'in', created.documents).execute();
  if (created.mappings.length > 0) await db.deleteFrom('signature_template_mappings').where('id', 'in', created.mappings).execute();
  // Audit entries reference a request with RESTRICT, so they go before the requests.
  if (created.requests.length > 0) {
    await db.deleteFrom('signature_audit_entries').where('request_id', 'in', created.requests).execute();
    await db.deleteFrom('signature_requests').where('id', 'in', created.requests).execute();
  }
  if (created.connections.length > 0) {
    await db.deleteFrom('signature_audit_entries').where('connection_id', 'in', created.connections).execute();
    await db.deleteFrom('signature_template_mappings').where('connection_id', 'in', created.connections).execute();
    await db.deleteFrom('esignature_connections').where('id', 'in', created.connections).execute();
  }
  await shutdownApi();
});

describe('the provider connection', () => {
  it('starts unusable and only becomes usable through an authorization', async () => {
    const { connections, gate } = repositories();
    const connection = await connections.create({ name: marker('conn_draft'), environment: 'demo' });
    created.connections.push(connection.id);
    expect(connection.status).toBe('not_connected');
    expect(connection.isActive).toBe(false);
    // The routing id exists from creation and is opaque: a webhook path segment, not a secret.
    expect(connection.publicId).toHaveLength(32);

    const before = await gate.assessment();
    expect(before.enabledConnections).toBe(0);

    await connections.recordAuthorized(connection.id, {
      accountId: 'acct-1',
      baseUri: 'https://demo.docusign.net',
      grantedScopes: ['signature'],
      subjectUserId: 'user-1',
    });
    const after = await connections.findById(connection.id);
    expect(after?.status).toBe('connected');
    expect(await connections.countUsable()).toBeGreaterThan(0);

    // No credential is reachable from this row: the vault owns those columns elsewhere.
    const raw = await ctx.database.db.selectFrom('esignature_connections').selectAll().where('id', '=', connection.id).executeTakeFirstOrThrow();
    const serialized = JSON.stringify(raw);
    for (const forbidden of ['payload_encrypted', 'refresh', 'client_secret', 'hmac']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('refuses activation before authorization and an environment that is not named', async () => {
    const { connections } = repositories();
    const connection = await connections.create({ name: marker('conn_inact'), environment: 'demo' });
    created.connections.push(connection.id);
    await expect(connections.setActive(connection.id, true)).rejects.toThrow(/must be authorized/);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(connections.create({ name: marker('bad_env'), environment: 'staging' as any })).rejects.toThrow(/demo or the production/);
  });

  it('keeps history when a connection is disconnected', async () => {
    const { connections, requests } = repositories();
    const connection = await connections.create({ name: marker('conn_disc'), environment: 'demo' });
    created.connections.push(connection.id);
    await connections.recordAuthorized(connection.id, { accountId: 'acct-1', baseUri: 'https://demo.docusign.net', grantedScopes: ['signature'] });
    const request = await requests.createDraft({ name: marker('req_on_disc'), connectionId: connection.id });
    created.requests.push(request.id);

    const disconnected = await connections.disconnect(connection.id);
    expect(disconnected.isActive).toBe(false);
    expect(disconnected.deleted).toBe(true);
    // The request row is untouched, and the connection still answers a direct read: plan §21.12.
    const stillThere = await connections.findById(connection.id, { includeDeleted: true });
    expect(stillThere?.accountId).toBe('acct-1');
    expect(await connections.hasRequests(connection.id)).toBe(true);
  });
});

describe('the request lifecycle through the repository', () => {
  it('creates a local draft with no envelope and no provider contact', async () => {
    const { requests } = repositories();
    const draft = await requests.createDraft({
      name: marker('req_draft'),
      sourceEntityType: 'Account',
      sourceRecordId: 'acc-1',
      createdById: 'admin',
      approvalRequired: false,
    });
    created.requests.push(draft.id);
    expect(draft.status).toBe('draft');
    expect(draft.providerEnvelopeId).toBeNull();
    expect(draft.version).toBe(1);
    expect(draft.approvalStatus).toBe('not_required');
  });

  it('refuses a CRM-initiated move into a provider-owned state and allows the evidenced one', async () => {
    const { requests, connections } = repositories();
    const connection = await connections.create({ name: marker('conn_gate'), environment: 'demo' });
    created.connections.push(connection.id);
    await connections.recordAuthorized(connection.id, { accountId: 'acct-1', baseUri: 'https://demo.docusign.net', grantedScopes: ['signature'] });

    const draft = await requests.createDraft({ name: marker('req_move'), connectionId: connection.id });
    created.requests.push(draft.id);

    const prepared = await requests.transition(draft.id, { expectedVersion: draft.version, to: 'ready_to_send', origin: 'local' });
    expect(prepared.version).toBe(draft.version + 1);
    const sending = await requests.transition(prepared.id, { expectedVersion: prepared.version, to: 'sending', origin: 'local', actorId: 'admin' });
    await expect(
      requests.transition(sending.id, { expectedVersion: sending.version, to: 'sent', origin: 'local' }),
    ).rejects.toThrow(/only a verified provider event/);

    const sent = await requests.transition(sending.id, {
      expectedVersion: sending.version,
      to: 'sent',
      origin: 'provider',
      providerStatusRaw: 'sent',
    });
    expect(sent.sentAt).not.toBeNull();
    expect(sent.providerStatusRaw).toBe('sent');

    // A completed request cannot be dragged back by an out-of-order event.
    const completed = await requests.transition(sent.id, { expectedVersion: sent.version, to: 'completed', origin: 'provider' });
    expect(completed.completedAt).not.toBeNull();
    await expect(requests.transition(completed.id, { expectedVersion: completed.version, to: 'sent', origin: 'provider' })).rejects.toThrow(/finished/);
    const reconciling = await requests.transition(completed.id, { expectedVersion: completed.version, to: 'reconciliation_required', origin: 'reconciliation' });
    const reConfirmed = await requests.transition(reconciling.id, { expectedVersion: reconciling.version, to: 'completed', origin: 'reconciliation' });
    expect(reConfirmed.status).toBe('completed');
  });

  it('loses a concurrent writer explicitly rather than overwriting it', async () => {
    const { requests } = repositories();
    const draft = await requests.createDraft({ name: marker('req_conc') });
    created.requests.push(draft.id);
    await requests.updateDraft(draft.id, draft.version, { name: marker('req_conc_renamed') });
    await expect(requests.updateDraft(draft.id, draft.version, { name: marker('req_conc_lost') })).rejects.toThrow(/has been modified/);
  });

  it('refuses a draft edit that names a server-owned column', async () => {
    const { requests } = repositories();
    const draft = await requests.createDraft({ name: marker('req_owned') });
    created.requests.push(draft.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(requests.updateDraft(draft.id, draft.version, { status: 'completed' } as any)).rejects.toThrow(/set by the platform/);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(requests.updateDraft(draft.id, draft.version, { providerEnvelopeId: 'forged' } as any)).rejects.toThrow(/set by the platform/);
  });

  it('refuses an edit of a request that has already been sent', async () => {
    const { requests, connections } = repositories();
    const connection = await connections.create({ name: marker('conn_sent'), environment: 'demo' });
    created.connections.push(connection.id);
    await connections.recordAuthorized(connection.id, { accountId: 'acct-1', baseUri: 'https://demo.docusign.net', grantedScopes: ['signature'] });
    const draft = await requests.createDraft({ name: marker('req_sent'), connectionId: connection.id });
    created.requests.push(draft.id);
    const sending = await requests.transition(draft.id, { expectedVersion: draft.version, to: 'sending', origin: 'local' });
    const sent = await requests.transition(sending.id, { expectedVersion: sending.version, to: 'sent', origin: 'provider' });
    await expect(requests.updateDraft(sent.id, sent.version, { subject: 'changed after send' })).rejects.toThrow(/only allowed while the request is a draft/);
    await expect(requests.softDelete(sent.id)).rejects.toThrow(/cannot be deleted; void it instead/);
  });

  it('records one provider envelope per connection, and refuses a collision', async () => {
    const { requests, connections } = repositories();
    const connection = await connections.create({ name: marker('conn_env'), environment: 'demo' });
    created.connections.push(connection.id);
    await connections.recordAuthorized(connection.id, { accountId: 'acct-1', baseUri: 'https://demo.docusign.net', grantedScopes: ['signature'] });

    const first = await requests.createDraft({ name: marker('req_env_1'), connectionId: connection.id });
    created.requests.push(first.id);
    const attached = await requests.attachProviderEnvelope(first.id, first.version, 'ENVELOPE-1', 'sent');
    expect(attached.providerEnvelopeId).toBe('ENVELOPE-1');

    const second = await requests.createDraft({ name: marker('req_env_2'), connectionId: connection.id });
    created.requests.push(second.id);
    await expect(requests.attachProviderEnvelope(second.id, second.version, 'ENVELOPE-1')).rejects.toThrow(/already recorded/);

    // The same id under a *different* connection is a different envelope: uniqueness is scoped to the
    // account context, exactly as plan §6.2 requires.
    const other = await connections.create({ name: marker('conn_env_other'), environment: 'production' });
    created.connections.push(other.id);
    await connections.recordAuthorized(other.id, { accountId: 'acct-2', baseUri: 'https://www.docusign.net', grantedScopes: ['signature'] });
    const third = await requests.createDraft({ name: marker('req_env_3'), connectionId: other.id });
    created.requests.push(third.id);
    expect((await requests.attachProviderEnvelope(third.id, third.version, 'ENVELOPE-1')).connectionId).toBe(other.id);
  });

  it('claims a send attempt once and refuses another request’s token', async () => {
    const { requests } = repositories();
    const draft = await requests.createDraft({ name: marker('req_send') });
    created.requests.push(draft.id);
    const envelope = buildSnapshot(`SignatureRequest:${draft.id}`, await snapshotPayload(draft.id));
    const claimed = await requests.claimSendAttempt(draft.id, draft.version, marker('attempt'), envelope);
    expect(claimed.sendAttemptId).toBe(marker('attempt'));
    expect(claimed.outgoingDigest).toBe(envelope.digest);

    // The same action retried with the same token keeps the snapshot it already wrote.
    const retried = await requests.claimSendAttempt(claimed.id, claimed.version, marker('attempt'), envelope);
    expect(retried.outgoingDigest).toBe(envelope.digest);

    const other = await requests.createDraft({ name: marker('req_send_other') });
    created.requests.push(other.id);
    await expect(requests.claimSendAttempt(other.id, other.version, marker('attempt'), envelope)).rejects.toThrow(/already been used/);
  });

  it('lists with the filters the request list screen needs', async () => {
    const { requests } = repositories();
    const draft = await requests.createDraft({ name: marker('req_list'), sourceEntityType: 'Quote', sourceRecordId: 'quote-1' });
    created.requests.push(draft.id);
    const bySource = await requests.list({ sourceEntityType: 'Quote', sourceRecordId: 'quote-1' });
    expect(bySource.list.map((entry) => entry.id)).toContain(draft.id);
    expect(bySource.total).toBeGreaterThanOrEqual(1);
    const mine = await requests.list({ createdById: 'admin', limit: 5 });
    expect(mine.list.length).toBeLessThanOrEqual(5);
  });
});

describe('recipients, documents, events and the audit trail', () => {
  it('stores the submitted identity as a snapshot and refuses an ambiguous template role', async () => {
    const { requests, recipients } = repositories();
    const draft = await requests.createDraft({ name: marker('req_recip') });
    created.requests.push(draft.id);

    const stored = await recipients.replaceForDraft(
      draft.id,
      [
        { name: 'Agent Test First', email: 'FIRST@Example.INVALID', routingOrder: 1 },
        { name: 'Agent Test Second', email: 'second@example.invalid', routingOrder: 1, recipientType: 'carbon_copy' },
      ],
      'admin',
    );
    created.recipients.push(...stored.map((entry) => entry.id));
    // Parallel routing at the same order is legitimate (plan §4.4). The email is normalized to lower
    // case, and the name is what the sender typed — never a Contact lookup (plan §4.4).
    expect(stored.map((entry) => entry.email).sort()).toEqual(['first@example.invalid', 'second@example.invalid']);
    expect(stored.map((entry) => entry.name).sort()).toEqual(['Agent Test First', 'Agent Test Second']);

    const refreshed = await requests.requireById(draft.id);
    expect(refreshed.version).toBe(draft.version + 1);

    await expect(
      recipients.replaceForDraft(
        draft.id,
        [
          { name: 'A', email: 'a@example.invalid', routingOrder: 1, roleName: 'Signer' },
          { name: 'B', email: 'b@example.invalid', routingOrder: 2, roleName: 'Signer' },
        ],
        'admin',
      ),
    ).rejects.toThrow(/template role/);
    await expect(recipients.replaceForDraft(draft.id, [{ name: 'A', email: 'not-an-email', routingOrder: 1 }])).rejects.toThrow(/valid email/);
  });

  it('applies a signer status once, and ignores a duplicate or backwards event', async () => {
    const { requests, recipients } = repositories();
    const draft = await requests.createDraft({ name: marker('req_status') });
    created.requests.push(draft.id);
    const stored = await recipients.replaceForDraft(draft.id, [{ name: 'Agent Test Signer', email: 'signer@example.invalid', routingOrder: 1 }], 'admin');
    created.recipients.push(...stored.map((entry) => entry.id));
    const signer = onlySigner(stored);

    const sent = await recipients.applyStatus(signer.id, { status: 'sent', eventId: 'evt-1' });
    expect(sent.changed).toBe(true);
    const replay = await recipients.applyStatus(signer.id, { status: 'delivered', eventId: 'evt-1' });
    expect(replay.changed).toBe(false);
    const backwards = await recipients.applyStatus(signer.id, { status: 'pending', eventId: 'evt-2' });
    expect(backwards.changed).toBe(false);
    const completed = await recipients.applyStatus(signer.id, { status: 'completed', eventId: 'evt-3' });
    expect(completed.recipient.completedAt).not.toBeNull();
    expect((await recipients.progress(draft.id)).completed).toBe(1);

    // A late "declined" for a signer who already completed is history, not a rewrite of the evidence.
    const declined = await recipients.applyStatus(signer.id, { status: 'declined', eventId: 'evt-4', declineReasonSafe: 'will not sign' });
    expect(declined.changed).toBe(false);
    expect(declined.recipient.status).toBe('completed');
  });

  it('records the artifact by the bytes that were sent, and is idempotent on a retry', async () => {
    const { requests, documents } = repositories();
    const draft = await requests.createDraft({ name: marker('req_doc') });
    created.requests.push(draft.id);

    const first = await documents.record({
      requestId: draft.id,
      artifactKind: 'source_snapshot',
      displayName: 'agreement.pdf',
      mimeType: 'application/pdf',
      byteSize: 1024,
      contentHashSha256: HASH_A,
      documentOrder: 1,
      settings: DEFAULT_ESIGNATURE_SETTINGS,
    });
    created.documents.push(first.snapshot.id);
    expect(first.created).toBe(true);

    const again = await documents.record({
      requestId: draft.id,
      artifactKind: 'source_snapshot',
      displayName: 'agreement.pdf',
      mimeType: 'application/pdf',
      byteSize: 1024,
      contentHashSha256: HASH_A,
      documentOrder: 1,
      settings: DEFAULT_ESIGNATURE_SETTINGS,
    });
    expect(again.created).toBe(false);
    expect(again.snapshot.id).toBe(first.snapshot.id);

    // A different byte string in the same slot is a changed document, and a draft must say so
    // rather than silently re-point the slot.
    await expect(
      documents.record({
        requestId: draft.id,
        artifactKind: 'source_snapshot',
        displayName: 'agreement-v2.pdf',
        mimeType: 'application/pdf',
        byteSize: 2048,
        contentHashSha256: HASH_B,
        documentOrder: 1,
        settings: DEFAULT_ESIGNATURE_SETTINGS,
      }),
    ).rejects.toThrow(/already holds different content/);

    const signed = await documents.record({
      requestId: draft.id,
      artifactKind: 'provider_signed_document',
      displayName: 'agreement-signed.pdf',
      mimeType: 'application/pdf',
      byteSize: 4096,
      contentHashSha256: HASH_B,
      providerDocumentId: 'provider-doc-1',
      settings: DEFAULT_ESIGNATURE_SETTINGS,
    });
    created.documents.push(signed.snapshot.id);
    // The source row is untouched by the signed copy, and the signed copy is classified as evidence
    // with no purge date (plan §4.5).
    const kinds = (await documents.listForRequest(draft.id)).map((entry) => entry.artifactKind);
    expect(new Set(kinds)).toEqual(new Set(['source_snapshot', 'provider_signed_document']));
    const source = (await documents.listForRequest(draft.id, ['source_snapshot']))[0];
    expect(source?.contentHashSha256).toBe(HASH_A);
    expect(source?.displayName).toBe('agreement.pdf');
    expect(signed.snapshot.retentionClass).toBe('evidence');

    const retried = await documents.record({
      requestId: draft.id,
      artifactKind: 'provider_signed_document',
      displayName: 'agreement-signed.pdf',
      mimeType: 'application/pdf',
      byteSize: 4096,
      contentHashSha256: HASH_B,
      providerDocumentId: 'provider-doc-1',
      settings: DEFAULT_ESIGNATURE_SETTINGS,
    });
    expect(retried.created).toBe(false);
  });

  it('appends a provider event once per dedup key and keeps an unknown one as history', async () => {
    const { requests, events } = repositories();
    const draft = await requests.createDraft({ name: marker('req_evt') });
    created.requests.push(draft.id);
    const input = {
      providerKey: 'docusign',
      providerEnvelopeId: 'ENVELOPE-EVT',
      providerEventId: marker('event-1'),
      eventTypeNormalized: 'sent',
      providerEventTypeRaw: 'sent',
      eventData: { status: 'sent' },
      signatureVerificationStatus: 'verified' as const,
    };
    const first = await events.append(input);
    if (first.created) created.events.push(first.event.id);
    expect(first.created).toBe(true);
    const replay = await events.append(input);
    expect(replay.created).toBe(false);
    expect(replay.event.id).toBe(first.event.id);

    const unmapped = await events.append({ ...input, providerEventId: marker('event-2'), eventTypeNormalized: 'unmapped', providerEventTypeRaw: 'future_status' });
    if (unmapped.created) created.events.push(unmapped.event.id);
    expect(unmapped.event.eventTypeNormalized).toBe('unmapped');
    expect(unmapped.event.processingStatus).toBe('pending');

    await events.linkRequest(first.event.id, draft.id);
    await events.markProcessed(first.event.id, 'applied');
    const stored = await events.findByDedupKey(first.event.dedupKey);
    expect(stored?.processingStatus).toBe('applied');
    expect(stored?.attemptCount).toBe(1);
    expect((await events.listForRequest(draft.id)).length).toBe(1);
  });

  it('durably accepts a delivery and refuses a duplicate without a second row', async () => {
    const { inbox } = repositories();
    const dedupKey = marker('delivery-1');
    const body = { envelopeId: 'ENVELOPE-INBOX', event: 'sent' };
    const accept = {
      providerKey: 'docusign',
      dedupKey,
      payloadHash: payloadDigest(body),
      contentLength: 128,
      signatureStatus: 'verified' as const,
      payloadMinimized: body,
    };
    const first = await inbox.accept(accept);
    if (first.created) created.inbox.push(first.delivery.id);
    expect(first.created).toBe(true);
    const duplicate = await inbox.accept(accept);
    expect(duplicate.created).toBe(false);
    expect(duplicate.delivery.id).toBe(first.delivery.id);

    expect(await inbox.markState(first.delivery.id, 'processed', { from: ['received'] })).toBe(true);
    // The second claim finds nothing: the row has already moved on, which is what makes a concurrent
    // worker's claim a no-op rather than a double processing.
    expect(await inbox.markState(first.delivery.id, 'processing', { from: ['received'] })).toBe(false);
    const counts = await inbox.countsByState();
    expect(counts.processed).toBeGreaterThanOrEqual(1);
  });

  it('appends the audit trail, refuses an undeclared action and drops credential-shaped detail', async () => {
    const { requests, audit } = repositories();
    const draft = await requests.createDraft({ name: marker('req_audit') });
    created.requests.push(draft.id);

    const entry = await audit.append({
      action: 'send.confirmed',
      requestId: draft.id,
      actor: { type: 'user', id: 'admin', name: 'admin' },
      correlationId: marker('corr'),
      detail: { documentCount: 1, signatureUrl: 'https://example/signed?a=b', recipientEmail: 'signer@example.invalid' },
    });
    expect(entry.action).toBe('send.confirmed');
    expect(Object.keys(entry.detail)).toEqual(['documentCount', 'recipientEmail']);

    const refused = await audit.append({ action: 'send.confirmed', requestId: draft.id, outcome: 'refused', reasonSafe: 'No provider connection is enabled.' });
    expect(refused.outcome).toBe('refused');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(audit.append({ action: 'envelope.forged' as any, requestId: draft.id })).rejects.toThrow(/not a declared signature audit action/);
    expect(await audit.countFor(draft.id)).toBe(2);
  });
});

describe('template mappings', () => {
  it('stores a mapping per connection and refuses an expression in its values', async () => {
    const { connections, mappings } = repositories();
    const connection = await connections.create({ name: marker('conn_map'), environment: 'demo' });
    created.connections.push(connection.id);

    const mapping = await mappings.create({
      name: marker('map'),
      connectionId: connection.id,
      providerTemplateId: 'template-1',
      providerTemplateName: 'Agent test agreement',
      supportedSourceEntities: ['Quote'],
      roleMappings: [{ roleName: 'Signer', recipientType: 'signer', routingOrder: 1, source: 'crmField', crmField: 'primaryEmail' }],
      fieldMappings: [{ tabName: 'company', crmField: 'name', required: true }],
      createdById: 'admin',
    });
    created.mappings.push(mapping.id);
    expect(mapping.version).toBe(1);
    expect(mapping.roleMappings[0]?.crmField).toBe('primaryEmail');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(mappings.create({ name: marker('map_bad'), connectionId: connection.id, providerTemplateId: 't', fieldMappings: [{ tabName: '${formula}', crmField: 'name', required: false }] } as any)).rejects.toThrow(/not an expression/);

    const updated = await mappings.update(mapping.id, mapping.version, { providerTemplateName: 'Renamed' }, 'admin');
    expect(updated.version).toBe(2);
    await expect(mappings.update(mapping.id, mapping.version, { providerTemplateName: 'stale' })).rejects.toThrow(/has been modified/);

    const deactivated = await mappings.setActive(mapping.id, false);
    expect(deactivated.isActive).toBe(false);
    expect(await mappings.findByProviderTemplate(connection.id, 'template-1')).toBeDefined();
  });
});

describe('the gate after ES.2', () => {
  it('still refuses a send with a live connection, because the connection phase has not shipped', async () => {
    const { connections, gate } = repositories();
    const connection = await connections.create({ name: marker('conn_gate2'), environment: 'demo' });
    created.connections.push(connection.id);
    await connections.recordAuthorized(connection.id, { accountId: 'acct-1', baseUri: 'https://demo.docusign.net', grantedScopes: ['signature'] });

    const assessment = await gate.assessment();
    expect(assessment.enabledConnections).toBeGreaterThan(0);
    // The feature flag is what stays closed until ES.4, so a stray connection row cannot open the
    // module: plan §18 acceptance holds across both mechanisms.
    expect(assessment.ready).toBe(false);
    // Resolved outside a request, the caller holds no capability at all, so the very first wall is
    // the permission check. The API-level refusal of the module switch is covered in
    // `esignature.test.ts`; either way, nothing is admitted.
    await expect(gate.assertOperation('sendEnvelope')).rejects.toThrow(/Permission|not enabled/);
  });
});

