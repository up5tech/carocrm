---
title: Campaigns and audiences
summary: The campaign lifecycle, the audience lists it aims at, and the consent and suppression rules a send obeys.
audience: user
order: 120
tags: [campaign, audience, target-list, consent, suppression, email]
aliases: ["chiến dịch marketing", "email marketing", "danh sách khách mục tiêu", "gửi chiến dịch"]
related: [user/lists-and-views, user/record-page, user/customer-success, admin/settings-overview]
updated: 2026-10-21
---

The Marketing group in the sidebar holds four record types: **Campaign**, **Target List**, **Marketing
Consent** and **Suppression**. Campaigns and target lists are ordinary [record pages](user/record-page) with
one extra panel; consent and suppression are lists you read and, where your role allows, edit.

A campaign is the plan. It is not the message run: sending is a separate record the module writes, and this
build has no screen for it. You can prepare, check and retire a campaign; you cannot yet press one button and
mail a list.

## The lifecycle

`status` is never a field you set. A new campaign is created as a **Draft** — writing any other value on the
form is refused — and every change comes from a named command.

| Command | Runs on | Moves the campaign to |
| --- | --- | --- |
| Schedule | Draft | Scheduled |
| Unschedule | Scheduled | Draft |
| Start | Draft, Scheduled | Running |
| Pause | Running | Paused |
| Resume | Paused | Running |
| Complete | Running, Paused | Completed |
| Cancel | Draft, Scheduled, Running, Paused | Archived |
| Archive | Completed, Failed | Archived |

**Failed** is produced by the delivery runtime and by nothing you can press. **Archived** is final: retiring a
finished campaign is **Archive**, and stopping a live one is **Cancel**, which is the only command that
requires a reason. Cancel and Archive both land on Archived so a retired campaign stays readable instead of
deletable — the default role permissions do not include campaign delete.

## The lifecycle panel

On a campaign record, below the fields, the panel shows the commands the server says you may run in the state
the record is actually in, plus three always-available controls: **Check send readiness**, **Duplicate as
draft**, and **Preview audience**. Below them sit a red block listing blockers titled "Why this cannot run
yet", a warning block, and the command history: when, from, to, command, reason, actor.

> [!NOTE]
> Only a campaign you may edit sees the buttons. The server decides the list on every load, so a colleague in
> another team may see a different panel on the same record.

## Checking readiness, and what blocks a start

**Check send readiness** runs the send-readiness report for the campaign's next move — a Draft is judged as a
would-be Scheduled campaign, a Scheduled or Paused one as a would-be Running campaign. A material change
(audience, content, sender, purpose, timing — not the name) makes the stored report stale, and the panel says
so.

The things that stop a campaign being scheduled are configuration problems: no name, no type, no purpose, an
audience you cannot read, no linked email template, no sending account when the deployment has no default, an
inverted start/end window, an unknown time zone, a negative budget, or a purpose that contradicts the type.

Reaching **Running** adds execution gates on top of those, and this is the one you will meet today: a
**provider must be bound**. Until an administrator names a live sending provider in the Marketing Automation
settings, **Start** is still offered but refused, and the message reads "This campaign cannot be started yet."
followed by "No marketing provider is configured, so nothing may be sent. Set the provider key in Marketing
Automation settings." If a provider is named but not live, the blocker names it and its mode. **Schedule** is
not blocked by this, so you can prepare and queue a campaign long before the platform can send it. A global
send pause set by an administrator blocks the same way.

## Audiences

A target list is an audience *definition*, never a pile of email addresses. Two membership modes:

- `static` — curated membership,
- `dynamic` — a stored, versioned criteria document resolved when the list is refreshed.

Audiences may only name **Contact** and **Lead** records. The criteria is validated when you save it, against
the field list, the field's type, the operators that type understands, and your own permission to filter on
that field; SQL, formulas and fields you cannot read are refused at the write. The list shows the resolved
count and the last refresh, and the refresh itself, membership rows and per-member state are written by the
module — there is no add-members button on this screen.

> [!WARNING]
> Audiences are a separate capability and it is off in a fresh install. Saving a target list is refused until
> an administrator turns it on. The same is true of the template capability that seals content revisions.

A campaign links several included and several excluded audiences. Exclusion wins. A list you cannot read, a
campaign with no included audience, or the same list on both sides (which would resolve to nobody) are all
blockers.

**Preview audience** answers "how many of these people could actually be mailed", counting every resolved
recipient into one category: eligible, same record in several audiences, same address on another record, no
email address, invalid address, excluded by an audience, global do-not-contact, complaint, bounce, other
suppression, unsubscribed, consent unknown or pending, frequency capped, record not readable. One message per
normalised address, kept on the contact in preference to a lead. Resolution stops at a configured ceiling
(10,000 records by default) and says so when the numbers are partial.

## Consent and suppression

Consent is one decision per address, channel and purpose, and it is gated by the campaign's **purpose**, not
by how the message is worded. The states and the labels they carry on screen:

| Stored | On screen |
| --- | --- |
| `Unknown` | No record |
| `PendingConfirmation` | Awaiting confirmation |
| `Consented` | Subscribed |
| `OptedOut` | Unsubscribed |
| `Suppressed` | Do not contact |
| `Invalid` | Address invalid |

Only `Consented` authorises a marketing send, and only for the purpose recorded. Email is the only channel in
this release. A row is titled by its decision and keyed on a digest of the address, not the address itself;
`confirmedAt`, `withdrawnAt`, the actor and the confirmation token are written by the module, and a consent
row can never be deleted — a withdrawal is a fact. Moving an unsubscribed address back to `Consented` needs a
basis and a reason naming the evidence.

The `ServiceNotice` purpose is the single exemption from marketing consent, which is why choosing it is not
casual: a campaign claiming it must tick an acknowledgement, and that tick is attributed to whoever set it. A
`Newsletter` campaign cannot claim it at all.

A suppression is a block with a scope (`Global`, `Channel`, `Purpose`, `TargetList`) and a reason
(`GlobalOptOut`, `Complaint`, `HardBounce`, `InvalidAddress`, `ManualBlock`, `OperatorBlock`,
`LegalRestriction`, `UnknownUser`). Blocks beat consent. A complaint, a hard bounce, a global opt-out, an
operator block or a legal restriction cannot be lifted from the record; a manual block, an invalid address or
an unknown user can be revoked, and the revocation is stamped with who did it and why rather than deleting
the row. By default no marketer role can create or edit a suppression — blocking an address is treated as a
compliance act, so ask an administrator.

Recipients keep their own exit: the published preference and unsubscribe links resolve to a token page, not a
login, and that page is where a person changes their purposes.

## Where to go next

- [Working with lists](user/lists-and-views) — filtering campaigns by status, type and purpose.
- [Reading and editing a record](user/record-page) — the audience relations on a campaign.
- [Customer success](user/customer-success) — the account-side view of the same customers.
- [Settings overview](admin/settings-overview) — where the campaign, audience and template switches live.
