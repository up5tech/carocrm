# ESignature module

Canonical module name: `ESignature` (no `Ua` prefix). API prefix: `/api/v1/ESignature`.
Webhook prefix: `/api/v1/integrations/esignature`. Frontend route: `/esignature`.

DocuSign is the first and only provider adapter for the initial release. The module owns signature
workflow records, recipient projections, provider event history, policy, audit and UI; it reuses the
platform's authentication, ACL, file storage, audit, jobs, notifications and settings.

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
