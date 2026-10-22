import { describe, expect, it } from 'vitest';

import {
  CONNECTION_STATUSES,
  REQUEST_STATUSES,
} from '../src/esignature/esignature-domain.js';
import {
  artifactRetentionFor,
  isAppendOnly,
  retentionPolicy,
  SOFT_DELETE_RULES,
} from '../src/esignature/esignature-retention.js';
import { DEFAULT_ESIGNATURE_SETTINGS } from '../src/esignature/esignature-settings.service.js';
import {
  approvalStillApplies,
  buildSnapshot,
  canonicalJson,
  type OutgoingSnapshotData,
  outgoingSnapshotDigest,
  readSnapshot,
} from '../src/esignature/esignature-snapshot.js';
import {
  allowedTargets,
  assertEditable,
  assertTransition,
  canRecipientMove,
  canTransition,
  isFinished,
  isTerminalStatus,
  RECIPIENT_STATUSES,
  REQUEST_TRANSITIONS,
  statusRank,
  type TransitionOrigin,
} from '../src/esignature/esignature-state-machine.js';
import { redactDetail } from '../src/esignature/signature-audit.repository.js';
import { assertConnectionTransition, canConnectionTransition, CONNECTION_TRANSITIONS } from '../src/esignature/signature-connection.repository.js';
import { buildEventDedupKey, payloadDigest } from '../src/esignature/signature-provider-event.repository.js';
import { normalizeFieldMappings, normalizeRoleMappings } from '../src/esignature/signature-template-mapping.repository.js';

/**
 * Phase 19-ES.2 — the domain rules, tested without a database
 * (`PLAN_Phase_19_ESignature.md` §17.1, §18 `19-ES.2` acceptance
 * "request state transitions are unit-tested").
 *
 * These are the decisions the later phases are not allowed to re-litigate: who may move a request
 * into a given state, what a snapshot promises, and what the retention rule refuses to throw away.
 * Nothing here touches the database, so the suite runs as plain unit tests.
 */

const EVIDENCE_STATES = ['sent', 'delivered', 'partially_signed', 'completed', 'declined', 'voided', 'expired'] as const;

