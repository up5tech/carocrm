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

## Environment notes

- Some sessions in this repo expose **no shell**: no `git`, no `pnpm typecheck`, no `vitest`, and no
  way to rename or delete files. When that happens, write the content changes, and record the exact
  commands the user must run instead of claiming verification.
