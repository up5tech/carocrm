# Changelog

All notable changes to CaroCRM are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project does not promise SemVer
compatibility for its internal APIs while it is in alpha.

## Versioning and tagging convention

- `package.json` `version` is the product version for the whole pnpm workspace. It is currently
  **1.0.0**, the in-development version — there is no tagged release yet.
- A release is a git tag `vX.Y.Z` plus a dated note in `docs/releases/` and a row in the table
  below. Pre-releases use `-alpha.N` / `-rc.N` suffixes.
- Database migrations are forward-only and numbered (`database/migrations/`); a release note names
  the migrations an operator must apply.
- **Release status:** 1.0.0 is an **alpha**. The Phase 23 security review
  (`docs/quality/phase-23-security-release-review.md`) and the Phase 24 product-completion plan
  (`plans/PLAN_Phase_24_Product_Completion.md`) record **NO-GO for production** until the open
  blockers in `docs/quality/known-gaps.md` and `docs/security/exception-register.md` close or are
  owner-accepted.

## [Unreleased] — Phase 24 and Phase 25 in progress

### Phase 25 — AI capability parity (in progress, not a release)

Documentation came first; 25.2–25.6 added code changes in this phase. Phase 25 produces
**alpha/pilot evidence only** while the Phase 24.12 production gate stays open; it is not a second
production go/no-go.

- **25.0** Read-only parity baseline and owner defaults D1–D7:
  `docs/quality/phase-25-ai-parity-baseline.md` and
  `docs/quality/phase-25-priority-decisions.md`; gap G99 filed.
- **25.1** One canonical AI claim source (`docs/architecture/ai-capability-matrix.md`), Twenty
  alpha/beta caveats and explicit skips, corrected tool counts (`MAX_TOOLS = 32`; registry 25,
  24 Chat-facing), trigger wording (implemented, feature-gated and default off) and CRM Chat contract
  status (v1.3.0, 27 routes). `plans/SPEC.md`, the compatibility matrix, alpha status, README and this
  changelog were reconciled. No code, migration, database row or provider account changed.
- **25.2** Published agent versions now carry `config.principal.mode`: `requesting_user` (default for
  manual, CRM Chat and the workflow AI action) or `publisher` (automated triggers only, and
  only when the door already runs as the agent owner). Service identities are refused; every run event
  stamps the effective principal and pinned version; revoked principals fail closed. The 11-capability
  least-privilege ACL profile is documented in `docs/architecture/ai-capability-matrix.md` §5. No
  migration or schema change — the rule rides in the existing version-config JSONB.
- **25.3** Provider capability parity without a second AI SDK: capability rows are derived from
  registered adapter objects and published in `AIAgents/action/health` under
  `providers.capabilityTable`; presets inherit their transport's row and are labelled
  adapter-contract, local-compatible-seam (Gemini) or not-verified. Anthropic `json_schema` requests
  now use a bounded host-defined extraction tool inside the adapter instead of being refused; the
  reserved tool name cannot be granted, prose fails closed, and `validateBoundedJsonSchema()` remains
  the schema authority. No dependency, migration, native adapter or live vendor call.
- **25.4** Reusable, versioned **non-executable** skills: additive migration 098 creates
  `ai_agent_skills` (stable key, version, draft/published/archived, visibility, owner, bounded text —
  no script field). A new `skillAdmin` capability (`AIAgentSkill` edit) guards CRUD/publish/archive;
  reading uses `use` plus row visibility. Published agent versions pin exact `(key, version)` pairs,
  refuse draft/invisible bindings and an over-ceiling composed prompt, place skill text below the
  operating rules, and record `skill.applied` in the run timeline. The AIAgents page gains a Skills
  tab and the agent editor a published-version picker. Module version is now 1.5.0. No code
  execution surface, new SDK, live call or destructive migration.