describe('signature request state machine', () => {
  it('declares a transition row for every declared state', () => {
    for (const status of REQUEST_STATUSES) {
      expect(REQUEST_TRANSITIONS[status], status).toBeTypeOf('object');
    }
    expect(Object.keys(REQUEST_TRANSITIONS).sort()).toEqual([...REQUEST_STATUSES].sort());
  });

  it('allows a draft to advance, and a reviewed draft back to draft', () => {
    expect(canTransition('draft', 'ready_to_send')).toBe(true);
    expect(canTransition('draft', 'pending_approval')).toBe(true);
    expect(canTransition('ready_to_send', 'draft')).toBe(true);
    expect(canTransition('draft', 'completed')).toBe(false);
    // A state never advances to itself.
    expect(canTransition('draft', 'draft')).toBe(false);
  });

  it('refuses a CRM user moving a request into any provider-owned state', () => {
    for (const target of EVIDENCE_STATES) {
      const from: Record<string, string> = {
        sent: 'sending',
        delivered: 'sent',
        partially_signed: 'sent',
        completed: 'partially_signed',
        declined: 'sent',
        voided: 'sent',
        expired: 'sent',
      };
      const origin = from[target] as keyof typeof REQUEST_TRANSITIONS;
      expect(canTransition(origin, target as never), `${origin} -> ${target} exists in the table`).toBe(true);
      expect(() => assertTransition(origin, target as never, 'local')).toThrowError(/only a verified provider event|provider/);
      expect(() => assertTransition(origin, target as never, 'provider')).not.toThrow();
    }
  });

  it('keeps the local preparation states reachable for a CRM user', () => {
    expect(() => assertTransition('draft', 'pending_approval', 'local')).not.toThrow();
    expect(() => assertTransition('pending_approval', 'ready_to_send', 'local')).not.toThrow();
    expect(() => assertTransition('ready_to_send', 'sending', 'local')).not.toThrow();
    expect(() => assertTransition('ready_to_send', 'draft', 'local')).not.toThrow();
  });

  it('treats a lost send response as its own state, never as a retry', () => {
    expect(() => assertTransition('sending', 'send_unknown', 'local')).not.toThrow();
    // A send whose outcome is unknown goes to the provider only through reconciliation or a verified
    // event — and never back to `ready_to_send`, which would be the blind retry (plan §4.3, §16).
    expect(canTransition('send_unknown', 'ready_to_send')).toBe(false);
    expect(canTransition('send_unknown', 'draft')).toBe(false);
    expect(() => assertTransition('send_unknown', 'draft', 'local')).toThrow();
  });

  it('gives a terminal state exactly one guarded way out', () => {
    const terminal = ['completed', 'declined', 'voided', 'expired'] as const;
    for (const status of terminal) {
      expect(isTerminalStatus(status)).toBe(true);
      // No provider event re-writes a finished envelope directly: drift is raised, then resolved.
      expect(allowedTargets(status, 'provider')).toEqual([]);
      // An operator may raise reconciliation — that fabricates no progress — and nothing else.
      expect(allowedTargets(status, 'local')).toEqual(['reconciliation_required']);
      expect(() => assertTransition(status, 'sent', 'provider')).toThrow(/finished/);
      expect(() => assertTransition(status, 'reconciliation_required', 'reconciliation')).not.toThrow();
    }
    // And reconciliation lands on whatever the provider says, including re-confirming the same
    // terminal state.
    expect(() => assertTransition('reconciliation_required', 'completed', 'reconciliation')).not.toThrow();
    expect(() => assertTransition('reconciliation_required', 'sent', 'provider')).not.toThrow();
  });

  it('does not let reconciliation invent progress on a live request', () => {
    // Reconciliation is a route out of a terminal or stuck state only; an operator raises it, and the
    // reconciliation path then lands on what the provider says.
    expect(() => assertTransition('sent', 'reconciliation_required', 'reconciliation')).toThrow();
    expect(canTransition('sent', 'reconciliation_required')).toBe(true);
    expect(() => assertTransition('sent', 'reconciliation_required', 'local')).not.toThrow();
    expect(() => assertTransition('sent', 'draft', 'reconciliation')).toThrow();
    expect(() => assertTransition('sending', 'draft', 'reconciliation')).toThrow();
  });

  it('refuses an unknown state rather than treating it as draft', () => {
    expect(() => assertTransition('draft', 'signed_by_hand' as never, 'local')).toThrow();
  });

  it('ranks progress but withholds a rank from states that do not describe progress', () => {
    expect(statusRank('draft')).toBe(0);
    expect(statusRank('partially_signed')).toBeGreaterThan(statusRank('sent') ?? 0);
    // A decline, a void, an expiry and a stuck state are not "further along" — comparing them would
    // let a mapper argue that a voided envelope is really still open.
    expect(statusRank('declined')).toBeNull();
    expect(statusRank('voided')).toBeNull();
    expect(statusRank('expired')).toBeNull();
    expect(statusRank('send_unknown')).toBeNull();
    expect(statusRank('reconciliation_required')).toBeNull();
  });

  it('marks the stuck states as needing an operator, and finished ones as closed', () => {
    expect(isFinished('send_unknown')).toBe(true);
    expect(isFinished('completed')).toBe(true);
    expect(isFinished('sent')).toBe(false);
    expect(assertEditable('draft', 'update')).toBeUndefined();
    expect(() => assertEditable('sent', 'update')).toThrow(/only allowed while the request is a draft/);
  });
});

