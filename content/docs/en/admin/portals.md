---
title: Portals
summary: What a portal is here, how its navigation is built, and how access control changes for a portal user.
audience: admin
order: 140
tags: [portals, external-access, acl, portal-roles]
related: [admin/settings-overview, admin/users-teams-roles, admin/module-settings]
updated: 2026-10-21
---

A portal is a separate, customer-facing application backed by the same data. Its users are ordinary user records
of type `portal`, each bound to one contact, and they are authorized **only** by portal roles. Everything about a
portal is decided by the server; the portal's own navigation only shows what the caller was allowed to see.

Open [Portals](/admin/portals) from the users group of [the administration area](admin/settings-overview). The
screen is administrator-only: a portal user who types the address is refused by the server, not redirected.

## What the screen holds

The table lists each portal with its name, its path, how many portal users it has, an active switch and a delete
action. **New portal** asks for a name and an optional path; the path must start with `/` and defaults to
`/portal`. Selecting a portal opens three tabs.

| Tab | What you can do in this build |
| --- | --- |
| Portal roles | Switch which portal roles this portal grants to all of its users |
| Navigation | Read the items: label, entity, route, position |
| Dashboards | Read the dashboards, which one is default, and the dashlet names inside each |

The server accepts more than the screen offers: navigation items, dashboards and dashlets have create, update and
delete endpoints, but this build has no editor for them. Editing those collections means calling those endpoints
yourself, as described in [API keys](admin/api-keys) for authenticating that work.

Hard limits, enforced when you write: 50 portals, 100 portal roles, 50 navigation items per portal, 50 dashboards
per portal, 50 dashlets per dashboard. A navigation item must name an entity **or** a route; an item with neither
is refused. A portal that still has users cannot be deleted — reassign or delete those users first.

## Portal users

A portal user is created like any other account at [Users](/admin/settings/users), by choosing the `portal` type.
Two things are then required and checked on write:

- The user must be assigned to an **active** portal.
- The user must be linked to a **contact** record that exists.

A portal account is never an administrator, and its internal role assignments are cleared: the two role spaces do
not mix. A portal role can be granted in two places — linked to the portal, which gives it to every user of that
portal, or assigned to the single user. Effective access is the maximum of both.

The internal role endpoints cannot read or write portal roles, and an internal role cannot be given to a portal
user. Portal roles carry entity permissions and field permissions in the same vocabulary as everything else:
actions `create`, `read`, `edit`, `delete`, `stream`, and levels `yes`, `all`, `team`, `own`, `no`.

## How the scope changes

This is the part that surprises people. For a portal principal:

1. Authority comes from portal roles only. The internal roles table is never consulted.
2. Record visibility is **always** narrowed to the user's own contact and that contact's account, plus one link
   hop. A portal role that grants entity-level `all` does not widen it: a record outside that neighbourhood is
   refused even when the permission says yes.
3. The neighbourhood is the record itself being the contact or account, a contact/account field on the record, or
   a stored link between them in either direction.
4. A user with no contact and no account sees nothing. The query is refused rather than run unscoped.
5. Field permissions apply on top: a field the roles do not allow to be read is stripped from the response, and a
   write that touches a field restricted to `no` is refused. A field no role mentions is readable.
6. If the account is deactivated or stops being a portal user mid-session, every decision denies.

> [!WARNING]
> A module feature can still veto a portal. Case access returns "no" for every portal role while Service Desk's
> portal feature is off, and a case marked hidden from the portal is never visible. See
> [Module settings](admin/module-settings).

## What a portal session reads

A signed-in portal user's own endpoints are the portal context (portal, the user, its contact, its roles, its
navigation, its dashboard), the navigation, the dashboard, and running one dashlet of that dashboard. Every other
read a portal user makes goes through the normal record endpoints and the six rules above. Calling a portal
endpoint as an internal user is refused with "Portal users only"; a portal user not assigned to a portal, an
inactive portal and an inactive user each get their own refusal.

A portal dashlet is one of three kinds — list, chart, KPI — and runs through the same portal scope, so it can
never return a row the user could not open. Its configuration names an entity, an optional filter, a size of 1 to
200 rows, and for a chart a grouping field that must be a categorical text field, or a measure that must be
numeric with the aggregation set to sum or average.

## What can go wrong

| Symptom | What it means |
| --- | --- |
| A portal user can open the record but not a field | Field permissions, not entity permissions. Check the role's field list. |
| Everything is empty for a correctly licensed user | The linked contact has no account and no link to the record. The scope is the answer. |
| The whole portal is unreachable | The portal's active switch is off. |
| Write refused although the role grants edit | Either a restricted field or the module feature is off. |

## Where to go next

- [Users, teams and roles](admin/users-teams-roles) — internal accounts, which behave differently.
- [Records and fields](admin/entities-and-fields) — the fields a portal role can restrict.
- [Dashboards and reports](user/dashboards-and-reports) — the internal equivalent of a portal dashlet.
