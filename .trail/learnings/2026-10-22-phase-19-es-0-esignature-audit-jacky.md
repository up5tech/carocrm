---
title: "Phase 19-ES.0 ESignature audit: reuse map and data-model decision"
author: Jacky
date: 2026-10-22
branch: master
touches:
  - apps/api/src/email/index.ts
  - apps/web/src/AppRoutes.tsx
  - apps/web/src/api/client.ts
  - apps/web/src/api/types.ts
  - apps/web/src/styles/carocrm.css
  - content/docs/en/user/activities-and-tasks.md
  - i18n/en/web.json
  - i18n/vi/web.json
  - PLAN_Phase_19_ESignature.md
  - apps/api/src/email/email-template-preview.service.ts
---

## Decided
- Phase 19-ES.0 (ESignature audit) delivered as docs only: `docs/implementation/esignature-audit.md` + `docs/compatibility/esignature.md`. No code/migration/seed changes.
- ESignature data model: dedicated relational tables (esignature_connections, signature_requests, signature_recipients, signature_document_snapshots, signature_provider_events, signature_webhook_inbox, signature_template_mappings, signature_audit_entries) — NOT entity_records metadata entities. Rationale copied from migration 056: the request state machine / send guard must be the only mutation path; generic PATCH /api/v1/:entity would bypass it. Secrets only via credential-vault + ENCRYPTION_KEY.
- Reuse map: OAuthFlowService skeleton (state/PKCE/advisory-lock refresh), credential-vault, provider-http-client + resilience.ts, webhook inbox pattern (marketing_provider_webhook_inbox / integration_webhook_deliveries), AttachmentService.download ACL + packages/files SHA-256 checksums, sales/document/snapshot.ts canonical-JSON digest envelope for the immutable send snapshot, JobsService + scheduled_jobs seed + x-worker-secret worker handlers, EventBus.dispatch(tx,...) outbox.
- DocuSign verified 2026-10-22: eSign REST v2.1, npm docusign-esign 10.1.0 (MIT, Node 12+), OAuth hosts account-d/account.docusign.com, base URI from /oauth/userinfo accounts[].base_uri → {base_uri}/restapi/v2.1/accounts/{id}/. Default grant: confidential authorization code; JWT non-default.

## Tried and ruled out
- Putting SignatureRequest in entity_records as a metadata entity — ruled out (state-machine bypass via generic PATCH; relational dedup/uniqueness constraints needed).

## Watch out
- The raw-body preParsing hook in apps/api/src/bootstrap.ts:141-165 is prefix-scoped to /api/v1/integrations/advanced-integrations — ES.11 must extend it to the ESignature webhook path or Connect HMAC verification will silently have no raw body.
- last_successful_sync_at on integration_connections is never written by any code (read-only gap) — don't copy that pattern for connection health.
- No generic Idempotency-Key middleware exists; send idempotency must be built via sendAttemptId + version check.
