---
title: Who can see what
summary: The five actions, the five levels, how several roles add up, and the reason a button you expected is not there.
audience: user
order: 40
tags: [acl, permission, role, level, button]
related: [admin/users-teams-roles, reference/glossary, reference/troubleshooting, user/record-page]
updated: 2026-10-21
---

Permission is decided by the server, in this order: what kind of account you are, then what your roles say
for that entity and that action, then which records that level covers, then which fields of the records that
survive you may read or write. A control hidden in the interface is convenience. The screen behind it asks
the same questions again, and refuses.

## The five actions

| Action | What it lets you do | What it does not give you |
| --- | --- | --- |
| create | Make a new record, and run an import of new rows on that entity. | Editing records that already exist. |
| read | See the record in a list, open it, find it in search, and export it to CSV. | Changing or removing anything. |
| edit | Change a saved record, including a cell edited from the list. | Creating a record or deleting one. |
| delete | Remove a record, including **Delete selected** on a list. | Recovering it afterwards; that is an administrator's action. |
| stream | Post a note on a record's stream. | Reading the stream, which needs `read`. |

There is no sixth action in this vocabulary. There is no `export`, `print`, `assign` or `approve` permission:
export rides on `read`, and an approval step reaches you because a process assigned it to you, not because a
role grants a permission.

## The five levels

| Level | Reach over the records |
| --- | --- |
| no | None. The entity is absent from your sidebar and from search, and a direct call is refused with `No "edit" permission for "Contact".` |
| own | The records you created, or that name you as the assigned user. |
| team | The records that carry a team you belong to. |
| all | Every record of that type. |
| yes | Also every record. It only differs from `all` when two roles are merged, where `yes` outranks it. |

A cell the role never mentions counts as `no`. A role may declare one `*` entry as its default for every
entity it does not name, so an unexpected level on one entity can come from that default rather than from a
row you were looking at.

## How several roles add up

- Your effective level for an entity and action is the **highest** level across all your roles — including
  the roles that reach you through a team.
- Nothing is subtractive. A second role can only widen what the first allows; there is no way to write a
  role that takes a permission away.
- The record scope of the winning level is then applied. A `team` role plus an `own` role means `team`, so
  the records you are assigned but that sit outside your teams are covered too.
- An account with no roles at all is refused everything, with the reason recorded as no roles assigned.
- Inside a project, a project role can narrow `own` or `team` further for the project's records. It cannot
  grant anything the global levels denied: an outsider with no global access stays an outsider.

## Fields come after records

| Rule | What it means for you |
| --- | --- |
| A field has two actions only: read and edit. | There is no per-field create or delete. |
| A field no role mentions is unrestricted. | Field rules are opt-in, per entity. |
| Read level `no` on a field. | The value is removed by the server before the record reaches your browser, on lists and on the record. |
| Edit level `no` on a field. | A save that touches it is refused: `Field(s) emailAddress cannot be modified.` Everything else in the payload can still be written. |

> [!WARNING]
> A field your role may not edit is **not** greyed out in the form. The form's read-only states come from the
> rules on the entity and from computed fields, not from field permissions, so the refusal arrives when you
> press Save. Expect the message, not a disabled control.

## The accounts that sit outside the role tables

| Account | How its access is decided |
| --- | --- |
| Administrator | The matrix is skipped: an effective `all` on every entity, and every field open. An account is administrative when it is active and marked as an administrator, or is of the admin type, or holds the system-administrator role. |
| API account | Exactly like a person: its roles are the whole story, and an API key is never wider than the account that owns it. |
| Portal user | Internal roles are never read for them. Their authority comes only from portal roles, and their reach is the neighbourhood of their own contact and account — a portal role at `all` still cannot open a record outside it. |
| A scheduled job | It runs with the stored authority of the person it belongs to: a scheduled report reloads its owner's current roles and teams and re-runs as them. |

## Administration screens

| Tier | What opens |
| --- | --- |
| Any signed-in account | Their own profile, the CRM screens their roles allow, and the handbook. |
| Administrator | The administration rail and the tabs marked for administrators. |

`admin` and `sysAdmin` resolve to the same test in this build, so a tab marked either one is open to every
administrator. There is no separate super-account. Which consequence that leaves is on
[the administration area](admin/settings-overview).

## Why a button is missing

| The control you cannot find | What it needs from you |
| --- | --- |
| The entity in the sidebar, in search, or in the palette's Records list | `read` on that entity. |
| **New**, and the create form | `create` on that entity. |
| **Edit** on a record | `edit`, at that level, for that record. |
| **Delete**, and **Delete selected** | `delete`, for that record. |
| The post box at the bottom of a stream panel | `stream` on that entity. |
| **Export CSV** | `read` on the entity. |
| **Import CSV** | `create` on the entity. |
| A field you were promised, absent from a record | Field read level `no` on one of your roles. |
| A whole administration tab | The administrative tier. No permission role can grant it. |
| A report's schedule controls | You are the report's owner, or an administrator. |

Two things this table cannot cover, because they are not permissions at all: a control that this build does
not have, and a feature the instance has switched off. [Troubleshooting](reference/troubleshooting) is the
page for the second, and the first is simply not in the interface — see
[glossary](reference/glossary) for the words that make it look like it should be.
