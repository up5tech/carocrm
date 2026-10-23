---
title: Configuring e-signature
summary: Turn the module on, connect DocuSign or Dropbox Sign, and set the document, signing, approval and callback policy behind every request.
audience: admin
order: 136
tags: [esignature, signature, docusign, dropbox-sign, providers, approvals, webhooks]
related: [admin/module-settings, admin/settings-overview, admin/users-teams-roles, user/esignature, admin/audit-jobs-and-operations]
updated: 2026-10-23
---

E-Signature prepares a signing request in the CRM, hands it to a provider, and projects the provider's
answers back onto the record. The provider stays the signing authority: only it can say an envelope was
delivered, signed or declined. The CRM keeps what was sent — a snapshot of the documents, their hashes,
the recipients and their routing — and an append-only history of every state change.

The module is provider-neutral. Two integrations are installed in this build, and they do not behave
identically:

| Provider key | Provider | Authentication | Sending shape | Embedded signing | Completion evidence |
| --- | --- | --- | --- | --- | --- |
| `docusign` | DocuSign | OAuth 2.0 authorization code with PKCE | Prepare a draft envelope, then send it | Yes | Yes |
| `dropbox_sign` | Dropbox Sign | API key | Create and send in one call | No | No |

Everything below is enforced by the server. The screens describe the same rules, but a hidden button has
never been the thing that refuses a call.

## Turning the module on

Open [Settings → E-Signature](/admin/settings/eSignature). The whole document is off by default — the
module, its features and its connections — so a fresh instance cannot send anything by accident.

The settings document is saved whole, with one version and one **Save**. A refused save changes nothing:
the stored version stays and the tab names the field that failed. A feature only takes effect when the
module is on, the feature is on, and the feature it depends on is on as well.

| Feature | What it enables | Depends on |
| --- | --- | --- |
| Signature requests | The request workspace, its lists and records | — |
| Provider connections | The connection control plane and its credentials | — |
| Attach CRM documents | Attaching CRM attachments as signature documents | Requests |
| Provider templates | The provider template catalog and role mappings | Connections |
| Send envelopes | The deliberate send to remote signers | Connections |
| Provider status events | The callback endpoint and the event inbox | Connections |
| Embedded signing | A signing session opened inside the CRM | Send, plus a return-host allowlist |
| Signed documents and evidence | Retrieving and downloading what came back | Connections |
| Approval before send | The approval queue and the send-time approval check | Requests |

> [!NOTE]
> A switch is a promise only together with its dependency. The health panel names every feature that is
> on while what it needs is off, and the send guard reads the effective answer, never the raw flag.

## The gate

Four things have to hold before the module will perform any provider operation. The gate reports the
first one that fails, and the page shows the same sentence to whoever opens it.

| Reason | What is missing |
| --- | --- |
| `module_disabled` | The module switch is off. |
| `connections_disabled` | Provider connection administration is off. |
| `encryption_key_missing` | `ENCRYPTION_KEY` is not configured, so a stored credential cannot be read. |
| `no_enabled_connection` | No connection is both authorized and active. |

A closed gate stops provider operations, not reading. Requests, documents, events and audit rows stay
readable to whoever holds the right to read them, and an administrator can still fix the cause. That is
deliberate: during an outage the audit trail must remain available.

## Connecting a provider

Open **E-Signature → Provider connections** on [the module page](/esignature). The create form follows
the provider's authentication style, because the two are genuinely different flows.

### DocuSign

1. Register an integration in DocuSign for **demo** or **production**, separately. The two environments
   get their own client id, secret, account and data-center base URI, and a connection never moves
   between them.
2. Enter the client id (integration key) and the redirect URI. The redirect URI must point at this
   platform's callback path on this host; any other path or a foreign host is refused.
3. Enter the client secret. It is written to the encrypted vault and can never be read back, not even by
   the administrator who typed it.
4. Complete consent. The browser leaves the CRM for the provider's consent screen and returns to the
   backend callback, which resolves the account id and the account-specific base URI. The connection
   becomes `connected` only after that answer is stored.
5. Store the Connect HMAC secret and register the callback URL in DocuSign Connect. Deliveries are
   verified against this secret; **Require HMAC** is on by default and turning it off is a debugging
   choice on a non-production connection only.

### Dropbox Sign