describe('recipient projection', () => {
  it('moves a signer forward and never back', () => {
    expect(canRecipientMove('pending', 'sent')).toBe(true);
    expect(canRecipientMove('sent', 'delivered')).toBe(true);
    expect(canRecipientMove('delivered', 'viewed')).toBe(true);
    expect(canRecipientMove('viewed', 'signed')).toBe(true);
    expect(canRecipientMove('signed', 'completed')).toBe(true);
    expect(canRecipientMove('completed', 'sent')).toBe(false);
    expect(canRecipientMove('completed', 'completed')).toBe(false);
    expect(canRecipientMove('declined', 'sent')).toBe(false);
  });

  it('lets a decline replace an open status but nothing replace a terminal outcome', () => {
    expect(canRecipientMove('delivered', 'declined')).toBe(true);
    expect(canRecipientMove('declined', 'completed')).toBe(false);
    for (const status of RECIPIENT_STATUSES) {
      expect(RECIPIENT_STATUSES).toContain(status);
    }
  });

  it('counts a signer who has signed as outstanding while others remain', () => {
    // The rule plan §4.7 names: one recipient completing does not complete the envelope. A signer who
    // has `signed` but is followed in the routing order still holds the envelope open.
    expect(canRecipientMove('signed', 'completed')).toBe(true);
    expect(REQUEST_TRANSITIONS.sent).toContain('partially_signed');
    expect(REQUEST_TRANSITIONS.partially_signed).not.toContain('sent');
  });
});

describe('connection lifecycle', () => {
  it('declares a row for every connection status and refuses a revoked grant being reused', () => {
    expect(Object.keys(CONNECTION_TRANSITIONS).sort()).toEqual([...CONNECTION_STATUSES].sort());
    expect(canConnectionTransition('reauthorization_required', 'connected')).toBe(true);
    expect(canConnectionTransition('not_connected', 'connected')).toBe(true);
    // An unauthorized row cannot be flipped to connected by the operator's switch alone, so the only
    // path is the authorization flow.
    expect(() => assertConnectionTransition('not_connected', 'disabled')).not.toThrow();
    expect(canConnectionTransition('disabled', 'not_connected')).toBe(true);
  });
});

