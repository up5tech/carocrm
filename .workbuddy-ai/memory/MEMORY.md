# Project memory — carocrmv2

Curated, long-lived notes. Daily logs live next to this file as `YYYY-MM-DD.md`.

## Module naming

- Phase-19 domain modules use **plain names**, not `Ua*` prefixes. The Sales module is `sales`
  (directory `apps/api/src/sales`, API prefix `/api/v1/Sales`, settings row `sales`), matching how
  Projects is `projects` / `/api/v1/Project`. `Ua*` names in `PLAN.md` (`UaProjects`,
  `UaWorkflows`, …) are legacy/aspirational and are not followed by the implementation.
- Consequence for any extension work: never introduce a `Ua`-prefixed module id, API prefix, class
  name, settings row or translation namespace.
- References *to other modules* may keep their own ids (`ua-stripe-integration`,
  `ua-accounting-integration`, `ua-customer-success`, `ua-projects` in
  `apps/api/src/sales/sales-module.ts` `OPTIONAL_INTEGRATIONS`).

## Repo conventions worth remembering

- Domain modules are kernel directories under `apps/api/src/<domain>` with a barrel exporting
  `<DOMAIN>_CONTROLLERS` / `<DOMAIN>_PROVIDERS`, spread into `AppModule` **before** the generic
  `:entity` wildcard controller.
- Records are metadata entities in `entity_records` (seed in `database/seed-metadata.ts`); the module
  adds only cross-record rules, registered on the `beforeValidate` hook so generic CRUD is validated
  identically to domain commands.
- Migrations: `database/migrations/<NNN>_phase<NN>_<slug>.sql`, additive only, applied in filename
  order inside one transaction each, tracked in `schema_migrations`.
- Money is a canonical decimal string at every boundary; `apps/api/src/sales/money/decimal.ts` is the
  module's decimal engine (the kernel has no currency registry or exchange-rate facility).
- Docs for a module go in `docs/modules/<module>/`; audits in `docs/implementation/`.

## Kernel `document` module

- Two halves: pure package `packages/document` (`@carocrm/document` — template engine, block model →
  text, optional pdfkit adapter, no database/NestJS) + thin API layer `apps/api/src/document`
  (`DocumentTemplate` entity + service + controller). 19-S.7 now uses it end to end:
  `apps/api/src/sales/document/quote-document.ts` builds a quote's blocks from the engine's own totals,
  and `quote-send.service.ts` renders them through `DocumentTemplateService`.
- Unresolved placeholders are **left in place and reported in `warnings`**, never blanked. One default
  template per entity type; a new default clears the old one. `document/action/preview` is admin-only.
- Metadata `acl.fieldPermissions` is **declarative only**: the ACL evaluator reads the role row's own
  `field_permissions`. A field-level deny is real only once it is set on a role.
- **Rendering through this module needs `DocumentTemplate: read`.** That is the kernel's own ACL check
  inside `DocumentTemplateService`, so a role that sends quotes must be granted it; the seeded
  metadata default (`read: 'all'`) is declarative only.

## Sales quote render/send (19-S.7)

- `POST /api/v1/Sales/quote/:id/render` and `…/:id/send` (both on the `SalesController`). Rendering is
  read-only; sending issues the draft and then creates + queues an `Email` linked by
  `parentType`/`parentId` through the existing `EmailService.queueSend` (which owns validation, the
  per-recipient ledger and the `system.sendEmail` job). The API never opens a socket.
- **Every gate runs before issuance** — `Email: create`/`edit` are pre-checked with `AclApiService`
  precisely so a refused caller cannot leave a `sent` quote with no email behind it. A re-send of a
  `sent` quote returns `issued: false` and records a *new* email rather than changing the document.
- An issued quote renders from its frozen snapshot (`issuedData`), never from the live catalog.
- A PDF **attachment** is still not produced: the blocks and the optional pdfkit adapter exist, but
  writing the PDF into an outbound message needs the attachment-storage path.

## Test seams for mail- and queue-touching suites

- Any suite that exercises a send must set `MAIL_TRANSPORT=memory` **and** `SMTP_FROM=<addr>` before
  `bootApi()` (config is read once at boot) and restore both in `afterAll` — without a From address
  `EmailService.queueSend` (correctly) refuses the message. `process.env` leaks between suites because
  the root vitest config runs `singleFork: true`.
- Stub the BullMQ hop on the instance: `ctx.app.get(JobsService).enqueue = async (i) => ({ id: 'x',
  job: i.job, status: 'pending' }) as unknown as JobView`. Assert the durable side effects, not the
  queue hop.

## Build / test pre-flight

- Workspace packages resolve through `dist/` (`exports` → `dist/index.js`, no vitest/tsc alias), so
  after adding or changing a package run `pnpm install` (updates `pnpm-lock.yaml` importers) then
  `pnpm build` before `pnpm typecheck` or any `apps/api` test. Pure suites under
  `packages/*/src/**` run without the build; API suites do not.

## Environment notes

- Some sessions in this repo expose **no shell**: no `git`, no `pnpm typecheck`, no `vitest`, and no
  way to rename or delete files. When that happens, write the content changes, and record the exact
  commands the user must run instead of claiming verification.
