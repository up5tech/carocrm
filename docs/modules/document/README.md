# Document module

The kernel-owned way a record becomes a document. Implemented as a pure package
(`packages/document`, published as `@carocrm/document`) plus a thin API layer
(`apps/api/src/document`), with metadata in `database/seed-metadata.ts`.

**Status: kernel module only.** It renders a template and lays out the result; it does **not** decide
what a quote or an invoice contains, and it does not send anything. The commercial modules build blocks
from their own frozen snapshot and hand them here. The Sales module is the first consumer — its
"print/email a document" command (19-S.7) is the reason this module exists.

## What it gives a user

| Capability | Where |
|---|---|
| Named, per-entity-type document templates (subject + body), listable and editable like any record | `/DocumentTemplate` (generic metadata-driven UI) |
| Which template a command picks when the caller names none | `GET /api/v1/document/defaultTemplate?entityType=…` |
| A render preview of a template against caller-supplied data | `POST /api/v1/document/action/preview` (administrator only) |
| ACL, audit, stream, import/export and field-level protection for templates | inherited from the kernel, no module code |

## Module layout

```text
packages/document/                 pure, no database, no NestJS — shared by the API and the worker
  src/template.ts                  the template engine: `{{ }}`, `{{{ }}}`, `{{#each }}`
  src/layout.ts                    the block model (heading/paragraph/keyValue/table/spacer) → text
  src/pdf.ts                       the optional pdfkit adapter (dynamic import, never a hard dependency)
  src/index.ts                     barrel

apps/api/src/document/
  document-template.service.ts     DocumentTemplate records, the one-default rule, render
  document.controller.ts           `/api/v1/DocumentTemplate` + `/api/v1/document/*`
  dto/document-shapes.ts           Zod request shapes (every schema `.strict()`)
  index.ts                         DOCUMENT_CONTROLLERS / DOCUMENT_PROVIDERS
```

`DOCUMENT_CONTROLLERS` is registered **before** the generic `:entity` controller in `app.module.ts`,
so `/api/v1/document/action/preview` can never be read as a template id.

## Template syntax

Deliberately tiny, so the same template and the same data always produce the same output:

| Token | Meaning |
|---|---|
| `{{ path.to.value }}` | substituted, HTML-escaped |
| `{{{ path.to.value }}}` | substituted raw (for HTML the template itself produces) |
| `{{#each lines}}…{{/each}}` | repeat the block for each element of the array at `lines` |

Inside an `#each` block a name resolves against the current element first, then against the root data —
`{{name}}` means the product name inside a line and the document name outside it. Nesting is capped at 8
levels and 2 000 items per block; a body is capped at 200 000 characters.

**Escaping applies to the substituted value, not to the template text.** A template is markup somebody
typed on purpose, so `<b>` in a body stays `<b>`; the untrusted half of the output is the record value,
and that is what becomes `Acme &amp; Sons`. A value that is not a scalar — an array, an object, a
non-finite number — is refused the same way an unknown name is: left in place, with a warning naming
what it was.

**An unresolved placeholder is left in place and reported in `warnings`** — never silently blanked. A
document that says `{{contactName}}` is a bug somebody notices; a document that says "Dear ," is one
nobody does. A subject line that cannot be resolved is dropped (an empty subject beats `Quote
{{missing}}`) and reported.

## The block model, and why not HTML

A document is a list of blocks (`heading`, `paragraph`, `keyValue`, `table`, `spacer`), not raw HTML:

* it renders to plain text with **no dependency at all** — which is what an email body needs;
* it renders to PDF by walking the blocks — **no CSS engine, no Chromium** in either process;
* it is a pure function, so a test can assert on a document without producing a binary.

What a commercial document contains is decided by the module that owns it, from its own frozen
snapshot. The kernel knows about tables and key/value pairs, and nothing about quotes or invoices.

## PDF

`pdfkit` is an **optional** dependency (`optionalDependencies`, loaded by dynamic import). An
installation without it still boots, still renders templates and still sends documents — only the
"attach a PDF" path is unavailable, and `pdfAvailable()` says so instead of throwing. Install it with
`pnpm add pdfkit -F @carocrm/document` when PDF attachments are wanted.

## Behaviour guarantees worth knowing

* **Render from a frozen snapshot, never from the live catalog.** A quote re-rendered a month after it
  was sent must show the prices that were sent, so the caller hands in a view built from a snapshot and
  this module only fills placeholders.
* **One default per entity type.** Marking a second template as default clears the previous one, so
  "the default" is never ambiguous. When none is marked, the first active template wins.
* **A preview is an administrative act.** Rendering arbitrary data produces HTML, so
  `document/action/preview` requires an administrator.
* **The template body is template source.** The metadata declares `fieldPermissions.DocumentTemplate.body
  = 'no'` as the contract; a deployment that wants a role to read templates but not their source sets
  that deny in the role row's own `field_permissions` (the ACL evaluator reads the role, not the
  metadata — PLAN §8).
* **Rendering is not sending.** Sending is the mail module's job; this module produces what gets sent.
