# Phase 19-ES.6 — Signature Request Draft and CRUD

> `PLAN_Phase_19_ESignature.md` §6.2, §8.2, §11, §13.1–§13.3, §18 `Phase 19-ES.6`.
> Acceptance: a user can create, edit and view a draft request; sent requests cannot be modified
> through generic PATCH endpoints; linked-record ACL is enforced.
>
> Prerequisites read: `esignature-es2-completion-report.md` (the request and recipient repositories,
> the state machine), `esignature-es5-completion-report.md` (the snapshot service this API drives),
> `esignature-es1-completion-report.md` (the capability matrix), `docs/module-guide.md` §ACL.

ES.6 is the module's first human surface over its own records: the list, the draft editor, and the
document/recipient configuration behind them. It answers the two authorization questions the plan asks
on every command — *may this caller hold this right* and *may this caller touch this record* — and adds
the one that is specific to this module: *may they read the CRM record they are linking to*.

---

## 1. Files

| File | What it owns |
| --- | --- |
| `esignature-request.service.ts` | `ESignatureRequestService`: `list`, `get`, `create`, `update`, `replaceRecipients`, `listRecipients`, `listDocuments`, `attachDocument`, `replaceDocument`, `detachDocument`, `openDocument`, `view`. The capability check, the record-scope check, the draft-state check and the linked-record rules all live here. |
| `esignature-request.controller.ts` | `GET/POST /api/v1/ESignature/requests`, `GET/PATCH /:id`, `GET/PUT /:id/recipients`, `GET/POST /:id/documents`, `PUT /:id/documents/order/:order`, `DELETE /:id/documents/:documentId`, `GET /:id/documents/:documentId/content`. Shape parsing only. |
| `signature-request.repository.ts` | `RequestAccessScope` and the SQL predicate that scopes a list (`assigned_user_id` / `created_by_id` / `team_ids ?| …`), mirroring the entity store's own `aclSql`. |
| `dto/esignature-shapes.ts` | `RequestCreateSchema`, `RequestUpdateSchema` (with the required `version`), `RequestRecipientsSchema`, `RequestDocumentAttach/ReplaceSchema`, `RequestListQuerySchema`. |
| `signature-recipient.repository.ts` | `RecipientInput` optionals widened for the DTO's exact-optional shape (no behaviour change). |
| `esignature-module.ts` | `requests` removed from `PENDING_FEATURES`; `19-ES.6` added to `IMPLEMENTED_PHASES`. |
| `pages/esignature/ESignatureRequestsPanel.tsx` (+ `ESignaturePage.tsx`, `api/client.ts`, `api/types.ts`, `i18n/{en,vi}/esignature.json`) | The list, the draft drawer (create / edit / view), the recipients editor, and the document upload/download surface. |

**No migration.** ES.2's tables already carry everything the draft needs; the API adds no column.

---

## 2. How each acceptance criterion is held

**A user can create, edit and view a draft.** `POST /requests` creates a draft owned by its creator and
their teams; `PATCH /requests/:id` edits it with an optimistic `version`; `GET /requests/:id` returns the
draft with its recipients, its documents and an `editable` flag derived from the state machine. The SPA
renders all three, and the live check below walks the whole path: create → attach a PDF → add a
recipient → edit → reopen.

**A sent request cannot be modified through a generic PATCH.** Two layers, both asserted:

- the module's own `PATCH` answers **409 `SIGNATURE_REQUEST_INVALID_STATE`** once the request leaves
  `draft`/`pending_approval`/`ready_to_send` — the service checks before the repository does, so the
  caller gets the module's stable code rather than a generic validation failure;
- there is **no generic route to reach**: `PATCH /api/v1/SignatureRequest/:id` is a 404, because a
  signature request is a dedicated table, not a metadata entity. The test asserts both the 404 and that
  the stored row is untouched.

**Linked-record ACL is enforced.** A request may name an Account, a Quote or a Project (plan §2.3). On
create and on re-point, the entity must exist in the metadata registry and the caller must be able to
read the record — otherwise **403**, before the row exists or changes. On read, the detail reports the
link as `accessible: false` with **no label** when the caller may not read the record, and as
`missing: true` when it was deleted (the id is stored without a foreign key precisely so the request
outlives its source). The suite proves all four outcomes.

---

## 3. Decisions taken here

- **Route prefix.** §8.2 writes the paths in lower case (`/api/v1/esignature/…`); the module registered
  `/api/v1/ESignature` in ES.1 and the control plane already answers there. The request surface follows
  the registered prefix, so the module has one origin rather than two spellings.
- **Write scope is the read level.** The capability matrix maps "prepare drafts" to
  `SignatureRequest:create` (an entity-level right) and there is no `edit` capability; record scope is
  therefore the evaluator's `read` level plus `manageDraft`. A role scoped to `own` can edit its own
  drafts and nothing else — which is the behaviour the plan's §11 ownership rules describe.
- **`version` travels in the body, not `If-Match`.** The form already renders the version, and a body
  validator can refuse a missing one outright; a stale version is a 409 from the repository's
  compare-and-set.
