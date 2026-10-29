---
title: Configuring Omnichannel
summary: Switch the shared inbox on, connect a messaging provider, open website chat, route conversations and grant the module's roles.
audience: admin
order: 138
tags: [omnichannel, settings, sms, whatsapp, web-chat, routing, roles]
aliases: ["cấu hình omnichannel", "cấu hình đa kênh", "kết nối twilio", "chat website", "phân quyền hộp thư đa kênh"]
related: [admin/voice, admin/service-desk, admin/users-teams-roles, admin/module-settings, user/omnichannel]
updated: 2026-10-30
---

Omnichannel has no settings tab of its own. It is a workspace over records that Voice & Communications
already owns, and most of what makes it work is configured elsewhere: the channels and provider accounts
in [Voice and messaging](admin/voice), queues and routing rules in [Service Desk](admin/service-desk),
and roles in [Users, teams and roles](admin/users-teams-roles). Its own document holds the workspace
switch, the website-chat policy, the AI agent link and the retention windows.

[The agent's side](user/omnichannel) describes the inbox itself. This page is the configuration behind it.

## Switch the workspace on or off

The workspace switch is **on** in a fresh settings document, but the module only appears for a role that
holds the inbox capability, and it stays empty until a channel is connected. A signed-in administrator
holding the `settingsManage` capability can close or reopen it from the **Workspace** switch in
[Omnichannel → Diagnostics](/omnichannel); the same change is the `features.workspace` field of the
module's settings document.

Check **Platform foundation** and **Modules the workspace builds on** before declaring it ready. The
required dependencies must be present, and the health answer says what is missing.

The switch is a server-side gate, not a hidden menu entry. While it is off:

- the inbox, timeline, replies, identity, snippets, drafts, calls, Case hand-off, reports, operations
  and AI assistant answer `403 FEATURE_DISABLED`;
- the public website chat refuses new sessions;
- the control plane stays reachable — health, capabilities, navigation, the settings document, the
  data-rights export and retention purge — so an administrator can always inspect the module and switch
  it back on;
- the provider webhook prefix stays open on purpose: receipts are still recorded, so a later replay has
  something to work with. Stopping inbound effects is the per-connection switch's job.

## Connect a messaging channel

1. Open [Settings → Voice & Communications](/admin/settings/voiceCommunications) and turn on
   `features.sms` and/or `features.whatsapp`; set a default account.
2. Create a provider account on the same tab. It needs a key, a provider, an environment, the
   capabilities the account really supports, a credential and a webhook secret. The credential and the
   secret are write-only: the screen learns whether they are present, never their value.
3. Register the callback URL at the provider. The generic shape is:

```text
POST https://<crm-host>/api/v1/integrations/voice-communications/{providerKey}/{accountKey}/{kind}
kind = voice-events | message-events | status-events | media-events
```

   The Omnichannel-owned prefix records into the same pipeline:

```text
POST https://<crm-host>/api/v1/integrations/omnichannel/{providerKey}/{accountKey}/message-events
```

4. Press **Test connection** in Omnichannel → Operations and confirm the probe answers. The
   `accountKey` is a routing identifier, not a secret; the provider's signature is the secret.
5. Keep receipts at least as long as the provider's retry window. Twilio callbacks carry no timestamp,
   so duplicate detection is the replay protection.

> [!WARNING]
> Live Twilio form callbacks have not been validated on the wire in this build. The SMS and WhatsApp
> chain is verified through the in-process simulator; treat a live Twilio deployment as a release
> candidate to prove against a sandbox number first.

## Website chat

The website widget is the public page `/chat`; a visitor needs no CRM account. Its policy is part of the
module document, and there is no administration form for it in this build — write it through the
module's `action/settings` endpoint:

```json
{
  "webChat": {
    "enabled": true,
    "allowedOrigins": ["https://www.example.com"],
    "requireConsent": true,
    "consentText": "I agree that this chat is stored so the team can reply.",
    "consentVersion": "1",
    "sessionHours": 24,
    "maxMessagesPerMinute": 20,
    "maxSessionsPerHour": 30,
    "maxBodyChars": 2000
  }
}
```

Origins are exact strings — scheme and host, no path — and an empty list refuses every session rather
than opening the widget to everyone. Consent is versioned on the session; changing the text or the
version asks the existing visitors again. Web chat is independent of SMS and WhatsApp: disabling one
does not close the other.

## Queues and routing

Routing is Service Desk's engine, extended for conversations:

1. In [Settings → Service Desk](/admin/settings/serviceDesk), turn on case management if it is off and
   turn on queues.
2. Create a **CaseQueue** with `acceptsConversations` on, add a **QueueMember** for each agent, and
   optionally attach a business calendar so out-of-hours conversations wait in the queue.
3. Create a **RoutingRule** with `routedObjectType` set to `conversation`, the conditions you need (for
   example channel equals `sms`), the target queue, a strategy (`roundRobin` or `leastBusy`), an active
   flag and a sort order. Rules run in order; no match is a deterministic unassigned fallback.
4. Route from the workspace with **Route**, or from the API. Assignment is version-guarded: a
   conflicting claim answers `409`, not a silent overwrite.

The **Route** action asks for the `queueManage` capability. Configuring the queue itself stays with
Service Desk.

## Identity and customer context

The resolver compares a normalized phone number or email with readable Contact/Lead records. It accepts
an exact single match and never guesses between two readable ones; a conflict goes to human review.
Staff **Link** and **Unlink** from the conversation's identity panel, always with a reason, and every
change is audited. Participants are not renamed to match the linked record.

## Roles

Three roles ship and can be assigned like any other role:

| Role | What it adds | Who it is for |
| --- | --- | --- |
| `omnichannelAgent` | `inboxView`, `reply` | every agent who answers conversations |
| `omnichannelSupervisor` | the agent rights plus `assign`, `identityLink`, `queueManage` | team leads |
| `omnichannelAdministrator` | the supervisor rights plus `opsRead`, `opsReplay`, `connectionManage`, `settingsManage` | the module administrator |

Agents also need the conversation and message read rights the module checks. Provider-account
administration stays with `VoiceProviderAccount` and the Voice settings tab. These module rights are
synthetic access-control resources, not metadata entities, so they do not appear in the Entity Manager
role matrix; the seeded roles are how they are granted.

## AI assistance

AI is optional and drafts only:

1. Publish an AI agent whose trigger allowlist includes `integration` and whose input mode is text.
2. Enable AIAgents execution and event triggers, and configure a provider.
3. Set the agent and the context limit in the Omnichannel document's `ai.agentId` and
   `ai.maxContextMessages` fields.

**AI suggest** in the composer fills an editable draft. A tool that would send a message
(`omnichannel.send_message`) is a material write and waits for a human approval in
[AI agents](/ai-agents); nothing is sent before that decision. An unconfigured or disabled agent
answers an actionable refusal and never blocks human replies.

## Retention, consent and data rights

- Consent and suppression belong to the channel owner — Voice and Marketing — not to a second
  Omnichannel store. The module reads their decision rather than keeping its own copy.
- The module document holds `retention.staleDraftDays` and `retention.expiredSessionDays`; the
  retention purge command deletes only the module's own expired drafts and visitor sessions.
- The conversation export is an administrator command. It excludes internal notes in the query itself
  and records an audit row with counts only, not content.

## Operations

Omnichannel → Operations reads the provider accounts and webhook receipts the channels already keep;
there is no second operational database. Four capabilities control it: `opsRead` to see it,
`opsReplay` to replay a receipt, `connectionManage` to probe a connection, and `settingsManage` for the
kill switch. Secrets are reported as present or missing, never shown.

**Replay** states which effects are idempotent and which are refused before it queues anything. The
kill switch reports its impact, including outbound messages still waiting for a provider confirmation.
The repository's Omnichannel runbook covers outages, expired tokens, signature failures, rate limits,
stuck jobs, duplicates and policy changes.

## Go-live checklist

- Workspace switch on; health green; the sidebar entry appears for an agent role.
- A provider account is enabled, the probe answers, and a signed simulator callback is recorded and
  processed.
- The Voice channel flag is on with a default account, and the consent basis is recorded.
- Website chat is enabled with exact origins; a test session sends and receives a reply.
- A queue, rule and members route a test conversation; a conflicting assignment answers `409`.
- Identity review matches the intended Contact and a manual link is audited.
- Internal notes do not appear on customer surfaces or in Case descriptions.
- Operations shows the account, backlog and failure categories; the kill switch is tested.
- Each role is verified server-side by calling an endpoint without the capability and seeing `403`.

## What this release does not claim

- Live Twilio callbacks are unverified, as the warning above says.
- MMS, Messenger, Instagram, email and Telegram are disabled: no adapter, no channel row, no claim.
- Voice calls are context only; the inbox is not a call console.
- Updates are polled, not streamed.
- The conversation tables are entity-level for access control: `team` and `own` behave like `all` in
  this build, so grant the module's rights to people you would trust with every conversation.
- AI replies are never autonomous; a send waits for a human approval.

## Where to go next

- [The Omnichannel inbox](user/omnichannel) — what an agent sees after this is configured.
- [Voice and messaging](admin/voice) — the channel document and provider accounts.
- [Service Desk](admin/service-desk) — queues, routing and the Cases a conversation can create.
- [Users, teams and roles](admin/users-teams-roles) — assigning the three module roles.
- [Module settings](admin/module-settings) — where each module document lives.
