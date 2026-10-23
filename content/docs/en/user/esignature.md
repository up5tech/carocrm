---
title: Signature requests
summary: Draft a request, attach the documents, name the signers, review the preview and send it — then track, remind, void and download.
audience: user
order: 85
tags: [esignature, signature, request, signing, documents, approval]
related: [user/record-page, user/lists-and-views, admin/esignature, reference/permissions-matrix, admin/audit-jobs-and-operations]
updated: 2026-10-23
---

A signature request is the CRM's record of a document set going out for signature. The provider does the
signing; the CRM keeps the draft, the reviewed snapshot, the sender, the time and the provider's answers.
You open it from the E-Signature page or from the CRM record it belongs to, and you can read it later even
if the provider is down.

Everything the screen offers is checked again on the server. A verb you cannot see is one you do not
hold the right for, and calling it directly is refused.

## Where requests live

Open **E-Signature** in the main menu to reach the request list. It filters by status, by approval state,
by name or subject, and by signer address; the count in the header is the server's total for the current
filters.

From a record — an account, contact, quote, project, case, campaign or customer-success profile — the
module's action opens a new request with the source record already attached. That link is what the
completion reports group by, so attach the record when there is one.

## Drafting a request

A draft is editable until it is sent. It carries:

- **Name** — required, and the only field the list shows as a title.
- **Subject and message** — what the signer sees in the invitation.
- **Source record** — optional; it feeds approval rules and the reports.
- **Expiry** — optional; without it the instance default applies (30 days unless your administrator
  changed it).
- **Recipients** — name, email, **signer** or **copy**, routing order and signing mode. Order 1 signs
  first; a copy receives the finished document without signing.
- **Documents** — attachments from the CRM, in order. The instance limits which file types and how many
  may be attached, and refuses a file over its size ceiling before anything leaves the CRM.

> [!NOTE]
> A draft may name a provider or inherit it from the chosen connection. It cannot be rebound to a
> connection of another provider afterwards, because the provider's envelope ids are what every later
> event joins on.

If your administrator mapped provider templates, a request can be built from a mapping. The mapping's
roles are matched to your recipients by the provider's own role names; the screen will not let you pick a
role the template does not have.

## Reviewing before you send

Opening **Preview** builds exactly what the provider would receive and reports what is missing. The
server also records a digest of that preview, so the send can prove it is sending what you reviewed.

- Problems are listed by name — a missing email, a document that is not readable, a routing order that
  cannot be honoured. Preparation is refused while any remain.
- Any edit after the preview makes it stale. The send is refused until you prepare again, which is the
  point: a request that changed after review was not reviewed.
- If the approval policy applies to the source record, preparing routes the request to **pending
  approval** instead of ready-to-send.

## Sending

Sending is the one action that cannot be undone. It requires:

- the **send** right, which is separate from drafting;
- an explicit confirmation — the button alone does not send;
- the current version, so a change made in another tab is refused instead of overwritten;
- a matching preview digest;
- the approval the policy requires, when it requires one.

A second click cannot send the same request twice. The provider is called at most once per deliberate
attempt, and the answer — envelope id, provider status and time — is recorded with the sender.

How the provider is called depends on the integration, not on you:

- **DocuSign** needs an unsent provider draft first. The request shows a **Create draft** step, and the
  draft can be abandoned without sending.
- **Dropbox Sign** creates and sends in one call. There is no draft step; the deliberate send is the
  creation.

## While it is out

Once sent, the request is frozen. Documents, recipients and the message are the snapshot the provider
received; the CRM does not rewrite them.

| Status | What it means |
| --- | --- |
| `sent` | The provider accepted the request and has invited the signers. |
| `delivered` | The provider reports the invitation reached at least one signer. |
| `partially_signed` | At least one signer signed; at least one has not. |
| `completed` | Every required signer signed. |
| `declined` | A signer declined; the reason is recorded. |
| `voided` | You or an administrator withdrew it, with a reason. |
| `expired` | The expiry passed before it completed. |

