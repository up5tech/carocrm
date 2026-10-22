---
title: Activities, tasks and the calendar
summary: Tasks, calls and meetings, the approval inbox at /tasks, email templates, and the month grid that shows them.
audience: user
order: 30
tags: [task, call, meeting, email-template, calendar]
related: [user/record-page, user/dashboards-and-reports]
updated: 2026-10-22
---

There are two different things called a task in this product, and mixing them up is the most common
confusion for a new user.

| Screen | What it holds |
| --- | --- |
| [My Tasks](/tasks) | **Approvals waiting on you**: workflow and process steps assigned to your account. |
| The activity records | The work you promised: [Tasks](/Task), [Calls](/Call), [Meetings](/Meeting), and email. |

## Activity records

A task is a to-do with a due date. Its statuses are Not started, Started, Completed, Cancelled and Deferred.
A call or a meeting is an activity with a start and an end, planned first and then held or not held. Email
has its own lifecycle, from draft to sent, and an inbound message arrives already marked as received.

Every activity can carry a reminder — an absolute date and time, or an offset before it — and a repeat of
daily, weekly, monthly or yearly.

> [!NOTE]
> A reminder is recorded as an in-app notification. This build has no email or popup reminder transport, so
> a reminder will not arrive on your phone. Plan around the [calendar](/calendar).

Activities attach to the records they belong to. Today the case screen and the project screen expose those
relation panels; on an account or a contact you create the activity itself and link the people and accounts
into it.

## Email templates

[Email Templates](/EmailTemplate) are the reusable subject and body behind an outbound email. The edit
screen is a workspace rather than a form: the draft on the left, the message as a recipient sees it on the
right.

- Write the body as HTML or as plain text — the two tabs are the two parts a send can carry.
- Click a placeholder under the editor to insert it at the cursor. The list is the field set of the record
  type chosen on the right, so `{{firstName}}` on a contact template means that contact's first name.
- Pick a **sample record** to see the placeholders filled with real values. The values come from records you
  are allowed to read, and nothing is stored or sent while you preview.
- Switch the frame between desktop and phone width before you send anything to a mobile mailbox.

When a placeholder has no value in the sample record the preview says so instead of hiding it: that token
will be empty in the message that goes out. A name that is not a field of the record at all is the usual
cause.

> [!NOTE]
> A campaign send personalises with the approved marketing placeholders (`recipientName`, `unsubscribeUrl`
> and the rest listed in the marketing guide), which is a narrower set than a contact's own fields.

## The month grid

[Calendar](/calendar) shows one month at a time. Choose which activity types appear, and whether you see
everyone's or only your own. Each day holds a few entries and then "+n more"; select a day to read the list.

Drag an entry to another day to move it. The time of day and the duration are kept, so a two-hour meeting
that starts at 14:00 still does. A recurring activity is marked, and a calendar note reminds you that times
are shown in your own zone — set that on [your profile](getting-started/your-profile).

The grid holds up to 500 entries. A busy month with a wide date window can quietly stop short, so narrow
the filters when something is missing.

## Approvals

The [My Tasks](/tasks) page groups work waiting on you into *Waiting for me*, *Answered* and *Everything*,
banners the overdue count, and marks an overdue due date in red. Open a row, choose the outcome and add a
comment to answer it. Twenty rows are shown at a time.

## Where to go next

- [Working with lists](user/lists-and-views) — filtering the activity list down to your week.
- [Dashboards and reports](user/dashboards-and-reports) — a project-task dashlet for a standing view.
