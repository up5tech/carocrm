# Marketing Automation — metrics, event semantics and attribution

**Delivered in:** Phase 19-MA.10 (normalized events), Phase 19-MA.11 (campaign log and statistics),
Phase 19-MA.17 (attribution and funnel).
**Plan:** `PLAN_Phase_19_Marketing_Automation.md` §5.9, §5.11, §5.14, §15 `19-MA.11`, `19-MA.17`.
**Code:** `marketing-event-ingestion.service.ts` (normalization and feedback), `marketing-campaign-log.service.ts`
(log and stats), `marketing-attribution.service.ts` (attribution and funnel), `marketing-operations.service.ts`
(operational counters). Storage: `marketing_events` (migration 042),
`marketing_recipient_deliveries` (migration 041).

Every number below is read from one of those two stores. Nothing is recomputed from campaign fields, and no
report adds a "sent" count that was not written by an event.

---

## 1. Event normalization

A provider webhook (`POST /webhooks/:providerKey`) is normalized onto one closed vocabulary before anything
is counted. Provider spellings collapse onto it (`EVENT_TYPE_MAP`); an unrecognized type becomes
`provider_error` rather than a new counter.

| Normalized type | Provider spellings accepted | Meaning |
| --- | --- | --- |
| `delivered` | `delivered`, `delivery` | provider accepted the message at the recipient's server |
| `hard_bounce` | `bounce`, `hard_bounce`, `hardbounce` | permanent failure — the address is suppressed |
| `soft_bounce` | `soft_bounce`, `softbounce` | temporary failure — **not** suppressed |
| `complaint` | `complaint`, `spam_complaint` | the recipient marked it as spam — suppressed |
| `unsubscribed` | `unsubscribe`, `unsubscribed` | the recipient opted out — suppressed globally |
| `opened` | `open`, `opened` | **approximate**, see §4 |
| `clicked` | `click`, `clicked` | a link was followed |
| `rejected` | `rejected` | the provider refused the message outright |
| `deferred` | `deferred` | the provider queued it for a later attempt |
| `provider_error` | `error`, anything unknown | the event could not be classified |

`marketing_events` keeps both the raw `event_type` and the `normalized_type`, plus `occurred_at` (provider
clock) and `received_at` (our clock). Reports use `normalized_type`; investigations read both.

Two more families write to the same table, and both are deliberately distinguishable:

| Row family | `normalized_type` | `campaign_id` | Written by |
| --- | --- | --- | --- |
| provider events | the table above | the campaign the event names | `marketing-event-ingestion.service.ts` |
| attribution outcomes | `conversion` | the campaign being credited | `POST action/attribution` (`MarketingIntegrationService.recordAttribution`) |
| cross-module signals | `provider_event` | **`null`** | `POST action/crossModuleEvent` — an audit trace of a Sales/CS/ServiceDesk signal, so it never enters a campaign's counters |

## 2. Counters and their denominators

`GET /api/v1/MarketingAutomation/action/campaign/:id/stats` returns:

| Field | Definition | Denominator / caveat |
| --- | --- | --- |
| `events.total` | number of `marketing_events` rows for the campaign | **events**, not people |
| `delivery.sent` | `delivered + opened + clicked` | a proxy for "reached the mailbox", derived from the event mix — it is not the number of submissions. The submission count lives in `marketing_recipient_deliveries.state in (Sent, Delivered, …)` |
| `delivery.delivered` | count of `delivered` | events; a recipient who opens without a delivery event is not counted here |
| `delivery.bounced` | `hard_bounce + soft_bounce` | events |
| `delivery.complained` | `complaint` | events |
| `delivery.unsubscribed` | `unsubscribed` | events |
| `delivery.opened` | `opened` | **approximate** (§4) |
| `delivery.clicked` | `clicked` | events |
| `uniqueRecipients` | `count(distinct recipient_entity_id)` | people, and only rows that carry a recipient id |

`asOf` is stamped on every response. The endpoint aggregates on read; there is no cached rollup that could be
stale without saying so.

`GET …/action/campaign/:id/log` pages the same rows (`limit` capped at 500, `offset`) with a
`normalizedType` filter. Access is the campaign's own record ACL — a report never reveals a recipient the
caller could not open.

## 3. Delivery ledger vs. events

Two different questions, two different stores:

* `marketing_recipient_deliveries` — **what we decided and did**: one row per recipient per send slot, with
  the state machine `Eligible → Queued → Sending → Sent → Delivered/Bounced/Complained/Unsubscribed`, plus
  `Blocked`, `Skipped`, `Failed`. This is the durable answer to "who was this send meant for".
* `marketing_events` — **what the provider reported**. A webhook may arrive for a recipient whose row is
  already terminal, may arrive twice, or may never arrive at all.

