# Phase 19-ES.10 — Controlled Send and Ambiguous Outcome Recovery

> `PLAN_Phase_19_ESignature.md` §4.3, §11.1, §11.2, §16, §18 `Phase 19-ES.10`.
> Acceptance: one deliberate action results in at most one effective send in tested retry scenarios; an
> ambiguous outcome results in `send_unknown` or a reconciliation state, never an unsafe blind retry; all
> sends record sender, time, source, documents and recipients.
>
> Prerequisites read: `esignature-es2-completion-report.md` (the state machine, `claimSendAttempt`,
> `transition`), `esignature-es3-completion-report.md` (`sendIdentity`, `SendOutcomeUnknownError`),
> `esignature-es8-completion-report.md` (the prepared snapshot and its digest),
> `esignature-es9-completion-report.md` (the provider draft this phase sends).

ES.10 is the irreversible act: one deliberate click sends one prepared provider draft. Everything in the
phase exists to make that sentence true under retries, double clicks, lost answers and provider refusals —
and to record who sent what, when.

---

## 1. Files

| File | What it owns |
| --- | --- |
| `esignature-request.service.ts` | `send`, `recoverSend` and `reconcileSend`, and a `send`-scoped `loadScoped` mode (the sender need not hold the drafting right). |
| `signature-request.repository.ts` | `releaseSendAttempt` — clears the attempt token only for a definitely-refused request, so a retry is a new deliberate action. |
| `esignature-errors.ts` | `signatureApprovalRequiredError` (the ES.1 code `SIGNATURE_APPROVAL_REQUIRED`). |
| `providers/docusign/docusign-adapter.ts` | `sendEnvelope` — `PUT /envelopes/{id}` with `status: 'sent'`, with the asymmetric failure rule: 4xx is definite, transport/5xx is `SendOutcomeUnknownError`, 429 keeps the provider's guidance. `sendEnvelope` flips to `true`. |
| `providers/fake-signature-provider.adapter.ts` | An unknown envelope is a stable `ProviderError NOT_FOUND`, so a definite refusal is distinguishable from a lost answer. |
| `esignature-request.controller.ts` / DTOs | `POST /requests/:id/send` (`{version, confirm}`), `POST …/send/recover`, `POST …/reconcile`. |
| `pages/esignature/ESignatureRequestsPanel.tsx` (+ client, types, i18n) | The send confirmation, the `send_unknown` warning with *Reconcile*, and the `provider_error` card with *Return to ready to send*. |
| `esignature-module.ts` | `19-ES.10` joins `IMPLEMENTED_PHASES`. |

**No migration.** The row already carried `send_attempt_id` (with its unique index), `sent_by_id`,
`sent_at`, `provider_status_raw`, the `failure_*` fields and the outbound snapshot.

---

## 2. How each acceptance criterion is held

**One deliberate action, at most one effective send.**

- The command requires `confirm: true`, a current `version`, a stored preview whose digest still matches,
  an existing provider envelope, and — when the policy demands it — an approval for that digest.
- A fresh attempt token is generated per action and **claimed** into the row under the unique index
  before anything leaves the process; the request then moves to `sending`. A second click, a reload with
  the old version, or a retry after `sent` is refused by the state machine (409).
- The provider call is keyed by `sendIdentity(connection, request, attempt token, envelope)`.
- The suite counts the fake adapter's `sendEnvelope` calls in every scenario: a happy send makes one, a
  retry after `sent` makes none, a retry after a lost answer makes none, and the retry that follows a
  *proven-unsent* reconciliation makes exactly one new one.

**An ambiguous outcome is `send_unknown`, never a blind retry.** The adapter decides what "ambiguous"
means (a lost transport answer or a 5xx), raises `SendOutcomeUnknownError`, and the service moves the
request to `send_unknown` with a safe failure record and an audit row (`send.outcome_unknown`). From
there the **only** command that may move it is `reconcile`:

| Provider answer | Local outcome |
| --- | --- |
| sent / delivered / partially signed / completed / declined / voided / expired | `sent` first (the fact that was missing), then the state the provider reports, through the state machine's allowed transitions |
| still a draft | `provider_error` with `PROVIDER_NOT_SENT` — the send provably did not happen, so `recover` can make it retryable |
| unknown / unreachable | refuses with `PROVIDER_OUTCOME_UNKNOWN`; the request stays `send_unknown` |

A **definite** refusal (4xx, not found, authorization) is separated at the adapter boundary and leaves the
request in `provider_error`, with the attempt token kept as evidence until `recover` releases it.

**Every send records sender, time, source, documents and recipients.** `sent_by_id` and `sent_at` are
written by the state machine at `sending`/`sent`; the immutable outgoing snapshot holds the documents with
their SHA-256, the recipients with routing and roles, the source entity, the account and the policy. The
audit row carries the attempt id, the provider status word and the recipient count — never a body, a
token or a signing URL.

