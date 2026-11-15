# Runbook — Inbound mail collection (Phase 24.6)

Purpose: how a single-tenant installation polls inbound mail into CRM records, how to configure
each source, and how to recover when a poll fails. Inbound mail is administered at installation
level (admin-only); a personal mailbox is never installation-wide readable — each connection keeps
its own owner, cursor and record ACL.

Binding: `POST /api/v1/Email/action/pollInbound` (admin session) polls **two** sources, in order:

1. the env-selected singleton (`MAIL_INBOUND_PROVIDER`), and
2. every active Mail Inbound Connection once configured (admin list:
   `GET /api/v1/EmailAccount/action/inbound-connections`).

With **no** provider configured the endpoint answers `FEATURE_DISABLED` ("inbound mail provider
is disabled") — it never returns a fake empty success. The response is
`{ fetched, stored, skipped, failed }`: `fetched` is what the providers returned, `stored` the new
records, `skipped` the messages already present (dedupe) and `failed` the messages that could not be
stored. A provider that fails outright makes the call fail with `VALIDATION_FAILED` — the message
names every failing connection.

## Option A — env singleton (one mailbox, simplest)

Set the provider and its settings **before** starting the API: bad configuration fails at boot,
not on the first poll.

| Provider | Settings |
|---|---|
| `none` (default) | nothing — polling fails clearly |
| `imap` | `IMAP_HOST`, `IMAP_USERNAME`, `IMAP_PASSWORD` (required); `IMAP_PORT` (993), `IMAP_SECURE` (`true` — forced for non-loopback hosts), `IMAP_MAILBOX` (`INBOX`), `MAIL_MAX_INBOUND_MESSAGE_BYTES` (10 MiB) |
| `graph` | `GRAPH_TENANT_ID` + `GRAPH_CLIENT_ID` + `GRAPH_CLIENT_SECRET` + `GRAPH_MAILBOX` **or** `GRAPH_ACCESS_TOKEN` (delegated, short-lived) |
| `fixture` | `MAIL_INBOUND_FIXTURE_DIR` — directory of `*.eml` files. **For tests/CI only.** |

Example (IMAP):

```bash
MAIL_INBOUND_PROVIDER=imap \
IMAP_HOST=imap.example.com IMAP_USERNAME=support@example.com IMAP_PASSWORD='…' \
IMAP_MAILBOX=INBOX \
pnpm start
```

Example (Graph, application permissions for a shared mailbox):

```bash
MAIL_INBOUND_PROVIDER=graph \
GRAPH_TENANT_ID=<tenant> GRAPH_CLIENT_ID=<app-id> GRAPH_CLIENT_SECRET='<secret>' \
GRAPH_MAILBOX=support@contoso.onmicrosoft.com \
pnpm start
```

## Option B — Mail Inbound Connections (several mailboxes)

Admin-only (`requireAdmin`):

```
POST   /api/v1/EmailAccount/action/inbound-connections
GET    /api/v1/EmailAccount/action/inbound-connections
GET    /api/v1/EmailAccount/action/inbound-connections/:id
PATCH  /api/v1/EmailAccount/action/inbound-connections/:id
DELETE /api/v1/EmailAccount/action/inbound-connections/:id   (soft delete)
```

Each connection: `provider` (`imap`|`graph`), `mailbox` + provider fields (`host`/`port`/`secure`/
`folder` for IMAP, `tenantId`/`clientId` for Graph), `credential` (write-only; stored encrypted
with `ENCRYPTION_KEY`, returned only as `hasCredential`), `ownerUserId` (the record owner — the
connection's records are ACL-scoped to it), `isActive`. Responses never include the credential.

## Guarantees and limits

- **Idempotent, restart-safe.** Dedupe key is `(connection_id, provider_message_id)`; a
  mailbox cursor is persisted only after a connection's whole batch is ingested. Re-running a
  failed or interrupted poll never duplicates a record, and the same provider id in two mailboxes
  never collides.
- **Bounded.** At most 50 messages per connection per run, 500 fetched per call. A message larger
  than `MAIL_MAX_INBOUND_MESSAGE_BYTES` is stored as a flagged fallback, not fetched repeatedly.
- **Partial-batch safe.** One malformed message becomes an `Inbound` record with
  `inboundParsed: false` + `inboundError`; one rejected attachment (malware/ACL/size) never
  loses the message. A message that cannot be stored at all (for example a subject longer than the
  `Email.name` limit) fails only itself: it is counted in `failed`, the rest of the batch is still
  ingested, and the connection's cursor is **not** advanced so the message is retried on the next
  poll while the stored ones dedupe away.
- **One broken mailbox never blocks the others.** A provider that fails is recorded on that
  connection's `lastError`; the other connections are still collected, and the call reports every
  failure at the end.
- **Suppression.** `messageKind: Bounce | AutoReply` records never auto-create a Case. A Case
  reply (`POST /api/v1/ServiceDesk/action/case/:id/emailReply`) refuses suppressed addresses
  (live `MarketingSuppression` rows) before any outbound effect.
- No background schedule ships with this phase: polling is on demand. Wire it to a cron job or the
  worker out of band if hands-free sync is wanted.

## Failure and recovery

| Symptom | Meaning | Action |
|---|---|---|
| `FEATURE_DISABLED` | No provider configured anywhere | Configure Option A or B, restart, re-run the poll |
| `Inbound poll failed for connection "…"` | That provider rejected/failed the poll; other connections already processed keep their records | Check the connection's `lastError` field, fix credentials/network, run the poll again — dedupe makes the repeat safe |
| `failed` is greater than 0 | A message could not be stored (for example a subject longer than `Email.name`); the rest of the batch was ingested | Fix the message content rule (or the mailbox), then re-run — the failed message is retried because the cursor did not move |
| `auth_failed` (connection `lastError`) | Bad mailbox password or rejected Graph app credentials | Rotate the credential (PATCH the connection), re-run |
| `connection_failed` / `timeout` | Host unreachable, port closed, TLS failure | Check host/port/security; the cursor is unchanged, so no message is lost |
| Records exist but nothing became Cases | They are `Bounce`/`AutoReply`, or `emailToCase` is disabled in ServiceDesk settings | Expected for bounces; enable `features.emailToCase` for `Standard` records |

## Security notes

- Credentials from the DB vault are decrypted in memory only; never log the `ENCRYPTION_KEY`,
  passwords or Graph secrets, and never poll a real customer mailbox in CI (use `fixture`).
- `MAIL_TRANSPORT=memory` (or `none`) keeps tests off the network entirely; fixture ingestion
  never sends mail.
- Inbound records respect the entity engine's record/field ACL: connections set
  `assignedUserId` from `ownerUserId`, so a non-admin reader sees only mailboxes their roles
  grant.
