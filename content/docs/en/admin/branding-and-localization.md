---
title: Branding, language and time
summary: The name and mark in the corner, the languages people may choose, and the clock the instance runs on.
audience: admin
order: 20
tags: [brand, localization, locale, timezone]
related: [admin/settings-overview, admin/main-menu]
---

Two tabs, both under [Administration](/admin/settings): **General** for what the product is called, and
**Localization** for which languages and which clock it uses.

## General

The branding document has three fields and nothing else:

| Field | Limit | What it changes |
| --- | --- | --- |
| Page title | 80 characters | The name in the sidebar header and the browser tab title. |
| Footer text | 200 characters | The line under the login form and the bottom of the shell. |
| Logo | an image attachment | The mark in the header. It must be an image you uploaded as an attachment. |

> [!NOTE]
> There is no colour, theme or dark-mode setting. The interface uses one theme, and branding changes the
> words and the mark, not the palette.

**Open this screen:** [General settings](/admin/settings/general).

## Localization

The localization document decides three things:

- **Enabled locales** — the languages anyone may choose, between one and twenty. A language that is not
  enabled here does not appear in a user's language menu.
- **Default locale** — what a new visitor sees, and the fallback when a translation is missing. It must be
  one of the enabled languages.
- **Default time zone** — the clock a user who has not chosen their own sees.

Each rule is enforced when you publish: a locale with no catalog on disk is refused, a default that is not
enabled is refused, and a time zone is validated against the platform's own calendar rules.

There is no week-start or first-day-of-week setting. A calendar month begins where the platform begins it.

**Open this screen:** [Localization settings](/admin/settings/localization).

## Who decides which language a person sees

Three layers, in order of precedence:

1. The user's own choice on [their profile](getting-started/your-profile), or the avatar menu, which writes
   the same setting.
2. The instance default locale, for anyone who never chose.
3. The browser's language, which is what a signed-out visitor on the login screen gets.

A time zone set on a profile changes how that person reads timestamps. It never changes a stored instant, so
it does not move a deadline for anybody else.

## What can go wrong

| Symptom | Cause |
| --- | --- |
| A language is missing from the menu | It is not in enabled locales. Add it and publish. |
| Publishing says the locale is unknown | The catalog for that locale is not installed on this instance. |
| Dates look wrong for one person only | Their profile time zone. Point them at their profile. |
| Your new name did not appear | The browser cached the page. Reload; the logo is fetched through its own endpoint. |

## Where to go next

- [The main menu](admin/main-menu) — rename what people see in the sidebar.
- [The administration area](admin/settings-overview) — how a document saves, and why one tab is one save.
