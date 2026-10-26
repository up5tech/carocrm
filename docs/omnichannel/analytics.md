# Omnichannel — conversation analytics (definitions)

> Phase 19-OM.20 (`PLAN_Phase_19_Omnichannel.md` §10.1, §14; endpoint
> `GET /api/v1/Omnichannel/action/analytics?days=N`). Every metric is recomputable from the
> authoritative records below; the JSON field names match this document.

## Why a dedicated path

The generic report/search engine resolves fields against **metadata entities**; the canonical
conversation records are dedicated tables (decision D1), so they are neither reportable nor searchable
through that engine (audit G7). This is the documented dedicated path: aggregate SQL over
`voice_conversations`, `voice_messages`, `voice_conversation_events`, `voice_webhook_events` and
`voice_provider_accounts`.

**ACL** — the endpoint requires the `inboxView` capability and the `CommunicationConversation` read
ACL: exactly the visibility the inbox itself has over these tables (entity-level; per-record ACL does
not exist for dedicated tables — audit G7). The response contains **no message content, no addresses
and no payloads**, only counts, durations and grouping keys (assignee ids, channel names, statuses).

## Window and timestamps

`days` (1–365, default 30) selects rows by their **recorded** timestamps — never a local submission
time standing in for delivery:

| Metric | Rows | Timestamp |
| --- | --- | --- |
| Volume | `voice_messages`, `is_internal_note = false` | `created_at` |
| First response | conversations created in window | conversation `created_at` → first outbound visible message `created_at` |
| Reply delay | inbound visible messages in window | inbound `created_at` → next outbound visible `created_at` |
| Reopen | `voice_conversation_events.kind = 'status_changed'` | event `created_at` |
| Delivery | outbound visible messages in window | `created_at` |
| Webhook backlog | `voice_webhook_events` | `received_at` |
| Backlog / assignment | live conversations (`archived = false`) | — (a snapshot, not a window aggregate) |

## Metrics

- **`volume.byChannel`** — customer-visible messages (inbound + outbound) per channel. Internal notes
  and drafts are excluded (`is_internal_note = false`); internal activity is never counted in a
  customer-message metric.
- **`backlog`** — live conversations by `open | pending_customer | pending_internal`, plus `unassigned`
  (no user and no team, not closed) and `snoozed` (`snoozed_until > now()`).
- **`assignment`** — top 20 open conversations grouped by user, else team, else `unassigned`.
- **`firstResponse`** — average minutes from the conversation's `created_at` to its first
  customer-visible outbound message. `sample` is the number of conversations that qualify; when zero,
  `averageMinutes` is `null` with an `unavailable` reason (never a fake zero). This describes
  *conversation* first response — ServiceDesk owns Case SLA metrics and they are not duplicated here.
- **`replyDelay`** — average minutes from each inbound customer message to the **next** outbound
  visible message in the same conversation. Unanswered inbound messages contribute no sample.
- **`handoffs`** — conversations created in the window with `case_id` set (the authoritative link the
  hand-off command writes; see OM.17).
- **`reopenRate`** — `reopened` = `status_changed` events `closed|resolved → open`; denominator
  `closedInWindow` = `status_changed` events ending in `closed|resolved`; `rate` is a percentage, `null`
  when the denominator is zero.
- **`delivery`** — outbound visible messages in `failed`, `undelivered` and **`unknown` reported
  separately**. `unknown` means the provider outcome is unconfirmed (a timeout); it is never counted as
  a failure or presented as success. `byCategory` groups the failure categories (13-category taxonomy,
  `unspecified` allowed).
- **`providerHealth`** — the owner's account health rows (`last_health_status`/`last_health_at`) and the
  webhook receipt backlog by processing status. With no enabled account the section reports
  `available: false` and its reason instead of an empty success.

## What is deliberately not here

- No content, no per-message listing, no customer identifiers (search remains the inbox's ACL-gated
  path; the dedicated tables are outside the generic search index — recorded gap G7).
- No Case SLA/CSAT metrics (ServiceDesk/CSAT own them).
- No inferred delivery success from a submission timestamp; absence of a provider callback stays
  visible as `unknown`.
