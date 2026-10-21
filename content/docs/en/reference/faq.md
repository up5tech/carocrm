---
title: Frequently asked questions
summary: Short answers to the questions this build really gets — each one points at the page that covers the subject properly.
audience: user
order: 20
tags: [faq, questions, password, search, import]
related: [getting-started/sign-in, user/stream-and-notifications, user/import-export, reference/troubleshooting]
updated: 2026-10-21
---

These are the questions where people look for a control that is not there, or use one the wrong way. If
your symptom has an error message attached to it, [troubleshooting](reference/troubleshooting) is the
faster page.

## Signing in and your account

### Can I reset my own password?

Yes, if you know the current one: the fourth card on [your profile](getting-started/your-profile) takes the
current password and the new one twice, with a minimum of eight characters. Changing it signs every device
out, including the one you are on, so expect to sign in again straight away.

### I forgot my password. Is there a link on the sign-in screen?

No. There is no self-service reset, no email link and no security questions in this product. Your
administrator sets a new password for you on the Users tab — see
[signing in and out](getting-started/sign-in) for what to ask them for, and when the sessions you already
have are closed.

### How long do I stay signed in?

The session renews while you work, and a signed device stays usable for roughly two weeks without asking
again. Closing the tab does not sign you out; signing out from the avatar menu, or changing your password,
ends it immediately. Details on [signing in and out](getting-started/sign-in).

### Is there a dark mode, or notification settings on my profile?

No. Your profile holds your details, your picture, your language and time zone, and your password — that is
all. There is no theme control, no per-user notification preferences and no email signature on that screen.

## Permissions and visibility

### Why can't I open the administration area?

Because administration needs the administrative tier, and that comes from the account itself: it is marked as
an administrator, or is of the admin type, or holds the system-administrator role. The ordinary permission
roles on the [Roles](/admin/settings/roles) screen do not grant it. Ask an administrator, and read
[the administration area](admin/settings-overview) for what the rail shows once you are in.

### Is a system administrator more powerful than an administrator?

No. They are one tier in this build: there is no separate super-account, so "system administrator" on a tab
is a label, not a higher power. [The administration area](admin/settings-overview) explains where the label
still matters.

### A colleague and I both opened the same record, but their screen has a field mine does not.

Two different causes, and [who can see what](reference/permissions-matrix) separates them. A field your role
may not read is stripped out by the server before the record reaches your browser — it is not merely hidden.
A field that is simply not in any layout panel is somewhere on the record, under **Other** at the bottom.

### A sidebar entry I know exists is missing for me.

Permissions are applied last, after the menu an administrator configured, so an entry you have no read
permission for never appears however it is styled. The other ordinary cause is a disabled entity. Both are
covered on [the main menu](admin/main-menu).

## Records, lists and data

### Why doesn't anything tell me when someone mentions me?

Because there is no notification bell and no unread badge. A mention is recorded and the data is there, but
nothing in the header surfaces it — see [stream and notifications](user/stream-and-notifications) for what
to do instead of relying on one.

### Will my activity reminder arrive by email or as a popup?

No. A reminder is stored as an in-app row and this build has no email or popup transport for it, so plan
around the [calendar](user/activities-and-tasks). The one message that does leave the system is a
scheduled report's CSV, emailed to the person who scheduled it.

### What is **My Tasks** for?

Approvals. [My Tasks](/tasks) lists the workflow and process steps waiting on your account, not the `Task`
activity records you promised to do. [Activities, tasks and the calendar](user/activities-and-tasks) keeps
the two apart.

### Can I search for a word inside a description or a note?

No. Search is a substring match over a small set of indexed fields — name, the main contact fields and an
exact id — not full text, and it stops at ten hits per entity. If you need "every record whose description
mentions X", a [list filter](user/lists-and-views) is the closer tool.

### Can I change a lot of records at once?

Not from a list: bulk delete is the only bulk action. The route that does exist is CSV — export the rows,
keep the `id` column, edit the values and import the file back, which updates each record by id. See
[importing and exporting CSV](user/import-export) for what a field type will and will not accept.

### My export gave me rows I never saw on screen.

Expected. Export follows the filter, not your page or your sort order, and can run to ten thousand rows, so
it can hand you more than the twenty you were looking at — and a filter you forgot about can make it shorter
than you expected too. The rules are on [importing and exporting CSV](user/import-export).

### I deleted a record by accident. Is it gone?

Not from the database, but not from your screens either: delete marks the record. Recovery is an
administrator's action, so say so quickly and give them the record name and the entity —
[reading and editing a record](user/record-page).

## Configuration

### Can I add a field myself?

Only if you are an administrator, and only from [Entity Manager](/admin/entity-manager). Two limits matter
before you try: a field's type cannot be changed after it is created, and removing a field disables it
rather than deleting it. Both are on [entities, fields and layouts](admin/entities-and-fields).

### I changed a setting and nothing happened.

Settings screens cache the value they consume, and a document tab does not take effect until you publish it.
[Troubleshooting](reference/troubleshooting) lists the specific cases, including the sidebar that follows a
menu change on the next load rather than the same click.
