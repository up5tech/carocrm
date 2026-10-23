# ESignature module

Canonical module name: `ESignature` (no `Ua` prefix). API prefix: `/api/v1/ESignature`.
Webhook prefix: `/api/v1/integrations/esignature`. Frontend route: `/esignature`.

The module is **provider-neutral by design**. DocuSign is the reference adapter and the integration
every delivered workflow was built against; a provider catalog lists every provider this build
knows, how each authenticates, and whether its integration is installed. DocuSign is therefore one
of several providers — not the only one the architecture can hold.

- Catalog: `apps/api/src/esignature/providers/signature-provider.catalog.ts`
  (`docusign` is `available`; `dropbox_sign` is `declared`, i.e. cataloged but not installed).
- Authorization per provider: `providers/signature-provider-auth.port.ts` plus one strategy per
  provider (`providers/docusign/docusign-auth.strategy.ts`). Connections, tokens and refresh are
  provider-neutral; OAuth client ids live per provider in `provider.clients.<key>`.
- Envelope operations: `providers/signature-provider.port.ts` and one adapter per provider.
- Admin surface: `GET /api/v1/ESignature/action/provider-catalog` feeds the provider picker; the
  connection row stores the chosen key, and the database allowlist is widened by migration `069`.

A provider is only connectable when it is `available` **and** has an authorization strategy; a
`declared` provider is refused with a stated reason rather than failing later at the first send.
Adding Dropbox Sign (or any other provider) means a descriptor, an auth strategy, an adapter and its
tests; nothing above the adapter boundary changes.

The module owns signature workflow records, recipient projections, provider event history, policy,
audit and UI; it reuses the platform's authentication, ACL, file storage, audit, jobs, notifications
and settings.

## Documents

- Compatibility and provider surface: `docs/compatibility/esignature.md`
- Operations runbook: `docs/runbooks/esignature-operations.md`
- Administrator setup and release: `docs/runbooks/esignature-admin-setup.md`
- Audit and feature contract: `docs/implementation/esignature-audit.md`
- Completion reports: `docs/implementation/esignature-es1-completion-report.md` through
  `esignature-es22-completion-report.md`
- Plan: `PLAN_Phase_19_ESignature.md`

## Status

19-ES.0 through 19-ES.22 delivered. Production disabled by default; live demo-account smoke test is
an operator step recorded in `esignature-es22-completion-report.md`.
