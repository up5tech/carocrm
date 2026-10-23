# Phase 19-ES.8 — Recipient Routing and Send Preview

> `PLAN_Phase_19_ESignature.md` §4.3, §4.4, §6.2, §11.1, §11.2, §13.3, §18 `Phase 19-ES.8`.
> Acceptance: a multi-recipient preview accurately reflects the final request; wrong or ambiguous signer
> mappings are blocked; no external send occurs during draft or preparation.
>
> Prerequisites read: `esignature-es2-completion-report.md` (the snapshot envelope and the request state
> machine), `esignature-es5-completion-report.md` (document hashes), `esignature-es6-completion-report.md`
> (the draft API), `esignature-es7-completion-report.md` (the mapping and `checkUsage`), and the plan's
> send-guard sequence (§4.3, §18 `19-ES.9`–`19-ES.10`).

ES.8 is the review step: it answers **what a send would carry** and **what must be true before one may be
prepared**, and it records that answer as an immutable snapshot with a digest. It does not create an
envelope and it cannot send — those are ES.9 and ES.10, and the acceptance criterion for this phase is
precisely that nothing external happens here.

---

## 1. Files

| File | What it owns |
| --- | --- |
| `esignature-preview.ts` | `buildSignaturePreview` — the pure preview: documents (with hashes), recipients and routing, the account context, the policy in force, the digest, and every problem that blocks preparation. |
| `esignature-request.service.ts` | `preview` (read), `prepare` (confirm + version + problems → `recordPreparation`), the mapping binding guard, and `dropStalePreparation` after every draft mutation. |
| `esignature-request.repository.ts` | `recordPreparation` (snapshot + digest + the status the policy allows, approval kept only for the same digest) and `invalidatePreparation` (back to `draft`, snapshot and approval dropped), plus `template_mapping_id` on the entity. |
| `esignature-snapshot.ts` | `OutgoingSnapshotData` gains the optional `templateMappingId` / `templateMappingVersion`, so a mapping edit changes the digest (and therefore invalidates a review). |
| `esignature-template.service.ts` | `evaluateMappingUsage` extracted, so the preview and `checkUsage` ask one question of a mapping. |
| `esignature-request.controller.ts` | `GET /requests/:id/preview`, `POST /requests/:id/prepare`. |
| `dto/esignature-shapes.ts` | `RequestPrepareSchema` (`version` + `confirm`), and `templateMappingId` on create/update. |
| `database/migrations/066_phase19_esignature_template_binding.sql` | `signature_requests.template_mapping_id` + a partial index. **Applied to `carocrm_dev`.** |
| `pages/esignature/ESignatureRequestsPanel.tsx` (+ client, types, i18n) | The preview card in the request drawer: digest, readiness, problems, recipients with routing, and a confirmed Prepare action. |

---

## 2. How each acceptance criterion is held

**The preview reflects the final request.** It is built from the request's own rows at the moment it is
asked for: the source snapshots in document order with their SHA-256, the recipients as submitted with
their type, routing order and template role, the connection's environment and account, the subject,
message, expiry and the policy. Two previews of unchanged state produce the same digest; changing a
recipient, a document or the subject changes it. The suite asserts each of those, and the live check
showed the same values on screen as the API returned.

**Wrong or ambiguous signer mappings are blocked.** Preparation refuses, with a named problem, when:

| Problem | Meaning |
| --- | --- |
| `no_documents` / `too_many_documents` | nothing to sign, or more documents than the installation allows |
| `no_signer` | every recipient is a carbon copy |
| `duplicate_signer_email` | two signers share one address — which one signs is not decidable |
| `expiry_in_past` | the request would be sent already expired |
| `connection_missing` / `connection_not_connected` | no account context to record, or a connection that cannot carry a request |
| `mapping_missing` / `mapping_inactive` / `mapping_connection_mismatch` | the bound mapping is gone, switched off, or belongs to another account |
| `missing_role` | a template role no recipient fills |
| `missing_tab_value` | a required tab whose mapped CRM value is blank |
| `source_values_unavailable` | the mapping needs source values and the linked record is missing or unreadable |

Binding a mapping is itself guarded: another connection's mapping and an inactive mapping are refused at
the draft, before a preview can even be asked for.

**No external send during draft or preparation.** Preparation makes no provider call at all. The suite
asserts it on the bound fake adapter's own ledger — no `sendEnvelope` **and** no `prepareEnvelope` — and
the request moves only between local states (`draft` → `ready_to_send`, or `draft` → `pending_approval`
when the policy requires an approval).

---

## 3. Decisions taken here

- **A request may bind a mapping, so a mapping edit is observable.** That needed one additive column
  (`template_mapping_id`, migration `066`), because without it "invalidate when the mapping changes" has
  nothing to compare. No foreign key: mappings are retired, never deleted, and the request keeps naming
  the mapping it was prepared from.
- **The preview is a pure function of rows, not a stored projection.** `GET preview` writes nothing and
  cannot trigger a side effect; `prepare` records the same payload with `buildSnapshot`, so the digest the
  review screen showed is the digest the request stores.