1. Paste the account's API key and save. The CRM calls the provider's account endpoint **before**
   anything is stored: a key the provider refuses creates no connection, and a key it accepts binds the
   account the connection will send through. There is no consent screen and nothing to authorize later.
2. Register the callback URL in the Dropbox Sign application settings. The callback's `event_hash` is
   derived from the same API key, so there is no second callback secret to store.
3. To rotate, use **Replace API key**. The new key is verified and re-binds the account; a refused key
   leaves the previous, working credential in place.

This integration has no unsent provider draft — its create call is the send — so a request is created at
the moment it is sent. It also cannot open an embedded signing session, and it cannot produce a
completion certificate: its audit trail lives inside a ZIP archive this integration does not unpack.
Signed documents themselves are retrievable.

### Connection states

| State | What it means | What still works |
| --- | --- | --- |
| `not_connected` | A row exists, no usable credential yet. | Nothing that reaches the provider. |
| `connected` | Credential verified and account bound. | Every operation the provider declares. |
| `reauthorization_required` | The provider refused the credential (a revoked grant, a replaced key). | Reading the row; every provider call is refused until fixed. |
| `disabled` | An administrator switched it off. | Reading and configuration; no provider call. |
| `error` | The last operation failed for a reason the module recorded. | Reading the redacted diagnostic; **Test connection** to re-check. |

**Test connection** asks the bound adapter and records the answer. A fake adapter is a real fact about the
installation: outside production the module binds a simulator, and the connection row says so. Nothing a
fake adapter sends reaches a signer.

**Disconnect** removes the stored credentials and any pending authorization state. Requests and their
history stay, with their provider envelope ids, because a contract that was sent is evidence and not
configuration.

## Documents and signing policy

| Field | Default | Effect |
| --- | --- | --- |
| Largest document | 25 MiB | Refused against the attachment's real size before anything is sent. |
| Documents per request | 5 | The request cannot be prepared beyond this count. |
| Allowed extensions | `pdf`, `doc`, `docx` | Checked on the attachment's own name, not the browser's claim. |
| Days until expiry | 30 | Used when the sender names no expiry date. |
| Allow reminders | Off | Whether the reminder action exists at all. |
| Minutes between reminders | 5 | A second reminder for the same request is refused inside this window; `0` disables it. |
| Embedded return hosts | Empty | Hosts a signing session may return to. Empty means no session can be created even with the switch on. |
| Callback payload ceiling | 256 KiB | A larger delivery is refused with `413` and never recorded. |
| Keep callback payloads | 90 days | The minimized payload is kept for this long; `0` keeps only the deduplication key. |
| Keep signed documents | Forever | `0` means no automatic deletion. A retention policy is an explicit choice. |

The stricter limit wins: the module's ceiling is checked first, then the provider's own. A provider that
publishes no per-document limit leaves the module's ceiling as the answer.

## Approval policy

Turn on **Approval before send** and the approval rules become part of the send guard:

- **Source types that require approval.** An empty list means no source type requires one.
- **Rules.** Each rule names a source entity, one metadata field, a closed operator (`equals`,
  `not_equals`, `gte`, `lte`, `contains`) and a literal value. A numeric operator refuses a non-numeric
  literal at save time. Rules are data, never expressions: nothing is evaluated as code.
- **Separation of duties.** On by default: the person who created or prepared a request cannot decide
  its approval.

Approval binds the exact prepared bytes. Editing the request afterwards invalidates the prepared preview,
and a new preview needs a new approval — an approval for a different envelope is not an approval. A
rejection needs a reason and leaves the request unsendable until it is re-prepared and approved.

Approvers hold the `approve` right, which is separate from drafting and from sending.

## Templates and mappings

A provider template lives in the provider's account; the CRM never writes it back. **Refresh catalog**
reads what the account holds, and a mapping names the roles and tabs the CRM will fill.

- Roles are matched by the provider's own role names, and each row says whether a recipient is a signer
  or a copy, its routing order and which CRM field supplies the person.
- Tabs are matched to CRM fields; a tab the provider does not have is refused, not guessed.
- A mapping carries a version. A mapping edited after a preview changes what would be sent, so the
  prepared digest changes with it.
- A provider that declares no template support cannot be mapped at all; the operation is refused before
  a call is made.

## Callbacks and the event inbox

Every connection carries an opaque `publicId` used as a path segment:

