# account-health-fields

A metadata-only extension package (PLAN §38, Phase 14). It exists to prove that a field package
needs **no** code in the core application: it is a directory with a manifest and a metadata document.

## What it contributes

| Contribution | Where |
|---|---|
| `Account.healthTier` (enum), `Account.renewalDate` (date) | `metadata/entities.json` |
| `Account.healthScore` (sandboxed `formula` field, PLAN §22) | `metadata/entities.json` |
| Detail and edit layouts with a "Customer health" panel | `metadata/entities.json` |
| `idx_account_health_tier` index *declaration* (metadata only, no DDL) | `metadata/entities.json` |
| `setup()` lifecycle log | `src/index.ts` |

The fields immediately get the generic create/read/update API, ACL, validation, audit, search,
import/export and the Entity Manager UI, because those all read metadata rather than a hard-coded
field list.

## Install

```bash
# EXTENSIONS_DIR must contain this directory
curl -X POST /api/v1/Extension/action/install \
     -H "Authorization: Bearer $TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"id":"account-health-fields"}'
# restart the API and the worker so the package is picked up (PLAN §38.3)
```

`GET /api/v1/Extension` shows the package, what it contributes and whether it is running.

## Notes

- The manifest sets `backend.worker = false`: the worker never imports `src/index.ts`.
- The formula field is evaluated by `@carocrm/formula` on every write through `RecordLogicService`;
  it is not editable by clients.
- The index declaration is metadata only. Creating a physical index is a reviewed migration
  (AGENTS.md §3.5), never something a browser request triggers.

## Building

The manifest points at `src/index.ts`, which `tsx` (dev) and the test runner load directly. A
compiled deployment runs `node dist/main.js` and needs JavaScript:

```bash
pnpm --filter @carocrm-ext/account-health-fields build   # emits dist/index.js
# then set manifest.json -> backend.entry = "dist/index.js"
```
