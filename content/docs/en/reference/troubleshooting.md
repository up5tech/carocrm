---
title: Troubleshooting
summary: When something fails: the message you saw, the reason behind it, and the screen an administrator fixes it on.
audience: user
order: 30
tags: [troubleshooting, errors, fixes, audit]
related: [reference/permissions-matrix, admin/users-teams-roles, admin/settings-overview, user/lists-and-views]
updated: 2026-10-21
---

Each row is a symptom this build can actually produce, with the cause the code gives it and the screen that
fixes it. Quote the message word for word when you ask an administrator — these strings identify the check
that refused you, and the [audit log](/admin/audit-log) usually holds the record of the attempt.

## Signing in

| Symptom or message | The cause | The fix |
| --- | --- | --- |
| `Authentication failed.` on the sign-in screen | One of the two fields is wrong. The first field is the sign-in name, not your display name and not your email address. | Sign in with the sign-in name. If the password is genuinely forgotten, an administrator sets a new one on the Users tab: [users, teams and roles](admin/users-teams-roles). |
| `User is not active.` | The account is marked inactive, which is a separate switch from its roles. | An administrator turns **Active** back on — [users, teams and roles](admin/users-teams-roles). |
| You are pushed back to the sign-in screen after a period of working | The session aged out, or somebody reset the password and every session it had opened was revoked. | Sign in again. If it happens on a device you use every day, ask whether a password reset is the reason. |
| Any address you type lands you on the sign-in screen | You have no session. This is not a refusal of the page you wanted. | Sign in, then open the address again. |

## Seeing a record

| Symptom or message | The cause | The fix |
| --- | --- | --- |
| `No "edit" permission for "Contact".` | Every role you hold answers `no` for that action on that entity, and no higher role overrides it. | Raise the cell on the matrix — [users, teams and roles](admin/users-teams-roles), then [who can see what](reference/permissions-matrix). |
| `Record not assigned to user` | Your effective level is `own`, and the record's assigned user is someone else and you did not create it. | Have it assigned to you, or widen the level to `team` or `all` — [users, teams and roles](admin/users-teams-roles). |
| `Record not in user teams` | Your effective level is `team`, and none of the record's teams is one of yours. | Add the person to that team, or raise the level — [users, teams and roles](admin/users-teams-roles). |
| `Field(s) emailAddress cannot be modified.` | A field rule on one of your roles sets the field's **edit** level to `no`. Writing anything else is still allowed. | Clear or raise the field restriction on the role — [users, teams and roles](admin/users-teams-roles). |
| The record opens, but a field your colleague sees is absent | Its **read** level is `no`, so the server strips the value out before the record reaches your browser. | It is a role field rule, not a layout problem — [users, teams and roles](admin/users-teams-roles). |
| A row you know exists is not in the list | Record scope, or a filter still applied — filters live in the address bar. | Read the URL and clear the filters — [working with lists](user/lists-and-views). |
| A sidebar entry you were told about is missing | Permission is checked after the menu is built, so an entry for something you may not read is never rendered. | Either grant the read permission or accept the shorter sidebar — [the main menu](admin/main-menu). |
| A portal user is told a record does not exist, and you can open it | Portal visibility is limited to the neighbourhood of that user's own contact and account, and an out-of-scope record answers as not found rather than refused. | Check the portal and its roles — [Portals](/admin/portals). |

## Saving a record

| Symptom or message | The cause | The fix |
| --- | --- | --- |
| `Record "C000012" in "Case" has been modified. Please refresh and try again.` | Someone else saved the same record while your form was open. The write is refused so their change is not silently overwritten. | Reload the record, re-apply your edit, save. |
| A save is refused with the name of a field you did not touch | A rule on the entity requires that field for the values you entered, or a computed field disagrees with what the form sent. | Fix the named field. If the rule itself is wrong, it lives in dynamic logic — [entities, fields and layouts](admin/entities-and-fields). |
| The browser asked whether you wanted to leave, and your edits are gone anyway | The unsaved-changes guard covers a reload or a closed tab; clicking away inside the application is not covered. | Save before you navigate. There is nothing to undo on a form that never saved. |
| A row you deleted in bulk came back as duplicates with new ids | The undo window recreates the rows as **new** records. Old ids, and anything that pointed at them, do not return. | Delete the recreated rows and warn anyone whose links referenced the old ids. |

## Administration and settings

