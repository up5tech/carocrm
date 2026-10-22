import { ValidationError } from '@carocrm/core/errors/index.js';

import {
  REQUEST_STATUSES,
  type SignatureRequestStatus,
  TERMINAL_REQUEST_STATUSES,
} from './esignature-domain.js';

/**
 * Phase 19-ES.2 — the signature request state machine
 * (`PLAN_Phase_19_ESignature.md` §4.7, §1.2, §4.3; `19-ES.2` acceptance
 * "request state transitions are unit-tested").
 *
 * The table is the whole product rule in one place, and it encodes the one thing this module may
 * never relax: **the provider is the signing authority**. A CRM user cannot mark a document signed
 * by editing a field, because a state that describes what happened at DocuSign can only be entered
 * with provider evidence. That is why `transition` takes an origin, and why the generic entity API
 * was refused for these records in `docs/implementation/esignature-audit.md` §6 — a
 * `PATCH /api/v1/SignatureRequest/:id` would be a way around this file.
 *
 * Three families of states, deliberately separate:
 *
 * - **local** — `draft`, `pending_approval`, `ready_to_send`: the CRM's own preparation work. No
 *   envelope exists yet (plan §4.3), and no provider has been contacted.
 * - **in flight** — `sending`, `send_unknown`, `provider_error`, `reconciliation_required`: the
 *   platform knows something happened and either lost the answer or disagrees with the provider.
 *   `send_unknown` is the state a lost response after submission enters, and it is never retried
 *   blindly — the correlation token already taken on that row is the proof (plan §16).
 * - **provider-owned** — `sent`, `delivered`, `partially_signed`, `completed`, `declined`, `voided`,
 *   `expired`: facts about the envelope. Every move into one of them requires an origin of
 *   `provider`.
 *
 * A terminal state (`completed`, `declined`, `voided`, `expired`) has exactly one way out: into
 * `reconciliation_required`, and only by the reconciliation path. Then the provider's answer decides
 * where it lands. An out-of-order or duplicate event therefore cannot drag a signed contract back
 * to `sent` (plan §4.7).
 */

/** Who caused the move, which is what decides whether a provider-owned state is reachable. */
export const TRANSITION_ORIGINS = ['local', 'provider', 'reconciliation'] as const;
export type TransitionOrigin = (typeof TRANSITION_ORIGINS)[number];

/**
 * The legal moves.
 *
 * Read `from: [possible targets]`. A state with no targets is a dead end by construction, not by
 * omission: `completed`, `declined`, `voided` and `expired` can only be re-opened through
 * reconciliation.
 */
export const REQUEST_TRANSITIONS: Readonly<Record<SignatureRequestStatus, readonly SignatureRequestStatus[]>> = {
  draft: ['ready_to_send', 'pending_approval', 'sending'],
  pending_approval: ['ready_to_send', 'draft'],
  ready_to_send: ['sending', 'draft', 'pending_approval'],
  // The send is in flight: either the provider answers, the answer is lost, or it refuses.
  sending: ['sent', 'send_unknown', 'provider_error', 'reconciliation_required'],
  // A lost response is resolved by evidence, never by assuming.
  send_unknown: ['sent', 'provider_error', 'reconciliation_required'],
  provider_error: ['draft', 'ready_to_send', 'sending', 'reconciliation_required'],
  // What the provider reports about a live envelope. `delivered` and `partially_signed` are
  // aggregates and the mapper (ES.12) is what decides whether one is unambiguous enough to store.
  sent: ['delivered', 'partially_signed', 'completed', 'declined', 'voided', 'expired', 'reconciliation_required'],
  delivered: ['partially_signed', 'completed', 'declined', 'voided', 'expired', 'reconciliation_required'],
  partially_signed: ['completed', 'declined', 'voided', 'expired', 'reconciliation_required'],
  // Terminal, with one guarded way back: reconciliation.
  completed: ['reconciliation_required'],
  declined: ['reconciliation_required'],
  voided: ['reconciliation_required'],
  expired: ['reconciliation_required'],
  reconciliation_required: [
    'draft',
    'ready_to_send',
    'sending',
    'send_unknown',
    'sent',
    'delivered',
    'partially_signed',
    'completed',
    'declined',
    'voided',
    'expired',
    'provider_error',
  ],
};

