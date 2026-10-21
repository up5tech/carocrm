---
title: Quotes and orders
summary: The Sales document flow — draft a quote or order, price its lines, issue it, render it and send it, and what the module actually ships.
audience: user
order: 80
tags: [sales, quote, order, invoice, document, pricing]
related: [user/record-page, user/lists-and-views, admin/entities-and-fields, admin/settings-overview]
updated: 2026-10-21
---

Sales turns a deal into documents. A quote is the offer; a sales order is the accepted one. The same
machine drives invoices and the rest. There is no dedicated Sales workspace: a document is an ordinary
record you read and edit on the [record page](user/record-page), pointing at an [account](/Account) and a
[contact](/Contact). The header is the generic form; the money lives in the lines, and the lines and the
document's own buttons come from the server, not from the record type's fields.

## What actually exists

Ten commercial document kinds share one engine: **Quote**, **Sales Order**, **Invoice**, **Credit Note**,
**Delivery Order**, **Return Order** on the selling side, and **Purchase Order**, **Receipt Order**,
**Bill**, **Bill Credit** on the purchasing side. Each kind owns its own states and transitions; they do
not share a single status list.

> [!NOTE]
> The purchasing kinds are gated behind the `purchases` switch in Sales settings, which is off by default,
> and their numbers only move once inventory is configured. This page is about the selling documents.

Supporting records — products and categories, price books and price rules, tax classes and rates,
suppliers, payments, subscriptions — are also part of Sales. Subscriptions and multi-currency are
switches too and start off.

## Drafting and pricing the lines

You create a document from its record create screen (`/Quote/create`, `/SalesOrder/create`, and so on),
or from an Opportunity, which seeds the account and contact for you. A document needs at least one line,
and every line needs a price:

- pick a product from the catalog, or type a custom line with its own name,
- set the quantity and the unit price; the price is resolved from the catalog or the document's price
  book as of the document's own date,
- the subtotal, discount, tax and total you see are computed by the server, never summed in the browser.

> [!WARNING]
> A line with no price cannot be saved. The totals engine refuses it, and the Save button stays disabled
> with a reason until every named line has a price. A missing price is never treated as zero.

## Issuing

Issuing is the one click that cannot be taken back. It validates and recalculates the document, freezes a
snapshot of the parties, lines, tax and rates, allocates the official number from the kind's series,
records who issued it and when, and locks the commercial fields. The number is allocated at issuance, so
an abandoned draft never consumes one. Quotes are numbered `Q-000001`, sales orders `SO-000001`.

For a quote, issuing is the **Send** transition. For a sales order it is **Confirm**. Once issued, the
document is read-only: the supported corrections are a credit note, a new document, or a privileged
**Unlock** that asks for a reason and is audited.

## Quotes

A quote moves through `draft → sent → accepted / rejected / expired → converted`, with a `cancelled`
branch. On a sent quote the buttons the server offers are **Accept**, **Reject**, **Expire** and
**Cancel**. Sending a draft quote is what issues it.

When a quote is accepted you can **Convert to sales order**, or **Create invoice** directly. You can do
one, not both — invoicing a quote that already produced an order would bill the same acceptance twice.

## Orders

A confirmed order moves through `draft → confirmed → partiallyFulfilled / fulfilled`, with a `cancelled`
branch. From a confirmed order you **Create invoice**, **Create delivery order**, or **Create return
order**. A return is bounded by what was actually delivered, not by what was ordered. A fulfilled order
does not rewind.

## Rendering and sending

The **Send** button opens one modal for every document kind. It shows the server's render of the document
— a chosen `DocumentTemplate`, or the built-in block layout when none is configured — and you pick
recipients and add a cover note:

- recipients may be left blank; the address is derived from the contact, then the account, and the send
  is refused only when there is genuinely nobody to mail,
- a mail transport must be configured, checked **before** the document is issued, so a document is never
  marked sent with no email behind it,
- the **Attach PDF** switch needs the optional `pdfkit` dependency; it is refused before issuing when that
  dependency is not installed,
- sending is handed to the mail module and queued to a worker, so the request itself does not hold an SMTP
  connection.

> [!NOTE]
> A sent document renders from its frozen snapshot, not from the live catalog. A renamed customer or a
> repriced product cannot rewrite a quote that has already gone out.

## Where to go next

- [Record page](user/record-page) — how the header and the line panel sit on a document.
- [Lists and views](user/lists-and-views) — filtering the documents by stage and date.
- [Entities, fields and layouts](admin/entities-and-fields) — why a field may be missing from the form.
- [Settings overview](admin/settings-overview) — the Sales switches that turn purchasing and subscriptions on.
