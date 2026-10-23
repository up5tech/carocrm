---
title: First-run checklist
summary: The five setup steps the home page tracks for an administrator, and the screen behind each one.
audience: admin
order: 15
tags: [first-run, setup, onboarding, admin]
aliases: ["khởi tạo hệ thống", "cài đặt lần đầu", "việc cần làm sau cài đặt"]
related: [admin/settings-overview, admin/main-menu, admin/users-teams-roles]
updated: 2026-10-21
---

A fresh instance needs a handful of decisions before anyone else can sign in usefully. The product tracks five of
them as a **Setup checklist** card on your [home page](/home). It is shown to administrators only, and it answers
one question per line: has this been done at all?

## How it decides

Completion is structural, not checked off. Each item looks for the underlying thing and reports done when it
exists, so the list cannot be made green by ticking boxes:

| Step | Route | Marked done when |
| --- | --- | --- |
| Configure the main menu | `/admin/settings/menu` | The main-menu document has been saved once |
| Add an outbound mailbox | `/admin/settings/email` | At least one email account exists and is not deleted |
| Create at least one role | `/admin/settings/roles` | At least one role exists and is not deleted |
| Create a team | `/admin/settings/teams` | At least one team exists and is not deleted |
| Invite your first user | `/admin/settings/users` | At least one account exists that is not deleted and is not a system account |

The checkboxes are read-only. Each line links to the screen that finishes it, and a progress bar above the list
counts how many of the five are done. When the last one flips, the list is replaced by a single
"all setup steps complete" line.

Nothing is stored per tick. The card asks the server the five questions each time your home page loads and renders
the answers, so there is no state to get out of date and nothing to reset. The card has no dismiss control: it
stays until the work is done, and it sits under the record-count tiles rather than over them.

> [!WARNING]
> Completing these five steps does not mean the instance is safe to hand over. Record access is decided by roles
> and teams, not by this list, and a feature whose module is switched off still needs enabling. Verify the
> permissions themselves rather than the green boxes.

> [!NOTE]
> Expect the list to start partly complete. Any account that is not a system account satisfies the last item, so
> the administrator you sign in as already does; an instance that has been seeded by the repository's setup script
> also already has roles and a team.

## The order to work in

The card lists these steps in that order, and it is a reasonable one, but two dependencies are worth knowing:

1. **Roles, then teams.** A role decides what a user may do; a team decides which records that permission reaches.
   Neither is useful alone, and a user created before them needs editing afterwards.
2. **Menu, so people find things.** The sidebar everyone else sees comes from the main-menu document. Configure it
   before you invite anyone, or your first users are shown a menu you did not choose.
3. **Mailbox, before anything that sends.** Notifications, case e-mails and outbound sends need a sending account.
   Until it exists those features are configured but silent.
4. **Users, last.** Creating accounts is the point at which the rest stops being practice.

## What the checklist does not cover

Five items cannot describe a whole product, so the card stays quiet about the choices that are yours to make
before or after launch:

- What the instance is called and which locales are offered: [Branding and localization](admin/branding-and-localization).
- Which module is switched on at all: [Module settings](admin/module-settings).
- Sign-in policy, API keys, external providers: [API keys](admin/api-keys), [Integrations](admin/integrations).
- Outside fields, layouts and entities your process needs: [Entities, fields and layouts](admin/entities-and-fields).
- A customer-facing space: [Portals](admin/portals).

If the card does not appear for you at all, either you are not signed in as an administrator or the checklist
request failed; the card hides itself rather than showing an error in its place.

## Where to go next

- [The administration area](admin/settings-overview) — how these screens are organized and how saving works.
- [The main menu](admin/main-menu) — the first item on the list.
- [Users, teams and roles](admin/users-teams-roles) — the last two, and what a new account can do.
