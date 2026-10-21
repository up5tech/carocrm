---
title: Glossary
summary: The vocabulary this interface actually uses — including the four words that mean something other than what they look like.
audience: user
order: 10
tags: [glossary, terms, vocabulary, entity, field]
related: [user/record-page, user/lists-and-views, admin/entities-and-fields, reference/permissions-matrix]
updated: 2026-10-21
---

This is the words-as-this-product-uses-them list. It is written from the screens and the server, so a
definition here matches the label you can click. Four terms are deliberately called out below because
they mean something other than what a newcomer expects.

## Records and their shape

| Term | What it means here |
| --- | --- |
| Record | One row of one record type: one contact, one case, one project task. It has an id, a name, and the bookkeeping columns every record carries. |
| Entity | The technical name of a record type. Entities are named in PascalCase (`Contact`, `ProjectTask`) and that name is what appears in addresses and in CSV headers. |
| Field | One value slot on a record. Its type is fixed once the field is created; renaming its label is always safe. |
| Metadata | The description of every entity, field, relation and layout. It is read at runtime, so an administrator's change applies without a deploy. |
| Layout | The order things appear in: which fields are list columns, which panels a record shows, which fields sit in the edit form. |
| Panel | A titled group of fields on a record screen or in the form. Fields placed in no panel are collected under **Other** at the bottom. |
| Relation | The link from one record to another, and the panel that lists them. Each relation panel shows up to 50 rows and offers **Link existing**, **New** and **Unlink**. |
| List | The screen for one entity: rows, columns, filters, sort, page size, and the CSV buttons. |
| Board | The second view of a list — one column per value of an enum field, one card per record. Dragging a card writes that field. A list offers it only when a field can be grouped by. |
| Filter | A condition you apply to a list. Several filters combine with **and** only. |
| Saved filter | A filter you kept. It belongs to you and is private; this build can apply and save one, not rename or delete one. |
| Stream (of a record) | The running history on a record: notes posted, fields changed, activities created. |
| Soft delete | A delete that marks the record rather than erasing it. It leaves your screens; recovering it is an administrator's action. |

## People and permission

| Term | What it means here |
| --- | --- |
| Role | A matrix: for each entity, for each action, a level. The same matrix can restrict individual fields. |
| Level | One cell of that matrix. `no`, `own`, `team`, `all`, `yes` — see [who can see what](permissions-matrix). |
| Team | A named group of people, plus the roles that apply **through** it. Team membership is what the `team` level reads. |
| Administrator | The single administrative tier. An administrator and a "system administrator" are the same thing in this build; there is no separate super-account. |
| API account | An account that is not a person. It has a sign-in name and roles, exactly like a user. |
| API key | A credential belonging to an API account. A key is never narrower and never wider than the account that owns it. |
| Portal | A separate surface for people outside your organisation. A portal user is tied to one portal and one contact record. |
| Portal role | The authority of a portal user. Portal roles are their own set: an internal role can neither be assigned to a portal user nor leak access to them. |
| Assigned user | The one record field that decides ownership: at the `own` level, a record is yours if you are its assigned user or you created it. |

## Work around the records

| Term | What it means here |
| --- | --- |
| Stream (the page) | [The activity feed](/stream) of what you follow and what you wrote, newest first, thirty entries at a time. |
| Follow | The star on a record's stream panel. It decides what reaches your stream; it changes no permission. |
| Mention | Typing **@** and a name in a stream post. It creates an in-app notification, for internal colleagues only. |
| Notification | A stored row saying you were mentioned or assigned. There is no bell and no unread badge, so nothing surfaces it for you. |
| Activity | The record types that are work with a time: `Task`, `Call`, `Meeting`, `Email`. |
| My Tasks | [The approval inbox](/tasks) — workflow and process steps waiting on your account. It is not the `Task` list. |
| Process | A multi-step approval: it parks on a person's step until they answer, and every step is recorded. Answered at **My Tasks**. |
| Workflow | Automation triggered by a record being created, updated, deleted or restored. Conditions and actions are configured, never scripted, and the worker executes them. |
| Case queue | A Service Desk routing list: cases arrive, the queue hands them to a member in order or by workload, and `manual` leaves them unassigned. Off until an administrator switches it on. |
| Job queue | The background work line behind [the Jobs screen](/admin/jobs): submitted jobs, retries, and the scheduled ones the worker runs on a clock. |
| SLA | A Service Desk response promise: first response, next response and resolution minutes, counted against a business calendar, with a warning threshold. Off by default. |
| Playbook | A Customer Success template of ordered steps and a trigger. Starting one makes a run, which keeps the steps it started with even if the template is edited later. |
| Document | Two distinct things. A **settings document** is one admin tab's JSON, edited as a unit and saved with the tab's **Save** button. A **document** made from a record is a printed rendering of it — a quote, a letter — filled from a stored template. |
| Attachment | A file stored against a record. Reading one is guarded by the parent record's permission. Record forms have no file field, so files arrive through a screen that offers one, or through the API. |
| Audit log | The field-level record of who changed what, including every metadata change. Secrets are redacted before a row is written. |
| Extension | An installed package that contributes entities, fields, screens or jobs. Installing one is an audited action and asks for a restart; the API never loads code at runtime. |

## Reports and dashboards

| Term | What it means here |
| --- | --- |
| Dashboard | Your own wall of live tiles. A shared dashboard is visible to colleagues. |
| Dashlet | One tile. The kinds today are list, chart, KPI and project tasks. |
| Report | A question you saved — a list, a number, a grouped table, a chart, a matrix or a KPI — that can be re-run, exported and scheduled. |
| Truncated | A number that stopped early because the scan hit its bound. The tile or the export says so; read that before quoting it. |

> [!WARNING]
> Four words to distrust. **Tasks** at `/tasks` are approvals, not the `Task` activity entity. A **queue**
> is either a case routing list or the background job line, depending on which screen you are on. A
> **stream** is both a page and a panel on a record, and also the name of the permission that lets you post
> on one. And a **document** is either a settings tab's stored JSON or a printed rendering of a record.

## Where to go next

- [Reading and editing a record](user/record-page) — the panels, relations and stream in place.
- [Working with lists](user/lists-and-views) — filters, columns and the board.
- [Entities, fields and layouts](admin/entities-and-fields) — the administrator's side of these words.
- [Who can see what](reference/permissions-matrix) — the level vocabulary in one table.
