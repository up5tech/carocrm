import type { SignatureRequestStatus } from './esignature-domain.js';
import {
  canRecipientMove,
  canTransitionFrom,
  type SignatureRecipientStatus,
} from './esignature-state-machine.js';

/**
 * Phase 19-ES.12 — the provider-event to projection mapper
 * (`PLAN_Phase_19_ESignature.md` §4.7, §10.3, §10.4, §18 `19-ES.12`).
 *
 * A Connect delivery is evidence, not a command. This file turns one verified event into the two
 * things the application may do with it — an optional recipient move and an optional envelope move —
 * and it does so without touching a database, a provider or a clock. Three rules are the whole
 * design:
 *
 * 1. **Recipient completion is not envelope completion.** A signer finishing moves that signer and
 *    at most the envelope to `partially_signed`. Only an envelope-level completion event (or a
 *    reconciliation answer) can write `completed`. That is the acceptance criterion, encoded.
 * 2. **The projection is monotonic.** A recipient move is filtered by the existing recipient table;
 *    an envelope target is filtered by the existing state machine with origin `provider`. A replay
 *    or an older event produces no move, and the event is kept as history (`out_of_order`).
 * 3. **An ambiguous status is not guessed.** An unknown provider word is `unmapped`; it is preserved
 *    and marked, never treated as success (plan §10.4).
 */

export const PROVIDER_EVENT_TYPES = [
  'sent',
  'delivered',
  'viewed',
  'signed',
  'completed',
  'declined',
  'voided',
  'expired',
  'partially_signed',
  'failed',
  'unmapped',
] as const;
export type ProviderEventType = (typeof PROVIDER_EVENT_TYPES)[number];

/** The recipient names a DocuSign payload may use, mapped to this module's vocabulary. */
const RECIPIENT_STATUS_WORDS: Readonly<Record<string, SignatureRecipientStatus>> = {
  created: 'pending',
  waiting: 'pending',
  sent: 'sent',
  delivered: 'delivered',
  viewed: 'viewed',
  signed: 'signed',
  completed: 'completed',
  completed_by_agent: 'completed',
  auto_responded: 'completed',
  autoresponded: 'completed',
  declined: 'declined',
  canceled: 'canceled',
  cancelled: 'canceled',
  expired: 'expired',
  timedout: 'expired',
};

/** The envelope states a provider may report, in this module's vocabulary. */
export type ProviderEnvelopeStatusName =
  | 'draft'
  | 'sent'
  | 'delivered'
  | 'partially_signed'
  | 'completed'
  | 'declined'
  | 'voided'
  | 'expired';

/** The envelope words a DocuSign payload may use, mapped to the request projection. */
const ENVELOPE_STATUS_WORDS: Readonly<Record<string, ProviderEnvelopeStatusName>> = {
  created: 'draft',
  sent: 'sent',
  delivered: 'delivered',
  completed: 'completed',
  declined: 'declined',
  voided: 'voided',
  expired: 'expired',
  timedout: 'expired',
  correct: 'sent',
  corrected: 'sent',
  partially_signed: 'partially_signed',
};

/** Whether a provider word names a recipient state this module understands. */
export function normalizeRecipientStatus(value: string | null): SignatureRecipientStatus | null {
  if (value === null) return null;
  return RECIPIENT_STATUS_WORDS[value.trim().toLowerCase()] ?? null;
}

/** Whether a provider word names an envelope state this module understands. */
export function normalizeEnvelopeStatus(value: string | null): ProviderEnvelopeStatusName | null {
  if (value === null) return null;
  return ENVELOPE_STATUS_WORDS[value.trim().toLowerCase()] ?? null;
}

/**
 * Normalize a Connect `event` value (`envelope-completed`, `recipient-delivered`, …) to the bare
 * status vocabulary above. The event *level* is carried separately by whether the payload names a
 * recipient — a prefix is not trusted to decide it on its own.
 */
export function normalizeProviderEventType(raw: string | null): ProviderEventType {
  if (raw === null) return 'unmapped';
  let value = raw.trim().toLowerCase();
  value = value.replace(/[\s_]+/g, '-');
  if (value.startsWith('envelope-')) value = value.slice('envelope-'.length);
  if (value.startsWith('recipient-')) value = value.slice('recipient-'.length);
  if (value === 'auto-responded' || value === 'autoresponded') return 'signed';
  if (value === 'timedout' || value === 'timed-out') return 'expired';
  if (value === 'partially-signed') return 'partially_signed';
  if (value === 'failed' || value === 'error' || value === 'delivery-failed') return 'failed';
  if ((PROVIDER_EVENT_TYPES as readonly string[]).includes(value)) return value as ProviderEventType;
  return 'unmapped';
}

export interface MapperRecipient {
  readonly id: string;
  readonly providerRecipientId: string | null;
  readonly recipientType: 'signer' | 'carbon_copy';
  readonly status: SignatureRecipientStatus;
}

export interface StatusMappingInput {
  readonly current: SignatureRequestStatus;
  readonly eventTypeNormalized: string;
  readonly recipientStatusRaw: string | null;
  readonly recipientProviderId: string | null;
  readonly recipients: readonly MapperRecipient[];
}

export interface RecipientTarget {
  readonly recipientId: string;
  readonly status: SignatureRecipientStatus;
}

