# Phase 19-ES.15 — Completed Documents and Completion Evidence

> `PLAN_Phase_19_ESignature.md` §4.5, §6.3, §12, §16, §18 `Phase 19-ES.15`.
> Acceptance: the signed copy and completion evidence are available to authorized users only; the
> original source document remains unchanged; retrying a download does not create duplicate artifacts.
>
> Prerequisites read: `esignature-es5-completion-report.md` (the artifact storage that was already
> built), `esignature-es12-completion-report.md` (the completion projection that triggers retrieval).

ES.15 connects the provider's finished documents to the module's derived-artifact store. The source
snapshot is never the target: signed documents and the certificate are new rows under a different
artifact kind and a different storage segment.

---

## 1. Files

| File | What it owns |
| --- | --- |
| `providers/docusign/docusign-adapter.ts` | `downloadCompletedDocuments` reads `GET /envelopes/{id}/documents`, fetches each non-certificate document as bytes and hashes it; falls back to the combined PDF. `downloadCompletionEvidence` fetches `/documents/certificate`. |
| `providers/docusign/docusign-transport.ts` | Adds `binary: true` to a request and `bytes` to the answer, so a PDF is not decoded as text. |
| `signature-document-snapshot.repository.ts` | `findByProviderDocumentId` — the second dedup identity beside the content hash. |
| `esignature-document.service.ts` | `openSnapshot` allows a derived artifact while `features.artifacts` is on, independently of the attachment feature; `storeDerivedArtifact` remains the only write path. |
| `esignature-request.service.ts` | `retrieveCompletedArtifacts` — `downloadCompleted` capability, completed state, both adapter calls, dedupe, store, audit; `openDocument` requires `downloadCompleted` for a derived artifact. |
| `esignature.controller.ts` | `POST action/retrieve-artifacts` — worker capability + system principal, for the job enqueued after completion. |
| `esignature-webhook.service.ts` | After a projection reaches `completed`, enqueues `esignature.retrieveCompletedArtifacts` when `artifacts` is effective. |
| `pages/esignature/ESignatureRequestsPanel.tsx` | *Retrieve signed documents* for a completed request; the existing document list downloads both derived artifacts and source snapshots. |

**No migration.** `signature_document_snapshots` already has the derived kinds, the provider-document-id
unique index and the content-hash unique index.

---

## 2. How each acceptance criterion is held

**Authorized users only.** The command checks the record ACL and the `downloadCompleted` right through
the gate, and the `artifacts` feature must be effective. Opening a derived artifact (`provider_signed_document`
or `completion_evidence`) requires `downloadCompleted`; a source snapshot remains readable with `use`.
The content route re-checks the request, verifies the stored bytes against the recorded SHA-256 and
serves `no-store` bytes with the digest header.

**The source is unchanged.** `storeDerivedArtifact` refuses a source kind and writes under
`esignature/<requestId>/derived/<row id>`, a key a source can never occupy. It reads the uploaded bytes
back and hashes the stored object before recording; a mismatch deletes the object. The source snapshot
row is never updated — the test asserts its hash before and after.

**Retries create nothing.** Retrieval first asks for an artifact by provider document id, then the store
asks by content hash. Both the unique indexes and the pre-checks make a second click or a retried job a
no-op; a second retrieval stores zero new rows and returns the same ids.

**Trigger.** A completion event projection enqueues the artifact job when the feature is on. The job
carries only the request id and is idempotent; the operator can also run it from the detail screen.

---

## 3. Decisions taken here

- **Both identities are checked.** The provider document id catches a re-download whose bytes are
  re-encoded; the content hash catches a provider that reuses a name. Either match returns the existing
  row.
- **A list-less account still gets evidence.** If the document list is empty or unknown, the adapter
  downloads the combined PDF rather than returning nothing.
- **The certificate is skipped in the signed-document list** and fetched via the certificate endpoint,
  so the artifact kind stays honest: signed document vs completion evidence.
- **`artifacts` can stand alone.** Reading a signed copy does not require the `documents` attachment
  feature; the document service accepts either feature for a derived artifact.

---

## 4. Verification

- `apps/api/test/esignature-lifecycle.test.ts` — two artifacts on completion, source hash unchanged,
  second retrieval `created: 0` with the same ids, byte download with the recorded checksum, a
  `use`-only reader refused for a derived artifact.
- `apps/api/test/esignature-docusign.test.ts` — document list + binary document + certificate, byte
  hashes, and the binary request flag.
- The existing ES.5 document tests still pass (`esignature-documents.test.ts`).
- Combined run and checks: see ES.16 report §4.

## 5. Still open

- The live document list, combined PDF and certificate endpoints are confirmed for shape against a stub;
  ES.22 validates them against the demo account.
- No retention job purges artifacts: `completedArtifactDays = 0` means evidence is kept, and a
  deletion policy is ES.20/ES.21.
