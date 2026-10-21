---
title: Signing in and out
summary: How to reach your workspace, how long you stay signed in, and who resets a forgotten password.
audience: user
order: 10
tags: [login, session, password]
related: [getting-started/your-profile, admin/users-teams-roles]
---

## Signing in

Open the address your administrator gave you. The sign-in screen asks for two things and nothing else:

1. **User name** — the sign-in name, not your display name or email address.
2. **Password** — case sensitive.

Select **Sign in**. You land on [your home dashboard](/home).

If the screen answers `Authentication failed.`, one of the two fields is wrong. Nothing is locked after
repeated failures and no message is sent anywhere — but there is also no self-service way back in, so a
forgotten password means [asking your administrator](#if-you-forget-your-password).

## How long you stay signed in

The workspace keeps working while you use it: the short-lived access token is renewed on its own, and a
signed device stays usable for about two weeks without asking again. Closing the browser tab does not sign
you out. Signing out explicitly, or changing your password, ends the session immediately.

## Changing your password

You can change your own password on [your profile](getting-started/your-profile): enter the current
password, then the new one twice. Eight characters is the minimum.

> [!WARNING]
> Changing your password signs **every** device out, including the one you are using. Expect to sign in
> again straight away.

## If you forget your password

There is no self-service reset in this product: no email link, no security questions. Your administrator
sets a new password for you in [Users](admin/users-teams-roles) — ask them. When they do, every session you
have is closed, so sign in again after.

## Signing out

Open the avatar menu in the top right and select **Sign out**. The workspace returns to the sign-in screen
and says `Signed out.`.

## Where to go next

- [Finding your way around](getting-started/find-your-way) — the sidebar, the header search and the command palette.
- [Your profile, language and time zone](getting-started/your-profile) — make the CRM read your language and your clock.
