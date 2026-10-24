---
title: Your home workspace
summary: What the home screen answers, in what order, and what each card links to.
audience: user
order: 25
tags: [home, tasks, calendar, dashboard]
related: [user/dashboards-and-reports, getting-started/find-your-way, user/activities-and-tasks]
updated: 2026-10-24
---

## What home is for

Home is the screen you open first, and it answers four questions in one order:

1. **What needs me now?** — the three cards under the greeting.
2. **What is on today?** — your agenda for the local day.
3. **What is the pulse?** — up to three numbers from the dashboard you land on.
4. **What changed?** — the latest entries from the records you follow.

It is not an inventory of the record types your instance has. There is no tile per module and no count
per module, so the page looks the same whether your instance enables four modules or forty. Counts per
module live in [dashboards](user/dashboards-and-reports), [reports](user/dashboards-and-reports) and on
each [list screen](user/lists-and-views).

## The greeting band

The large line is a greeting, and under it is today's date and your job title. Below that, one sentence
states the day: how many tasks are waiting for an answer, how many are overdue, and how many events are
on today. When nothing is waiting it says so instead of showing a row of zeros.

The band also carries the three things you do from here:

- **Search records** — type a name and press **Enter** to open the results page. The `⌘K` / `Ctrl+K`
  hint next to it opens the [command palette](getting-started/find-your-way) instead.
- **Create** — opens the same record types your sidebar offers, alphabetically. Pick one to open its
  new-record form.
- **Dashboards** — opens the dashboard screen, where you can star a board as your default.

## The three focus cards

Each card is one link, and its number is part of its accessible name.

| Card | Shows | Opens |
| --- | --- | --- |
| My tasks | How many tasks are waiting, how many are overdue and the two nearest due dates. | [My tasks](/tasks) |
| Today | How many events are on today and the next one's time. | [Calendar](/calendar) |
| Approvals | How many approval processes you are part of that are running. | [My tasks](/tasks), on its Approvals tab |

If a card cannot load it stays in place, says `This card could not load.` and offers **Retry**. The
other cards keep working: one failing source never blanks the page.

## Today's agenda

Up to six entries for your local day — calls, meetings, tasks and project tasks — with a time gutter
and a dot marking the type. Selecting an entry opens the record. When the day holds more than six, the
rest are counted as `+N more` and link to the calendar.

The day matches the [calendar](user/activities-and-tasks) screen: both use the same four activity types
and the same local day, so an entry you see here is an entry you see there.

## At a glance

Up to three KPI dashlets from the dashboard you land on. The dashboard itself — and which numbers it
shows — is decided in [Dashboards](user/dashboards-and-reports): the board you starred, otherwise one
scoped to your role, otherwise the first board you can see. If no board carries a KPI dashlet the panel
is simply absent; home never falls back to counting modules.

## Activity

The latest five entries from the stream you follow, with the author, a short relative time and a link to
the record. It is the same feed as [the stream](user/activities-and-tasks) filtered to **Followed**. When
the feed is empty, follow a record from its own page or use **Find a record to follow**.

## Administrators: the setup banner

While the first-run checklist is incomplete, an administrator also sees a slim banner under the greeting
with progress and the next two steps as links. It disappears at 100 %, and a user who is not an
administrator never sees it.

## Where to go next

- [Dashboards and reports](user/dashboards-and-reports) — where the numbers on this page come from.
- [Working with lists](user/lists-and-views) — filters, columns and saved views.
