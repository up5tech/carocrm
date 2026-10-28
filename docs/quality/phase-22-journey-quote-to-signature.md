# Phase 22.9 — Journey: a quote becomes a signed document

> **Date:** 2026-10-28
> **Plan:** `PLAN_Phase_22_Integration_E2E_Hardening.md` §13.2 (steps 1–10) and its acceptance assertions
> **Test:** `apps/api/test/phase22-journey-quote-to-signature.test.ts` (12 ordered steps)
> **Depends on:** `docs/quality/phase-22-journey-lead-to-customer.md` (22.8), `docs/quality/phase-22-idempotency-retry.md` (22.7)
> **Status:** Implemented. The journey runs end to end against the configured primary database with the in-process fake provider; the three acceptance assertions hold.

---

## 1. The journey in one sentence

A Sales quote is the commercial record, a signature request is created **against that quote**, the
reviewed bytes become an immutable snapshot, a policy sends the request to a second person, the
provider is asked once, its events move the request, the evidence lands **beside** the source — never
on it — and the Sales records are exactly where they were: a signed document is not a payment.

## 2. Preconditions and required capabilities

| Precondition | How the journey gets it | Required? |
|---|---|---|
| The `ESignature` settings row | enabled, with `requests`, `connections`, `documents`, `templates`, `send`, `webhooks`, `artifacts` and `approvals` on | **Required** |
| An approval policy for quotes | `approval.requiredForSourceEntities: ['Quote']`, `preventSelfApproval: true` | **Required** for the approval branch |
| A connected provider account | a `SignatureConnectionRepository` connection, `recordAuthorized`, and the vault's `oauth_access_token` + `webhook_secret` | **Required** |
| A provider | the **fake** DocuSign adapter, bound automatically outside production (`esignature/index.ts:107`) | **Required** — no envelope leaves the machine |
| A template mapping | `fake-template-1`, `supportedSourceEntities: ['Quote']`, the role `Signer 1` and one tab (`Full Name`) filled from the quote's `name` | **Optional** — the journey proves both the template path and the document path |
| A Sales quote (and an invoice) | created through `POST /api/v1/Sales/document` | **Required** |
| The Sales module | installed | **Required** for the "not a payment" assertions |

## 3. The actors

| Actor | Rights | What the journey proves with it |
|---|---|---|
| The administrator | everything (the sender) | prepares the request, asks for the send, and **cannot approve their own request** |
| An approver | `SignatureRequest: read all`, `SignatureApprove: edit yes` | the only person who can release the request |
| The provider | the fake adapter | one envelope, one send, and the events the journey scripts |

## 4. The test-owned data

Every record carries the `AGENT_TEST_LS29_` marker: the quote, the invoice, the account, the
product, the signature requests, the attachments, the template mapping, the connection and its vault
secrets, the roles and the users. The cleanup removes **exactly those ids** — the requests, their
snapshots, their recipients, their events, their audit rows, their inbox rows, the stored bytes and
the files on disk — plus the Sales fixture's own records.

## 5. The steps, and what each one asserts

| Step | What happens | What the journey asserts |
|---|---|---|
| 1 | A Sales quote and an invoice are created | the quote is a `draft`; the invoice is `unpaid` |
| 2 | A signature request is created with `sourceEntityType: 'Quote'` and `sourceRecordId` | the request's source view names the quote and is `accessible`; the request starts as a `draft` |
| 3 | The recipients, the document and the preview | the recipients take the mapping's role (`Signer 1`); the preview has **no** problems and reports `approvalRequired: true` — the policy says so before anybody is asked |
| 4 | The request is prepared | the status becomes `pending_approval`; the source snapshot exists with a sha-256 hash, a `esignature/<requestId>/source/…` path and the attachment it was copied from |
| 5 | The send is attempted, then the approval | the send is refused (409) while the request waits; the **sender may not approve** (403 `SIGNATURE_APPROVAL_SEPARATION_REQUIRED`); the approver releases it and the audit trail records `approval.granted` |
| 6 | The envelope is created and the request is sent | the provider was asked **once** (`fake.calls` has one `sendEnvelope`), the envelope is `sent`, the request is `sent` |
| 7 | The provider's events arrive | `envelope-delivered` moves the request to `delivered`; the same event again is a safe `duplicate` with no second effect; a forged delivery is **401** and changes nothing |
| 8 | The signature completes and the evidence is retrieved | the request is `completed`; the derived artifact has a different hash and a `derived/` path; the **source snapshot is byte-for-byte what it was** |
| 8b | A second request takes the **document path** (no template) | the provider answers with a **signed copy**, stored under `derived/` with its own hash — and the source snapshot is untouched again |
| 9 | A declined request and a voided request | each is its own story (`declined`, `voided`); an **older** `sent` event cannot move a voided request back — it is ignored |
| 10 | The Sales records are inspected | the quote is still a `draft` and the invoice still `unpaid`; **no** `Payment` and **no** `PaymentAllocation` row was created |
| 11 | A send whose answer is lost | the send answers 409 `PROVIDER_OUTCOME_UNKNOWN`, the request is held as `send_unknown`, and reconciliation asks the provider — which says it is `sent` |

