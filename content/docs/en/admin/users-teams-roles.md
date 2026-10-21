---
title: Users, teams and roles
summary: Adding a person, giving them a password, and deciding what they may see and do.
audience: admin
order: 40
tags: [users, teams, roles, acl]
related: [admin/api-keys, admin/settings-overview]
updated: 2026-10-21
---

Access in this CRM is decided by three things: the **user**, the **teams** they belong to, and the **roles**
that carry permissions. All three are record screens — each change saves on its own, there is no save bar.

**Open these screens:** [Users](/admin/settings/users), [Teams](/admin/settings/teams),
[Roles](/admin/settings/roles).

## Add a user

On the Users tab, create the record and fill in:

1. **Sign-in name** — what they type at the login screen. It is not their email address.
2. **First name, last name, email, phone, job title** — what colleagues see.
3. **Password** — optional at creation. Leave it empty and the person cannot sign in until you set one.
4. **Administrator** — switches the account to the administrative tier, which opens
   [the administration area](admin/settings-overview).
5. **Active** — an inactive account cannot sign in; its records stay where they are.
6. **Roles** and **Teams** — assigned on the same form.

Accounts come in three kinds: a regular user, an administrator, and a portal user tied to a portal and a
contact record.

## Set or reset a password

Open the user and use the password dialog: a new password twice, at least eight characters.

> [!WARNING]
> Setting a password ends every session that account has, on every device. Tell the person before you do it,
> and treat a reset as the answer to a forgotten password — there is no self-service reset for them to use.

## The last administrator

An account counts as administrative when it is active and is marked as an administrator, or is of the admin
type, or holds the system-administrator role. Refusing to change the only one of those is a rule, not a
preference:

```text
This is the last administrator account, so it cannot be demoted, deactivated or deleted.
```

The check runs on the state *after* your change, which is what stops a lockout where you remove the role from
the last admin while making them inactive in the same save.

## Roles

A role is a matrix: for each entity, for each action, a level.

| Actions | Levels |
| --- | --- |
| create, read, edit, delete, stream | yes (everything), all, team, own, no |

`team` means the records of the teams the user belongs to; `own` means the records the user created or is
assigned to. A cell you leave unset is stored as nothing at all rather than as a refusal, which is why the
JSON of a role stays small.

A role can also restrict **fields**: per entity, a read level and an edit level for each field. A field you
may not read is stripped from the record before it reaches the browser — it is not merely hidden.

A role that is assigned to a user, an API account or a team cannot be deleted. Remove the assignment first.

## Teams

A team is a name, a list of members, the roles that apply **through** it, and an optional private flag.
Membership is the authoritative table: the team's stored member list is a copy of it, which is why a person
who is in the membership table is in the team no matter what the other list says.

Deleting a team removes membership and the team's role links. Records that were shared with that team keep
their reference — they do not move back to an owner.

## What can go wrong

| Symptom | Cause |
| --- | --- |
| A person sees a shorter sidebar than you | Their roles, or the [main menu](admin/main-menu) — permission is applied last. |
| A record opens but a field is missing | Field-level read permission on their role. |
| Deleting a user is refused | It is your own account. Sign in as someone else. |
| The password dialog is refused | Fewer than eight characters, or the two entries differ. |
| A role list is empty in a picker | Pickers read a bounded first window of records, not the whole table. |

## Where to go next

- [API keys](admin/api-keys) — an account that is not a person.
- [Branding, language and time](admin/branding-and-localization) — which languages your users may pick.
