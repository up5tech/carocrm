# Runbook — Installation-wide inbound email and calendar sync (Phase 24.7)

> **Phase 24.7 deliverable.** Companion runbooks: `docs/runbooks/inbound-mail.md` (the Phase 24.6
> inbound-mail operations), `docs/runbooks/advanced-integrations.md` (operator incidents),
> `docs/compatibility/advanced-integrations/providers.md` and `sync-semantics.md` (the delivered
> provider facts).

This runbook is for the **single operator** of a single installation: the person who decides whether
a mailbox or a calendar is collected at all, and what happens when collection fails. Phase 24.7
delivered the bounded installation-wide inbound sync scope chosen by owner decision **D5** — inbound
mail from **IMAP and Microsoft Graph**, plus **inbound calendar events** from **Google Workspace and
Microsoft 365**, administered at installation level. Outbound sending (SES/SendGrid/Microsoft Graph
send) and a provider push for Google Calendar are **out of scope** by decision, and are recorded as
such rather than approximated.

## 1. What Phase 24.7 delivered

| Surface | Delivered | Where |
| --- | --- | --- |
| Inbound mail (IMAP + Microsoft Graph) | The `InboundMailProvider` port, adapters, MIME parsing, per-connection cursors, scoped dedupe, partial-batch isolation, bounce/auto-reply suppression, thread linking — delivered in 24.6; the installation-wide *connections* layer is the Phase 24.7 sync surface | `POST /api/v1/Email/action/pollInbound`, `/api/v1/EmailAccount/action/inbound-connections` |
| Inbound calendar events (Google Workspace) | Full enumeration plus incremental sync through the Google Calendar `syncToken`; all-day events anchored at midnight in the event's own zone; private events gated by the connection's `includePrivateEvents` | `POST /api/v1/AdvancedIntegrations/action/mappings/:id/sync` over a `google-workspace` connection |
| Inbound calendar events (Microsoft 365) | Full enumeration plus incremental sync through Graph delta links; webhook delivery for change notifications (client-state verified) | `POST /api/v1/AdvancedIntegrations/action/connections/:id/renew-subscriptions`, `POST /api/v1/AdvancedIntegrations/action/process-webhook-event` |
| Ownership of synced records | A **personal** connection's records are written under the connection owner's authority, through the same path the polling and webhook paths use; a deactivated owner stops the sync | `sync-orchestrator.service.ts` (`asOwner`), `webhook-ingress.service.ts` |

An **incremental** mapping does not re-read the object: the engine calls the connector's delta feed
(Google `syncToken`, Graph `@odata.deltaLink`), so a run collects the changes since the last one and
stores the provider's next delta token. A `full` mapping still enumerates every page. The checkpoint
records **which feed** its cursor belongs to (`integration_sync_checkpoints.cursor_kind`, migration
`097_phase24_7_incremental_cursor.sql`), because a page offset handed to a delta reader is a cursor
the connector refuses. After an upgrade from a build that only had the page reader, the first
incremental run starts the delta feed at its beginning instead — the external link makes that re-read
idempotent, so no record is duplicated.

**Supported connection counts.** There is no product cap on mailboxes or calendars: each connection
is its own row with its own owner, credential, cursor and ACL, and the suites run two connections
against the same provider ids to prove that neither sees the other's records. The bound that matters
in practice is provider-side: Google and Graph apply per-installation quotas, and the engine's rate
limit and circuit breaker are **per connection**, so one throttled mailbox does not stop the others.
The `MAIL_INBOUND_PROVIDER` environment singleton remains the one-mailbox shortcut; the connections
endpoint above is the supported way to collect several.

The sync engine keeps one checkpoint per `(connection, mapping, direction)`: inbound cursors are
advanced **per page**, only past operations that committed, and an expired provider cursor
(`410 Gone` from Google, an invalid delta link from Graph) drops the cursor and re-runs a **full**
enumeration rather than failing the installation.

## 2. Operator setup — turn it on

Nothing is enabled by default. An installation that has not configured a provider answers
`FEATURE_DISABLED` ("inbound mail provider not configured") and has no calendar connections, so no
sync runs exist.

**Inbound mail.**

1. **Environment singleton (one mailbox, simplest).** Set `MAIL_INBOUND_PROVIDER=imap|graph` (and the
   IMAP/Graph settings). The default remains `none`.