## 6. Expected persisted state and evidence

| What | Where | What the journey asserts |
|---|---|---|
| the request | `signature_requests` | status, the source pair, the approval fields, the outgoing digest |
| the recipients | `signature_recipients` | the role the mapping asked for |
| the source snapshot | `signature_document_snapshots` (`artifact_kind = 'source_snapshot'`) | the hash, the `source/` path, the attachment it came from |
| the derived artifacts | `signature_document_snapshots` (`provider_signed_document` / `completion_evidence`) | a different hash, a `derived/` path, the same `request_id` |
| the webhook receipts | `signature_webhook_inbox` | one row per delivery; a duplicate is one row |
| the provider events | `signature_provider_events` | one row per event; a replay adds none |
| the audit trail | `signature_audit_entries` | `approval.granted` among the request's actions |

## 7. Deduplication and provider interactions

One provider, one envelope, one send: the journey asserts the fake's call ledger directly. The
webhook path is deduplicated twice — by the inbox key (the provider's event id) and by the provider
event row — and the journey proves the outer one (a replay is a `duplicate` acknowledgement, not a
second effect). The ambiguous send is never retried blindly: the request is held as `send_unknown`
and reconciled by asking the provider.

## 8. Findings

| # | Finding | Severity | Disposition |
|---|---|---|---|
| F1 | **There is no Sales → ESignature contract.** The two modules do not import each other, no contract adapter exists for ESignature, and the only link is the generic pair `sourceEntityType` + `sourceRecordId` the signature request stores (`signature-record-entry.service.ts` lists `Quote` as an entry point). The events ESignature publishes (`esignature.requestCompleted`, `esignature.completedArtifactAvailable`) have **no consumer** — nothing in the platform reacts to a completed signature | Medium | Recorded as gap G26. The journey proves the negative the plan asks for (step 9): a signed document changes nothing in Sales |
| F2 | **A template envelope carries the provider's own files.** The reviewed local bytes are only handed to the provider when the request has no template (`envelopeInputFor`), so a *template* request returns the completion evidence while a *document* request returns the signed copy | Info | Not a defect — a documented decision. The journey proves both paths so nobody has to guess which artifact a request produces |
| F3 | The approval-specific code `SIGNATURE_APPROVAL_REQUIRED` is unreachable while a request waits: the state guard refuses first (`SIGNATURE_REQUEST_INVALID_STATE`, 409) | Info | Recorded, not changed — the refusal is correct and stable; the code names the situation for a client that looks for it |

## 9. Evidence

| Command | Result |
|---|---|
| `npx vitest run apps/api/test/phase22-journey-quote-to-signature.test.ts` | **12 passed** (the 12 ordered steps) |
| `pnpm verify` | **green** — `lint` exit 0, `typecheck` exit 0, `test` 239 files / 3218 tests passed, `test:web` 5 files / 21 tests passed |
| `pnpm lint:changed` | 0 errors, 0 warnings |
| `npx tsc --noEmit -p apps/api/tsconfig.json` | clean |

**Database discipline.** The configured primary database only (`AGENTS.md` §3.1); no database, schema
or container was created; nothing was truncated, dropped or reset. Every row and every stored byte
the journey created is deleted by exact id.

**External effects.** None. The provider is the in-process fake: no envelope is created at a vendor,
no mail is sent, no network call leaves the machine.

## 10. Known limitations

1. **The journey is not a browser journey.** It drives the public API contracts, which is what the
   plan asks for; the SPA's own signature screens are covered elsewhere.
2. **The steps are ordered on purpose.** A journey that asserted its halves separately would not prove
   that they fit together; each `it` states what the previous one left behind.
3. **The provider events are scripted, not organic.** The fake can emit whatever the journey tells
   it to, so the journey proves the *projection* (which event moves which state) rather than a
   vendor's timing.
4. **The quote is never sent.** The journey stops at the signature: the Sales quote's own `send`
   transition (which issues the quote and queues a mail) is a separate journey, and the "a signed
   document is not a payment" assertion depends on the quote staying in `draft`.

## 11. Acceptance criteria (plan §13.2)

- [x] **Exactly one logical signature request is created for one idempotency key.** The journey asserts the provider's call ledger: one `sendEnvelope` for one request, and one envelope.
- [x] **Document versions and signature evidence remain immutable and auditable.** The source snapshot's hash and path are identical before and after the evidence arrives; the derived artifact has its own hash and its own `derived/` path; the approval is an audit row.
- [x] **Invalid webhooks cannot advance the workflow.** A forged delivery is 401 and changes nothing; a duplicate is acknowledged without a second effect; an older event cannot move a terminal request back.
