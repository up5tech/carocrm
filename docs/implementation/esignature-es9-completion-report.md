# Phase 19-ES.9 — DocuSign Envelope Preparation

> `PLAN_Phase_19_ESignature.md` §4.3, §4.5, §5.2, §6.2, §6.7, §13.3, §18 `Phase 19-ES.9`.
> Acceptance: a demo provider accepts a draft envelope for the synthetic test document; retrying
> preparation cannot create uncontrolled duplicate provider drafts; provider state maps to local
> draft/prepared state accurately.
>
> Prerequisites read: `esignature-es2-completion-report.md` (the request state machine and
> `attachProviderEnvelope`), `esignature-es3-completion-report.md` (the adapter contract, the fake and
> `prepareIdentity`), `esignature-es7-completion-report.md` (the mapping and its roles/tabs),
> `esignature-es8-completion-report.md` (the prepared snapshot this phase sends to the provider).

ES.9 creates the **provider-side draft** from the reviewed snapshot: `status: 'created'` at DocuSign,
which emails nobody and invites no signer. The local request stays `ready_to_send` and gains the envelope
id; ES.10 is the only thing that can move it to `sending`.

---

## 1. Files

| File | What it owns |
| --- | --- |
| `providers/docusign/docusign-adapter.ts` | `prepareEnvelope` — the envelope request for both shapes (a template with `templateRoles` and tabs nested under them, or the snapshotted documents as base64 with `recipients`), with the CRM request id and idempotency key as text custom fields. `abandonDraftEnvelope` — `DELETE /envelopes/{id}`. `prepareEnvelope` flips to `true`; `sendEnvelope` stays `false` until ES.10. |
| `providers/fake-signature-provider.adapter.ts` | `abandonDraftEnvelope`, and the prepare call now records the template id, recipient count and mapped-tab count so a test can assert what reached the adapter. |
| `providers/signature-provider.port.ts` | `MappedFieldInput` on `PrepareEnvelopeInput`, and the `abandonDraftEnvelope` operation. |
| `esignature-request.service.ts` | `prepareEnvelopeAtProvider` (guards, advisory lock, idempotency, attach, audit) and `abandonProviderEnvelope` (provider delete, then release). The view now reports the envelope id and the provider's status word. |
| `esignature-request.repository.ts` | `releaseProviderEnvelope` — clears the id for an unsent request only. |
| `esignature-preview.ts` | The snapshot now carries `mappedFields` (tab, role, value), and a template request no longer needs a local document. |
| `esignature-snapshot.ts` | `OutgoingSnapshotData.mappedFields` — the reviewed tab values are part of the digest. |
| `signature-template-mapping.repository.ts` / `esignature-template.service.ts` | A field mapping gains `roleName`, validated against the template tab's own role (`tab_role_mismatch`), so a value cannot be sent to the wrong signer. |
| `esignature-request.controller.ts` / DTOs | `POST /requests/:id/envelope` (`{version}`) and `POST /requests/:id/envelope/abandon`. |
| `pages/esignature/ESignatureRequestsPanel.tsx` (+ client, types, i18n) | *Create provider draft* / *Delete draft* in the preview card, with the draft's id and status. |
| `esignature-module.ts` | `send` leaves `PENDING_FEATURES` (its range, ES.9–ES.10, begins here); `19-ES.9` joins `IMPLEMENTED_PHASES`. |

**No migration.** The request row already had `provider_envelope_id`, `provider_status_raw` and
`last_provider_sync_at`; the mapping's new `roleName` lives inside its existing JSONB column.

---

## 2. How each acceptance criterion is held

**The provider accepts a draft for the synthetic document.** Against the bound fake adapter the suite
asserts exactly one `prepareEnvelope` call, the envelope id recorded on the request, `provider_status_raw
= draft`, and the local status still `ready_to_send` with `sentAt` null. The live DocuSign adapter is
covered by four transport-level tests: the document body (`status: 'created'`, base64 file, signer and
CC routing, the mapped tab under its signer), the template body (`templateId` + `templateRoles` with the
tabs nested under each role), a template recipient without a role refused before any request, and the
DELETE for abandonment (404 treated as already gone). The **demo-account** half of the sentence needs
real credentials and is ES.22's, as with ES.4.

**Retrying preparation cannot create uncontrolled duplicates.** Three layers:

