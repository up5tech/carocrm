# Phase 19-ES.12 — Envelope and Recipient State Synchronization

> `PLAN_Phase_19_ESignature.md` §4.7, §10.3, §10.4, §18 `Phase 19-ES.12`.
> Acceptance: completed is shown only after a trusted event/reconciliation proves envelope completion;
> recipient completion does not incorrectly complete a multi-recipient envelope; state cannot move
> backwards because of a duplicate or older event.
>
> Prerequisites read: `esignature-es2-completion-report.md` (the recipient projection, the state
> machine and the event history), `esignature-es11-completion-report.md` (the verified delivery this
> phase consumes).

ES.12 is the translation layer between "what DocuSign said" and "what the CRM shows". It is a pure
mapper plus a transactional application, so every rule below is unit-testable without a provider.

---

## 1. Files

| File | What it owns |
| --- | --- |
| `esignature-status-mapper.ts` | Vocabulary normalization (`envelope-completed`, `recipient_completed`, `auto_responded`, `timedout`, `failed`, …), recipient moves, envelope target, and the ordered transition chain. No database, provider or clock. |
| `esignature-webhook.service.ts` | Applies the mapper in one transaction: recipient `applyStatus` (monotonic, event-id dedup), envelope `transition` (origin `provider`), event processing status, inbox state and audit. |
| `esignature-request.service.ts` — `reconcileSend` | The operator's read-only reconciliation for `sending`, `send_unknown`, `reconciliation_required`, provider-owned and terminal states; projects recipients and the envelope from `envelopeStatus` + `listRecipients`. |
| `signature-request.repository.ts` | `recordReconciliation` — dates an agreement without inventing a transition. |
| `esignature-request.controller.ts` | `GET /requests/:id/events` (timeline), the existing `POST …/reconcile`. |

**No migration.** The request, recipient and event columns were already present.

---

## 2. How each acceptance criterion is held

**Completed needs provider proof.** A recipient-level `completed` event moves that signer and, at most,
the envelope to `partially_signed`. Only an envelope-level completion event (`completed` without a
recipient id) or a reconciliation answer can write `completed`. The mapper has no arithmetic that turns
"all signers done" into envelope completion.

**A recipient cannot complete a multi-recipient envelope.** Each event names one provider recipient; the
mapper resolves that local row by recorded provider id, then client id, then email. The envelope target
is `partially_signed`, never `completed`.

**No backwards movement.** The recipient projection refuses a settled signer and a lower rank. The
envelope target goes through the ES.2 state machine with origin `provider`; a terminal request refuses a
provider event, and the service records the event as `ignored` (`out_of_order`) instead of moving. A
reconciliation is the only path that can leave a terminal state, and it lands on the provider's answer.

**Out-of-order delivery is recoverable.** A `delivered` event that arrives while the send answer was
lost produces the chain `sent → delivered`, so the state machine never has to jump a gap it refuses. An
unknown event word is `unmapped`: stored, marked, never treated as success.

**One reconciliation covers all states.** For `sending`/`send_unknown`, the first fact recorded is `sent`;
the provider's further state is applied through allowed transitions. For a terminal request the
`reconciliation` origin is used. When the provider agrees, `last_reconciled_at` is dated without a
version-inventing transition. A provider answer that is older than the projection leaves the projection
alone and records the drift in the audit trail.

---

## 3. Decisions taken here

- **Normalization is shared by the live adapter and the processor.** The adapter stores the raw event
  word; the inbox stores it; the processor normalizes through the same function. One vocabulary, one
  correction point.
- **A failure event means reconciliation, not a guessed state.** `failed`/`error` targets
  `reconciliation_required`, which is honest about the missing information.
- **Recipient ids are attached from the send answer.** The provider assigns its own ids; after a
  successful send the service records them by email/client id, so later events join on a fact rather
  than a guess. An event for a recipient the request does not hold still carries the envelope fact.
- **Raw provider words are diagnostics.** The request view and timeline expose `providerStatusRaw` /
  `providerEventTypeRaw` only to a caller with `auditRead`; the normalized status is the product answer
  for every reader (plan §13.4).

---

## 4. Verification

- `apps/api/test/esignature-status-mapper.test.ts` — envelope/recipient vocabulary, recipient completion
  not completing the envelope, the lost-send chain, out-of-order and unmapped cases.
- `apps/api/test/esignature-lifecycle.test.ts` — recipient-completed event → `partially_signed`;
  envelope-completed event → `completed`; an older `sent` event stays ignored; reconciliation to
  completed is idempotent; list progress and the timeline; reconciliation projects recipients.
- Combined run and checks: see ES.16 report §4.

## 5. Still open

- The live event names and payload shape are confirmed in ES.22 against a demo account; the mapper is
  the one place a correction lands.
- No scheduled `reconcileStuckRequests` sweep is registered yet (ES.20).
- Reconciliation is operator-invoked; a "stale projection" alert is reporting work (ES.19/ES.20).
