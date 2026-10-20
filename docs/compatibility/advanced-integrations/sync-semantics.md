# Advanced Integrations — sync semantics per provider

> Phase 19-INT.16–19-INT.24 deliverable (`PLAN_Phase_19_Advanced_Integrations.md` §8, §3.3;
> `19-INT.16`–`19-INT.24`).
> Status: **the engine's semantics are delivered; each provider's pagination facts are the
> implementation's pins, not verified observations of a live account.**
> Parent document: `docs/compatibility/advanced-integrations.md`.

## 1. The engine's contract (provider-neutral)

These rules hold for every connector, and they are the platform's, not a vendor's.

| Rule | Where it is implemented |
| --- | --- |
| The cursor is **opaque**. The runtime stores it and hands it back; it never decodes it. | `connectors/kit/connector-kit.ts` — `encodeCursor` / `decodeCursor`. A cursor the connector did not write is refused. |
| The page size is **clamped** by the provider's declared maximum. | The capability declaration's `maxPageSize`; the connector clamps again. |
| A checkpoint advances **only** past a successful, durable operation. | `sync-orchestrator.service.ts` |
| A re-run is **idempotent**: the same external id resolves to the same CRM record. | `external-link.service.ts` — a unique index per `(connection, object type, external id)`. |
| A provider-side delete **unlinks**, it does not hard-delete the CRM record. | The mapping's deletion policy; the default is unlink. |
| An expired cursor is a **controlled resync**, never a mass deletion. | The connector reports `cursorExpired`; the engine drops the cursor and re-runs the full enumeration. Because a delete maps to *unlink*, a resync cannot erase a record that is merely absent from the new snapshot. |
| The same record may not be written by two directions at once. | `record-origin.service.ts` — the origin table prevents an inbound sync from echoing back to the provider. |
| A conflict never overwrites silently. | `conflict.service.ts` — the default `manual` policy opens a conflict instead. |

## 2. The provider facts

### 2.1 Google Workspace

| Object | Full sync | Incremental | Cursor | Expiry |
| --- | --- | --- | --- | --- |
| `calendarEvent` | `GET /calendar/v3/calendars/{id}/events` with `singleEvents=true&showDeleted=true` | The same endpoint with `syncToken` | The connector's opaque cursor carries the calendar index, the page token and the sync token. | An expired `syncToken` produces `410 Gone`; the connector reports `cursorExpired`. |
| `contact` | `GET /people/v1/people/me/connections` | The same endpoint with `syncToken` and `requestSyncToken=true` | The cursor carries the page token and the sync token. | An invalid `syncToken` produces `400 Bad Request`. Only the incremental request carries a sync token, so a bad request there *is* the token. |

**The cursor spans several calendars.** `calendarIds` may name more than one calendar, so the
cursor carries the calendar index as well. When the last page of a calendar is read, the next
cursor moves to the next calendar; when the last calendar is finished, the cursor is `null`.

**`showDeleted=true`** is deliberate: a cancelled event is reported as cancelled rather than
disappearing, so the deletion policy — not the connector — decides what happens to the CRM record.

### 2.2 Microsoft 365

| Object | Full sync | Incremental | Cursor | Expiry |
| --- | --- | --- | --- | --- |
| `outlookEvent` | `GET /graph/v1.0/me/events` | `GET /graph/v1.0/me/calendarView/delta` | The cursor holds Graph's `@odata.nextLink` while the feed pages, and the `@odata.deltaLink` when it is complete. | Graph's own expiry rules; a `410` is surfaced as a provider error. |
| `outlookContact` | `GET /graph/v1.0/me/contacts` | `GET /graph/v1.0/me/contacts/delta` | The same. | The same. |

**The final delta link is what gets persisted.** The engine pages through the feed because the
connector hands it one Graph page at a time, and the cursor it stores at the end is the delta link.
A connector that returned the first page's link would either re-read forever or skip a change.

**A link is re-validated before it is requested.** Graph's links are absolute; the connector
refuses any that does not point at `graph.microsoft.com` over `https`.

**Throttling** is Graph's `429` with a `Retry-After` header, which the platform's HTTP client
turns into a rate-limited, retryable provider error. The provider's rate-limit strategy is
declared as `provider_header`.

### 2.3 Zoom

| Object | Full sync | Incremental | Cursor |
| --- | --- | --- | --- |
| `meeting` | `GET /v2/users/{userId}/meetings?type=upcoming` | **None.** The declaration is `incrementalSync: false`. | The cursor holds Zoom's `next_page_token`. |

Zoom is a **destination**: the declaration is outbound-only, so the platform reads the user's
meetings for reconciliation and writes meetings the CRM asks for. The reconciliation read is what
makes a create idempotent — see `providers.md` §3.3.

### 2.4 Stripe

| Object | Full sync | Incremental |
| --- | --- | --- |
| `paymentIntent` | `GET /v1/payment_intents?limit=N&starting_after=…` | **None.** |
| `customer` | `GET /v1/customers?limit=N&starting_after=…` | **None.** |
| `checkoutSession` | `GET /v1/checkout/sessions?limit=N&starting_after=…` | **None.** |

Stripe's cursor is the last id of the page, sent back as `starting_after`. The connector knows
whether another page exists because Stripe answers with `has_more`.

