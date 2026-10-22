---
title: Reading and editing a record
summary: The panels a record is made of, how saving works, and what protects you from losing changes.
audience: user
order: 20
tags: [record, edit, panels, stream]
related: [user/lists-and-views, user/stream-and-notifications]
updated: 2026-10-22
---

Open any row and you are on its record screen: a title bar with **Edit** and **Delete**, then the panels that
make up the record, then its relations and its stream.

## What the panels show

The order and the names of the panels come from the record's layout, which an administrator can change —
so two instances of the same product can present the same record differently. Fields that are not placed in
any panel appear under **Other**, at the bottom. Nothing is hidden from you by an unplaced field; the
difference is only where it sits.

Under the panels are the relations: the accounts, contacts, cases or projects this record belongs to. Each
relation panel shows one page of its rows — five by default, and the pager under the table shows how many
rows the relation has in all and steps through them; you can widen the page there too. The panel offers
**Link existing**, **New** and **Unlink**. When a record has several relations, they appear as tabs instead
of stacked panels, and the tab you are looking at is written into the address, so a link can open a record
already on the right tab.

> [!NOTE]
> **New** on a relation panel opens a blank create form. It does not pre-fill the parent record, so link the
> new row back to this one or it will look like the record vanished.

## Editing

**Edit** replaces the read-only view with a form. Fields marked as required are enforced before the form is
accepted, along with a maximum length and the shape of an email or web address.

A rule set on the entity can hide, require or block a field depending on what else you typed. When a rule
blocks the save, the form tells you which field is the reason rather than failing silently.

Press **⌘Enter** / **Ctrl+Enter** to save, or use the **Save** button. Two records with the same name in the
same place prompt you to confirm — usually a double-click on **Create**.

## Losing changes

If you leave an unsaved form, the browser asks whether you really want to go. That guard covers closing the
tab or reloading; it does not cover clicking away inside the application. Save before you navigate.

## Deleting

**Delete** asks for confirmation and then returns you to the list. A deleted record is not gone from the
database, but it is gone from your screens; recovering it is an administrator's job.

## Where to go next

- [Activities, tasks and the calendar](user/activities-and-tasks) — logging the calls and meetings.
- [Stream and notifications](user/stream-and-notifications) — following a record and mentioning a colleague.
