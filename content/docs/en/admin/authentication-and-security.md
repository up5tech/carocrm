---
title: Authentication and security
summary: The password and session policy you can store, what sign-in actually enforces today, and the guarded danger zone.
audience: admin
order: 70
tags: [security, sessions, passwords, tokens, danger-zone]
aliases: ["đăng nhập và bảo mật", "xác thực hai lớp", "khóa phiên", "chính sách mật khẩu"]
related: [admin/settings-overview, admin/users-teams-roles, admin/api-keys, admin/email-and-notifications, getting-started/sign-in]
updated: 2026-10-21
---

Open [Administration → Authentication](/admin/settings/authentication). The tab edits one settings
document, `security`, in three cards: password policy, sessions, and the sign-in notice. Saving works the
same way as every other document tab — see [The administration area](admin/settings-overview).

> [!WARNING]
> Nothing outside this tab reads the `security` document yet. Sign-in, session lifetime and the password
> rules you set here are **stored and versioned, not enforced**: the authentication service does not read
> the document, and the sign-in page does not show the notice. Publish your policy so it is recorded and
> reviewable, and treat the behaviour below as what the build actually does.

## What the tab exposes

| Control | Field | Allowed | Default |
| --- | --- | --- | --- |
| Minimum length | `password.minLength` | integer 6 to 128 | 8 |
| Must also contain | `password.requireUppercase`, `requireNumber`, `requireSymbol` | three switches | all off |
| Idle logout | `session.idleLogoutMinutes` | integer 0 to 10080; 0 means keep the session | 0 |
| One session per user | `session.singleSession` | on or off | off |
| Sign-in notice | `loginNotice` | up to 500 characters, or empty | empty |

The footer of the tab names the document and shows its version. A write that arrives with a stale
version is refused with a conflict, and you must reload before publishing.

## What is enforced today

These are the rules the running code applies, independent of the tab:

- Passwords are hashed with argon2id. There is no plaintext or reversible storage.
- The API rejects a new password shorter than **8 characters**: on changing your own password (maximum
  256 characters), on an administrator setting or resetting one (maximum 512), and on creating a portal
  user. No complexity rule — uppercase, digit or symbol — is checked anywhere.
- Sign-in checks the password and the account state. A missing, inactive, deleted or password-less
  account gets the same generic failure, so the response does not say which.
- The sign-in form itself applies no policy beyond requiring a non-empty password.

## Sessions and tokens

A successful sign-in creates a row in `user_sessions` and returns two tokens.

| What | How it works now |
| --- | --- |
| Access token | A signed JWT carrying the user and session id; default lifetime 900 seconds (`ACCESS_TOKEN_TTL`) |
| Refresh token | 32 random bytes; only its hash is stored; default lifetime 14 days (`REFRESH_TOKEN_TTL`) |
| Cookies | `CRM-SESSION` and `CRM-REFRESH` are read-only to the browser, `CRM-CSRF` is not; all three are `SameSite=Lax` |
| Refresh | The old session row is revoked and a new one is written, so a stolen refresh token works once |
| Logout | Revokes the session row and clears all three cookies |
| Changing your own password | Revokes every active session of that account, so other devices sign out |
| An administrator setting a password | Does **not** revoke that account's sessions |
| Old session rows | The `system.pruneSessions` job deletes rows revoked or expired more than 30 days ago — see [jobs](/admin/jobs) |

Each sign-in starts its own session, so one person on two browsers has two rows. Turning on
`singleSession` does not change that while the document has no consumer.

> [!DANGER]
> The signing key comes from the server configuration, not from this tab, and it ships with a
> development default. Whoever holds it can mint valid access tokens. Set it in the deployment
> environment before the instance holds real records; rotating it invalidates every session.

## The danger zone

[Administration → Internal](/admin/settings/internal) is the only place with destructive buttons. It
shows instance facts first: metadata version, entity count, override count, the extensions this process
loaded, the job queue name and its counts, the Node version, and uptime.

Below that, two actions, each behind a phrase you must type exactly:

- **Reset metadata overrides** asks for `RESET METADATA`. It removes the per-entity overrides written by
  the [Entity Manager](admin/entities-and-fields) so the shipped definitions apply again. It never
  touches record data. The button tells you how many overrides will go.
- **Purge the queue** asks for `PURGE QUEUE`. It removes jobs still **waiting**; active and completed
  jobs are left alone. If the queue is unreachable the action refuses instead of guessing.

Both require the same administrative tier as every other security tab, the server re-checks the phrase
on every request, and both write a row to the change log naming the account that ran them — see
[the audit log](/admin/audit-log).

> [!NOTE]
> "System administrator" on these tabs is a label, not a second power level. An administrator and a
> system administrator are the same tier in this build, so the tabs marked `sysAdmin` open for anyone who
> is an administrator.

## What can go wrong

| Symptom | What it means |
| --- | --- |
| A stricter password policy changes nothing at sign-in | Expected: the document is stored only, no enforcement point reads it yet |
| A user stays signed in after you set their password | Use [Users](admin/users-teams-roles) to make them change it themselves; that path revokes sessions |
| Every session is invalid after a deploy | The signing key changed; that is the intended effect of rotating it |
| The queue purge says the queue is unreachable | Redis is down or `JOB_QUEUE_NAME` differs between the API and the worker |

## Where to go next

- [API keys](admin/api-keys) — machine access, which is separate from user sessions.
- [Email accounts and notifications](admin/email-and-notifications) — the encryption key that protects
  stored mailbox credentials.
- [The administration area](admin/settings-overview) — how documents, versions and the save bar work.
