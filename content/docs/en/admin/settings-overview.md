---
title: The administration area
summary: How the admin screens are organized, who may open each one, and how saving a setting works.
audience: admin
order: 10
tags: [admin, settings, permissions]
related: [admin/main-menu, admin/users-teams-roles]
---

Open [Administration](/admin/settings) from the sidebar or the command palette. The shell is a rail of tabs
on the left and one editor on the right.

## The tabs

What you see in that rail depends on you. The catalog is fixed by the product and grouped: system, users,
security, customization, messaging and integrations; a group with nothing left in it is not shown. Your own
list is then filtered by level, and the first tab you may open becomes the landing tab, which is why
two administrators can land on different screens from the same URL.

| Tab | Where it lives |
| --- | --- |
| General, Localization, Main menu, Layout | `/admin/settings/general`, `/localization`, `/menu`, `/layout` |
| Entity Manager, Attachments, Jobs, Audit log | `/admin/entity-manager`, `/admin/settings/attachments`, `/admin/jobs`, `/admin/audit-log` |
| Users, Teams, Roles, Portals | `/admin/settings/users`, `/teams`, `/roles`, `/admin/portals` |
| Authentication, Permissions, API keys, Internal | `/admin/settings/authentication`, `/permissions`, `/apiKeys`, `/internal` |
| Email, Notifications, Webhooks | `/admin/settings/email`, `/notifications`, `/webhooks` |
| Sales, Service Desk, Customer Success, Marketing, Chat, Voice, Extensions, Workflows, Processes | Their own module pages, reached from the same rail |

Three consequences people are surprised by:

- An administrator and a system administrator are the **same tier** in this build. There is no separate
  super-account, so "system administrator" in the interface is a label on a tab, not a higher power.
- A tab you may not open is missing from the rail. Opening its URL anyway gives you an empty rail and the
  message "This section is not available to you" — the data behind it is refused by the server.
- Module tabs appear only if the module is installed, so a fresh instance has a shorter rail.

## How saving works

Settings screens are backed by a **document**: the whole tab is one JSON document that you edit and publish
as a unit. Those tabs carry a save bar with **Publish**, **Discard** and **Reload**, and the tab in the rail
gets a dot while the draft differs from the saved version. Record screens — users, teams, roles, API keys,
permissions, email, internal tools — save each change immediately and have no save bar.

| What happened | What it means |
| --- | --- |
| A field error under the control, and nothing saved | The document failed validation. Fix it; the stored version is untouched. |
| "Reload the tab before saving" | Someone else saved first. Reload, re-apply your change, publish again. |
| The tab shows defaults you never set | The stored row could not be read as this document. The service fell back to defaults rather than erroring — check the audit log. |

> [!WARNING]
> Leaving an administration tab with unsaved changes warns you only when the browser reloads or closes.
> Clicking another tab in the rail is guarded; typing a new address is not.

## What can go wrong

| Symptom | Where to look |
| --- | --- |
| A setting publishes and nothing changes | The screen that consumes it caches. Jobs and jobs-like data refresh on their own; check the tab's own note. |
| The sidebar did not follow a menu change | [The main menu](admin/main-menu) — the navigation cache is dropped on save. |
| A user cannot see a screen you can | [Users, teams and roles](admin/users-teams-roles). Hiding a control in the interface is not a permission; the server decides. |

## Where to go next

- [The main menu](admin/main-menu) — what the sidebar shows to everyone else.
- [Entities, fields and layouts](admin/entities-and-fields) — when a screen is missing a field you need.
- [Audit log](/admin/audit-log) and [jobs](/admin/jobs) — what to read when something is wrong.
