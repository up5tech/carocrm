# Phase 19-ES.22 — End-to-End QA and Release Readiness

> `PLAN_Phase_19_ESignature.md` §17, §18 `Phase 19-ES.22`, §19 Definition of Done.
> Acceptance: all required scenarios in §17 pass for the fake adapter; production remains disabled
> until an administrator explicitly configures and enables a production connection; no new database,
> schema, container or copy was created for tests; a release checklist and support runbook are
> available.

ES.22 records the final verification of the ESignature module. The fake-adapter end-to-end lifecycle
is green. The live DocuSign demo-account smoke test is **not** executed in this environment because
no DocuSign credentials, integration key or demo account are configured; it is left as an explicit
operator step before production enablement and is documented in the admin setup guide.

---

## 1. Files

| File | What it owns |
| --- | --- |
| `docs/runbooks/esignature-admin-setup.md` | Administrator setup, environment promotion, rollback and disable procedure. |
| `docs/modules/esignature/README.md` | Module overview and document index. |
| `docs/implementation/esignature-es22-completion-report.md` | This report. |

---

## 2. Fake-adapter end-to-end lifecycle

| Scenario | Test file | Result |
| --- | --- | --- |
| Full lifecycle slice (draft → snapshot → prepare → send → status → artifact) | `apps/api/test/esignature-flow.test.ts` | 3/3 passed |
| DocuSign adapter contract, OAuth, templates, webhook, status mapper | `apps/api/test/esignature-docusign.test.ts` | 32/32 passed |
| Domain state machine and audit redaction | `apps/api/test/esignature-domain.test.ts` | 34/34 passed |
| Provider contract, registry, idempotency | `apps/api/test/esignature-provider.test.ts` | 28/28 passed |
| Controlled send and ambiguous outcome recovery | `apps/api/test/esignature-send.test.ts` | passed |
| Webhook intake and projection | `apps/api/test/esignature-webhook*.test.ts` | passed |
| Approval workflow | `apps/api/test/esignature-approvals.test.ts`, `esignature-approval-policy.test.ts` | passed |
| Reporting and dashlets | `apps/api/test/esignature-reporting.test.ts` | 12/12 passed |
| Operations and recovery workbench | `apps/api/test/esignature-operations.test.ts` | 8/8 passed |
| All ESignature suites | `apps/api/test/esignature*.test.ts` | 317/317 passed in 20 suites |

---

## 3. Live demo-account smoke test (operator step, not run here)

The following must be executed against a DocuSign developer/demo account with synthetic documents and
signers before an installation is called verified. Record the date and outcome in
`docs/compatibility/esignature.md` §7 when performed.

1. Create a named connection (Demo environment), complete OAuth, verify account id, user and
   account-specific base URI.
2. Refresh the template catalog and configure one template-role mapping.
3. Create a draft request from a synthetic source record, attach a synthetic document, configure one
   signer, review the preview and prepare.
4. Send the envelope to a synthetic signer; confirm a single envelope exists in DocuSign.
5. Deliver a Connect event (or run reconciliation) and confirm the local status projects to `sent`,
   then `completed` only after a verified event.
6. Retrieve the completed document and completion certificate; confirm they are stored as new
   derived artifacts and the source document is unchanged.
7. Verify embedded signing (if enabled) with an allowlisted return host.
8. Verify resend, void and the refused-by-name correction path.

No automated test in the repository sends a real signing invitation or uses a production account.

---

## 4. OpenAPI, migrations, registration, permissions, translations

- OpenAPI definitions are generated from the controllers' `@ApiTags`/DTO shapes and served at
  `GET /api/v1/OpenApi`.
- Migrations `064_phase19_esignature.sql` and `065_phase19_esignature_oauth.sql` (plus additive
  `066`–`068`) are version-controlled and backwards-compatible; no destructive change was applied.
- Module registration uses the existing barrel + two-spread pattern; `ESignatureModule` loads at
  order 396.
- Permissions are defined through the synthetic ACL resource pattern; list/detail/send/approve/
  void/correct/download/connection administration are gated.
- Translations exist for `en` and `vi` under `i18n/{en,vi}/esignature.json`.

---

## 5. Clean deployment verification

- `pnpm typecheck` — passed (API + web).
- `pnpm lint` — passed for the changed files.
- `pnpm --filter @carocrm/web build` — passed.
- `pnpm db:migrate` — migrations applied to the configured primary database; no extra database,
  schema, container or copy was created.
- No `.env` secrets, generated build output or test artifacts are committed.

---

## 6. Known limitations (release)

- Live DocuSign demo-account smoke test is not executed in this environment (no credentials).
- Correction remains capability-false until live behaviour is verified.
- JWT grant is out of scope for the first release.
- Scheduled reconciliation/inbox sweeping is not registered by default; operators use the workbench.
- Qualified electronic signature status, jurisdictional compliance and legal enforceability are
  explicitly out of scope; DocuSign remains the signing authority.

---

## 7. Release decision

The module is released as **DocuSign-first, fake-adapter-verified, production-disabled by default**.
An administrator must explicitly configure and enable a production connection before any real
envelope can be sent. This matches `PLAN_Phase_19_ESignature.md` §19 and §22.