| Symptom or message | The cause | The fix |
| --- | --- | --- |
| `settings were changed by someone else. Reload the tab before saving.` | A settings document was published while your tab held an older version. The message names the document by its internal name — `brand`, `navigation`, `security` — not by the tab label you see. | **Reload** the tab, re-apply your change, then **Save** — [the administration area](admin/settings-overview). |
| `Administrator access is required to change … settings.` | That document's write level is above you, whatever else you may read. | Ask an administrator, and check which tier the tab sits on — [the administration area](admin/settings-overview). |
| A tab you opened shows defaults nobody set | The stored row could not be read as that document, so the service fell back to defaults instead of erroring. | Read the [audit log](/admin/audit-log) for who wrote it, then republish — [the administration area](admin/settings-overview). |
| A setting published and nothing changed | The screen that consumes the value caches it. Most refresh on their own; the menu is cached per person for thirty seconds. | Reload the consuming screen, then check that tab's own note — [the main menu](admin/main-menu). |
| The sidebar did not follow a menu change you published | The navigation cache is dropped on save, so the sidebar updates on the next load, not during the click. | Reload. If it still differs, the entry's permission is the reason — [the main menu](admin/main-menu). |
| A tab in the rail is missing, or says "This section is not available to you" | The tab's level is above your account, and the data behind it is refused by the server as well. | Check the tier and the tab catalog — [the administration area](admin/settings-overview). |
| A new field exists but appears nowhere | It is not in any layout panel, or the entity is disabled and the interface ignores it. | Drag it into a panel or enable the entity — [entities, fields and layouts](admin/entities-and-fields). |
| Saving a layout is refused with a field error | A panel names a field that does not exist, or one that was disabled. | Remove the stale reference — [entities, fields and layouts](admin/entities-and-fields). |
| The change you saved vanished after a reload | Two administrators edited the same entity, and the later save replaced the earlier one. | Reload and re-apply. Every metadata write is in the [audit log](/admin/audit-log). |
| `This is the last administrator account, so it cannot be demoted, deactivated or deleted.` | The rule runs on the state *after* your change, so removing the last active administrator is refused even in a combined save. | Make another account administrator first, then change this one — [users, teams and roles](admin/users-teams-roles). |

## Data in and out

| Symptom or message | The cause | The fix |
| --- | --- | --- |
| An import stops at once, before any row is written | A header column names no field of that entity. The whole file is refused rather than half-run. | Rename or drop the column. Field names, not labels — [importing and exporting CSV](user/import-export). |
| The import made duplicates of rows you meant to update | The file had no `id` column, so every row was treated as a new record. | Export again with the `id` column and re-import — [importing and exporting CSV](user/import-export). |
| The import reported the same column refused on many rows | Values the type will not take: a relation, a dropdown or an address is not importable here. | Set those on the record. The report gives the row numbers it refused — [importing and exporting CSV](user/import-export). |
| A long paste was refused outright | An import is bounded to five megabytes and two thousand rows, and gives up after fifty errors. | Split the file — [importing and exporting CSV](user/import-export). |
| Every cell that began with `=` now begins with an apostrophe | The export guards against spreadsheet formula execution. It is deliberate. | Delete the apostrophe if you are pasting the value somewhere that will not run it. |
| Search returns nothing for a phrase you know is in a record | Search matches a small indexed set of fields as a substring. A word inside a description or a note is not in that set. | Filter the list on the field instead — [search and the command palette](user/search). |
| The list says the entity is not available | Metadata for that entity failed to load. | Reload; if it persists, it is an instance problem — [entities, fields and layouts](admin/entities-and-fields). |

## Automation and background work

| Symptom or message | The cause | The fix |
| --- | --- | --- |
| A workflow you edited did not run | Runs execute the **published** version. A draft saves but never executes, and a run that already started keeps the version it began on. | Publish it, then check the run history — [workflows](/admin/workflows). |
| A process instance failed instead of waiting on a person | Its assignee could not be resolved, which fails the instance and records the reason rather than hanging. | Read the instance error, then fix the assignment — [processes](/admin/processes). |
| An approval you answered did not move the process on | Only the first answer advances the token; the step is locked once answered, so a second answer cannot move it again. | Reload [My Tasks](/tasks) and read the instance history before answering twice. |
| Something is refused as a disabled feature | This instance has the switch off. In Service Desk, only case management is on by default — queues, SLA and the rest are separate switches; outbound email is likewise refused when no transport is configured. | Turn it on in that module's settings tab, or accept that the feature is not deployed — [the administration area](admin/settings-overview). |
| An email was recorded but never sent | Nothing sends from the application process: sending is a background job, and it needs a configured transport. | Check the transport on the Email tab and the job at [Jobs](/admin/jobs). |
| Jobs stay waiting and never start | No worker is claiming them. Cancellation is cooperative, so a running job only stops at its next checkpoint. | Read the status and the log at [Jobs](/admin/jobs); the waiting list can be purged on the Internal tab, which asks for an exact confirmation phrase. |
| An extension is installed but contributes nothing | Installation records the package and runs its SQL, but providers and screens are decided when the process starts, so it asks for a restart. | Restart the application, then re-read the list — [extensions](/admin/extensions). |
| A dashboard number disagrees with a report over the same rows | Both scan a bounded window and say so when they stop early; the tile's own note is the warning. | Read the truncation note before quoting it — [dashboards and reports](user/dashboards-and-reports). |

> [!TIP]
> When you cannot tell whether a missing control is a permission or a bug, ask for the record or the screen
> while signed in as an administrator. If the administrator sees it and you do not, it is permission: start
> at [who can see what](reference/permissions-matrix). If neither sees it, the control is not in this build.
