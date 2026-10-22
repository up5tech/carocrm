# Phase 19-ES.5 — Secure Document Snapshot Service

> `PLAN_Phase_19_ESignature.md` §4.5, §6.3, §12.9, §18 `Phase 19-ES.5`.
> Acceptance: source files cannot be overwritten by a provider result; the snapshot hash/version is
> stable for the exact submitted bytes; unauthorized source documents cannot be attached to a request.
>
> Prerequisites read: `esignature-es2-completion-report.md` (the snapshot table, the artifact kinds,
> the retention classes); `esignature-es4-completion-report.md` (the connection lifecycle and the
> service-authority model); `docs/implementation/esignature-audit.md` §3 (the attachment/file reuse).

ES.5 gives the module its document integrity: a signature request stops pointing at "an attachment"
and starts pointing at **the bytes that were submitted**, copied once into storage this module owns,
hashed, and sealed against the file that came after it. No HTTP surface arrives here — a draft has to
exist before anything can be attached to it, and that is ES.6 — so this is the service ES.6 will call,
proved against the real database and the real file storage.

---

## 1. Files

| File | What it owns |
| --- | --- |
| `esignature-document.service.ts` | `ESignatureDocumentService`: `attachAttachment`, `replaceDocument`, `detachDocument`, `listDocuments`, `openSnapshot`, `storeDerivedArtifact`, plus the pure `policyIssue` and `storageKey`. `extensionOf` and `documentCeiling` are exported because they are the policy's two decision points and both are asserted directly. |
| `signature-document-snapshot.repository.ts` | `findBySourceAttachment`, `findByHash` (now public), `requireById`, `requireForRequest`, and an optional caller-supplied `id` on `record()` — needed because the storage key is derived from the row's id, so the id must exist before the bytes are written. |
| `esignature-errors.ts` | `signatureDocumentNotReadableError` with a closed reason list (`not_readable`, `type_not_allowed`, `too_large`, `too_many`, `empty`, `storage_unavailable`, `checksum_mismatch`). ES.1 declared the code; this is its first consumer. |
| `esignature-module.ts` | `DOCUSIGN_DOCUMENT_RESTRICTIONS` (the provider's per-document ceiling and accepted formats), `documents` removed from `PENDING_FEATURES`, `19-ES.5` added to `IMPLEMENTED_PHASES`. |
| `index.ts` | Registers the service and exports its surface. |

**No migration.** Everything ES.5 stores already exists in `064_phase19_esignature.sql`: the snapshot
table, its content-hash CHECK, the three uniqueness rules that make an artifact idempotent, and the
`artifact_kind` separation this phase relies on.

---

## 2. How each acceptance criterion is held

**Source files cannot be overwritten by a provider result.** Three independent things make this true,
and the suite asserts each:

- the storage key carries the **artifact kind as a path segment** — `esignature/<request>/<source|derived>/<id>[.ext]`
  — so a derived artifact cannot resolve to a source object even if it holds byte-identical content
  (the test stores a "signed" PDF with exactly the source's bytes and re-reads the source object);
- `storeDerivedArtifact` accepts only the three derived kinds and refuses `source_snapshot` by name, so
  there is no call that writes provider bytes into a source row's kind;
- the repository has no operation that rewrites a stored row's `storage_ref` or bytes, and
  `removeFromDraft` soft-deletes a row and leaves its object in place.

**The snapshot hash is the hash of the exact submitted bytes.** The copy runs through the platform's
own `StreamProbe`, so the digest is computed while the bytes stream into storage and the ceiling is
enforced at the same time — never a hash of a name, never a hash recomputed at render time. Two
independent checks then apply: the copied bytes must match the **attachment's own recorded checksum**
(a source that differs from what the platform hashed on upload is refused with `checksum_mismatch`,
and the half-written object is deleted), and `openSnapshot` re-hashes what storage returns on every
read, so ES.9 sends and ES.15 serves only bytes that still match their record. The test replaces the
source attachment's stored bytes *after* the snapshot and shows the snapshot still returns the
original; then it deletes the source attachment entirely and shows the snapshot still reads back.

**Unauthorized source documents cannot be attached.** The only reader of file bytes in this service is
`AttachmentService` — `getById` for the metadata and `download` for the stream — which enforces the
parent record's ACL, the attachment visibility gate and the uploader-or-administrator rule
(`attachment.service.ts:293-308`). The test drives it with a second real user who holds
`manageDraft` but cannot read the file: the call is refused with the platform's own
`AUTHORIZATION_DENIED`, and the assertion that follows is the one that matters — **no snapshot row and
no object exist**, because the refusal happens before anything is copied. The same user then attaches a
file they *can* read, and it succeeds, which is what proves the refusal was about the file.

---

## 3. Decisions taken here

- **The snapshot is a copy, not a reference.** The plan allows either an immutable version reference or
  the bytes; this platform's attachments have no versioning (an id owns one storage key, and nothing
  rewrites it), so a reference would be a pointer to a row that can be deleted. The copy is what makes
  the evidence survive its own source, and its key is namespaced per request.
- **The policy is the tighter of the settings document and the provider.** An administrator
  allowlisting `.zip` does not get zips into an envelope: `policyIssue` requires the extension to be in
  `documents.allowedExtensions` **and** in `DOCUSIGN_DOCUMENT_RESTRICTIONS.supportedExtensions`, and the
  size ceiling is `min(settings, provider)`. A name whose declared MIME contradicts its extension is
  refused (plan §12.9 names the unexpected MIME type as an attack surface).
- **`DOCUSIGN_DOCUMENT_RESTRICTIONS` is an expected value, not a verified one.** The ES.0 audit
  verified DocuSign's API surface, not its per-document limits. The numbers are conservative and the
  effective ceiling is the tighter of the two, so a wrong guess can only refuse a document that would
  have been accepted. ES.22 re-verifies against the live account and corrects this one constant.
- **`documents` leaves `PENDING_FEATURES`, but `effective.documents` stays false until ES.6.** The
  composed flag also requires `requests`, because a document with no request to belong to is not
  something an administrator can use. The service therefore gates on the module switch plus the
  `documents` switch — the flags that describe *this* infrastructure — and the UI keeps reading
  `effective`, which opens when the request workspace ships.
- **A replaced document is soft-deleted, not erased.** `replaceDocument` names the slot, retires the
  old row and leaves its bytes: an approval or a send preview was decided against those bytes, and
  plan §6.6 wants that reconstructable.
- **`storeDerivedArtifact` asserts no caller capability.** It is the worker's write path (ES.15), which
  runs under the module's documented service authority where there is no session to check. Every
  human-facing method on this service does assert one.
- **The refused copy leaves nothing behind.** Every failure path after a `storage.put` deletes what it
  wrote, and the ES.5 suite asserts both that the database has no row and that the request's snapshot
  directory is empty afterwards.

---

## 4. Verification

**`apps/api/test/esignature-documents.test.ts` — 25 checks, all green**, against the configured
database and the configured local file storage (AGENTS.md §3.1: no database, schema or container is
created; every attachment, snapshot, request and audit row is removed by its own id, the snapshot
directory is deleted, and the `ESignature` settings row is restored exactly as found).

| Group | Covers |
| --- | --- |
| policy (7) | allowlist and provider intersection; MIME/extension contradiction; the tighter of the two size ceilings, including a settings value above the provider's; the count limit; an empty file; extension parsing against a path-shaped name; the source/derived key layout. |
| snapshotting (6) | the happy path end to end (hash, size, MIME, order, retention class, `sourceVersionId` = the attachment's checksum, audit row with no document content); idempotency per attachment; one object when two attachments carry the same bytes; the source replaced **and** deleted afterwards; a tampered source refused with nothing recorded; a policy refusal that copies nothing. |
| authorization (5) | a drafting user who cannot read the file is refused and records nothing; the same user with a readable file succeeds; `manageDraft` needed to change documents and `use` to list them; every verb refused while the module or the feature is off; documents frozen once the request leaves the editable states. |
| derived artifacts (3) | a byte-identical signed PDF stored as a new artifact with the source untouched; the same provider artifact twice is a no-op; a `source_snapshot` kind refused; a snapshot whose object was tampered with will not open. |
| detach and replace (3) | detach keeps the bytes and frees the slot; another request's snapshot cannot be detached through this one; a replaced slot retires the old row soft-deleted and keeps its object as evidence. |

The module's own suites are now **170 green** (ES.1 20, ES.2 53, ES.3 31, ES.4 41, ES.5 25).
`pnpm typecheck`, `pnpm -r build` and `pnpm lint` are green. The full `pnpm test` run is
**2 438 passed / 7 failed in 5 files**, and every one of the seven is the pre-existing set named in §6
— no ESignature suite is among them.

**No browser check is possible for this phase**: ES.5 ships no route and no screen. The evidence is
the integration suite running against the real storage driver and the real attachment ACL, plus the
live check that comes with ES.6 (the draft document picker).

---

## 5. What later phases take from here

- **ES.6** calls `attachAttachment` / `replaceDocument` / `detachDocument` / `listDocuments` from the
  draft endpoints, and the attachment upload flow that feeds them.
- **ES.8** builds the outgoing snapshot from `listDocuments` and the digests recorded here.
- **ES.9** sends `openSnapshot` bytes to the provider — the reason the digest is re-verified on read.
- **ES.15** calls `storeDerivedArtifact` for signed documents and the completion certificate; the
  separation, the idempotency and the `evidence` retention class are already in place.
- **ES.19** may add a sweep for objects whose row was soft-deleted; today they are kept deliberately.

## 6. Known limits and the pre-existing baseline

- Attachment bytes are read twice on a snapshot (once into the copy, and once more by
  `openSnapshot`'s verification at read time). That is the integrity guarantee, not an accident.
- `openSnapshot` returns a buffer, bounded by the document ceiling (the tighter of the settings value
  and DocuSign's 25 MiB). If a later phase needs larger documents, the read becomes a stream plus a
  trailing digest — the write path already streams.
- A snapshot object is removed only when its *copy* failed; a soft-deleted row leaves its bytes for
  the retention job to decide on (ES.19).
- `sourceVersionId` records the attachment's checksum, because the platform has no file versioning;
  if attachments ever gain versions, that column is where the real id goes.
- Pre-existing full-suite failures, unchanged by this phase: `docs-content` +
  `packages/docs/corpus` (`/EmailTemplate` `unknownAppRoute`, from commit `5ce375e`) and the
  `service-desk` / `service-desk-workflow` / `service-desk-sla` suites (shared dev-DB state and a
  time-of-day-dependent SLA assertion).