export interface StatusMapping {
  /** The one recipient row this event moves, when it names a recipient this request holds. */
  readonly recipient: RecipientTarget | null;
  /**
   * The envelope moves to apply, in order.
   *
   * A delivered/viewed/completed event that arrives while the send answer was lost is two facts:
   * the envelope was sent, and it is further along. The chain makes the first fact explicit instead
   * of asking the state machine to jump a gap it correctly refuses (plan §4.7).
   */
  readonly envelopeChain: readonly SignatureRequestStatus[];
  readonly outcome: 'applied' | 'recipient_only' | 'unmapped' | 'out_of_order' | 'no_recipient' | 'no_change';
}

export function mapProviderEvent(input: StatusMappingInput): StatusMapping {
  const event = normalizeProviderEventType(input.eventTypeNormalized);
  if (event === 'unmapped') {
    return { recipient: null, envelopeChain: [], outcome: 'unmapped' };
  }

  const recipientLevel = input.recipientProviderId !== null && input.recipientProviderId.trim() !== '';
  const localRecipient = recipientLevel
    ? input.recipients.find((entry) => entry.providerRecipientId === input.recipientProviderId) ?? null
    : null;

  const recipientStatus = recipientLevel
    ? normalizeRecipientStatus(input.recipientStatusRaw) ?? recipientStatusFromEvent(event)
    : null;

  const envelopeTarget = recipientLevel ? envelopeTargetForRecipient(recipientStatus) : envelopeTargetForEvent(event);
  const envelopeChain = envelopeTarget === null ? [] : transitionChain(input.current, envelopeTarget);
  // A target equal to the current state is not "out of order": it is the provider agreeing with the
  // projection, which is a no-op, not drift.
  const outOfOrder = envelopeTarget !== null && envelopeTarget !== input.current && envelopeChain.length === 0;

  if (recipientLevel && recipientStatus !== null) {
    if (localRecipient !== null) {
      const recipient: RecipientTarget = { recipientId: localRecipient.id, status: recipientStatus };
      if (envelopeChain.length > 0) return { recipient, envelopeChain, outcome: 'applied' };
      if (recipientMoves(localRecipient.status, recipientStatus)) return { recipient, envelopeChain, outcome: 'recipient_only' };      return { recipient: null, envelopeChain: [], outcome: outOfOrder ? 'out_of_order' : 'no_change' };
    }
    // The event names a recipient this request does not hold (a provider-side recipient, or one
    // whose id was never attached). The envelope fact is still usable; the person-level move is not.
    if (envelopeChain.length > 0) return { recipient: null, envelopeChain, outcome: 'applied' };
    return { recipient: null, envelopeChain: [], outcome: outOfOrder ? 'out_of_order' : 'no_recipient' };
  }

  if (envelopeChain.length > 0) return { recipient: null, envelopeChain, outcome: 'applied' };
  return { recipient: null, envelopeChain: [], outcome: outOfOrder ? 'out_of_order' : 'no_change' };
}

function recipientStatusFromEvent(event: ProviderEventType): SignatureRecipientStatus | null {
  switch (event) {
    case 'sent':
      return 'sent';
    case 'delivered':
    case 'viewed':
      return event;
    case 'signed':
      return 'signed';
    case 'completed':
      return 'completed';
    case 'declined':
      return 'declined';
    case 'expired':
      return 'expired';
    case 'voided':
      return 'canceled';
    default:
      return null;
  }
}

/**
 * The envelope consequence of one person's move.
 *
 * `completed`/`signed` deliberately produce no envelope target: even when every signer has finished,
 * the envelope is completed by the provider's envelope-level event, not by the CRM's arithmetic
 * (plan §4.7). `partially_signed` is the honest aggregate while at least one signer is outstanding.
 */
function envelopeTargetForRecipient(status: SignatureRecipientStatus | null): SignatureRequestStatus | null {
  switch (status) {
    case 'sent':
      return 'sent';
    case 'delivered':
    case 'viewed':
      return 'delivered';
    case 'signed':
    case 'completed':
      return 'partially_signed';
    case 'declined':
      return 'declined';
    default:
      return null;
  }
}

function envelopeTargetForEvent(event: ProviderEventType): SignatureRequestStatus | null {
  switch (event) {
    case 'sent':
      return 'sent';
    case 'delivered':
    case 'viewed':
      return 'delivered';
    case 'partially_signed':
      return 'partially_signed';
    case 'completed':
      return 'completed';
    case 'declined':
      return 'declined';
    case 'voided':
      return 'voided';
    case 'expired':
      return 'expired';
    case 'failed':
      // A failure is evidence that the projection needs a human and the provider; it is not a state
      // the CRM can resolve by guessing (plan §10.3).
      return 'reconciliation_required';
    default:
      return null;
  }
}

/** The ordered moves that reach `target`, or none when the state machine refuses the jump. */
function transitionChain(current: SignatureRequestStatus, target: SignatureRequestStatus): SignatureRequestStatus[] {
  if (current === target) return [];
  if (canTransitionFrom(current, target, 'provider')) return [target];
  if (
    (current === 'sending' || current === 'send_unknown') &&
    canTransitionFrom(current, 'sent', 'provider') &&
    canTransitionFrom('sent', target, 'provider')
  ) {
    return ['sent', target];
  }
  return [];
}

function recipientMoves(from: SignatureRecipientStatus, to: SignatureRecipientStatus): boolean {
  return canRecipientMove(from, to);
}
