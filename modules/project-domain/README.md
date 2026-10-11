# project-domain

A custom CRM domain module shipped as an extension package (Phase 14 acceptance).

## What it contributes

| Contribution | Where |
|---|---|
| `Project` entity: fields, relations, layouts, ACL defaults | `metadata/entities.json` |
| `isOverdue` sandboxed formula field (PLAN §22) | `metadata/entities.json` |
| "Projects" navigation entry | `manifest.json` → `frontend.nav` |
| `GET /api/v1/Project/:id/summary` | `src/project.controller.ts` |
| Dependency on `webhook-integration` (load order + uninstall guard) | `manifest.json` |

Because `Project` is an ordinary metadata entity, it immediately gets:

- `GET/POST/PUT/DELETE /api/v1/Project` with record-level ACL (`own`/`team`/`all` levels),
- field-level permissions, validation, audit history, stream items, attachments and relations,
- the generic list/detail/edit SPA screens, and the Entity Manager admin UI.

## The one custom endpoint

`GET /api/v1/Project/:id/summary` returns a derived view (status, due date, progress, ownership).
It asks the host's ACL evaluator (`EXTENSION_ACL`) before reading and never queries more than the
one record, so it cannot become a side door around record-level ACL.

## Install

```bash
# dependencies are checked first: install webhook-integration before this package
curl -X POST /api/v1/Extension/action/install ... -d '{"id":"project-domain"}'
```

Uninstalling `webhook-integration` is refused while `project-domain` is installed, with a message
naming the dependent.

## Building

```bash
pnpm --filter @carocrm-ext/project-domain build   # emits dist/index.js
# then set manifest.json -> backend.entry = "dist/index.js"
```

Development (`tsx`) and the test suite load `src/index.ts` as the manifest declares.
