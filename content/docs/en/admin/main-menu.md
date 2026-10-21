---
title: The main menu
summary: Enable, rename, reorder and colour the sidebar every user sees — and what those controls cannot do.
audience: admin
order: 30
tags: [menu, navigation, sidebar]
related: [admin/settings-overview, admin/branding-and-localization]
updated: 2026-10-21
---

**Open this screen:** [Main menu settings](/admin/settings/menu).

The menu is one document. Your edits stay a draft until you publish the tab, and only the entries you
actually changed are stored — everything else keeps following whatever the product ships, so an upgrade can
still improve a row you never touched.

## What you can do to an entry

| Control | Effect |
| --- | --- |
| Enable / disable | A disabled entry is dropped from everyone's sidebar. Switched-off rows are listed at the end so you can turn them back on. |
| Rename | You pick a label, from the labels the product knows. A new word nobody has translated is not something this screen can invent. |
| Icon | From a fixed set of icons. |
| Accent | From a fixed palette, so a coloured entry still matches the interface. |
| Reorder | The up and down buttons, or drag one row. A dragged row can move within its own parent, not between groups. |
| Restore defaults | Throws away your overrides for the whole menu and returns to the shipped order and names. |

## What decides what a user finally sees

Four layers, applied in this order:

1. The shipped defaults.
2. This document — your renames, your order, your disabled entries.
3. Permissions. A user who may not read an entity never sees its row, however you have styled it.
4. Order, then the sidebar is rendered.

> [!WARNING]
> Permission is checked last, which means this screen can hide things but cannot reveal them. A menu entry
> for a module that is switched off, or for a record type a person may not read, stays invisible to them no
> matter what you set here. And hiding an entry is not a permission: the screen behind it is still guarded by
> the server, so a bookmark or a typed URL is refused on its own.

## When the change appears

Publishing the menu drops the navigation cache, so the sidebar follows on the next load — usually the next
click, never a restart. The menu is cached per person for thirty seconds, so a second browser may lag by
that much.

## What can go wrong

| Symptom | Cause |
| --- | --- |
| An entry will not drag into another group | Cross-parent moves are not supported. Reorder inside its own group. |
| A rename did not take | You saved a label the interface does not have. Pick an existing label. |
| A user says they cannot see what you enabled | Their role. Check [users, teams and roles](admin/users-teams-roles), not this tab. |
| The whole menu reset to defaults unexpectedly | **Restore defaults** was published. It clears overrides for every entry, not one. |

## Where to go next

- [Branding, language and time](admin/branding-and-localization) — the name and the mark around the menu.
- [Entities, fields and layouts](admin/entities-and-fields) — where a record type's own navigation settings live.
