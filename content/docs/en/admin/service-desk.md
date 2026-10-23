---
title: Configuring Service Desk
summary: Administer case numbering, resolution, routing fallback, SLA clocks and email replies from one validated settings document.
audience: admin
order: 132
tags: [service-desk, settings, queues, sla, email-to-case, business-calendar]
aliases: ["cấu hình bàn hỗ trợ", "hàng đợi case", "mục tiêu SLA", "tự động phân công"]
related: [admin/settings-overview, admin/module-settings, admin/email-and-notifications, admin/portals, user/service-desk-cases]
updated: 2026-10-22
---

Service Desk keeps one validated settings document named `serviceDesk`. It decides which capabilities
accept work, how cases are numbered, what resolving requires, where routing falls back, and which address
replies use. The agent-facing result is described in [Cases, queues and SLAs](user/service-desk-cases);
this page is the configuration side.

## The tab and how saving works

[Settings → Service Desk](/admin/settings/serviceDesk) is a tab of [the administration area](admin/settings-overview).
It shows the document's version, one row per policy value, and a warning banner when the document reports
a problem. **Save** posts the whole draft to `POST /api/v1/ServiceDesk/action/settings`; the module merges
it over the stored document, validates the merged result against its strict schema, and refuses the write
whole if a value is invalid or a key is unknown. The stored version stays untouched and the tab shows the
refusal. An accepted save increments the version, records who saved it, and updates the module's cached
copy. **Discard** returns to the loaded version; **Reload** fetches the stored one.

The tab is mostly a switch-and-number editor. Booleans get a switch, numbers a number box, and only a
null value gets a text box. A string is shown in a single-option select and a list as one JSON value, so
neither can be edited from the tab. Post the leaf you want to `POST /api/v1/ServiceDesk/action/settings`
instead, for example `{"features":{"queues":true}}` or `{"resolution":{"codes":["Solved","Duplicate"]}}`.

> [!NOTE]
> There is no conflict check. Save writes the draft you loaded, so Reload before saving if another
> administrator may have edited the document. A stored row that no longer satisfies the schema reads as
> defaults rather than reporting an error.

## What starts on and off

| Feature | Default | What it controls |
| --- | --- | --- |
| Case management | on | Create, edit and conversation commands on cases |
| Queues and routing | off | Assign, route and queue configuration writes |
| SLA policies and clocks | off | Policy matching and clocks for new cases |
| Email-to-case | off | Inbound polling and email replies |
| Customer portal access | off | Every portal decision on a case |
| Knowledge base | off | Article commands and article expiry |
| Customer satisfaction | off | Survey invitations and the dashboard average |
| Case notifications | off | Notification rows written by the module |

A flag stops new work; it does not hide history. With case management off, case create and edit are
refused but existing cases stay readable. With queues off, queue fields already on a case are still
visible, but assign and route are refused. The `requires` lists shown by module health are advisory: the
settings schema accepts any combination. Turning email-to-case on without a mailbox saves, but the flag
does not configure one: the email module must already be fetching inbound mail. Turning satisfaction off
stops new invitations and hides the dashboard average; a token already issued can still be submitted
until it expires.

## Numbering

`prefix` is 1–16 characters, trimmed, must start with a letter and may contain only letters, digits or
dashes; the default is `C`. `padding` is a whole number from 1 to 12, default 6. A number is the prefix plus
a Postgres sequence value padded to that width, so the defaults produce `C000001`. Padding is presentation
only: the sequence value is unique, and a number that outgrows the padding simply gets longer. Changing
the prefix or padding affects the next allocation, never an existing number, and a save does not reset the
sequence. An admin-only preview shows the next formatted number without consuming it.

## Defaults

`status`, `priority`, `type` and `source` accept one value of the case enums; defaults are `New`, `Normal`,
`Question` and `Web`. The group is validated and stored, but no server path reads it when a case is
created: entity metadata supplies the initial values, and email-to-case hard-codes `Email` as the source.
Change this group only for completeness; change field defaults in metadata if you need different forms.

## Resolution

| Field | Range or default | Effect |
| --- | --- | --- |
| `requireCode` | boolean, on | Resolving without a code is refused |
| `requireSummary` | boolean, off | Resolving without a summary is refused |
| `codes` | up to 50 strings, 1–64 characters | A typed code must be in the list |
| `reopenWindowDays` | whole number 0–3650, default 0 | Days after resolution when reopen is refused; 0 means no limit |