- **25.5** One bounded workflow AI action: `runAgent` starts a pinned published agent through the
  existing DB-free workflow executor and worker port. The API's shared-secret door (`POST
  /api/v1/AIAgents/action/worker/workflow/run`) re-checks the published version, `triggers.workflow`,
  pinned skill keys, approval expectation, the 25.2 principal and bounded JSON output before applying
  mapped primitive fields. Long runs park the workflow with the step still `running`; the agent engine
  queues a deterministic `workflow.resume` job when the run settles. Runs carry `trigger = 'workflow'`
  and a workflow causation id (additive migration 099); no system agent, code execution, shell/SQL
  interpolation, new SDK or new MCP surface. AIAgents module version is now 1.6.0.
- **25.6** Trigger parity: published agents can bound an `entity.updated` watch list to
  `triggers.watchedFields` and one sandboxed `triggers.condition` evaluated by `@carocrm/formula`.
  Current values read as `field('name')` and previous values as `field('__previous_name')`; only
  watched fields are readable, and no new expression language is introduced. The committed entity
  event now carries a bounded before/after snapshot of changed scalar fields, and the shared-secret
  trigger door applies all filters before fan-out, so unchanged fields, false conditions and
  create/delete/restore events become quiet skips. The existing five-start cap, recursion guard and
  `evt:<eventId>:<agentId>` idempotency key are unchanged; cron equivalence and its process-timezone
  gap are documented in the canonical matrix. No migration. AIAgents module version is now 1.7.0.
  Automated checks are assigned to the developer by `AGENTS.MD` §4.

Not shipped by 25.6: assignable agent roles, code-defined agents, attachments
(25.7), web grounding (25.8), chat page context (25.9), installation cost view (25.10) and the golden
evaluation gate (25.11).

### Phase 24

Single-tenant product completion (`plans/PLAN_Phase_24_Product_Completion.md`). Delivered so far:

- **24.0** Baseline audit and owner decisions D1–D7:
  `docs/quality/phase-24-priority-decisions.md`.
- **24.1** Single-tenant charter ratified (`docs/reference/product-charter.md`); PLAN.md, README,
  alpha-status, compatibility matrix, tenancy decision and exception register reconciled; the unused
  `tenantId`/`getTenantId` surface removed.
- **24.2** NO-GO blocker records prepared: G1/D3 disposition recorded, G80/G81 read-only
  verification, owner signature table — all signatures still pending, release stays NO-GO.
- **24.3** Production installation artifacts: multi-stage `docker/production.Dockerfile`
  (API / migrate / worker / SPA), `docker-compose.production.yml`, least-privilege Postgres role
  provisioning, production install smoke script, and
  `docs/runbooks/installation-and-upgrade.md`. Artifact builds validated; no deployment has been
  exercised.
- **24.5** Release truthfulness: this changelog, the Phase 24 release note, corrected
  README migration count and quick-start pointer, known-gaps summary reconciliation, Phase 23 plan
  status correction.
- **24.6** Real inbound mail: an IMAP and a Microsoft Graph adapter behind the
  `InboundMailProvider` port (plus a filesystem fixture provider for tests), bound by
  `MAIL_INBOUND_PROVIDER` — the default stays `none` and fails clearly. `POST
  /api/v1/Email/action/pollInbound` ingests a mailbox into `Email` records exactly once per
  message and per connection (scoped dedupe, independent cursors, idempotent across restarts),
  stores attachments through the attachment ACL/malware path, and classifies bounce/auto-reply
  messages so they never trigger an outbound effect. Mailboxes are administered at installation
  level under `EmailAccount/action/inbound-connections`; the credential is write-only and encrypted
  with `ENCRYPTION_KEY`. Operator guide: `docs/runbooks/inbound-mail.md`.
- **24.7** Installation-wide email and calendar sync: the bounded scope chosen in owner decision D5
  is delivered. Inbound mail collection (IMAP + Microsoft Graph) is wrapped in the installation-wide
  connection layer — personal or shared mailboxes, each with its own owner, credential scope, cursor
  and ACL; inbound calendar events are collected through the sync engine (Google Calendar full +
  incremental via `syncToken` with all-day events anchored at the event's own zone and private
  events opt-in, Microsoft 365 Graph delta links plus the delivered webhook path); inbound records
  are written under the connection owner's authority (personal connections) or the caller's (shared);
  checkpoints are per connection/mapping/direction and advance only past committed pages, with a
  controlled full re-sync on an expired provider cursor. Runbook: `docs/runbooks/inbound-sync.md`.
  Migration `096_phase24_7_sync_metadata.sql`. Not exercised against a live mailbox or calendar.

Still open: `api-spec/` registry completion to `--strict` and the typed client (24.4, in flight),
outbound events/webhooks (24.8), provider sandbox certification (24.9 — inventory and sandbox plans
recorded in `docs/quality/phase-24-9-sandbox-certification.md`, live certification pending), UX
completion (24.10 — gap inventory recorded in `docs/quality/phase-24-10-ux-completion.md`, implementation
pending), quality debt (24.11 — inventory and task status recorded in `docs/quality/phase-24-11-quality-debt-scale.md`,
implementation pending), final go/no-go (24.12 — release review recorded in `docs/quality/phase-24-12-release-review.md`, decision pending).

## [1.0.0-alpha] — 2026-11-13 — Phase 23 security hardening

Full note: [`docs/releases/2026-11-13-phase-23.md`](docs/releases/2026-11-13-phase-23.md).
Release decision: **NO-GO for production** (`docs/quality/phase-23-security-release-review.md`).

- Authentication: login throttling + per-account lockout, self-service password reset, enforceable
  MFA policy, session listing/revocation with refresh-family reuse detection, API-key rotation with
  scopes and IP/CIDR restrictions, generic OIDC sign-in as configuration (`OIDC_PROFILES`).
- Authorization: async work re-derives its principal (`runAsUser`), every explicit 403 writes a
  redacted audit row, attachment reads require parent ACL, CSV export blanks read-denied columns and
  neutralises formula-leading values.
- Untrusted input: one shared SSRF classifier, marketing webhook HMAC-SHA256 over
  `timestamp.rawBody`, Ed25519 extension package signatures (`EXTENSION_TRUST_MODE=enforce` in
  production), real PDF/ZIP/Office magic-byte validation.
- Operations: retention schedules for receipts/jobs/stream orphans (migration 094), deep-redacted
  job views, bounded process-local security counters, production boot guards that refuse placeholder
  secrets and the dev database fallback.
- Migrations `089`–`094`, all additive. **Release remains NO-GO**: G80/G81 backup/restore blocked,
  no `LICENSE`/distribution decision, High/Critical exceptions unsigned.

## [1.0.0-alpha] — 2026-10-29 — Phase 22 integration & E2E hardening

Full note: [`docs/releases/2026-10-29-phase-22.md`](docs/releases/2026-10-29-phase-22.md).
Release decision at the time: **NO-GO for production** (superseded by the Phase 23 review above,
which keeps the same blockers open).

Earlier history: Phases 1–21 are documented per module in `docs/implementation/`,
`docs/compatibility/` and `docs/reference/alpha-status.md`; module-level release notes live beside
their modules (e.g. `docs/modules/crm-chat/RELEASE_NOTES.md`).
