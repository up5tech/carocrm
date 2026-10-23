---
title: Integrations
summary: The connector workspace, its connection states and capabilities, and the outgoing webhook endpoints.
audience: admin
order: 120
tags: [integrations, connectors, webhooks, oauth, sync]
aliases: ["tích hợp bên thứ ba", "webhook", "gọi API ra ngoài"]
related: [admin/settings-overview, admin/users-teams-roles, admin/api-keys]
updated: 2026-10-21
---

This build has two integration surfaces, and they do different jobs. [Advanced Integrations](/advanced-integrations)
connects the CRM to a provider through a connector and syncs records both ways. [Webhooks](/admin/settings/webhooks)
pushes a small event envelope from the CRM to a URL you own. Neither one replaces the other.

## Advanced Integrations

Open [Administration](/admin/settings) and choose the Advanced Integrations tab in the integrations group; the
workspace is a full screen with five tabs.

| Tab | What it holds |
| --- | --- |
| Providers | The connector catalog, each with its capabilities and status |
| Connections | Your connections to providers, with state, scopes and owner |
| Mappings | How a provider's fields map onto CRM entity fields |
| Runs | Sync runs and their outcomes |
| Conflicts | Records where the provider and the CRM disagree |

Nine connectors ship with an adapter bound: `google-workspace`, `microsoft-365`, `zoom`, `stripe`, `mailchimp`,
`meta-lead-ads`, `shopify`, `quickbooks-online`, `generic-rest`. A tenth, `fake-provider`, fabricates answers and
is registered only when the server is not running in production, so a live instance cannot select it. A provider
with no adapter cannot be connected to at all; the create request is refused.

### Connections and their state

A new connection starts in `draft`. A draft is inert: it holds configuration and no credential, and nothing may
call the provider through it. The full state list is `draft`, `pending_authorization`, `connected`, `degraded`,
`reauthorization_required`, `paused`, `revoked`, `error`. Moves between them are checked, so refusing an illegal
transition tells you which states are legal from where you are. `revoked` is terminal.

Four states never reach `connected` and are refused before any provider call: `draft`, `pending_authorization`,
`paused`, `reauthorization_required`. A paused connection stays paused until you resume it, which is deliberate —
a job that treated a pause as "retry later" would keep calling a provider an operator stopped on purpose.

A connection belongs either to the organization or to one user. When the provider supports inbound webhooks the
connection is given an opaque key used as a path segment, so the callback URL cannot be enumerated. The key is a
routing identifier, not a secret; the secret is the provider's signature, which the connector verifies before
anything is recorded.

The callback endpoint is shared by every connector:
`POST /api/v1/integrations/advanced-integrations/{providerKey}/{webhookKey}/{kind}`. It needs no CRM session,
answers as soon as the delivery is verified and recorded, and processing happens in a job, so a slow provider
never holds the connection open.

### What you may do here

Seven capabilities gate this workspace: use, provider administration, connection administration, credential
administration, authorization administration, settings administration, diagnostics. Each is an ordinary access
control resource, so it is granted by a role and evaluated by the same engine as the rest of the product; an
administrator passes every one of them. The workspace asks the server which capabilities you hold and hides the
actions you cannot take. A refusal names the capability, never your roles.

Diagnostics are the most restricted of them. Redacted provider traffic is more sensitive than the module's own
records, so it sits behind its right.

### Module settings

The module's own settings are not one of the [settings documents](admin/settings-overview); the workspace reads
and writes them through its own endpoint. The defaults worth knowing:

- OAuth: PKCE on, and a connection must hold every required scope before it can report `connected`.
- Re-authorization warnings: 7 days before a credential expires.
- Retention purge: **off**. A purge deletes rows, so keeping everything is the default and you turn the purge on
  yourself. When on, it touches only the module's own diagnostics, never a CRM record.
- Debug mode: off, and it can carry an expiry. A debug mode with no expiry is flagged as a warning.
- Health thresholds decide when the connection detail starts saying a connection is degraded.

## Outgoing webhooks

[Settings → Webhooks](/admin/settings/webhooks) lists endpoints. An endpoint has a name, a URL, the events it
subscribes to, an optional signing secret and an enable switch. The four events it can subscribe to are
`entity.created`, `entity.updated`, `entity.deleted`, `entity.restored`. Expanding an endpoint shows its delivery
ledger: status, attempts, response code, error.

Two rules are enforced on the server rather than in the form:

- A secret is stored encrypted and is never returned by a read. The screen only ever learns whether one is set,
  so re-saving an endpoint without typing a secret keeps the existing one.
- A URL you type is resolved and checked before any request is made: loopback, link-local, cloud-metadata and
  private ranges are refused, and redirects are not followed. The check runs again on each attempt, because DNS
  can change between them.

Delivery runs as a job in the worker, never inside the request that saved the record. Each attempt signs the body
when a secret is configured and writes one ledger row per endpoint. The request has a 10 second timeout.

## What can go wrong

| Symptom | What it means |
| --- | --- |
| "ENCRYPTION_KEY is not configured" | Credentials cannot be stored or read. Set the platform encryption key, then re-enter the secret. |
| A stored credential cannot be decrypted | The key changed since it was saved. Re-enter the secret. |
| A provider call is refused by state | The connection is in one of the four non-callable states. Resume or re-authorize it. |
| A webhook URL is refused | The address resolves to a private or reserved range. |
| A delivery row says failed with an HTTP code | Your receiver answered; the code is recorded, and a transport failure is retried with backoff. |

## Where to go next

- [Users, teams and roles](admin/users-teams-roles) — granting the integration capabilities to a named person.
- [API keys](admin/api-keys) — authenticating a system that calls the CRM itself.
- [Audit log, jobs and operations](admin/audit-jobs-and-operations) — the jobs the module runs and their logs.