describe('immutable snapshot', () => {
  const data: OutgoingSnapshotData = {
    providerKey: 'docusign',
    connectionId: 'conn-1',
    environment: 'demo',
    accountId: 'acct-1',
    templateId: null,
    subject: 'Please sign',
    message: null,
    emailBlurb: 'Hello',
    expiresAt: null,
    documents: [
      {
        documentSnapshotId: 'doc-1',
        displayName: 'agreement.pdf',
        mimeType: 'application/pdf',
        byteSize: 1234,
        contentHashSha256: 'a'.repeat(64),
        documentOrder: 1,
        sourceAttachmentId: 'att-1',
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
    policy: { maxDocumentsPerRequest: 5 },
  };

  it('produces the same digest for equal content, in any key order', () => {
    const first = buildSnapshot('SignatureRequest:r1', data);
    const reordered = JSON.parse(JSON.stringify({ ...data, subject: 'Please sign' })) as OutgoingSnapshotData;
    const second = buildSnapshot('SignatureRequest:r1', reordered, first.capturedAt);
    expect(second.digest).toBe(first.digest);
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('changes the digest when a document, a recipient or the policy changes', () => {
    const base = outgoingSnapshotDigest(data);
    const [document] = data.documents;
    const [recipient] = data.recipients;
    if (document === undefined || recipient === undefined) throw new Error('The fixture must carry one document and one recipient.');
    expect(outgoingSnapshotDigest({ ...data, documents: [{ ...document, contentHashSha256: 'b'.repeat(64) }] })).not.toBe(base);
    expect(outgoingSnapshotDigest({ ...data, recipients: [{ ...recipient, email: 'other@example.invalid' }] })).not.toBe(base);
    expect(outgoingSnapshotDigest({ ...data, policy: { maxDocumentsPerRequest: 9 } })).not.toBe(base);
  });

  it('freezes the captured payload so a later mutation of the source cannot rewrite the evidence', () => {
    const mutable = JSON.parse(JSON.stringify(data)) as OutgoingSnapshotData;
    const envelope = buildSnapshot('SignatureRequest:r1', mutable);
    mutable.recipients = [];
    const source = mutable.documents[0];
    if (source === undefined) throw new Error('The fixture must carry a document.');
    source.displayName = 'replaced.pdf';
    expect(envelope.data.recipients).toHaveLength(1);
    expect(envelope.data.documents[0]?.displayName).toBe('agreement.pdf');
    expect(Object.isFrozen(envelope.data)).toBe(true);
  });

  it('refuses to read an envelope whose payload no longer matches its digest', () => {
    const envelope = buildSnapshot('SignatureRequest:r1', data);
    const tampered = JSON.parse(JSON.stringify(envelope)) as { data: OutgoingSnapshotData };
    tampered.data.subject = 'silently changed';
    expect(() => readSnapshot(tampered)).toThrow(/does not match its digest/);
    expect(() => readSnapshot({ ...envelope, version: 2 })).toThrow(/Unsupported signature snapshot version/);
    expect(readSnapshot(envelope).digest).toBe(envelope.digest);
  });

  it('binds an approval to the exact reviewed snapshot', () => {
    const reviewed = outgoingSnapshotDigest(data);
    expect(approvalStillApplies(reviewed, reviewed)).toBe(true);
    expect(approvalStillApplies(reviewed, outgoingSnapshotDigest({ ...data, subject: 'different' }))).toBe(false);
    expect(approvalStillApplies(null, reviewed)).toBe(false);
    expect(approvalStillApplies(reviewed, null)).toBe(false);
  });

  it('refuses content a JSON document cannot hold', () => {
    expect(() => canonicalJson(() => 1)).toThrow(/cannot contain a function/);
    expect(() => canonicalJson(Number.NaN)).toThrow(/non-finite/);
  });
});

describe('retention and data minimization', () => {
  it('never puts the evidence trail on a timer', () => {
    const decisions = retentionPolicy({ ...DEFAULT_ESIGNATURE_SETTINGS, retention: { webhookPayloadDays: 1, completedArtifactDays: 1 } });
    const bySubject = new Map(decisions.map((entry) => [entry.subject, entry]));
    expect(bySubject.get('eventHistory')?.purgeAfter).toBeNull();
    expect(bySubject.get('auditTrail')?.purgeAfter).toBeNull();
    expect(bySubject.get('completionEvidence')?.purgeAfter).toBeNull();
    expect(bySubject.get('webhookInboxPayload')?.purgeAfter).not.toBeNull();
  });

  it('treats a zero day setting as no automatic deletion, not as delete now', () => {
    const decisions = retentionPolicy(DEFAULT_ESIGNATURE_SETTINGS);
    expect(decisions.find((entry) => entry.subject === 'signedDocument')?.purgeAfter).toBeNull();
    expect(DEFAULT_ESIGNATURE_SETTINGS.retention.completedArtifactDays).toBe(0);
  });

  it('classifies a signed document and a certificate as evidence, and a source snapshot as business data', () => {
    const signed = artifactRetentionFor('provider_signed_document', DEFAULT_ESIGNATURE_SETTINGS);
    expect(signed.retentionClass).toBe('evidence');
    expect(signed.purgeAfter).toBeNull();
    expect(artifactRetentionFor('completion_evidence', { ...DEFAULT_ESIGNATURE_SETTINGS, retention: { ...DEFAULT_ESIGNATURE_SETTINGS.retention, completedArtifactDays: 30 } }).purgeAfter).toBeNull();
    expect(artifactRetentionFor('source_snapshot', DEFAULT_ESIGNATURE_SETTINGS).retentionClass).toBe('business');
  });

  it('names which tables application code may never delete from', () => {
    expect(isAppendOnly('signature_audit_entries')).toBe(true);
    expect(isAppendOnly('signature_provider_events')).toBe(true);
    expect(isAppendOnly('signature_webhook_inbox')).toBe(true);
    expect(isAppendOnly('signature_requests')).toBe(false);
    expect(Object.values(SOFT_DELETE_RULES)).toContain('append_only');
  });
});

describe('audit redaction', () => {
  it('drops credential-shaped, URL-shaped and body-shaped values whatever their size', () => {
    const detail = redactDetail({
      recipientEmail: 'signer@example.invalid',
      contentHashSha256: 'a'.repeat(64),
      clientSecret: 'super-secret',
      refreshToken: 'rt',
      signatureUrl: 'https://docusign.example/signed?a=b',
      documentContent: 'x'.repeat(10_000),
      rawPayload: { anything: 1 },
      'signing-uri': 'https://docusign.example/signed?a=b',
      documentOrder: 1,
      reason: 'reviewed',
    });
    expect(detail).toEqual({
      recipientEmail: 'signer@example.invalid',
      contentHashSha256: 'a'.repeat(64),
      documentOrder: 1,
      reason: 'reviewed',
    });
  });

  it('truncates a long legitimate value instead of storing a document', () => {
    const detail = redactDetail({ voidReason: 'x'.repeat(5_000) });
    expect(String(detail['voidReason'])).toHaveLength(500);
  });

  it('recurses into objects and arrays, and stops at a bounded depth', () => {
    const detail = redactDetail({ nested: { token: 't', keep: 1 }, list: [{ authorization: 'a', keep: 2 }] });
    expect(detail).toEqual({ nested: { keep: 1 }, list: [{ keep: 2 }] });
    let deep: Record<string, unknown> = { keep: 'leaf' };
    for (let index = 0; index < 8; index += 1) deep = { level: deep };
    expect(JSON.stringify(redactDetail(deep))).toContain('truncated');
  });
});

describe('template mapping validation', () => {
  it('accepts a plain role and field mapping', () => {
    const roles = normalizeRoleMappings([{ roleName: 'Signer', recipientType: 'signer', routingOrder: 1, source: 'crmField', crmField: 'primaryEmail' }]);
    expect(roles[0]).toMatchObject({ roleName: 'Signer', crmField: 'primaryEmail' });
    const fields = normalizeFieldMappings([{ tabName: 'name', crmField: 'firstName', required: true }]);
    expect(fields[0]).toMatchObject({ tabName: 'name', required: true });
  });

  it('refuses an expression in a mapping value', () => {
    expect(() => normalizeRoleMappings([{ roleName: '${account.name}', recipientType: 'signer', routingOrder: 1, source: 'crmField', crmField: 'x' }])).toThrow(/not an expression/);
    expect(() => normalizeFieldMappings([{ tabName: '{{formula}}', crmField: 'name', required: false }])).toThrow(/not an expression/);
  });

  it('refuses an unknown property rather than storing it for something else to interpret', () => {
    expect(() => normalizeRoleMappings([{ roleName: 'Signer', recipientType: 'signer', routingOrder: 1, source: 'manual', crmField: null, script: 'drop table' }])).toThrow(/unknown property/);
  });

  it('refuses a CRM-sourced role with no field, and an out-of-range routing order', () => {
    expect(() => normalizeRoleMappings([{ roleName: 'Signer', recipientType: 'signer', routingOrder: 1, source: 'crmField', crmField: null }])).toThrow(/must name a field/);
    expect(() => normalizeRoleMappings([{ roleName: 'Signer', recipientType: 'signer', routingOrder: 0, source: 'manual' }])).toThrow(/between 1 and 99/);
    expect(() => normalizeRoleMappings([{ roleName: 'Signer', recipientType: 'approver', routingOrder: 1, source: 'manual' }])).toThrow(/supported recipient type/);
  });
});

describe('event identity', () => {
  it('builds a stable dedup key from the provider event id when there is one', () => {
    expect(buildEventDedupKey('docusign', 'evt-1')).toBe('docusign:evt-1');
    expect(() => buildEventDedupKey('docusign', '   ')).toThrow(/deduplication key/);
  });

  it('digests the canonical form, so key order cannot create a second event', () => {
    expect(payloadDigest({ a: 1, b: 2 })).toBe(payloadDigest({ b: 2, a: 1 }));
    expect(payloadDigest({ a: 1 })).not.toBe(payloadDigest({ a: 2 }));
  });
});

describe('the gate stays closed without a connection', () => {
  it('keeps every provider-owned state unreachable from a local origin, whatever the starting state', () => {
    const origins: TransitionOrigin[] = ['local'];
    for (const origin of origins) {
      for (const from of REQUEST_STATUSES) {
        for (const to of allowedTargets(from, origin)) {
          expect(EVIDENCE_STATES).not.toContain(to);
        }
      }
    }
  });
});
