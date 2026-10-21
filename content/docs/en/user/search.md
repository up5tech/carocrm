---
title: Search and the command palette
summary: Finding a record across the CRM, and finding a screen without knowing where it lives.
audience: user
order: 50
tags: [search, palette, find]
related: [getting-started/find-your-way, user/lists-and-views]
---

Two tools answer two different questions: **search** finds a record, the **command palette** finds a screen.

## Search across records

Open [Search](/search), or type in the header box and press **Enter**.

1. Enter what you remember: a name, part of a name, an email address, a phone number, or an exact record id.
2. Narrow the scope with the entity selector. Left alone, it searches the types you can read.
3. Results arrive grouped by entity, with a count in each group. Select a row to open the record.

What it does not do is worth knowing before you rely on it:

- It is a substring match over a small set of fields, not full-text search. A word inside a note body will
  not be found.
- Ten hits per entity is the ceiling, and up to twenty-five entity types are queried at once. A search that
  looks short may simply have stopped.
- Types you cannot read are skipped silently — an empty result can mean "no match" or "no permission".
- There is no paging of results and no field-level filter here. For that, use a list with
  [filters](user/lists-and-views).

## The command palette

Press **⌘K** / **Ctrl+K** anywhere. Three modes, picked with the tabs at the top:

| Mode | Use it when |
| --- | --- |
| Commands | You know the screen: home, search, dashboards, reports, stream, calendar, my tasks, administration. |
| Records | You know the *type* but not the URL — it lists entity pages you may read, up to twelve. |
| Recent | You were just there. The last twenty pages you visited. |

The palette navigates. It does not create a record, and "Records" means the list page of an entity rather
than an individual contact.

> [!TIP]
> "Recent" is stored on your own device, and only a few routes are remembered: your home page,
> administration pages, and account and contact screens.

## Where to go next

- [Finding your way around](getting-started/find-your-way) — the sidebar and the header box.
- [Working with lists](user/lists-and-views) — filtering is more precise than searching.