/**
 * States that describe the provider's world rather than the CRM's.
 *
 * Entering any of them with `origin: 'local'` is the exact bug plan §1.2 forbids: it would let a
 * status edit forge a signature. `send_unknown` and `provider_error` are deliberately *not* here —
 * they describe what this platform observed about its own call, and the operator who marks a stuck
 * send as reconciled is telling the truth about having tried.
 */
export const PROVIDER_OWNED_STATUSES: ReadonlySet<SignatureRequestStatus> = new Set([
  'sent',
  'delivered',
  'partially_signed',
  'completed',
  'declined',
  'voided',
  'expired',
]);

/** States a request may not leave except through reconciliation. */
export const TERMINAL_STATUSES: ReadonlySet<SignatureRequestStatus> = TERMINAL_REQUEST_STATUSES;

/** True for a state that has no ordinary successor. */
export function isTerminalStatus(status: SignatureRequestStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** True for a state whose meaning is decided by DocuSign rather than by this CRM. */
export function isProviderOwnedStatus(status: SignatureRequestStatus): boolean {
  return PROVIDER_OWNED_STATUSES.has(status);
}

/** Whether the move is in the table at all, ignoring who caused it. */
export function canTransition(from: SignatureRequestStatus, to: SignatureRequestStatus): boolean {
  return (REQUEST_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * The states an origin may move a request into.
 *
 * A CRM user gets the local and in-flight moves; a verified provider event gets the provider-owned
 * ones; the reconciliation path gets the guarded exit from a terminal state. Anything else is
 * refused — including the tempting shortcut of letting a local actor "just fix" a stuck status.
 */
export function allowedTargets(from: SignatureRequestStatus, origin: TransitionOrigin): readonly SignatureRequestStatus[] {
  const declared = REQUEST_TRANSITIONS[from] ?? [];
  if (origin === 'local') return declared.filter((target) => !PROVIDER_OWNED_STATUSES.has(target));
  // A terminal state only opens through reconciliation: a fresh provider event for an envelope the
  // CRM already finished is a *drift signal*, and the reconciliation path is what resolves it.
  if (origin === 'provider' && TERMINAL_STATUSES.has(from)) return [];
  return declared;
}

/**
 * Whether `origin` may move a request from `from` to `to`.
 *
 * `reconciliation` is the one origin allowed to leave a terminal state, and it lands on the provider's
 * answer rather than inventing one.
 */
export function canTransitionFrom(
  from: SignatureRequestStatus,
  to: SignatureRequestStatus,
  origin: TransitionOrigin,
): boolean {
  if (origin === 'reconciliation') {
    // Reconciliation is only a route out of a terminal or stuck state, and it never re-enters the
    // preparation states: the envelope is already at the provider.
    if (!TERMINAL_STATUSES.has(from) && from !== 'reconciliation_required' && from !== 'sending' && from !== 'send_unknown') {
      return false;
    }
    return (REQUEST_TRANSITIONS[from] ?? []).includes(to) || PROVIDER_OWNED_STATUSES.has(to);
  }
  return allowedTargets(from, origin).includes(to);
}

/**
 * Validate a move, refusing it with the states that *would* have been legal.
 *
 * The refusal is a `ValidationError` with the stable module code in `details.code`, so the API
 * envelope carries `SIGNATURE_REQUEST_INVALID_STATE` and the SPA can explain the state without
 * parsing a message.
 */
export function assertTransition(
  from: SignatureRequestStatus,
  to: SignatureRequestStatus,
  origin: TransitionOrigin,
): void {
  if (!isRequestStatus(from) || !isRequestStatus(to)) {
    throw new ValidationError('Unknown signature request state.', {
      code: 'SIGNATURE_REQUEST_INVALID_STATE',
      from,
      to,
    });
  }
  if (canTransitionFrom(from, to, origin)) return;
  const legal = allowedTargets(from, origin);
  const reason =
    origin === 'local' && PROVIDER_OWNED_STATUSES.has(to) && canTransition(from, to)
      ? 'provider_evidence_required'
      : origin === 'provider' && TERMINAL_STATUSES.has(from)
        ? 'terminal_state_needs_reconciliation'
        : 'transition_not_allowed';
  throw new ValidationError(
    reason === 'provider_evidence_required'
      ? `A signature request in "${from}" cannot move to "${to}": only a verified provider event or a reconciliation result can show that the envelope is there.`
      : reason === 'terminal_state_needs_reconciliation'
        ? `A signature request in "${from}" is finished. Reconcile it against the provider before its state changes again.`
        : `A signature request in "${from}" cannot move to "${to}".`,
    {
      code: 'SIGNATURE_REQUEST_INVALID_STATE',
      reason,
      from,
      to,
      origin,
      allowed: [...legal],
    },
  );
}

export function isRequestStatus(value: unknown): value is SignatureRequestStatus {
  return typeof value === 'string' && (REQUEST_STATUSES as readonly string[]).includes(value);
}

/**
 * A stable rank for ordering and drift detection: how far a projection has advanced.
 *
 * `reconciliation_required`, `provider_error` and `send_unknown` deliberately sit *outside* the
 * progression (rank of the state they describe is unknown), so an out-of-order event cannot use a
 * rank comparison to argue that a completed contract is really still `sent`.
 */
const STATUS_RANK: Readonly<Partial<Record<SignatureRequestStatus, number>>> = {
  draft: 0,
  pending_approval: 1,
  ready_to_send: 2,
  sending: 3,
  sent: 4,
  delivered: 5,
  partially_signed: 6,
  completed: 7,
};

const STATUS_STUCK: readonly SignatureRequestStatus[] = [
  'send_unknown',
  'provider_error',
  'reconciliation_required',
];

/**
 * The progression rank, or `null` for a state that does not describe progress
 * (`declined`, `voided`, `expired` and the stuck states).
 *
 * ES.12 uses `null` as "do not compare, do not assume": a rank is a projection aid, never the
 * authority for whether a projection may move.
 */
export function statusRank(status: SignatureRequestStatus): number | null {
  if (status in STATUS_RANK) return STATUS_RANK[status] ?? null;
  if (STATUS_STUCK.includes(status)) return null;
  return null;
}

/** Whether a status means the request needs an operator to look at it (plan §13.2, §14). */
export function needsAttention(status: SignatureRequestStatus): boolean {
  return STATUS_STUCK.includes(status);
}

/** The stuck states, exported so the operator view names them rather than restating them. */
export const ATTENTION_STATUSES: readonly SignatureRequestStatus[] = STATUS_STUCK;

/**
 * Whether a request is finished business-wise.
 *
 * Used by the guard that refuses reminder, resend and correction calls on a closed envelope, so the
 * refusal happens before anyone contacts the provider (plan §16 acceptance).
 */
export function isFinished(status: SignatureRequestStatus): boolean {
  return TERMINAL_STATUSES.has(status) || needsAttention(status);
}

/** Whether the request may still be edited as a draft (plan §8.2 "Draft state only"). */
export function isEditable(status: SignatureRequestStatus): boolean {
  return status === 'draft' || status === 'pending_approval' || status === 'ready_to_send';
}

/** Refuses an edit that would change what has already been sent. */
export function assertEditable(status: SignatureRequestStatus, action: string): void {
  if (isEditable(status)) return;
  throw new ValidationError(`"${action}" is only allowed while the request is a draft.`, {
    code: 'SIGNATURE_REQUEST_INVALID_STATE',
    status,
    action,
  });
}

// ---------------------------------------------------------------------------
// Recipient projection
// ---------------------------------------------------------------------------

/**
 * The recipient lifecycle, kept separate from the envelope's on purpose (plan §4.7, §6.4).
 *
 * A recipient's `completed` never means the envelope is complete: that inference is the exact bug
 * plan §4.7 names. So recipient status is a projection of one person's part, ordered for the
 * monotonicity rule below, and the envelope's aggregate is decided by the mapper in ES.12.
 */
export const RECIPIENT_STATUSES = [
  'pending',
  'sent',
  'delivered',
  'viewed',
  'signed',
  'completed',
  'declined',
  'canceled',
  'expired',
] as const;
export type SignatureRecipientStatus = (typeof RECIPIENT_STATUSES)[number];

/** The progression of one signer. A lower rank is always older information, never newer. */
const RECIPIENT_RANK: Readonly<Record<SignatureRecipientStatus, number>> = {
  pending: 0,
  sent: 1,
  delivered: 2,
  viewed: 3,
  signed: 4,
  completed: 5,
  // The three endings are not on the progression: they replace it, and nothing after them applies.
  declined: -1,
  canceled: -1,
  expired: -1,
};

export const RECIPIENT_TERMINAL_STATUSES: ReadonlySet<SignatureRecipientStatus> = new Set([
  'declined',
  'canceled',
  'expired',
]);

/**
 * Statuses that end a signer's own story: the three provider outcomes, plus `completed`, which is the
 * signer having done their part.
 *
 * `completed` belongs here and not with the progression: a signer who has signed is not going to
 * decline next week, and letting a late or forged event move them to `declined` would rewrite who
 * signed what. The envelope's aggregate is a separate question (plan §4.7).
 */
const RECIPIENT_SETTLED_STATUSES: ReadonlySet<SignatureRecipientStatus> = new Set([
  'completed',
  ...RECIPIENT_TERMINAL_STATUSES,
]);

export function isRecipientStatus(value: unknown): value is SignatureRecipientStatus {
  return typeof value === 'string' && (RECIPIENT_STATUSES as readonly string[]).includes(value);
}

/** Whether the signer's own outcome is a provider ending. */
export function isRecipientTerminal(status: SignatureRecipientStatus): boolean {
  return RECIPIENT_TERMINAL_STATUSES.has(status);
}

/** Whether the signer's part is over, either by signing or by an ending. */
export function isRecipientSettled(status: SignatureRecipientStatus): boolean {
  return RECIPIENT_SETTLED_STATUSES.has(status);
}

/**
 * Whether a recipient may move from `from` to `to`.
 *
 * The rule is monotonic and it is here for one reason: a replayed or out-of-order delivery must not
 * make a signer who has already completed look un-signalled (plan §4.7, §10.3). A terminal outcome
 * may be replaced by another terminal outcome only through reconciliation, which is what the
 * `false` for "already terminal" gives ES.12 — it records the event as history and leaves the
 * projection alone.
 */
export function canRecipientMove(
  from: SignatureRecipientStatus,
  to: SignatureRecipientStatus,
): boolean {
  if (from === to) return false;
  // A settled signer never moves again, in either direction.
  if (isRecipientSettled(from)) return false;
  if (isRecipientSettled(to)) return true;
  return RECIPIENT_RANK[to] > RECIPIENT_RANK[from];
}

/** How far along this signer is; `null` for a settled outcome, which is not a stage. */
export function recipientRank(status: SignatureRecipientStatus): number | null {
  return isRecipientSettled(status) ? null : RECIPIENT_RANK[status];
}

/**
 * The recipients still holding the envelope open.
 *
 * `signed` counts as outstanding: a signer who has signed may still be followed by others in the
 * routing order, and what the envelope waits for is the recipients ahead of and including the last
 * routing order (plan §4.7 — a single recipient completing does not complete the envelope).
 */
export function isRecipientOutstanding(status: SignatureRecipientStatus): boolean {
  return status === 'pending' || status === 'sent' || status === 'delivered' || status === 'viewed' || status === 'signed';
}
