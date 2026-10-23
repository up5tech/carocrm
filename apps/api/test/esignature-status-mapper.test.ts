import { describe, expect, it } from 'vitest';

import {
  mapProviderEvent,
  normalizeEnvelopeStatus,
  normalizeProviderEventType,
  normalizeRecipientStatus,
} from '../src/esignature/esignature-status-mapper.js';

/**
 * Phase 19-ES.12 — the pure status mapper
 * (`PLAN_Phase_19_ESignature.md` §4.7, §10.3, §10.4).
 *
 * The acceptance criteria this file holds directly: a recipient completing never completes a
 * multi-recipient envelope, and an older/duplicate event cannot move the projection backwards.
 */

const SIGNER = { id: 'r1', providerRecipientId: 'prov-1', recipientType: 'signer' as const, status: 'sent' as const };
const OTHER = { id: 'r2', providerRecipientId: 'prov-2', recipientType: 'signer' as const, status: 'sent' as const };

describe('provider vocabulary normalization', () => {
  it('maps the documented Connect words and leaves the rest unknown', () => {
    expect(normalizeProviderEventType('envelope-completed')).toBe('completed');
    expect(normalizeProviderEventType('recipient-delivered')).toBe('delivered');
    expect(normalizeProviderEventType('envelope-timedout')).toBe('expired');
    expect(normalizeProviderEventType('recipient-auto-responded')).toBe('signed');
    expect(normalizeProviderEventType('something-new')).toBe('unmapped');
    expect(normalizeRecipientStatus('auto_responded')).toBe('completed');
    expect(normalizeRecipientStatus('timedout')).toBe('expired');
    expect(normalizeRecipientStatus('surprise')).toBeNull();
    expect(normalizeEnvelopeStatus('correct')).toBe('sent');
    expect(normalizeEnvelopeStatus('surprise')).toBeNull();
  });
});

describe('recipient events', () => {
  it('moves the signer and only partially completes the envelope', () => {
    const mapping = mapProviderEvent({
      current: 'sent',
      eventTypeNormalized: 'completed',
      recipientStatusRaw: 'completed',
      recipientProviderId: 'prov-1',
      recipients: [SIGNER, OTHER],
    });
    expect(mapping.recipient).toEqual({ recipientId: 'r1', status: 'completed' });
    expect(mapping.envelopeChain).toEqual(['partially_signed']);
  });

  it('still does not complete the envelope when the last signer finishes — the provider must say so', () => {
    const mapping = mapProviderEvent({
      current: 'partially_signed',
      eventTypeNormalized: 'completed',
      recipientStatusRaw: 'completed',
      recipientProviderId: 'prov-2',
      recipients: [{ ...OTHER, status: 'completed' }, { ...SIGNER, status: 'completed' }],
    });
    // The signer move is offered (the repository's monotonic rule will refuse it), no envelope move.
    expect(mapping.envelopeChain).toEqual([]);
    expect(mapping.outcome).not.toBe('applied');
  });

  it('proves the envelope was sent when a delivered event arrives after a lost send answer', () => {
    const mapping = mapProviderEvent({
      current: 'send_unknown',
      eventTypeNormalized: 'delivered',
      recipientStatusRaw: 'delivered',
      recipientProviderId: 'prov-1',
      recipients: [SIGNER, OTHER],
    });
    expect(mapping.envelopeChain).toEqual(['sent', 'delivered']);
  });

  it('refuses to move a completed envelope backwards from an older event', () => {
    const mapping = mapProviderEvent({
      current: 'completed',
      eventTypeNormalized: 'sent',
      recipientStatusRaw: 'sent',
      recipientProviderId: 'prov-1',
      recipients: [SIGNER, OTHER],
    });
    expect(mapping.envelopeChain).toEqual([]);
    expect(mapping.outcome).toBe('out_of_order');
  });
});

describe('envelope events', () => {
  it('completes only from an envelope-level completion event', () => {
    const mapping = mapProviderEvent({
      current: 'delivered',
      eventTypeNormalized: 'completed',
      recipientStatusRaw: null,
      recipientProviderId: null,
      recipients: [SIGNER, OTHER],
    });
    expect(mapping.envelopeChain).toEqual(['completed']);
    expect(mapping.outcome).toBe('applied');
  });

  it('treats an unknown event as unmapped, never as success', () => {
    const mapping = mapProviderEvent({
      current: 'sent',
      eventTypeNormalized: 'something_new_in_2027',
      recipientStatusRaw: null,
      recipientProviderId: null,
      recipients: [SIGNER],
    });
    expect(mapping).toMatchObject({ envelopeChain: [], outcome: 'unmapped' });
  });

  it('records a recipient event it cannot match without guessing a person', () => {
    const mapping = mapProviderEvent({
      current: 'sent',
      eventTypeNormalized: 'delivered',
      recipientStatusRaw: 'delivered',
      recipientProviderId: 'provider-only',
      recipients: [SIGNER],
    });
    expect(mapping.recipient).toBeNull();
    expect(mapping.envelopeChain).toEqual(['delivered']);
  });
});
