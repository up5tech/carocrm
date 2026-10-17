# Email-to-case

## Configuration

- `features.emailToCase` must be on; the `Email` entity (mail pipeline) must be registered.
- `settings.email.replyFromAddress` optionally pins the outbound reply identity. Empty (default)
  means the sending mail account or the process-wide transport default is used. The module no
  longer hard-codes a vendor address.
- Inbound polling uses the kernel mail pipeline (`EmailService.pollInbound`) and its configured
  accounts. The module does not own an IMAP client or a second mailbox table.

## Inbound processing

`POST /api/v1/ServiceDesk/action/emailToCase { "emailId": "…" }` processes one stored inbound email.
`POST …/emailToCase/processInbound` first polls the mail pipeline, then processes every stored
inbound message that has not been processed or skipped.

Rules:

1. Only a stored email with `status = Inbound` is accepted.
2. Auto-replies (`Auto:` subject, out-of-office, `Auto-Submitted` header) and delivery status
   notifications are skipped and marked `skipped:<reason>`.
3. The thread key is `threadId`, else `inReplyTo`, else `messageId`, else the email id. A prior
   email or case with the same thread appends to that case; otherwise a new `Case` is created with
   `source = Email`.
4. A new case resolves the Contact by sender address and copies its Account; the body becomes the
   first public Stream item. The case receives `lastActivityAt` and `lastCustomerResponseAt`.
5. The processed email is marked `emailToCaseStatus = processed`, `caseId`, `streamItemId` and
   `threadId`. Reprocessing returns the same case without creating a duplicate; skipped messages are
   not retried by the poller.
6. Attachments are not copied into a second store; the Stream item carries the email reference.

Ambiguous thread matches are not guessed: without a reliable thread key the message starts a new
case. Processing counts (`fetched`, `stored`, `skipped`, `processed`, `failed`) are returned so an
operator can see partial failure.

## Outbound replies

`POST /api/v1/ServiceDesk/action/case/:id/emailReply { "text": "…" }`:

- requires `features.emailToCase`, a readable case and a requester address (case field or Contact);
- creates an outbound `Email` record linked to the case, with `inReplyTo` and `threadId` copied from
  the case's last inbound email so customer replies thread back;
- queues the send through the kernel mail transport (`EmailService.queueSend`) and reports
  `queued: false` when the transport is not configured or the queue call fails;
- appends a public Stream item, stamps `lastActivityAt`, `lastAgentResponseAt` and the first
  response time.

Tests inject a fake/memory mail transport; no live email is sent.

## Troubleshooting

| Symptom | Check |
|---|---|
| `403 FEATURE_DISABLED` | `features.emailToCase` in `GET /api/v1/ServiceDesk/action/settings` |
| Email skipped | `emailToCaseStatus` on the Email record (`skipped:auto-reply`, `skipped:dsn`, …) |
| Reply not queued | mail transport configuration (`MAIL_TRANSPORT`, SMTP settings) and the worker |
| Duplicate case | thread identity on the stored email; the processor is idempotent by `emailId`/thread |
| No sender address | `settings.email.replyFromAddress`, the sending account, or `SMTP_FROM` |
