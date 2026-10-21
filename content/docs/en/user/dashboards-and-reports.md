---
title: Dashboards and reports
summary: The tiles you open every morning, and the saved questions you run when someone asks how it went.
audience: user
order: 60
tags: [dashboard, dashlet, report, schedule]
related: [user/lists-and-views, user/import-export]
updated: 2026-10-21
---

Two screens answer two different needs. A [dashboard](/dashboards) is a wall of live tiles you look at. A
[report](/reports) is a question you saved, run when you need an answer, and export when someone needs the
numbers.

## Dashboards

Your home page is a fixed set of counters plus, for an administrator, the setup checklist. Anything you want
to watch properly belongs on a dashboard.

**Create one.** Open Dashboards, choose **New**, give it a name. A dashboard is yours; a shared dashboard is
visible to colleagues, and a portal user can only see their own.

**Add a dashlet.** The kinds available today are:

| Dashlet | What it shows |
| --- | --- |
| List | Records of one entity, up to twenty-five rows, no links out. |
| Chart | A bar chart drawn from grouped counts. |
| KPI | A single number. |
| Project tasks | The work in a project, grouped by triage, backlog, work, phase or sprint. |

Tiles run when the dashboard opens and when you press **Refresh**; a single tile can be re-run on its own.
The star marks the dashboard you want next time, and that choice is saved on your account.

> [!WARNING]
> A dashlet scans a bounded window of records, not the whole table. When it has to stop early, the tile says
> so on its own — read that note before quoting the number.

## Reports

**Build one.** Choose an entity, then the shape of the answer: a list, a summary number, a grouped table, a
chart, a matrix, or a KPI. Pick the columns, the row and column dimensions, the time grain (day, month,
year) and the metric — count, sum, average, minimum or maximum. Filters combine with **and**, and a preview
shows the answer before you save anything.

**Run and export.** A saved report can be re-run at any time and exported to CSV. Export needs a saved
report, and the same truncation rule applies: if the scan stopped early, the export warns you.

**Schedule it.** A report can be sent to its owner on a schedule. The default is Monday at 08:00; you choose
the pattern, and it can be paused or removed. Only the owner or an administrator can change a schedule. This
is the one place where the CRM sends email on its own.

**Limits worth knowing:** a report scans up to 2,000 records, groups at most 100 values, and an instance
holds up to 200 reports. Twenty rows are previewed at a time.

## Where to go next

- [Importing and exporting CSV](user/import-export) — when you need all the rows, not a picture of them.
- [Working with lists](user/lists-and-views) — a saved filter is lighter than a report.
