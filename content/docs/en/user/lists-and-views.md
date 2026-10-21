---
title: Working with lists
summary: Columns, filters, saved views, sorting, inline edits and the bulk actions a list really has.
audience: user
order: 10
tags: [lists, filters, columns, bulk]
related: [user/record-page, user/import-export]
---

A list is the screen you land on when you open a record type, for example [Contacts](/Contact). Everything
on it is about one question: how do I get to the handful of rows I care about?

## Find rows

- **Search box** — type and press **Enter**. It matches the record name and the main contact fields (first
  name, last name, email, phone) and a record id exactly. It is not a full-text engine; see
  [search](user/search) for that.
- **Filters** — open the filter area, pick a field, an operator and a value, then **Apply**. Operators
  available today are contains, equals, not equals, greater than, less than, is empty and is not empty.
  Several filters are combined with **and** only. **Clear** removes them.
- Only a shortlist of fields is offered in the filter picker. If the field you want is missing, the list
  still shows it as a column and the search page can still find it.

## Save a filter

Choose a saved filter in the picker, or press **Save current filters** to keep what you have. A saved filter
belongs to you and is private. The screen can apply and save them; renaming, editing or deleting one is not
part of this build, so give it a name you will not regret.

## Arrange the rows

- **Sort** — click a column header. Click again to reverse.
- **Columns** — the Columns button chooses which fields are shown. Your choice is remembered per entity.
- **Density and page size** — both are remembered too, so a list you set up once stays set up.
- The address bar mirrors what you are looking at: filters, sort and page size are all in the URL, which
  means a list state can be pasted into a colleague's browser and land on the same rows.

## Change a cell without opening the record

For a short text or number field, click the cell (or focus it and press **Enter** or **Space**), type, then
press **Enter**. One field is saved at a time. Dropdowns, relations and dates are not editable this way —
open the record.

## Select and act together

Tick the boxes on the left of rows. A bar appears with the count, **Delete selected** and **Cancel**.

> [!WARNING]
> Bulk delete is the only bulk action in this build. There is no bulk assign, update, merge or email. After
> a bulk delete, a short undo window appears — a few seconds, and the rows come back as *new* records with
> new ids, so any link that referenced the old ids does not return.

## Export and import

The header carries **Export CSV** and **Import CSV** for the entity you are looking at. Both are covered in
[importing and exporting CSV](user/import-export).

## What can go wrong

| Symptom | Cause |
| --- | --- |
| The list says the entity is not available | Metadata for that entity failed to load. Reload; if it persists, ask an administrator. |
| A row you expect is missing | You do not have permission for it, or a filter is still applied. Check the URL. |
| Export produced more rows than you could see | Export follows the filter only — not your current sort or page. |

## Where to go next

- [Reading and editing a record](user/record-page) — what a record screen holds.
- [Dashboards and reports](user/dashboards-and-reports) — a list you keep coming back to belongs on a dashboard.