---

## 3. Decisions taken here

- **The sender is not the drafter.** Send is its own capability (`SignatureSend`), so the command loads the
  request with a `send` scope rather than the drafting one; a role may prepare and not send, which is the
  split plan §11.1 asks for.
- **Sending requires the prepared provider draft.** ES.9 created it; ES.10 sends it. Auto-preparing inside
  the send would make one click produce two provider calls, which is exactly the shape the "one
  deliberate action" rule forbids.
- **Reconciliation is ES.10's own command, not a webhook feature.** The gate's `reconcile`/`envelopeStatus`
  operations belong to the Connect feature (ES.11), so this command checks the `send` capability, the
  request's scope and the adapter's declared `envelopeStatus` capability directly. ES.12 will project the
  full state from events; this exists so a send has a safe way out today.
- **A 5xx is ambiguous, not a rejection.** DocuSign may have acted before failing to answer; the safe
  classification is "unknown" because the alternative is a resend. A 429 stays definite (the request was
  not accepted) and carries `Retry-After`.
- **Recovery is explicit.** A `provider_error` is not silently retryable: `recover` moves it to
  `ready_to_send` and releases the attempt, so the next send is a new deliberate action with a new key.
- **The approval gate compares digests, not flags.** `approvalStillApplies(approvedDigest, outgoingDigest)`
  — an approval for other bytes does not send this envelope. ES.17's approve/reject flow is what fills the
  approved digest.

---

## 4. Verification

| Suite | Covers |
| --- | --- |
| `apps/api/test/esignature-send.test.ts` (9) | confirmation, stale version and the missing-draft refusal with no provider call; the approval requirement for the exact digest; the send right separated from the drafting right and from another user's request; a happy send recording sender/time/status/snapshot and one adapter call; a second send refused with no second call; a lost response held as `send_unknown` with the resend refused and no second call; reconciliation of a lost answer into `sent`; reconciliation proving a send never happened (`draft` → `provider_error` → `recover` → a new, single send); a definite rejection (`NOT_FOUND`) marked `provider_error`, the attempt kept, then released by `recover`. |
| `apps/api/test/esignature-docusign.test.ts` (updated) | the live adapter now declares `sendEnvelope`; the fence moved to `envelopeStatus`. |

The module's own suites are now **247 green** (ES.1 20, ES.2 53, ES.3 31, ES.4 41, ES.5 25, ES.6 18,
ES.7 23, ES.8 14, ES.9 13, ES.10 9). The API typechecks and the module's files lint clean. The full
`pnpm test` run is **2 516 passed / 6 failed in 4 files**, all six in the pre-existing set named in §6.

**Live check** (scratch API `:3046` from the repo root, Vite on `:5146`, admin session): a prepared
request with a provider draft showed *Send now* disabled until the confirmation box was ticked; sending
answered "The envelope was sent." and the drawer showed **Sent** / *No longer a draft*. A second request
seeded into `send_unknown` showed the warning ("The provider may have accepted this envelope…") with a
*Reconcile with the provider* button; reconciling against a provider that still held a draft answered
"The reconciliation completed." and showed **Provider error** with *Return to ready to send*; that
returned the request to **Ready to send** with the send control back. Afterwards the shared dev database
holds zero ESignature rows.

---

## 5. What later phases take from here

- **ES.11/ES.12** project the envelope and recipient state from Connect events; a `send_unknown` will
  usually be resolved by an event rather than the reconcile command, and ES.12 must apply the same
  reconciliation rule (evidence first, state second).
- **ES.17** fills `approved_digest`; ES.10's gate then opens for requests the policy covers.
- **ES.19**'s stuck-request job will call `reconcileSend` on requests left in `sending`.

## 6. Known limits and the pre-existing baseline

- The provider's send answer is not projected onto the recipient rows here: the returned recipient statuses
  are recorded on the audit row, and ES.12 owns the projection (with its monotonic, deduplicated rules).
- A `provider_error` needs an explicit `recover`; nothing retries a failed send automatically, by design.
- The demo-account acceptance (a real envelope actually sent) needs credentials and is ES.22's; the fake
  proves the state machine and the guard, not DocuSign's behaviour.
- The SPA's whole-project typecheck/build may be red on the unrelated in-progress Email Template designer
  files in the working tree; only the module's files were checked, and none of those files are part of
  this commit.
- Pre-existing full-suite failures, unchanged: `docs-content` + `packages/docs/corpus`
  (`/EmailTemplate` `unknownAppRoute`, commit `5ce375e`) and the `service-desk*` suites (shared dev-DB
  state and a time-of-day-dependent SLA assertion).
