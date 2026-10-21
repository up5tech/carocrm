---
title: API keys
summary: Credentials for another system, how they are issued, how they authenticate, and how to retire one.
audience: admin
order: 50
tags: [api, keys, integration, security]
related: [admin/users-teams-roles, admin/settings-overview]
---

**Open this screen:** [API keys](/admin/settings/apiKeys).

An API key belongs to an **API account**, which is a record very like a user: it has a sign-in name and it
has roles. The key is only ever as powerful as the account that owns it.

> [!NOTE]
> There is no scope, no expiry and no per-key description in this build. A key cannot be narrower than its
> account, and it does not stop working on a date. All of that is decided by the roles on the account — see
> [users, teams and roles](admin/users-teams-roles).

## Issue a key

Create the account, give it the roles it needs, and the response includes a secret. That is the only moment
the secret exists in readable form.

| Part | What it looks like |
| --- | --- |
| Key id | A short public identifier, `key_` followed by hex. Safe to log. |
| Secret | A long random string. Shown once, stored only as a hash, never retrievable. |

The dialog that shows them keeps a combined `keyId:secret` value you can copy. Copy it into your secret
manager **now**: closing the dialog is irreversible, and the record screens will only ever show the key id,
its creation date, its last use and whether it is revoked.

## Use a key

The caller sends one header on each request:

```text
Authorization: ApiKey keyId:secret
```

A wrong format, a revoked key, a secret that does not match its hash, or an inactive account are all refused
with the same generic answer. Every accepted call stamps the key's **last used** time, which is how you find
out whether a key is still alive before you revoke it.

A key on an account holding the system-administrator role signs in with administrative rights, so treat that
assignment the way you treat a human administrator.

## Rotate and revoke

- **Rotate** issues a new key and revokes the old one in the same action. Do this when a person leaves a team
  that used the key, or on any suspicion of a leak.
- **Revoke** marks the key as revoked. It stops working immediately and cannot be un-revoked.

> [!WARNING]
> Revoking does not undo what the key already did, and it does not touch any other key on the same account.
> If a secret leaked, rotate every key the account has and change the account's roles.

## What can go wrong

| Symptom | Cause |
| --- | --- |
| `Invalid API key format.` | The header is not `ApiKey keyId:secret` — a missing space, or a bearer token. |
| `Invalid API key.` | Revoked, wrong secret, or the account is inactive. The message does not distinguish them, on purpose. |
| A call that used to work now fails | The account was deactivated or its roles were changed. |
| You lost the secret | Expected. Issue a new key. |

## Where to go next

- [Users, teams and roles](admin/users-teams-roles) — what the roles on an API account actually allow.
- [Audit log](/admin/audit-log) — what an account did.