- an envelope already on the request is returned as-is with **no provider call** (asserted by counting
  the fake's calls across the retry);
- the command runs under `pg_advisory_xact_lock(hashtext(request_id))`, so two concurrent preparations
  serialise and the loser sees the winner's envelope;
- the idempotency key is `prepareIdentity(connection, request, snapshot digest)` — the same reviewed
  payload is the same key, and a changed draft is refused first by the stale-preview guard
  (`PREVIEW_OUTDATED`).

**Provider state maps to the local state accurately.** The only local transition a preparation causes is
`attachProviderEnvelope`: no status change, no `sentAt`, no send attempt. Abandoning the draft calls the
provider first and then clears the id/status on the request, which stays exactly `ready_to_send`.

---

## 3. Decisions taken here

- **A tab value belongs to a role, and the mapping now says so.** A DocuSign tab is filled by a specific
  template role; sending a value to the wrong one signs a contract with the wrong person. `roleName` is
  part of the field mapping, validated against the tab's own role in the live template, carried in the
  snapshot, and used by the adapter to nest tabs under the right role.
- **The tab values are in the snapshot.** ES.8 recorded documents and recipients; ES.9 needed the mapped
  values too, because a source record edited between preview and send must change the digest, not the
  envelope. The preview now resolves them (through the caller's own ACL) into `mappedFields`.
- **A template request needs no local document.** The template supplies its documents; requiring an
  attachment would be a rule about our storage leaking into the provider's model. A document request
  still needs one.
- **The abandonment is provider-first, then local.** A draft the provider already lost still needs its
  local id cleared, or the next preparation would be blocked forever; the local release is guarded to
  unsent requests so a real send's envelope id can never be forgotten.
- **`send` is no longer pending, but sending is not offered.** The feature now covers the preparation
  pipeline; `sendEnvelope` is still capability-`false`, so the gate refuses an actual send by name until
  ES.10 ships it. The ES.1 gate test was updated to expect the real reason (`PROVIDER_NOT_CONNECTED`)
  instead of the pending-feature refusal.
- **A lost prepare response is surfaced, not retried blindly.** The adapter raises its normal
  transport/provider error, the local request keeps no envelope id, and the operator's next step is a
  deliberate retry or an abandonment at the provider. The only duplicate this can produce is an unsent
  draft, which invites nobody — the plan's cleanup task exists for exactly that case.

---

## 4. Verification

| Suite | Covers |
| --- | --- |
| `apps/api/test/esignature-docusign.test.ts` (+4) | the document envelope body and response mapping; the template envelope body with tabs under roles; a role-less recipient refused before the request leaves the process; DELETE abandonment and the 404 path. |
| `apps/api/test/esignature-envelopes.test.ts` (9) | a draft without a preview refused; the happy path (id recorded, status `ready_to_send`, `draft` status, one adapter call, no `sendEnvelope`, audit); a retry returning the same envelope with no second call; a tampered stored digest refused with `PREVIEW_OUTDATED`; abandonment deleting at the provider, clearing the row and allowing a new preparation; abandoning with no envelope refused; the template path passing `templateId`, one recipient and one mapped tab; a drafting user preparing their own request end to end; another user refused. |

The module's own suites are now **238 green** (ES.1 20, ES.2 53, ES.3 31, ES.4 41, ES.5 25, ES.6 18,
ES.7 23, ES.8 14, ES.9 13). The API typechecks and the module's own files lint clean; the **repo-wide**
`pnpm lint` / SPA typecheck are currently red on an unrelated in-progress change in the working tree
(`apps/web/src/components/email/*` and `pages/EmailTemplateDesignerPage.tsx`, the Email Template
designer, not part of this commit). The full `pnpm test` run is
**2 507 passed / 6 failed in 5 files**, all six in the pre-existing set named in §6.

**Live check** (scratch API `:3045` from the repo root, Vite on `:5145`, admin session): a prepared
request showed *Ready to send*; *Create provider draft* answered "The provider draft was created. Nothing
has been sent." and the card showed `Draft: fake-env-2` with status `draft`; *Delete draft* → confirm
answered "The provider draft was deleted.", the tag disappeared, *Create provider draft* returned, and the
status stayed *Ready to send* throughout. Afterwards the shared dev database holds zero ESignature rows.

---

## 5. What later phases take from here

- **ES.10** sends: it transitions `ready_to_send` → `sending`, uses the recorded envelope id, and applies
  the ambiguous-outcome rules. The idempotency key derivation and the custom fields are already in place
  for reconciliation.
- **ES.12** reconciles by the envelope id and the custom fields this phase writes.
- **ES.16** voids/corrects a live envelope; abandonment here only ever touches an unsent draft.

## 6. Known limits and the pre-existing baseline

- The demo-account acceptance ("a demo provider accepts a draft for the synthetic document") is verified
  against the stub transport and the fake only; real credentials are ES.22's.
- A retried preparation after a genuinely lost response can leave one extra **unsent** provider draft;
  the local id is only recorded on a success. This is documented rather than hidden, and the abandon
  command plus the DocuSign account's own draft list are the recovery path.
- `expiresAt` is carried in the snapshot but not yet translated into DocuSign's `notification.expire*`
  fields; the expiry policy is applied at send time in ES.10.
- The SPA's whole-project typecheck/build cannot be run green right now because of the unrelated
  in-progress Email Template designer files in the working tree; only the module's files were checked.
- Pre-existing full-suite failures, unchanged: `docs-content` + `packages/docs/corpus`
  (`/EmailTemplate` `unknownAppRoute`, commit `5ce375e`) and the `service-desk*` suites (shared dev-DB
  state and a time-of-day-dependent SLA assertion).
