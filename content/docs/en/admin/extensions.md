---
title: Extensions
summary: How a package gets onto this instance, what installing and enabling really do, and what an extension can add.
audience: admin
order: 110
tags: [extensions, packages, modules, manifest, migrations]
aliases: ["tiện ích mở rộng", "cài plugin", "gói mở rộng"]
related: [admin/settings-overview, admin/main-menu, admin/entities-and-fields, admin/workflows-and-processes, admin/authentication-and-security]
updated: 2026-10-21
---

Open [Administration → Extensions](/admin/extensions). The screen lists every extension package the server
can find on disk and lets an administrator install, enable, disable or uninstall it. Managing extensions
requires the same administrative access as the rest of the panel, and every lifecycle action is written to
[the audit log](/admin/audit-log).

## Where packages come from

A package is a directory with a `manifest.json`, and the platform only looks inside the directory named by
the server configuration (`EXTENSIONS_DIR`, default `extensions`).

> [!WARNING]
> There is **no upload path** for an extension. Placing a package on the instance is a deployment step —
> someone copies files onto the server. The screen can therefore install only what an operator has already
> put there, and nothing you type here can make the process load code from elsewhere.

The list shows a row for each package found, whether or not it is installed, with its name, version,
description, load order, its location on disk, its declared dependencies and permissions, and a
**contributes** summary: the entity types it ships, how many controllers and hooks, the job names, the
migration files, and how many navigation entries it adds. Running packages are listed first, in the order
they loaded, so the list reads as the effective metadata precedence.

| Tag you see | What it means |
| --- | --- |
| Installed | An activation row exists in the database |
| Enabled | The row is switched on, so the next start loads it |
| Restart required | Installed but not loaded by this process — a restart is pending |
| A red problem tag | The manifest does not match this platform version, and install is disabled |

## Install

Install runs the checks first and the damage last:

1. The id is validated (lowercase kebab-case, 2 to 64 characters) and the package must exist on disk.
2. It must not already be installed.
3. Its platform version window must contain this build.
4. Every dependency it declares must already be installed, checked transitively.
5. Its SQL migrations are applied, reporting which ran and which were already present.
6. The activation row is written, enabled from the start.

The answer always carries a restart notice: providers, controllers and metadata precedence are decided
when the process starts, and the API deliberately never loads or evicts code at runtime. Until you restart
the API and the worker, the extension is enabled on paper and absent in practice — its entities have no
screens, its jobs are not registered, and its navigation is not offered. A step that fails leaves the row
unwritten, so retrying after a failed migration is safe.

## Enable, disable, uninstall

The switch flips the activation row. The next start loads only the enabled set, and a package whose graph
is broken stops the boot rather than being skipped quietly.

Uninstall removes the activation row and refuses if another installed package depends on it, naming the
dependents. **SQL already applied is left in place** — there is no rollback, by design, so an extension that
created tables keeps its data until a migration explicitly removes it. Uninstalling is therefore not a way
to undo a schema change.

## What an extension can add

- **Entities and fields.** Metadata from the package joins the [entity types](admin/entities-and-fields) the
  platform knows, which is how a module ships its own records.
- **Sidebar entries.** Each navigation entry names an app route, a label, an optional icon resolved from
  the interface's own icon set, an order within the extension group, and optionally an `adminOnly` flag or a
  required permission.
- **Background jobs, hooks and endpoints** that other parts of the system can call — including the job a
  workflow's `runJob` step can queue, see [Workflows and processes](admin/workflows-and-processes).

Navigation is fetched by any signed-in user from the extension frontend endpoint, because the sidebar needs
it. That response is filtered on the server: an `adminOnly` entry is simply not sent to someone who is not
an administrator, rather than hidden in the browser. A module's own administration tabs appear in the rail
only once its package is installed and loaded, which is why a fresh instance shows a shorter rail — see
[The administration area](admin/settings-overview) and [The main menu](admin/main-menu).

> [!NOTE]
> One example you can see without leaving the panel: the Webhooks tab explains that endpoints cannot be
> registered until the webhook package is installed, because that capability ships as an extension.

## What can go wrong

| Symptom | What it means |
| --- | --- |
| Install is greyed out | The manifest carries a platform version problem; check the tag |
| Installed, enabled, but its screens are missing | This process has not restarted since the install |
| Install says a dependency is not installed | Install that package first |
| Uninstall names other extensions | Remove the dependents before the one they need |
| The instance refuses to boot after a deploy | A package graph failed to load; disable it in the database or fix the directory |

The [Internal](/admin/settings/internal) tab lists the extension ids this process actually loaded, which is
the quickest way to tell "enabled" from "running".

## Where to go next

- [Workflows and processes](admin/workflows-and-processes) — automating around an installed package.
- [Email accounts and notifications](admin/email-and-notifications) — the inbound-mail seam an extension can
  replace.
- [The administration area](admin/settings-overview) — how tabs appear and disappear with modules.