**Payment state arrives by webhook, not by polling.** A Stripe event is claimed by the Sales
domain bridge and applied through `PaymentService.ingestProviderEvent`, which is idempotent on
Stripe's own event id. A duplicate or out-of-order delivery therefore changes nothing, and a
terminal state is never reversed.

### 2.5 Mailchimp

| Object | Full sync | Incremental |
| --- | --- | --- |
| `audienceMember` | `GET /3.0/lists/{listId}/members?count=N&offset=…` | **None.** |
| `campaign` | `GET /3.0/campaigns?count=N&offset=…` | **None.** |

Mailchimp paginates by offset, and the cursor carries the audience index and the offset. When the
last member of an audience is read, the next cursor moves to the next audience.

**Consent events arrive by webhook** and are claimed by the consent bridge, which applies them to
the suppression list with the provider's event id as provenance.

### 2.6 Meta Lead Ads

| Object | Full sync | Incremental |
| --- | --- | --- |
| `lead` | `GET /{formId}/leads?limit=N` | The same endpoint with `after` and `since`. The cursor holds the form index and the `after` cursor. |
| `leadForm` | `GET /{adAccountId}/leadgen_forms?limit=N` | **None.** |

The `since` bound comes from the engine's look-back window. The cursor advances to the next form
when the last lead of a form is read.

**The submission id is the identity.** A repeated submission resolves to the same CRM record, and
the form id is carried as the parent.

### 2.7 Shopify

| Object | Full sync | Incremental |
| --- | --- | --- |
| `order` | `GET /admin/api/2024-10/orders.json?limit=N` | **None.** |
| `customer` | `GET /admin/api/2024-10/customers.json?limit=N` | **None.** |
| `product` | `GET /admin/api/2024-10/products.json?limit=N` | **None.** |

Shopify paginates with the `Link` header and `rel="next"`. The connector reads the header, and the
cursor holds the next page URL — which is **re-validated against the connection's own store host**
before it is requested.

### 2.8 QuickBooks Online

| Object | Full sync | Incremental |
| --- | --- | --- |
| `customer` | `POST /v3/company/{realmId}/query` — `select * from Customer` | The same with `where MetaData.LastUpdatedTime >= '<watermark>'` |
| `invoice` | `select * from Invoice` | The same, with the watermark. |
| `payment` | `select * from Payment` | The same, with the watermark. |

The watermark is the highest `LastUpdatedTime` the previous run saw. The comparison is `>=`, not
`>`, because a provider that stamps records with the same second would otherwise be able to hide a
change. The cursor holds the position and the watermark.

**Amounts are decimal strings.** `"100.00"` stays `"100.00"`; nothing is parsed into a binary
float.

### 2.9 Generic REST

| Object | Full sync | Incremental |
| --- | --- | --- |
| `restObject` | `GET {baseUrl}{listPath}` with the configured page size and cursor parameter | **None.** The cursor is whatever the endpoint's `nextCursorPointer` names. |

The endpoint's own pagination shape is described by pointers, so the connector does not have to
know the vendor's convention. A pointer that does not resolve ends the enumeration.

## 3. The deletion semantics, in one table

The rule from the plan: *"A provider delete never hard-deletes a CRM record by default."*

| Provider | What the connector reports | What the CRM does |
| --- | --- | --- |
| Google Calendar | `status: cancelled` | The mapping's deletion policy: unlink, archive or conflict. The event is not erased. |
| Google Contacts | The contact is absent from the connection listing | Unlink by default. |
| Microsoft 365 | `isCancelled: true` | The same. |
| Stripe | Nothing — the connector is read-only and the declaration is `not_synchronized`. | Nothing is deleted. |
| Mailchimp | A member that disappears | Unlink by default. |
| Meta | A `delete` action type | Unlink by default. |
| Shopify | A `/delete` topic | Unlink or void, per the mapping. A commercial document is never erased. |
| QuickBooks Online | Nothing — the declaration is `not_synchronized`. | Nothing is deleted. |

## 4. The outbound direction

| Provider | Outbound? | How a write is made safe |
| --- | --- | --- |
| Google Workspace | Yes, with the write scope. | The engine's operation record carries an idempotency key; Google Calendar's own create is not idempotent, so a retried create is a conflict the mapping policy resolves. |
| Microsoft 365 | Yes, with the write scope. | The same. |
| Zoom | **Yes — the only connector that writes by default.** | The operation's marker travels in `tracking_fields`, and a create reconciles before it creates. |
| Mailchimp | Yes, for audience members. | A write that would resubscribe a suppressed member is refused without consent evidence. |
| Stripe, Meta, Shopify, QuickBooks, generic REST | **No.** | The declaration is inbound-only, and the write operation refuses with a precise message. |

## 5. What a deployment must confirm

1. The page size each provider honours — the connector clamps to the declared maximum, so a wrong
   maximum shows up as a smaller page, never as an error.
2. Whether the provider's cursor expires and how it signals it. The connectors handle `410` (Google
   Calendar), a `400` on a sync-token request (Google People) and Graph's delta rules. A provider
   that signals expiry differently would need a change in that connector alone.
3. Whether the provider's `since` bound is inclusive. The QuickBooks watermark is `>=` for exactly
   this reason.
