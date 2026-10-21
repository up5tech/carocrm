---
title: Entities, fields and layouts
summary: Add a record type, add a field, and rearrange the panels — without a code change or a deploy.
audience: admin
order: 60
tags: [entity, field, layout, metadata]
related: [admin/settings-overview, admin/main-menu]
---

The CRM is driven by metadata: what a record type is, which fields it has, how its screens are arranged. All
of it can be changed at runtime from [Entity Manager](/admin/entity-manager), and every change is applied to
the running instance as soon as you save it.

> [!NOTE]
> Metadata describes the screens and the API. It does not move columns in the database, and an index you add
> here is a declaration, not a migration. Anything that changes the physical schema is a deployment task.

## Create a record type

Choose **Create** and give it a name in PascalCase, like `Warranty`, and a label. A new entity arrives with
the bookkeeping fields every record has — id, name, description, created and modified stamps, creator and
editor, assigned user, teams, and a soft-delete marker — plus one short text field for a code.

Then decide how it behaves:

| Setting | Where |
| --- | --- |
| Label and icon | The entity's own card |
| Enabled or disabled | Turns the type into something the interface ignores |
| Navigation | Its group in the sidebar, its order, whether it is hidden, and what a board view groups by |
| Relations | Which other types it points at, and what those rows are labelled |
| Dynamic logic | Rules that hide, require or set a field depending on what else is typed |

A disabled entity is not deleted: its records stay in the database, the interface stops offering it.

## Fields

Add a field from the entity's field list. The types you can pick today:

```text
varchar  text  int  float  decimal  bool  date  datetime
enum  multiEnum  currency  url  email  phone  link  linkMultiple  formula
```

Two limits matter more than the list:

- **A field's type cannot be changed after it is created.** Pick deliberately, or add a new field and
  disable the old one.
- **Removing a field disables it; it does not delete it.** The values stay, and the field stops appearing on
  screens and in exports. A field cannot be renamed in a way that reuses the old name for something else.

Renaming a field's *label* is safe at any time — that is text, not data.

## Layouts

Layouts decide the order of what a person reads. The editor covers three views:

| View | What it controls |
| --- | --- |
| List | Which fields are columns. A field left out is not a column; it is still on the record. |
| Detail | The panels on a record screen, and the fields inside each one. |
| Edit | The same shape for the create and edit form. |

Drag a field between a panel and the pool, rename or remove a panel, reorder them, and the preview on the
right shows the result before you save. Fields that end up in no panel are grouped under **Other** at the
bottom of a record, so nothing becomes unreachable. When a record has two or more relations, the detail view
can arrange them as tabs instead of stacked panels.

> [!NOTE]
> Filter, search and mass-update layouts exist in the metadata but have no editor on this screen. They are
> read-only here.

## What can go wrong

| Symptom | Cause |
| --- | --- |
| Saving a layout is refused with a field error | A panel names a field that does not exist, or one you disabled. |
| A new field does not appear | It is not in the layout. Drag it into a panel, or accept it under **Other**. |
| The change vanished after a reload | Two administrators editing the same entity. Reload and re-apply. |
| The sidebar did not gain the new type | Navigation for the entity, then [the main menu](admin/main-menu). |

Every metadata write is recorded in the [audit log](/admin/audit-log), so you can see who changed what field.

## Where to go next

- [Importing and exporting CSV](user/import-export) — which field types take data in.
- [The administration area](admin/settings-overview) — how the rest of the admin screens are arranged.