The detail view shows each recipient's progress and the request's event timeline. Provider events arrive
in the background and move the request without anyone clicking anything; the timeline is the record of
what arrived and when.

**Remind** re-sends the invitation to recipients who have not signed. It needs the reminder switch to be
on, the provider to support it, and the cooldown to have passed since the last one — a second reminder
inside the window is refused with the time remaining.

**Void** withdraws a sent request. It needs a reason, and it is only possible while the request is
`sent`, `delivered` or `partially_signed`; a completed or declined request cannot be voided. The provider
is asked to void the envelope and the request becomes `voided` when it agrees.

> [!WARNING]
> There is no delete. A request that has been sent is evidence: void it instead, and its history stays
> readable.

## When the answer is lost

A send can fail in a way that leaves the answer unknown — the provider accepted the request but the reply
never arrived. The request is held as `send_unknown`, and the only way forward is **Reconcile**.

- Reconciliation asks the provider for the truth, by envelope id. If the provider has it, the request
  becomes sent and the provider's state is projected. If it does not, the request becomes `provider_error`
  with the reason, which proves nothing was sent.
- Only after that proof does **Recover** return the request to ready-to-send. The retry is then a new,
  deliberate send with the guard run again, including approval.
- A provider that never returned an envelope id leaves nothing to reconcile by id. The request stays
  held, and an administrator finds it in the provider console with the correlation id recorded in the
  audit trail before deciding what to do.

## Signing inside the CRM

Where embedded signing is switched on — and the CRM's host is on the administrator's return-host
allowlist — a signer can be opened inside the CRM instead of by email. The signing session is short-lived
and a returned URL outside the allowlist is refused, because that would be an open redirect with a live
signing session attached.

Not every provider supports it. Dropbox Sign requires all signers of a request to use the same flow and
this integration does not offer that flow, so a request through that provider is refused for embedded
signing rather than half-configured.

## Signed documents

When a request completes and the artifacts feature is on, **Retrieve signed documents** fetches the
signed file set and, when the provider produces one, its completion evidence. Both are stored with the
request and can be downloaded by someone holding the download right.

- The downloaded file is the provider's own signed document, not a rendering by the CRM.
- Google Drive links, "signing links" and other bearer URLs are never stored as the artifact.
- Retention is the administrator's choice; the default keeps completed artifacts until someone removes
  them.

## What you can and cannot do

| Action | What it needs |
| --- | --- |
| See the menu and the list | The `use` right |
| Open a request | `use`, plus the record access your role gives you (`own`, `team` or `all`) |
| Draft, attach documents, edit recipients | `manageDraft` |
| Prepare the preview | `manageDraft` |
| Send | `send` |
| Decide an approval | `approve` |
| Void | `void` |
| Download signed documents | `downloadCompleted` |
| Read the audit and event history | `auditRead` |

A request you do not hold `read` for is absent from the list rather than shown empty. If a linked CRM
record is hidden from you by its own access rules, the request still opens, but the source record shows
as restricted and no name is invented for it.

Correction of an already-sent envelope is not open in this build: the action is refused and the refusal
is recorded. Void is the supported way to stop something that is out.

## Reports and operations

The E-Signature page carries the module's operational reports: requests created, completion rate, median
time to completion, pending approvals, recipients still waiting, exceptions, and volume by source record
or by owner, over a selectable window.

The operations panel — visible to holders of the connection-read right — is the administrator's view of
the callback inbox, the recovery queues and failed jobs. It is diagnostic, not a second send button.

## Limits worth knowing

- Documents are limited by type, count and size; the instance sets the numbers and the provider's own
  limit can be stricter.
- A sent request cannot be edited, and a request cannot be deleted.
- There is no bulk send and no CLM; a request is one document set to one recipient group.
- Dropbox Sign requests cannot be embedded, cannot produce completion evidence, and are created at the
  moment they are sent.
- Approval binds the exact preview. Editing after approval means asking again.