- **A list is scoped by a predicate, not by filtering rows.** `RequestAccessScope` builds the same SQL
  the entity store uses (`assigned_user_id = me OR created_by_id = me OR my teams overlap team_ids`), so
  pagination and `total` stay honest for a scoped user.
- **Documents delegate to ES.5.** The request service checks the request's ACL, then calls the snapshot
  service that owns the bytes; the download route re-hashes the object against its record before sending
  it (plan §4.5). A document id from another request is refused, not served.
- **Recipients are replaced as a set.** A partial edit could leave two signers in one routing slot; the
  repository already refuses a duplicate template role, and the API surfaces that as
  `details.code = RECIPIENT_NOT_AUTHORIZED`.
- **No `DELETE` for a request.** A request is evidence. A draft's removal belongs to the module's
  soft-delete path, not to the CRUD surface, and nothing in this phase needed it.
- **The UI uploads through the platform attachment API first.** `POST /Attachment/upload` (parentless,
  owned by the uploader) then `POST /requests/:id/documents` — so the request API never accepts bytes
  and the file still goes through the platform's MIME, size and malware checks.

---

## 4. Verification

**`apps/api/test/esignature-requests.test.ts` — 18 checks, all green**, against the configured database
and storage, with four real users: two drafters scoped to `own`, an `all` reader and a read-only role.
Accounts created for the linked-record tests are removed with their audit, stream and outbox rows; every
request, attachment, snapshot and settings change is removed by its own id.

| Group | Covers |
| --- | --- |
| draft CRUD (4) | create → list → read with the audit row; edit with the version and a stale-version 409; server-owned field and empty body refused; reassignment. |
| linked records (4) | a readable source with its label, and clearing it; a foreign source refused on create **and** on re-point with nothing changed; a source that moves out of scope reported without its name; a deleted source reported as missing; a non-entity and a missing record refused. |
| record scope (3) | one drafter hidden from another on read, patch and list, visible to an `all` reader; read right separated from the drafting right; the same scope applied to recipients and documents. |
| frozen request (2) | edits, recipients and documents refused with 409 `SIGNATURE_REQUEST_INVALID_STATE` once sending; the generic entity route is a 404 and the row is untouched. |
| recipients (1) | set replacement, validation of email/empty/duplicate role, and the audit row. |
| documents (3) | upload → attach → list → download (bytes and checksum) → detach; the policy refusal and a document from another request; slot replacement with the previous snapshot retired, not rewritten. |
| list query (1) | status filter, unknown status 400, `needsAttention`, paging bounds. |

The module's own suites are now **188 green** (ES.1 20, ES.2 53, ES.3 31, ES.4 41, ES.5 25, ES.6 18).
`pnpm typecheck`, `pnpm -r build` and `pnpm lint` are green; the full `pnpm test` run is
**2 457 passed / 6 failed in 5 files**, all six in the pre-existing set named in §6.

**Live check** (scratch API on `:3042` from the repo root, Vite on `:5142`, admin session): the requests
panel listed an empty state and a "New request" button; the drawer created `AGENT_TEST_es6_ui_draft` with
a signer and `routingOrder 1`; the detail showed `Draft` + `Editable draft`; attaching a 77-byte PDF
reported *"The document was snapshotted onto the draft."* and rendered `6618a19a973ee153…` — the file's
own SHA-256; editing the subject and saving re-rendered the detail with the new subject (the detail query
is invalidated on save — without that it kept the pre-edit copy, which the first browser pass caught);
the download and remove controls are present. Afterwards the shared dev database holds **zero** ESignature
rows and the settings row was removed.

---

## 5. What later phases take from here

- **ES.8** adds `prepare`, which builds the outgoing snapshot from `listDocuments` and the digests and
  freezes the version this API bumps.
- **ES.10** adds `send`, which re-checks `editable`, claims `sendAttemptId` and uses the same ACL path.
- **ES.13** extends the list with signer-progress and the source-record link label; the fields the plan
  §13.2 asks for that are not here (recipient status summary, last provider sync) belong to the phases
  that produce them.
- **ES.17** flips the approval flags this draft already carries.

## 6. Known limits and the pre-existing baseline

- The source record's label is resolved per row on the list page (one lookup plus one ACL decision per
  distinct request). At the page size the screen uses that is fine; a larger list needs a batched
  lookup in the store.
- The request list does not yet show recipient progress or "needs reconciliation" detail; the status is
  the request's own.
- Attaching a document requires the file to exist as an attachment first; the editor uploads it, but a
  "pick from this record's attachments" flow is not built (the plan does not ask for a second document
  manager).
- A draft can be created with no recipients; the send guard (ES.9/ES.10) is what will refuse to send it.
- Pre-existing full-suite failures, unchanged by this phase: `docs-content` + `packages/docs/corpus`
  (`/EmailTemplate` `unknownAppRoute`, commit `5ce375e`) and the `service-desk*` suites (shared dev-DB
  state and a time-of-day-dependent SLA assertion).
