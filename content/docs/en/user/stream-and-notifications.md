---
title: Stream and notifications
summary: What the stream shows, how following works, what a mention does, and where notifications are not.
audience: user
order: 40
tags: [stream, follow, mention, notification]
related: [user/record-page, user/activities-and-tasks]
updated: 2026-10-22
---

The [stream](/stream) is the running record of what happened in the CRM: notes posted on records, fields
that changed, activities that were created. It reads newest first and loads thirty entries at a time.

## What you see

Three views decide whose updates appear:

| View | Contents |
| --- | --- |
| Followed | Records you follow. |
| My posts | Anything you posted yourself. |
| All | Followed plus your own posts. |

> [!NOTE]
> "All" is not the whole company. It is what you follow and what you wrote — a stream of everything every
> colleague did is not what this view means, and it is not what it shows.

Entries that belong to a portal or to a record you may not read are filtered out for you, so two people can
see different streams on purpose.

## Follow a record

Open the record and use the star in its stream panel. Following decides what reaches your stream and the
**Followed** view; it does not change your permissions.

## Write a note and mention someone

Type in the stream panel at the bottom of a record and press **⌘Enter** / **Ctrl+Enter**. A change you made
to a field is summarized in the stream as `Label → value`.

To pull a colleague in, write **@** and their name. A mention creates an in-app notification for them — but
only for internal staff, never for a portal user.

## The notification bell

The bell in the header is your own inbox. The badge on it is the number of unread notifications addressed
to you; it updates live as notifications arrive, and again each time you open the panel. A live connection
is kept open while the app is in the tab — including notifications created by background jobs and
workflows, which arrive the same way.

Clicking the bell lists your latest notifications, newest first — a mention, a case assigned to you or
replied to, an SLA warning or breach, a process task, a customer-success alert, an incoming call. Clicking
a notification opens the record it points at and marks it read; the check on a row marks only that one, and
**Mark all as read** clears the badge in one go. Reading is always explicit: opening the panel never clears
anything.

- A mention notifies internal staff only, and never a portal user.
- Reminders on activities are stored as in-app rows too; there is no email or popup delivery.
- The one message that does leave the system is a **scheduled report's** CSV, which is emailed to the person
  who scheduled it.

## Where to go next

- [Reading and editing a record](user/record-page) — the stream panel in context.
- [Search and the command palette](user/search) — when you need a record, not a story.
