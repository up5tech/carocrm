---
title: Module settings
summary: What each optional module's settings document holds, where you edit it, and what starts switched off.
audience: admin
order: 130
tags: [modules, settings, feature-flags, sales, service-desk]
related: [admin/settings-overview, admin/portals, admin/integrations]
updated: 2026-10-21
---

Several modules ship with the product and each keeps **one** validated settings document: the whole module policy
in a single versioned record, with the module's own service validating it. This page is the map of those documents
and of what is switched on when an instance is fresh.

## The documents

| Document | Where you edit it | Groups of settings |
| --- | --- | --- |
| `sales` | [Settings → Sales](/admin/settings/sales) | features, currency, pricing, tax, numbering, inventory, variants, subscriptions |
| `serviceDesk` | [Settings → Service Desk](/admin/settings/serviceDesk) | features, numbering, defaults, resolution, assignment, SLA, email |
| `customerSuccess` | [Settings → Customer Success](/admin/settings/customerSuccess) | features, lifecycle, segments, assignment, health, renewal, playbooks, jobs |
| `marketingAutomation` | Its module endpoint; no administration tab in this build | features, defaults, sender, limits, provider, delivery, safety |
| `crmChat` | The settings dialog on [Chat](/crm-chat) | features, assistant, execution, limits, retention, safety |
| `voiceCommunications` | Its module endpoint; the Voice screen shows its warnings | features, provider, policy, webhook, media, AI |
| `aiAgents` | The Settings tab of [AI agents](/ai-agents) | features, provider, limits, approval, retention, safety, tools, data policy |

The three tabs in the rail behave like any other draft tab of [the administration area](admin/settings-overview):
**Save**, **Discard**, **Reload**, a version number, and a dot on the tab while your draft differs. The
module's own endpoint is the authority — a value it does not accept is refused with its reason, and a key it does
not know is refused rather than stored and ignored. That refusal is the reason the generic policy tabs render an
enumerated value as a plain field: the tab never guesses a list the module has not published.

Seven of these documents carry enough policy to deserve their own guide rather than a row in a table:
[CRM Chat](admin/crm-chat), [AI agents](admin/ai-agents), [Sales](admin/sales),
[Service Desk](admin/service-desk), [Customer Success](admin/customer-success),
[Marketing](admin/marketing) and [Voice and messaging](admin/voice).

## What starts off

Every module starts with its read-only or structural capabilities on and everything that spends money, sends
messages or writes data on someone else's behalf **off**.

| Module | On by default | Off by default |
| --- | --- | --- |
| Sales | Product prices, price books, supplier prices, issuance locking | Tax-inclusive prices, product variants, purchases, inventory, subscriptions, payment requests, multi-currency |
| Service Desk | Case management | Queues, SLA, email-to-case, portal, knowledge base, CSAT, notifications |
| Customer Success | Health scoring, health history, success plans, goals, risks, onboarding, playbooks, reviews, renewal readiness | Notifications, automation, adoption signal |
| Marketing | Campaigns | Audience, templates |
| Chat | The chat workspace | Grounded CRM answers, help article answers, action proposals, feedback, conversation search, and the write switch |
| Voice | Nothing | Voice, SMS, MMS, WhatsApp, recordings, transcripts, AI enrichment |
| AI agents | Agent definitions | Execution, memory, evaluations, event triggers, scheduled triggers, portal assistant |

> [!NOTE]
> **Voice Communications is the module that is entirely off by default.** All seven of its features start off, so
> a fresh instance sends nothing over SMS, WhatsApp or a call provider until you enable the channel you have
> configured. Consent is required per channel out of the box, and quiet hours are off.

Two other defaults do the same kind of work: AI agent **execution** is off, so installing a definition never runs
it; Chat's **write switch** is separate from its action-proposal feature, so enabling the feature without the
switch still refuses a mutation. A Chat flag only takes effect when the whole chain it requires is on.

## When a flag is not enough

A feature flag refuses new work, it does not hide history. While case management is off, case create and edit
commands are refused but existing cases stay readable; the same holds for campaigns and for agent definitions.

The screens show warnings rather than blocking you. A warning is a configuration problem the module can see but
not decide for you — a feature whose supporting infrastructure has not landed yet, a default provider missing so
no agent can publish, an enabling flag whose prerequisite is off. Check the warning list before you conclude a
feature is broken.

Portal access is the flag most often missed. A portal role can grant Case, and a portal user still sees nothing:
every portal decision on a case returns "no" while Service Desk's portal feature is off, and a case marked hidden
from the portal is never visible. See [Portals](admin/portals).

## What can go wrong

| Symptom | Where to look |
| --- | --- |
| A tab you expect is missing from the rail | Only Sales, Service Desk and Customer Success have tabs here; the rest are reached from their own screen |
| A value publishes and nothing changes | The feature that reads it is off; check the module's feature list |
| The save is refused as invalid | The document is rejected whole. The stored version is untouched; fix the named field |
| The tab shows defaults you never set | The stored record could not be read as this document, so the service fell back to defaults |

## Where to go next

- [The administration area](admin/settings-overview) — how a settings document is saved.
- [Integrations](admin/integrations) — provider connections the Marketing and Voice documents refer to.
- [Portals](admin/portals) — the module flags that change what an external user can reach.
