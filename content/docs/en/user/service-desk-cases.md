---
title: Cases, queues and SLAs
summary: The support case lifecycle, queue routing, the SLA clock and satisfaction surveys — and which of them are switched on.
audience: user
order: 90
tags: [case, service-desk, queue, sla, csat, support]
aliases: ["yêu cầu hỗ trợ", "case hỗ trợ khách hàng", "ticket", "chuyển case"]
related: [user/record-page, user/lists-and-views, user/activities-and-tasks, user/stream-and-notifications, admin/settings-overview]
updated: 2026-10-21
---

A case is a support request tracked on the [Case list](/Case). One thing shapes everything here: only
**case management** is on by default. Queues, SLA, email-to-case, the portal, the knowledge base, CSAT
and notifications are separate switches in Service Desk settings and start **off**, so a control or a
number this page describes may simply not be present until an administrator turns it on.

## The case record

The fields you fill are subject, description, status, priority, type, source and the requester — an
account, contact or lead, or a name and email when the channel only knows an address. The classification
values are fixed lists you can configure through metadata:

- priority: `Low`, `Normal`, `High`, `Urgent`;
- severity (impact, kept distinct from priority): `Low`, `Normal`, `High`, `Critical`;
- type: `Question`, `Incident`, `Problem`, `Service Request`;
- source: `Web`, `Email`, `Portal`, `API`, `Web Form`, `Workflow`, `Phone`.

The case number is allocated by the server (`C000001`), and the timing, SLA, escalation and ownership
fields are server-owned — you cannot set them by editing the record.

## Lifecycle

Every status change is a command, not a field write, and the buttons you are shown are the ones the
server says the current actor may run on this case from its current state: **Start**, **Pending
customer**, **Pending internal**, **Escalate**, **De-escalate**, **Resolve**, **Reopen**, **Close**,
**Cancel**. A case in `New`, `Open`, `Pending Customer`, `Pending Internal`, `Escalated`, `Resolved`,
`Closed` or `Cancelled` sees only the moves its state allows; the rest are absent.

- Resolving normally requires a resolution code (required by default); a resolution summary is optional
  unless configured.
- Closing only runs from `Resolved`.
- Reopening a `Closed` or `Cancelled` case needs a broader permission than an ordinary edit, and a
  configured reopen window can refuse it once the case has been resolved too long.
- A resolved or closed cycle is never erased — the reopen keeps the earlier timestamps and the status
  history below the buttons.

The conversation panel distinguishes a **Public reply**, which the requester sees, from an **Internal
note**, which they never do. A public reply is what satisfies a first-response target.

## Queues and routing

When queues are enabled, a case belongs to a `CaseQueue` that assigns work with one of three strategies —
`manual`, `roundRobin` or `leastBusy` — and a fallback for when no eligible member exists (`unassigned`
or a configured owner). Routing rules match a case on `source`, `priority`, `type`, `severity` or
`status` with `equals`, `notEquals` and `in`; a rule's conditions are ANDed, and only that fixed field
list is ever evaluated, so a rule can reach no arbitrary data. On a case the assignment controls are
**Assign to queue** and **Route**.

A queue's own page shows the workload: how many cases sit unassigned and how many active cases each
eligible agent already holds. If a queue has nobody eligible, the case stays in the queue rather than
being forced onto someone.

## The SLA clock

When SLA is enabled, each case is matched to an `SLAPolicy` on its creation — the active policy whose
conditions it satisfies, lowest priority number winning. A policy sets first-response, next-response and
resolution targets in minutes. A clock per target runs against a `BusinessCalendar` (weekly working
intervals and holidays, evaluated in the calendar's own time zone); with no calendar it counts wall-clock
minutes.

- The case-level `SLA state` summarises the clocks: `NotApplicable`, `OnTrack`, `Warning`, `Breached`,
  `Paused` or `Met`.
- A clock enters `Warning` at a configured threshold (75% by default) and `Breached` when it passes its
  due instant.
- `Pending customer` and `Pending internal` pause the clock when the policy says so; resuming shifts the
  deadline by the business minutes spent paused rather than shortening the target.
- A breach escalates the case and notifies its watchers (the assignee and followers), deduplicated, and
  only while the case is still active. A scheduled pass runs this in bounded batches.

## CSAT surveys

When CSAT is enabled a satisfaction survey can be invited once the case is `Resolved` or `Closed`. The
invitation is a single-use token that expires after seven days, and a reopened case gets a fresh cycle.
The customer opens the survey page (`/csat`) with that token, gives a 1–5 rating and optional feedback,
and submits once. The page never names or loads the case, so a leaked link reveals nothing else. Staff
see the average on the Service Desk dashboard, not per case.

> [!NOTE]
> The current screens have no "Invite survey" button on the case itself, and no merge, duplicate-detection
> or knowledge-base panel on the case page. Those exist as commands and endpoints, not yet as controls here.

## Where to go next

- [Record page](user/record-page) — how the lifecycle and conversation panels sit on a case.
- [Lists and views](user/lists-and-views) — filtering cases by status, priority and SLA state.
- [Settings overview](admin/settings-overview) — turning queues, SLA and CSAT on.
