# Marketing Automation — compatibility note

**Status:** baseline, written in Phase 19-MA.0. Grows as sub-phases land; every row that moves to
`implemented` names the acceptance rule that was actually tested in this project.

Plan reference: `PLAN_Phase_19_Marketing_Automation.md` §1.3 (clean-room and compatibility boundary),
§2 (reference baseline), §14 (documentation list).

## 1. Position

- This module is a **clean-room TypeScript implementation of documented product behaviour**. No upstream
  source file, PHP class, database schema, asset, icon, branding, translation string or copy block is
  reproduced. Names, code, comments, migrations and UI wording are this project's own.
- **No database or source-level compatibility with EspoCRM is claimed or attempted.** The schema here is
  independent (`entity_records` JSONB + this project's migrations); a `Campaign` record in a CaroCRM
  database is not a row that can be moved to or from an EspoCRM installation.
- Compatibility is claimed only for **documented user-visible behaviour**, one row at a time, with the
  reference page and the acceptance rule that was verified against this codebase. Anything else is labelled
  **project-specific** below, and no project-specific enhancement is ever described as an upstream feature.

## 2. Baseline references consulted

Reviewed as behavioural context only (§2 of the plan). Versions are the live public documentation as read
during MA.0; the URLs are recorded so a later reader can re-check them.

| Area | Reference |
| --- | --- |
| Campaigns | https://docs.espocrm.com/user-guide/campaigns/ |
| Target Lists | https://docs.espocrm.com/user-guide/target-lists/ |
| Mass Email | https://docs.espocrm.com/user-guide/mass-email/ |
| Emails / placeholders / guidelines | https://docs.espocrm.com/user-guide/emails/ |
| Workflows | https://docs.espocrm.com/administration/workflows/ |
| Advanced Pack (Workflows/BPM context) | https://docs.espocrm.com/extensions/advanced-pack/overview/ |
| Modules | https://docs.espocrm.com/development/modules/ |
| Metadata | https://docs.espocrm.com/development/metadata/ |
| ACL | https://docs.espocrm.com/development/acl/ |
| API | https://docs.espocrm.com/development/api/ |
| Scheduled jobs | https://docs.espocrm.com/development/scheduled-job/ |
| Extension catalog | https://www.espocrm.com/extensions/ |

## 3. Behaviour matrix

`planned` = requirement understood, not built. `implemented` = built in this checkout and covered by the
stated acceptance rule. Nothing is `implemented` before MA.3.

| Behaviour | Reference basis | Status | Acceptance rule in this project |
| --- | --- | --- | --- |
| Campaign record with a type and a status, a schedule and an owner | Campaigns user guide | **planned (MA.3)** | A `Campaign` record can be created, read, edited and deleted through `/api/v1/Campaign` with entity + record ACL enforced. |
| Campaign lifecycle Draft → Scheduled → Running → Paused → Completed, plus Failed/Archived | Campaigns user guide (statuses) + plan §5.1 | **planned (MA.3)** | Illegal moves are refused server-side with a stable code; the allowed command set is answered by the server, not by the client. |
| A campaign cannot start without audience, content, sender and consent policy | plan §5.1 | **planned (MA.3)** | `POST …/action/campaign/:id/validate` returns blocking findings; `schedule`/`start` refuse while any blocker stands. |
| Duplicate a campaign without its results | plan §5.1 | **planned (MA.3)** | `duplicateAsDraft` copies configuration only: no status history, no recipients, no delivery or provider identifiers, no live enrollment. |
| Target list as an inclusion/exclusion audience record | Target Lists user guide | **planned (MA.4)** | Exclusion wins over inclusion in every resolution; membership is stored as data, never as SQL. |
| Manually populated and criteria-populated audiences | Target Lists user guide | **planned (MA.4)** | Static membership and validated dynamic criteria resolve to the same recipient contract. |
| Campaign log events (sent, opened, clicked, opted out, bounced, lead created) | Campaigns user guide | **planned (MA.10–MA.11)** | Append-only log rows keyed to campaign + recipient; engagement rows only for events a provider actually reported. |
| Campaign statistics with explicit denominators | Campaigns user guide, Mass Email | **planned (MA.11)** | Every rate names its denominator and its calculation timestamp. |
| Batched mass email with administrative limits | Mass Email user guide | **planned (MA.8–MA.9)** | Bounded chunks, persistent recipient state, retries that cannot duplicate a message. |
| Opt-out per target list and global suppression | Target Lists + Campaigns user guides | **planned (MA.5)** | Global suppression beats segment membership on every send path, including manual retry. |
| `{{placeholder}}` message personalization | Emails user guide | **partly existing** | The platform already renders `{{key}}` substitution ([packages/mail/src/template/index.ts:14](file:///Users/up5techjacky/Documents/projects/carocrmv2/packages/mail/src/template/index.ts#L14)); per-recipient context is a MA.6 addition, not upstream parity. |
| Metadata-driven entity/ACL/API/job conventions | developer docs (metadata, ACL, API, scheduled job) | **existing platform behaviour** | The module uses the same Entity Engine, ACL, API, hook, job and outbox primitives as every other domain; verified by the module health endpoint's evidence list. |

## 4. Explicitly **not** compatible / project-specific

These are this project's own design and must never be presented as EspoCRM features:

- The **journey builder** — versioned graphs, enrollment, waits, branch decisions, goal conditions and
  re-entry policy. Upstream's documented campaign automation is campaign-log and workflow based; the visual
  journey engine here is a project requirement (plan §1.3).
- **`MarketingJourney`, `MarketingSend`, `MarketingConsent`, `MarketingSuppression`,
  `MarketingRecipientDelivery`, `MarketingEvent`, `MarketingForm`** and their records: project names and
  project schema.
- The **provider adapter contract** and its capability negotiation: no upstream equivalent is claimed.
  Upstream sends through SMTP with per-message recipient limits; the plan requires a provider-independent
  domain model (§1.2), which is a project extension.
- **Inbound provider webhooks** (delivered/bounced/complaint/unsubscribed) with signature verification and
  a dedupe inbox: a project design. Upstream has no equivalent inbox in this checkout (audit §4.4).
- **Signed, opaque public unsubscribe and preference tokens** with expiry and scope, and the preference
  center: project design; the plan requires it (§5.3.1) and no upstream token contract is reproduced.
- **Attribution, funnel analytics and conversion tracking** (MA.17): project features.
- **Consent evidence, basis, policy-version and history** as first-class records: project features. The
  audit found no consent substrate at all here (audit §1, §4.1), so nothing is inherited from anywhere.

## 5. Naming deviations, recorded deliberately

| Plan suggestion | This project | Why |
| --- | --- | --- |
| `MarketingCampaign` / "existing `Campaign`" | **`Campaign`** | No upstream-shaped campaign record exists here to extend, so the canonical name is the plain one, exactly as this repo took the plain `Case` for Service Desk. A `MarketingCampaign` next to a `Campaign` would be two names for one concept (plan §0.2). |
| `MarketingSegment` / "existing `TargetList`" | **`TargetList`** + `TargetListEntry` | The documented audience record is the target list; §0.2 says reuse that name where the contract suits. `MarketingSegment` would compete with it. |
| `CampaignLog` | **`CampaignLog`** (MA.11) | Matches the documented concept and stays the single campaign activity ledger. |
| Events named `marketing.x.y.v1` | **`marketingCampaign.scheduled`** style, `schemaVersion` in the payload | The kernel event grammar allows 2–4 dot segments ([apps/api/src/events/event-bus.ts:14](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/api/src/events/event-bus.ts#L14)); `marketing.send.recipient.queued.v1` is 5 and would be rejected. Repo convention also carries no version suffix — versions live in the payload. |

## 6. Verification note

Behaviour rows move to `implemented` only when a test in this checkout proves the stated acceptance rule
against the configured primary database (AGENTS.md §3, plan §12). Documentation of a behaviour is never
evidence that it works.
