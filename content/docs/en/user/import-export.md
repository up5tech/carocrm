---
title: Importing and exporting CSV
summary: The CSV round-trip on a list screen — what the file must look like and exactly what an import does.
audience: user
order: 70
tags: [csv, import, export, data]
related: [user/lists-and-views, admin/entities-and-fields]
---

Both buttons are on the [list screen](user/lists-and-views) of the entity you are working with, so an import
or an export always belongs to one record type.

## Export

Press **Export CSV**. The file is built from the records the current filter matches — the whole match, not
the page you are looking at, and not your sort order. Expect:

- one row per record, one column per field, except the password field and the bookkeeping columns
  (`id`, `createdAt`, `modifiedAt`, `createdById`, `modifiedById`, `deletedAt`),
- up to 10,000 rows,
- a Windows-style line ending and a name like `Contact-2026-10-21.csv`,
- a leading apostrophe on any cell that starts with `=`, `+`, `-`, `@` or a tab, so a spreadsheet cannot
  execute it.

The exported header row uses field names, not display labels — `emailAddress`, not "Email".

## Import

Press **Import CSV**, paste the file contents into the box, and confirm.

> [!NOTE]
> There is no file picker, no column mapping and no dry run. What you paste is what runs, so test with two
> or three rows first.

The file must be comma-separated, with the field names in the first non-empty line. Quoted cells are
supported, so a value containing a comma or a newline survives the round trip.

What happens to each row:

| Your file | The result |
| --- | --- |
| A column with no field of that name | The whole import stops. Fix the header. |
| No `id` column | Every row is **created**. Pasting the same file twice makes duplicates. |
| An `id` column | That record is **updated**; an id that no longer exists creates a new record instead of failing. |
| A true/false field | `true`, `1`, `yes` or `y` are all accepted, and the same in the negative. |
| A multi-select field | Split on a comma, a semicolon or a pipe. |
| A date or datetime | Written in the normal calendar form; it is stored as an instant. |
| A relation, a dropdown or an address field | Not importable through this screen. |

The run is synchronous and reports what it did: created, updated, skipped, and the row numbers of anything
it refused. It gives up after 50 errors. The ceiling is 5 MiB and 2,000 rows per import.

## A safe round trip

1. Export a handful of rows and open the file in a plain text editor.
2. Change the values you need, keep the header untouched, keep the `id` column.
3. Paste the first three rows and import. Check the record on screen.
4. Import the rest.

## Where to go next

- [Entities, fields and layouts](admin/entities-and-fields) — why a field may refuse to import.
- [Dashboards and reports](user/dashboards-and-reports) — reporting over the data instead of pasting it.
