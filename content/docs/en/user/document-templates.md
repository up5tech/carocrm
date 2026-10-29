---
title: Document templates
summary: Design the page a quote or invoice prints on — placeholders, the default template, and what the preview shows.
audience: user
order: 87
tags: [document, template, quote, invoice, placeholders, pdf]
aliases: ["mẫu tài liệu", "thiết kế mẫu báo giá", "mẫu in hóa đơn", "biến thay thế"]
related: [user/sales-quotes, admin/sales, admin/entities-and-fields]
updated: 2026-10-30
---

A document template is the named subject and body a Sales document renders into when it is printed or
emailed. [Quotes and orders](user/sales-quotes) owns the document; this page owns the sheet it prints on.

Open [Document templates](/DocumentTemplate). The list is an ordinary record list — name, code, target
entity, format, locale, default and active — and it appears in the sidebar as **Document Template**.

## What a template decides

- **Target entity** is the document kind the template belongs to, such as Quote, Invoice or Sales Order.
  A template is only offered to that kind.
- **Code** is the stable name a command or a default-template lookup refers to. It is unique.
- **Name**, **subject**, **body**, **format** and **locale** are what the reader sees.
- **Active** decides whether the template can be used at all. An inactive template is not offered by
  the Send modal, and asking the server to render it directly is refused.
- **Default** is the one a send picks when the caller names no template. There is one default per target
  entity; marking a second clears the previous.

When no template is configured for a document kind, the server still renders its built-in block layout,
so a document can always be sent.

## Create a template

Open [Create template](/DocumentTemplate/create). The designer asks for the name, code, target entity,
format (HTML document or Plain text), an optional locale, a subject, the body and the two switches,
**Active** and **Default**.

The body has two editors:

- **Visual design** — a canvas with document blocks (title, facts, paragraph, addresses, line items,
  totals, notes, divider, spacer) for composing the page without writing HTML.
- **HTML** — the source, where the same body is edited as text.

A placeholder palette sits beside both. Clicking a placeholder inserts it at the cursor; line-item
tokens only make sense inside the repeated line block described below. **Preview** opens a drawer with
the server's render, and **Save** stores the record.

After the first save, the **code** and **target entity** are locked — commands and default-template
lookups depend on them. The other fields stay editable.

## Placeholders

The template language is deliberately small:

| Token | What it does |
| --- | --- |
| `{{ field }}` | Substitutes the value, escaped for HTML. |
| `{{{ field }}}` | Substitutes the value raw, for HTML the template itself produces. |
| `{{#each lines}}…{{/each}}` | Repeats the block once per line item. |

Inside an `{{#each lines}}` block a name resolves against the current line first, then against the
document: `{{name}}` is the product name inside the block and the document name outside it. The loop is
capped, and a body has a size ceiling, so a runaway template is refused rather than rendering forever.

An unresolved placeholder is **left in place and reported** in the preview's warnings. It is never
silently blanked: a page that says `{{contactName}}` is a bug somebody notices, while "Dear ," is one
nobody does. An unresolved subject is dropped and reported instead of sending a subject full of braces.

## Preview, default and send

The **Preview** drawer renders against a representative Sales document with two line items, totals and
the usual parties. It uses the same renderer as a real send, so what the drawer shows is what the
document will look like.

> [!NOTE]
> Rendering arbitrary data is an administrative action in this build. A role that may create or edit a
> template but is not an administrator gets a permission refusal from the preview; saving still works, and
> the saved template is rendered for real when the document is sent.

In the Sales **Send** modal you choose a template from the active templates for that document kind, or
leave **Default template** selected. Sending renders from the document's frozen snapshot, so a rename or
a price change after the fact cannot rewrite what was already sent.

## What can go wrong

| Symptom | What it means |
| --- | --- |
| The preview shows a permission refusal | Preview is administrator-only; ask an administrator to check the render. |
| A placeholder appears literally on the preview | The sample data does not resolve that name; the warning names it. |
| The template is missing from the Send modal | It is inactive, or its target entity is a different document kind. |
| Changing the code or target entity is refused | Both are fixed after creation; create a new template instead. |
| The **Source** tab says the source is not readable | Your role is denied the body field; the template details remain readable. |
| **Attach PDF** is refused | The optional `pdfkit` dependency is not installed; the document still renders and sends without a PDF. |

## Where to go next

- [Quotes and orders](user/sales-quotes) — the document flow that uses the template.
- [Configuring Sales](admin/sales) — the commercial switches around numbering, tax and inventory.
- [Entities, fields and layouts](admin/entities-and-fields) — changing the fields a template can name.