`POST /api/v1/integrations/esignature/{publicId}`

It is a routing identifier, not a secret. Authentication is the provider's signature over the exact bytes
it sent, which is why the raw body is preserved for this prefix and the endpoint never reads a parsed one.

- **DocuSign** signs with the connection's Connect HMAC secret.
- **Dropbox Sign** derives `event_hash` from `event_time + event_type` keyed by the account's API key,
  and retries — eventually disabling the endpoint — unless the answer body is exactly
  `Hello API Event Received`. This module sends that body for accepted and duplicate deliveries and never
  for a refused one.

A verified delivery is recorded in a durable inbox with a deduplication key, then processed by a job. The
inbox is what lets an event be replayed after a failure without asking the provider to resend it.
Processing is idempotent per delivery and projects provider state onto the request; it never sends
anything.

| Answer | Meaning |
| --- | --- |
| `200` / `202` | Accepted, or a duplicate of one already accepted. |
| `401` | Verification failed. Retrying the same delivery will fail the same way. |
| `404` | The module is off, the routing id is unknown, or the provider has no verification in this build. |
| `413` | The body exceeds the configured ceiling. |

Event history, refusals and dead-lettered deliveries are readable to a holder of the audit right, and the
operations panel reports the queue depth and the oldest pending delivery.

## Rights

Each right is an ordinary access-control resource, granted by a role and evaluated by the same engine as
the rest of the product. Record scoping applies on top: `SignatureRequest` read and create decide which
requests you see and draft, and the send, void, correct, approve and download rights are separate
resources of their own.

| Right | What it opens |
| --- | --- |
| `use` | The menu entry, the request list, and the requests your record access allows |
| `manageDraft` | Creating and editing drafts, attaching documents, replacing recipients |
| `send` | The deliberate external action of sending |
| `approve` | Deciding the approval a request requires |
| `void` | Withdrawing a sent envelope, with a reason |
| `correct` | The correction exception path (not open in this build, see below) |
| `downloadCompleted` | Retrieving and reading signed documents and evidence |
| `connectionRead` | Reading connections, environments and redacted diagnostics |
| `connectionManage` | Creating, authorizing, testing, enabling and disconnecting connections |
| `templateMappingManage` | Refreshing the template catalog and editing mappings |
| `auditRead` | The append-only lifecycle audit and the provider event history |

An administrator passes every right; a signature user should not hold `connectionRead`, because that
answer names the provider account the CRM sends through.

## Operations

The operations panel on [the module page](/esignature) reports the platform checks, the webhook queue,
the recovery queues and the failed jobs. It is readable with `connectionRead`, and every retry it offers
is an ordinary command with the same checks as the screen that normally triggers it.

- **Stuck** — a request `sending` for longer than the threshold, or an in-flight request with no
  projection. Reconcile it.
- **Send outcome unknown** — the provider may have accepted the send but the answer was lost. Reconcile;
  never resend blindly. Reconciliation either concludes the send or proves it never happened, which is
  what makes a later, deliberate send safe.
- **Provider errors** — a definite refusal. Use **recover**, then a new deliberate send; the guard runs
  again, including approval.
- **Dead-lettered callbacks** — read the redacted reason, fix the cause (usually a rotated secret), then
  retry the delivery.

To roll back, switch the module off, or disable the connection. Both stop provider work immediately and
keep every stored request, event and artifact. Re-enabling requires a working credential again, not a
replay.

## Limits in this build

- No CLM, Rooms, bulk send, provider-side template authoring or Connect management beyond the callback.
- Correction of a sent envelope is declared unsupported by both adapters; the action is refused and the
  refusal is audited. Void is the supported way to stop an envelope.
- Dropbox Sign has no embedded signing, no completion evidence and no unsent draft. Its account API key
  is both the credential and the callback key.
- An ambiguous send through a provider that never returned an envelope id cannot be reconciled by id. The
  operator finds the request in the provider console with the correlation id recorded in the audit trail.

## Where to go next

- [Signature requests](user/esignature) — the user-side guide to drafting, sending and tracking.
- [Module settings](admin/module-settings) — how the settings document and feature switches behave.
- [Audit log, jobs and operations](admin/audit-jobs-and-operations) — where the event history and failed
  jobs are read.
- [Files and storage](admin/files-and-storage) — where document snapshots and downloaded artifacts live.
