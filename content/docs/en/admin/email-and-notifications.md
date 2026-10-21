---
title: Email accounts and notifications
summary: The mailboxes and outbound transport, how a message actually leaves the system, and the notification defaults tab.
audience: admin
order: 80
tags: [email, smtp, mailboxes, notifications, transport]
related: [admin/settings-overview, admin/authentication-and-security, user/stream-and-notifications, admin/files-and-storage]
updated: 2026-10-21
---

Open [Administration → Email](/admin/settings/email). Two cards: the outbound transport this process is
configured with, and the mailboxes you can define. This tab edits records, not a settings document, so
every change saves as you make it and there is no publish bar.

## The transport

The transport is chosen by the server configuration, not by this screen. The card reports three facts —
whether it is live, its name, and the from address — and offers **Verify connection**, which opens the
connection and returns the provider's own failure text rather than a stack.

| Configuration | Values |
| --- | --- |
| `MAIL_TRANSPORT` | `none` (the default), `memory`, `smtp`, `relay` |
| Host and port | `SMTP_HOST` (required once a transport is enabled), `SMTP_PORT` |
| Credentials | `SMTP_USER` and `SMTP_PASSWORD`, which must be set together or neither |
| Sender | `SMTP_FROM`, falling back to `SMTP_USER`; `SMTP_FROM_NAME`, `SMTP_REPLY_TO` |
| Encryption | `SMTP_SECURE`, assumed on when the port is 465 |
| Limits | `MAIL_MAX_RECIPIENTS` (default 50), `SMTP_POOL_SIZE` (up to 20), connection timeouts |

`none` is the default so a half-installed system cannot send mail by accident, and the card shows the
transport as disabled. `relay` refuses to accept credentials: it is for a host that already trusts this
server. A broken SMTP configuration fails at boot rather than at the first send.

## Mailboxes

A mailbox is a named set of SMTP settings you can reuse. The list shows its address, the
`host:port (encryption)` it dials, whether a password is stored, and whether it is active. Each row has
**Edit**, **Test settings** and **Delete**.

- Fields: name (up to 190 characters), email address, from name, SMTP host, port 1 to 65535, encryption
  `none`, `starttls` or `ssl` (starttls by default), user name, password, and a signature up to 10 000
  characters.
- The password is **write-only**: it is encrypted at rest with AES-256-GCM using the deployment
  `ENCRYPTION_KEY`, and the API can only tell you whether one is stored. Leaving the field blank on edit
  keeps what is there; it never clears it.
- Without `ENCRYPTION_KEY`, saving a password fails with a clear message instead of writing plaintext.
- Exactly one mailbox may be flagged **Default**; turning it on for a second mailbox turns it off for the
  first. The label says system notifications are sent from it.
- Unknown encryption modes are rejected when the transport is built, so a typo surfaces at send time
  rather than silently falling back.

## How a message leaves

Nothing is sent from the API process.

- Sending creates an `Email` record and queues a `system.sendEmail` job; the worker opens the connection.
- Statuses are `Draft`, `Queued`, `Sending`, `Sent`, `Failed` and `Inbound`. Only `Draft` and `Failed`
  can be queued, so a double click cannot send twice.
- Every recipient gets its own line in the delivery ledger (`pending`, `sending`, `sent`, `rejected`,
  `failed`, `skipped`), which is what the message view reads.
- Account mailboxes send with `From` not pinned, because a mailbox legitimately sends on behalf of a
  team; the transport-level allowlist still applies.

Inbound collection is a seam, not a feature: the built-in provider polls nothing, and
`POST /api/v1/Email/action/pollInbound` is a safe no-op until an extension supplies a real adapter.

## The notifications tab

[Administration → Notifications](/admin/settings/notifications) edits the `notifications` document: a
digest cadence (`off`, `daily`, `weekly`; default `daily`), *Email on assignment* (on by default) and
*Email on stream updates* (off by default). It has the usual document save bar and a version.

> [!WARNING]
> No code reads this document yet. There is no digest job, and no notification or stream event sends
> mail. The card describes itself as the defaults new users' preferences start from, but there is also no
> per-user email preference screen in this build — the preferences that exist are interface settings such
> as density, list page size, columns and favourites. Publishing these switches records an intent; it
> changes nothing users can observe.

What notifications do today is in-app: rows written when someone posts to a record you follow, is
assigned work, or an activity reminder comes due, read from the bell and marked read individually or all
at once — see [Stream and notifications](user/stream-and-notifications). Reminders are delivered as
in-app rows only.

## What can go wrong

| Symptom | Where to look |
| --- | --- |
| Verify says the transport could not be verified | The mode is `none`, or `SMTP_HOST` and friends are unset in the environment |
| A mailbox saves but sending fails | Run **Test settings**: it opens the real connection with that mailbox's credentials |
| Saving a password is refused | `ENCRYPTION_KEY` is missing in the server configuration |
| Mail is queued and nothing arrives | The worker is not running or its queue name differs from the API's — see [jobs](/admin/jobs) |
| Nothing arrives from an inbound mailbox | No inbound provider is installed; polling is a no-op by design |

## Where to go next

- [Authentication and security](admin/authentication-and-security) — the deployment key that protects
  stored credentials.
- [The administration area](admin/settings-overview) — why some tabs have a publish bar and this one does
  not.
- [Stream and notifications](user/stream-and-notifications) — what your users actually see.