2. **Several mailboxes.** Administer Mail Inbound Connections under
   `EmailAccount/action/inbound-connections` (`POST|GET /api/v1/EmailAccount/action/inbound-connections`,
   `…/action/inbound-connections/:id`). Each connection: `provider` (`imap`|`graph`), the mailbox
   fields, the credential (write-only, stored encrypted with `ENCRYPTION_KEY`) and `ownerUserId`.
   Inbound records are ACL-scoped to the owner.

**Inbound calendar.**

1. Create a connection (`POST /api/v1/AdvancedIntegrations/action/connections`) with the
   `google-workspace` or `microsoft-365` provider and run its OAuth flow (`…/action/connections/:id/authorize`).
2. Create an object mapping (`POST /api/v1/AdvancedIntegrations/action/mappings`) for
   `calendarEvent` → the CRM activity entity the installation uses, with `syncMode` `full` (first run)
   or `incremental`, and activate it (`…/action/mappings/:id/activate`).
3. Run the sync (`POST /api/v1/AdvancedIntegrations/action/mappings/:id/sync`), then watch
   `GET /api/v1/AdvancedIntegrations/action/connections/:id/detail` and `…/action/metrics`.

A manual run is bounded (`maxRecords` at most 1000, `pageSize` clamped by the declared provider
maximum) — a bulk sync is a bounded, cancellable run, per plan §13.5.

## 3. Credential scope and ownership

- Google Workspace connections are granted `Calendars.Read` + `Contacts.Read` by default, with
  `Calendars.ReadWrite` / `Contacts.ReadWrite` as the optional write scope. A read-only grant therefore
  reads and links, and cannot write.
- A `user`-owned connection is a **personal** mailbox or calendar. Its records are written under that
  user's authority (the same authority the polling and webhook paths enter), and the record is
  assigned to that owner. The installation-wide view never widens to "all personal mailboxes": a user
  who did not own the connection sees only what the entity ACL allows on the linked record.
- An `organization`-owned connection is shared installation data; the run keeps the authority of the
  administrator or scheduler that triggered it.

## 4. Rate limits and quotas

- The provider-declared `maxPageSize` clamps every page request; the connector clamps again.
- Google answers throttling with `429` + `Retry-After`, which the platform honours before its own
  bounded backoff; the connection's rate-limit strategy is `provider_header` for Google and
  fixed-window for the test connectors.
- The executor's circuit breaker opens per connection when the provider fails repeatedly; a failing
  provider then refuses calls (fail-closed) rather than hammering it.

## 5. Failure and recovery

| Symptom | Cause | Action |
| --- | --- | --- |
| Run status `failed`, error code `PROVIDER_UNAVAILABLE` / `RATE_LIMITED` | Provider outage or quota | Circuit breaker state in `…/action/metrics`; bounded retry; dead letter; replay after the provider recovers |
| `cursors.resetRequired` / run re-runs as a full sync | Google `syncToken` expired (`410 Gone`) or an invalid Graph delta link | Automatic: the engine drops the cursor and re-runs the full enumeration; a provider delete maps to *unlink*, so a resync cannot erase a record that is merely absent |
| Dead letter on a run | A single operation failed and stayed unapplied | `…/action/connections/:id/dead-letters`, then `…/action/dead-letters/:id/replay` (idempotent) |
| Run stuck / too many failures | Operator cancellation or retry policy | `POST /api/v1/AdvancedIntegrations/action/runs/:id/cancel`; counters in `…/action/connections/:id/runs` |
| Personal connection owner deactivated or deleted | The owner's authority can no longer be entered | The sync stops under that identity rather than continuing under another; the connection reports the failure and the operator reactsivate/replace the owner |

For inbound **mail** specifically, the failure vocabulary is the Phase 24.6 one (`FEATURE_DISABLED`,
per-connection `lastError`, partial-batch `failed`, restart-safe cursors) — see
`docs/runbooks/inbound-mail.md`.

## 6. Guarantees and explicit non-goals

- Sync is **installation-administered and opt-in**: an unconfigured installation fails clearly
  (`FEATURE_DISABLED`) instead of pretending to collect.
- Multiple personal/shared mailboxes and calendars inside one organisation are supported; each keeps
  its own owner, credential scope, cursor and ACL.
- **No provider is enabled by default**, and no automated test or CI run contacts a live mailbox or
  calendar: the fixture connector and `MAIL_INBOUND_PROVIDER=fixture` are the only paths used by the
  suites.
- Out of scope (recorded decision D5, not deferred by accident): Google Calendar push notifications
  (the incremental sync covers the need; a push deployment waits for a reviewed change), outbound
  sending through SES/SendGrid/Microsoft Graph, and the email UI. The compatibility matrix and the
  provider docs state exactly what is implemented, deferred and why.