The default code list is `Solved`, `Workaround`, `Duplicate`, `No Response`, `Not Reproducible` and
`Information Provided`. An empty list accepts any non-empty code, and a code is only checked when one is
typed. Closing only runs from `Resolved`. Reopening a `Closed` or `Cancelled` case also needs a broader
permission than an ordinary edit. The window is measured from the case's `resolvedAt`; a case without that
timestamp is not refused by the window.

## Assignment

`defaultQueueId` is a queue id or empty, default empty. It is read only by **Route**: when no routing rule
matches, the case goes to that queue if it exists and is active, and a matched rule that names no queue
also falls back to it. A missing or inactive queue is ignored and the case keeps its current queue and
owner. The id is not checked when you save, so a typo is accepted and silently ignored at routing time.
The field does nothing while queues are off, because Route itself is refused. It does not assign every
new case. The tab can fill the value only while it is empty; change a set id through the endpoint.

## SLA

The document's SLA group has one field: `lastScanAt`, the timestamp of the last successful scheduled scan.
The scan writes it without bumping the settings version, and editing it changes nothing. Everything that
shapes the clock lives on records instead. An `SLAPolicy` holds first-response, next-response and
resolution targets in minutes, its conditions, priority, pause flags, warning thresholds and an optional
`BusinessCalendar`. A `BusinessCalendar` holds weekly intervals, holiday dates and an IANA time zone.

When SLA is on, a new case takes the active policy with the lowest priority number whose conditions match.
No matching policy means `NotApplicable` and no clocks; a zero-minute target creates no clock. Clocks count
business minutes when the policy names a calendar: intervals are evaluated in the calendar's own time
zone, holidays are skipped, and an empty or unreadable interval set falls back to wall-clock minutes. An
invalid time zone is treated as UTC.

`Pending Customer` and `Pending Internal` pause the clocks when the policy says so. Resuming shifts each
deadline by the business minutes spent paused rather than shortening the target, and a paused clock is
never breached. The worker's scan runs every five minutes and examines at most 500 clocks per pass. A
reached warning threshold sets `Warning`; passing the due instant sets `Breached`, escalates the case and
notifies its assignee and followers. Escalation is recorded even when notifications are off; only the
alerts are suppressed. A closed or merged case is marked without being re-notified. Turning SLA on does
not create clocks for existing cases, and the scan still expires knowledge-base articles when SLA is off.

## Email

`replyFromAddress` is one email address or empty, default empty. It is used only as the `fromAddress` of
the outbound Email record created when staff reply to a case by email; empty means the sending account or
the process-wide transport default. It does not affect inbound intake and carries no display name. The
email-to-case feature must also be on for the reply command to run.

## What is stored but not enforced

| Setting | What actually happens |
| --- | --- |
| `defaults.*` | No server path reads it; new cases use metadata defaults |
| `assignment.defaultQueueId` | Only a Route fallback; existence is not checked on save |
| `sla.lastScanAt` | Operational metadata, overwritten by each scan |
| Feature `requires` lists | Shown by module health, not enforced by the validator |

## Troubleshooting

| Symptom | Field or prerequisite |
| --- | --- |
| Case create or edit is refused | Case management is off |
| New cases get an unexpected status or source | `defaults` is not applied; check field metadata and the intake channel |
| Case numbers changed format | `numbering.prefix` or `padding`; existing numbers are not rewritten |
| Resolve is refused for a missing code | `resolution.requireCode` is on, or the typed code is not in `codes` |
| Reopen is refused | `reopenWindowDays` has passed, or a closed or cancelled case lacks the broader permission |
| Route leaves the case unowned | Queues off, no rule matched, and the default queue is empty or inactive |
| SLA state is `NotApplicable` | SLA off, or no active policy matches the case |
| A clock never warns | Policy warning thresholds, the calendar's intervals, or the clock is paused |
| A breach happens but nobody is told | Case notifications are off |
| A portal user sees no cases | Portal feature off, or the case is marked hidden |
| The satisfaction average is missing | Customer satisfaction is off |

## Where to go next

- [Cases, queues and SLAs](user/service-desk-cases) — what an agent does with these settings.
- [Portals](admin/portals) — portal roles and the case flag they depend on.
- [Email and notifications](admin/email-and-notifications) — the mail connection email-to-case uses.
- [Module settings](admin/module-settings) — the settings document map.