- **The approval requirement is the policy's, not only the draft's.** A source entity listed in
  `approval.requiredForSourceEntities` makes preparation go to `pending_approval` even when the draft's
  own `approvalRequired` flag is false — and the row records that effective requirement
  (`approval_required` is written by `recordPreparation`), so the history explains why.
- **Editing a prepared draft returns it to `draft`.** A subject, recipient, document or mapping change
  drops the snapshot, the preparation stamps and any approval bound to the old digest
  (`invalidatePreparation`), and the audit records `preparation_invalidated`. A preview that no longer
  describes the request must not be able to reach a send.
- **An approval survives only for the same bytes.** `recordPreparation` keeps `approved_digest` when it
  matches the new digest and clears it otherwise, so re-preparing an identical request does not demand a
  second signature and re-preparing a changed one does.
- **`confirm: true` is a body field that must be literally true.** A defaulted flag would let a retried
  call look confirmed; the service refuses anything else with `CONFIRMATION_REQUIRED`.
- **The preview reads source values through the caller's own ACL.** A mapping whose values come from a
  record the caller cannot read is reported as `source_values_unavailable` rather than filled from data
  the request's screen could not show.
- **A request already sending cannot be prepared.** The write guard answers 409
  `SIGNATURE_REQUEST_INVALID_STATE` before any snapshot is considered.

---

## 4. Verification

**`apps/api/test/esignature-preview.test.ts` — 14 checks, all green**, against the configured database
and storage, with an `own`-scoped drafter, a second user, two connected accounts and real mappings.

| Group | Covers |
| --- | --- |
| the preview reflects the request (2) | documents with their hash, recipients with type and routing, account and policy; nothing written; digest stable across two reads and changed by a recipient edit. |
| blocked requests (3) | no document, no signer (CC only), duplicate signer address, past expiry; a template role nobody fills and a required tab with no source value; a foreign mapping, an inactive mapping, a request with no connection. |
| preparation (3) | `confirm: false` → `CONFIRMATION_REQUIRED`, stale version → 409, nothing changed; the happy path stores the snapshot and digest and moves to `ready_to_send` **with no provider call**; the approval policy moves it to `pending_approval` and records the requirement. |
| invalidation (2) | a subject edit and a recipient edit each return the request to `draft`, drop the snapshot and approval, audit `preparation_invalidated`, and a second preparation produces a different digest. |
| the mapping is part of the snapshot (1) | the template id and mapping version are recorded; editing the mapping makes the stored preview stale and changes the digest. |
| scope and state (3) | a drafter previews their own request; another user is refused; a request already sending cannot be prepared. |

The module's own suites are now **225 green** (ES.1 20, ES.2 53, ES.3 31, ES.4 41, ES.5 25, ES.6 18,
ES.7 23, ES.8 14). `pnpm typecheck`, `pnpm -r build` and `pnpm lint` are green; the full `pnpm test` run
is **2 493 passed / 7 failed in 5 files**, all seven in the pre-existing set named in §6.

**Live check** (scratch API `:3044` from the repo root, Vite on `:5144`, admin session): a draft with one
snapshotted PDF and two recipients showed the preview card — digest `d928cfda1b2c947f…`, "The request is
ready to prepare.", 1 document, 2 recipients with their routing and types, `demo · fake-account-1`,
approval "Not required". Ticking the confirmation and pressing *Prepare this request* answered
"The preview was recorded. Nothing has been sent.", the drawer's status became **Ready to send**, and no
stale-preview warning appeared. Afterwards the shared dev database holds zero ESignature rows (the
scratch connection, request, recipient, snapshot, mapping and settings row were removed by id), and no
snapshot objects remain.

---

## 5. What later phases take from here

- **ES.9** builds the provider-side draft from `request.outgoingSnapshot.data` — the same payload the
  review showed — and its idempotency comes from the request's own version and a stable key.
- **ES.10** sends, and its guards are the ones this phase put in place: `ready_to_send`, a current
  digest, no stale preview, and (when required) an approval for that digest.
- **ES.17** decides approvals; this phase only routes a request into `pending_approval` and keeps an
  approved digest valid for exactly one payload.

## 6. Known limits and the pre-existing baseline

- The preview does not render a document page or resolve field *positions*; it reports the tab names and
  the CRM values the mapping will use. A visual preview belongs to ES.9/ES.13.
- An approval decision itself is ES.17's; there is no approve/reject route yet, so a request prepared
  under an approval policy stays in `pending_approval`.
- `templateMappingId` is not part of the ES.6 draft UI yet — it is set through the API; the mapping
  picker arrives with the send wizard.
- A mapping edit does not push requests back to `draft`; it makes their stored preview *stale*, which
  preparation refuses to send from (ES.10's guard). The request row is only rewritten when the draft
  itself changes.
- Pre-existing full-suite failures, unchanged: `docs-content` + `packages/docs/corpus`
  (`/EmailTemplate` `unknownAppRoute`, commit `5ce375e`) and the `service-desk*` suites (shared dev-DB
  state and a time-of-day-dependent SLA assertion).
