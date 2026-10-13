# project-domain

A sample extension package (Phase 14 acceptance) that adds a derived view and three fields to the
**core** `Project` entity shipped by Phase 19 (Projects).

It is deliberately *not* the Projects module: the entities, boards, stages, roles, groups, tasks,
dependencies, clone and the three views belong to `apps/api/src/projects` and
`docs/modules/projects/README.md`. What this package demonstrates is the extension SDK path —
metadata merged onto an existing entity, one custom controller, and the dependency between two
installed packages.

## What it contributes

| Contribution | Where |
|---|---|
| `budget`, `progress` on the core `Project` entity | `metadata/entities.json` |
| `isOverdue` sandboxed formula field (PLAN §22), computed from `dateEnd` | `metadata/entities.json` |
| an additive index declaration (`idx_project_progress`), merged not replacing | `metadata/entities.json` |
| `GET /api/v1/Project/:id/summary` | `src/project.controller.ts` |
| dependency on `webhook-integration` (load order + uninstall guard) | `manifest.json` |

Because `Project` is a metadata entity of the platform, it already has list/detail/edit screens,
record-level ACL, field permissions, audit history, stream items, attachments and relations; the
package contributes only the derived `summary` view on top.

## Why there is no navigation entry

`Project` is a core entity since Phase 19, so the SPA already navigates to it from the metadata
Records menu. A second "Projects" entry from this package would be a duplicate, and the Phase 19
detail page links its own Plan/Board/Gantt views.

## Install

```bash
# dependencies are checked first: install webhook-integration before this package
curl -X POST /api/v1/Extension/action/install ... -d '{"id":"project-domain"}'
```

Uninstalling `webhook-integration` is refused while `project-domain` is installed, with a message
naming the dependent. Uninstalling *this* package removes only its fields: `Project` itself and its
Phase 19 fields stay, which is what `apps/api/test/extensions.test.ts` asserts.

## Building

```bash
pnpm --filter @carocrm-ext/project-domain build   # emits dist/index.js
# then set manifest.json -> backend.entry = "dist/index.js"
```

Development (`tsx`) and the test suite load `src/index.ts` as the manifest declares.
