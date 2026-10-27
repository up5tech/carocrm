# Omnichannel — administrator setup

> Phase 19-OM.23 (`PLAN_Phase_19_Omnichannel.md` §14). This is the customer-facing configuration
> checklist for the first release. Operations incidents are in `runbook.md`; scope and known
> limitations are in `release-readiness.md`.

## 1. Switch the module on

1. Grant the administrator role the `OmnichannelSettings` **edit** capability (the built-in
   administrator has it through `*`).
2. `POST /api/v1/Omnichannel/action/settings` with `{ "features": { "workspace": true } }`.
3. Check `GET /api/v1/Omnichannel/action/health`: `workspaceReady` must be true and the required
   dependencies present. The sidebar entry appears through `GET action/nav`.

The workspace switch is a **server-side gate**, not a hidden menu entry. With it off:

- every agent-facing route answers `403 FEATURE_DISABLED` — the inbox, timeline, replies, identity,
  snippets, drafts, calls, Case hand-off, the reports, the operations views and the AI assistant;
- the public web-chat channel is refused as well ("the website chat is not open");
- the **control plane stays reachable**, so an administrator can always inspect and recover the
  module: `action/health`, `action/capabilities`, `action/nav`, the settings document, the
  data-rights export and the retention purge;
- the provider webhook prefix stays open on purpose: receipts are still recorded so a later replay
  has something to work with. Stopping inbound **effects** is the per-connection switch's job
  (Operations → the connection's kill switch), and turning the workspace off hides the result.

So turning the switch off is the module-level kill switch; the individual connections have their own
switch in Operations.

## 2. Bind a provider account (SMS / WhatsApp via Twilio)

1. Enable the Voice channel flag: `POST /api/v1/VoiceCommunications/action/settings` with
   `{ "features": { "sms": true, "whatsapp": true }, "provider": { "defaultAccountKey": "<key>" } }`.
2. Create the account (administrator; `VoiceProviderAccount` edit):

   ```json
   POST /api/v1/VoiceCommunications/action/accounts
   {
     "key": "twilio-main",
     "providerKey": "twilio",
     "label": "Twilio main",
     "environment": "live",
     "enabled": true,
     "capabilities": [
       "messaging.sms.send", "messaging.sms.receive",
       "messaging.whatsapp.send", "messaging.whatsapp.receive",
       "messaging.deliveryStatus", "webhook.signatureValidation",
       "provider.healthCheck"
     ],
     "credential": "<Twilio auth token or API key secret>",
     "webhookSecret": "<the value you configure as the Twilio auth token used to sign callbacks>",
     "config": {}
   }
   ```

   The credential and webhook secret are write-only; responses expose presence flags only.
3. Register the callback URL at the provider. The generic shape is:

   ```
   POST https://<crm-host>/api/v1/integrations/voice-communications/{providerKey}/{accountKey}/{kind}
   kind ∈ voice-events | message-events | status-events | media-events
   ```

   or the Omnichannel-owned prefix (same receipt pipeline):

   ```
   POST https://<crm-host>/api/v1/integrations/omnichannel/{providerKey}/{accountKey}/message-events
   ```

   `accountKey` is a routing identifier, not a secret. Pin the exact URL in the account's
   `webhookUrl` when a proxy rewrites host/scheme, because the signature covers the URL.
4. Press **Test connection** on **Omnichannel → Operations** (or
   `POST action/operations/accounts/{key}/test`) and confirm `ok: true`.
5. Keep receipts at least as long as the provider retry window; Twilio callbacks carry no timestamp,
   so dedup is the replay protection.

> Live Twilio callbacks are not yet validated on the wire (no form-urlencoded parser). Use the
> simulator for acceptance until that gap is closed (`release-readiness.md` §7).

## 3. Website chat

1. `POST /api/v1/Omnichannel/action/settings`:

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

   An empty `allowedOrigins` refuses every session; mutations without an allowlisted `Origin` are
   refused. Origins are exact strings (scheme + host, no path).
2. The widget page is `/chat` in the SPA; it talks to the public endpoints
   `POST /api/v1/Omnichannel/chat/session` and `/messages`. The visitor cookie is `httpOnly`,
   path-scoped to `/api/v1/Omnichannel/chat`, and stores only a hash server-side.
3. Consent is versioned and recorded on the session when `requireConsent` is on. Changing the text
   or version requires a new consent.
4. Web chat is independent of SMS/WhatsApp: disabling it leaves the inbox and other channels
   working.

## 4. Queues, routing and assignment

1. Enable ServiceDesk queues: `POST /api/v1/ServiceDesk/action/settings` with
   `{ "features": { "queues": true, "caseManagement": true } }`.
2. Create a `CaseQueue` with `acceptsConversations: true`, a `QueueMember` for each agent, and
   optionally a `BusinessCalendar` (outside hours the conversation waits in the queue).
3. Create a `RoutingRule` with `routedObjectType: "conversation"`, conditions such as
   `[{ "field": "channel", "operator": "equals", "value": "sms" }]`, the queue, strategy
   `roundRobin|leastBusy`, `isActive: true` and a sort order. Rules run in sort order; no match is a
   deterministic unassigned fallback.
4. Route from the workspace (**Route**) or `POST action/conversations/{id}/route`. Assignment is
   version-guarded; a conflicting claim answers 409.

## 5. Identity and customer context

- The resolver matches normalized phone/e-mail against readable Contact/Lead/Account records, exact
  matches only; two readable matches become a review conflict, never a guess.
- Staff review and link/unlink from the conversation's **Identity** panel
  (`identityLink` capability); every change requires a reason and is audited.
- Participants are not renamed automatically; the linked entity is the CRM context.

## 6. Roles

Three roles ship with the platform and can be assigned to a user from **Admin → Users → Roles**:

| Role | Holds | For |
| --- | --- | --- |
| `omnichannelAgent` | `inboxView`, `reply` | every agent who answers conversations |
| `omnichannelSupervisor` | the above + `assign`, `identityLink`, `queueManage` | team leads |
| `omnichannelAdministrator` | the above + `opsRead`, `opsReplay`, `connectionManage`, `settingsManage` | the module administrator |

`sysAdmin`'s wildcard still holds every right. The module's rights are *synthetic permission
resources*, not metadata entities, so they do not appear in the Entity Manager's role matrix — the
seeded roles are how they are granted.

| Capability | Resource/action | Typical holder |
| --- | --- | --- |
| `inboxView` | `OmnichannelConversation:read` | every agent |
| `reply` | `OmnichannelMessage:create` | every agent |
| `assign` | `OmnichannelAssignment:edit` | team lead |
| `identityLink` | `OmnichannelIdentity:edit` | senior agent |
| `queueManage` | `OmnichannelQueue:edit` | the **Route** action — routing a conversation into a queue is the module's queue-management act (ServiceDesk still owns queue *configuration*) |
| `opsRead` / `opsReplay` | `OmnichannelOps:read|edit` | operations |
| `connectionManage` | `OmnichannelConnection:edit` | integration administrator |
| `settingsManage` | `OmnichannelSettings:edit` | module administrator |

Agents also need the owner records they read: `CommunicationConversation:read` and
`CommunicationMessage:create`. Provider-account administration stays `VoiceProviderAccount:edit`;
the channel catalog itself is available to any caller with `inboxView` and exposes no secret.

## 7. AI assistance (optional)

1. Create and publish an AI agent whose trigger allowlist includes **integration** and whose input
   mode is text. The demo data ships one: **Omnichannel Assistant** (`omnichannel-assistant`), which
   holds the `omnichannel.send_message` tool.
2. Enable AIAgents execution and event triggers, and configure a provider.
3. Set the agent in Omnichannel: `POST /api/v1/Omnichannel/action/settings` with
   `{ "ai": { "agentId": "<agent id>", "maxContextMessages": 10 } }`.
4. Suggestions are drafts only; the send tool is `material_write` and waits for human approval — the
   approval inbox (AIAgents → Approvals) is where that pause is decided. An unconfigured or disabled
   agent answers an actionable refusal and never blocks human replies.

> The tool may only be granted to an agent whose approval list contains `material_write`. The grant
> is refused otherwise, and the tool scopes no metadata entity (it writes conversation records, which
> the owner addresses by its ACL resources), so the registry accepts it.

## 8. Operations

- **Omnichannel → Operations** shows connection health, credential/secret presence (booleans), last
  event time, awaiting confirmations, receipt backlog and failure codes.
- Safe tools: probe, inspect (redacted payload), replay (idempotency statement), reconcile unknown
  sends and the per-connection kill switch. See `runbook.md` for the incident playbooks.
- Elevated capabilities: `opsRead`, `opsReplay`, `connectionManage`, `settingsManage`.

## 9. Go-live checklist

- [ ] Workspace flag on; health green; sidebar visible for an agent role.
- [ ] Provider account enabled, probe `ok`, a signed simulator callback is recorded and processed.
- [ ] Voice channel flag on and default account set; consent basis recorded.
- [ ] Web chat enabled with exact origins; a test session sends and receives a reply.
- [ ] Queue + rule + members route a test conversation; assignment conflict returns 409.
- [ ] Identity review matches the intended Contact and a manual link is audited.
- [ ] Internal notes never appear on customer surfaces or in Case descriptions.
- [ ] Operations overview shows the account, backlog and failure categories; kill switch tested.
- [ ] Roles verified server-side by calling an endpoint without the capability (403).
- [ ] Backup + additive migrations applied; no reset and no second database.
