# Knowledge Base

## Records

- **`KnowledgeCategory`** — name, code, optional parent category, sort order, active flag.
- **`KnowledgeArticle`** — title (`name`), slug, summary, body, category, language, status
  (`Draft`, `InReview`, `Published`, `Archived`, `Expired`), `isInternal`, `publishedAt`,
  `expiresAt`, author/reviewer, tags.

Both are ordinary metadata entities in `entity_records`. Regular roles cannot create/edit them
through the record API (metadata ACL `create/edit: no`); administrators manage them through the
generic Entity Manager, and publication/archival use the audited module commands.

## Commands

| Endpoint | Permission | Effect |
|---|---|---|
| `POST /ServiceDesk/action/knowledge/:id/publish` | administrator | sets `Published` and `publishedAt`; audited |
| `POST /ServiceDesk/action/knowledge/:id/archive` | administrator | sets `Archived`; audited |
| `GET /ServiceDesk/action/knowledge/portal` | any authenticated principal | published, non-internal, in-date articles only |
| `GET /ServiceDesk/action/case/:id/knowledgeSuggestions` | caller who can read the case | keyword suggestions from the portal-safe list |

`publish` and `archive` run through `EntityCrudService`, so the field audit records the transition.

## Portal visibility rules

An article is returned only when **all** hold:

1. `status = Published`;
2. `isInternal ≠ true`;
3. `publishedAt` is absent or in the past;
4. `expiresAt` is absent or in the future.

Drafts, in-review, archived and internal articles never appear in portal search or suggestions.
Suggestions use at least four-character subject words against the article title and summary; they are
advisory and never include internal content.

## Expiry

The scheduled SLA pass (`serviceDesk.slaScan`) calls `expireDueArticles`: every `Published` article
whose `expiresAt` has passed becomes `Expired` through the audited entity update. This is idempotent
(only `Published` rows are candidates) and runs even when the SLA feature is off, as long as the
`knowledgeBase` feature is on.

## Limitations

- There is no separate KB editor or preview route in this phase; the generic metadata screens render
  the fields and the existing rich-text/Markdown sanitization applies to `body`.
- Article version history is the generic audit log, not a content-version table.
- "Useful article" feedback is not instrumented.