The two are linked by `send_id` + `slot` + recipient. A webhook updates the ledger row it names
(`applySideEffects`), and refuses two rewrites: a terminal `Bounced` is never upgraded by a late `delivered`,
and the `Sent` → `Delivered` edge is the only forward path. That is why a duplicate webhook cannot inflate
either store: the inbox dedupe key stops the event from being written twice, and the ledger update is
idempotent.

## 4. Open tracking is approximate — by design

Open events depend on a tracking pixel that privacy proxies prefetch, mail clients block, and text-only
readers never request. The plan says this explicitly (§3.2) and this module keeps the promise honest:

* `opened` is stored and reported, never merged into `delivered`;
* `delivery.sent` is a *derived* figure and is labelled as such above — do not present it as submissions;
* `GET …/public/open` returns a 1×1 GIF and **records nothing**: this deployment does not mint per-recipient
  pixel identifiers, so opens only ever arrive from a provider that reports them;
* a campaign that needs a reliable reach number uses `delivered` (provider-confirmed), not `opened`.

## 5. Suppression feedback

Three normalized types write suppression automatically (`SUPPRESSING_EVENT_REASONS`):

| Event | Suppression written | Scope | Overridable? |
| --- | --- | --- | --- |
| `hard_bounce` | `HardBounce` | `Global` | no |
| `complaint` | `Complaint` | `Global` | no |
| `unsubscribed` | `GlobalOptOut` | `Global` | no |

`soft_bounce` writes nothing: a temporary failure is not a preference. The write runs under the module's
service identity (§9.2), because a webhook has no logged-in principal — without that, the event would be
recorded and the block silently not applied. If the write fails anyway, the inbox row is marked
`processed_with_errors` with the reason, so an operator can see it instead of trusting a "processed" status.

## 6. Attribution

`GET …/action/campaign/:id/attribution?model=first_touch|last_touch|influenced`

| Field | Definition |
| --- | --- |
| `touches` | `marketing_events` rows for the campaign |
| `uniqueRecipients` | distinct `recipient_entity_id` |
| `conversions` | rows whose `normalized_type = 'conversion'` (written by `POST action/attribution` or a cross-module event) |
| `conversionRate` | `conversions / touches` |
| `influencedRevenue` | `sum(properties->>'amount')` over conversion rows, or `null` when none |
| `asOf` | read timestamp |
| `note` | the model's own caveat, returned with the number so a dashboard cannot drop it |

**Revenue is never additive.** A conversion may be attributed to several campaigns; `influenced` therefore
carries the sentence "Influenced revenue is not additive across campaigns". `first_touch`/`last_touch` select a
single touch per conversion. The module stores references and an optional amount supplied by the caller — it
never copies Sales financial records, so a Sales-side correction does not silently restate marketing history.

One reading caveat: a conversion row stores the *outcome* record in `recipient_entity_type`/`recipient_entity_id`
(an Opportunity id, say) because there is no separate reference column. `uniqueRecipients` on a campaign that
has conversions therefore counts outcome records alongside addressed people; read it as "distinct subjects",
or restrict to provider-event rows when the question is really "how many people".

## 7. Funnel

`GET …/action/campaign/:id/funnel` groups events by `normalized_type` ordered by first occurrence, and returns
`stages[]` plus `dropOff[]` (`1 - next/prev`). Caveats worth stating in any UI built on it:

* the stage order is *observed*, not declared — a campaign with no `opened` events has no open stage rather
  than a zero;
* a stage counts **events**, so a recipient who clicks three links contributes three clicks;
* `dropOff` between stages with different units (delivered → clicked) is a rate over events, not people. For a
  people-based rate, divide by `uniqueRecipients` and say so.

## 8. Operational counters

`GET …/action/diagnostics` (administrator) returns `deliveryStates` (counts per ledger state), `deadLetters`
(`state = 'Failed'`), and `stuckSending` (`Sending` with a claim older than ten minutes). These are the numbers
the runbooks act on:

* rising `deadLetters` → read `error_code` per row; retries are exhausted, not in flight;
* `stuckSending` > 0 → a worker died mid-claim; the next sweep recovers the row after
  `delivery.staleClaimMinutes`;
* `paused: true` in a batch result → the emergency stop is on, not a provider fault.

## 9. What is deliberately not measured

* No per-journey funnel table. Journey progress is read from `MarketingJourneyEnrollment.state` counts and the
  step-execution trace; there is no separate aggregate to reconcile.
* No "incremental revenue". Attribution is influence, and the API says so on every response.
* No open-rate benchmark, no engagement score, no lead score. Those would be new models, not measurements of
  what happened.
