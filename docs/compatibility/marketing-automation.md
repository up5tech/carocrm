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
stated acceptance rule. MA.0–MA.7 are delivered; MA.8 onward is planned.

| Behaviour | Reference basis | Status | Acceptance rule in this project |
| --- | --- | --- | --- |
| Campaign record with a type and a status, a schedule and an owner | Campaigns user guide | **implemented (MA.3)** | A `Campaign` record can be created, read, edited and deleted through `/api/v1/Campaign` with entity + record ACL enforced. |
| Campaign lifecycle Draft → Scheduled → Running → Paused → Completed, plus Failed/Archived | Campaigns user guide (statuses) + plan §5.1 | **implemented (MA.3)** | Illegal moves are refused server-side with a stable code; the allowed command set is answered by the server, not by the client. |
| A campaign cannot start without audience, content, sender and consent policy | plan §5.1 | **implemented (MA.3, gates live since MA.4/MA.5)** | `POST …/action/campaign/:id/validate` returns blocking findings; `schedule`/`start` refuse while any blocker stands. What still blocks `start` today is a live provider (MA.7) and the global send pause — never a missing audience or consent check. |
| Duplicate a campaign without its results | plan §5.1 | **implemented (MA.3)** | `duplicateAsDraft` copies configuration only: no status history, no recipients, no delivery or provider identifiers, no live enrollment. |
| Target list as an inclusion/exclusion audience record | Target Lists user guide | **implemented (MA.4)** | Exclusion wins over inclusion in every resolution, applied by record *and* by address identity; membership is stored as data and resolved through the query engine, never as SQL a caller supplied. |
| Manually populated and criteria-populated audiences | Target Lists user guide | **implemented (MA.4)** | Static membership and validated dynamic criteria resolve to the same recipient contract; an operator with no read access to a record gets `recordUnreadable`, not a silent skip and not a leaking count. |
| Preview counts and explainable eligibility | plan §5.2, §5.5 | **implemented (MA.4)** | Every resolved recipient lands in exactly one headline category (`AUDIENCE_CATEGORY_CODES`), the counts add up to the resolved population, and a resolution that hits the configured ceiling says `truncated` instead of looking complete. |
| Stable send snapshot | plan §5.2, §6.1 | **implemented (MA.4)** | `audienceSnapshot` freezes the composition and per-recipient decisions; changing the segment afterwards produces a new snapshot, never an edit of the old one. |
| Campaign log events (sent, opened, clicked, opted out, bounced, lead created) | Campaigns user guide | **planned (MA.10–MA.11)** | Append-only log rows keyed to campaign + recipient; engagement rows only for events a provider actually reported. |
| Campaign statistics with explicit denominators | Campaigns user guide, Mass Email | **planned (MA.11)** | Every rate names its denominator and its calculation timestamp. |
| Batched mass email with administrative limits | Mass Email user guide | **planned (MA.8–MA.9)** | Bounded chunks, persistent recipient state, retries that cannot duplicate a message. |
| Opt-out per target list and global suppression | Target Lists + Campaigns user guides | **implemented (MA.5)** | `MarketingSuppression` is a tombstone per address × channel × scope; a `GlobalOptOut` outranks segment membership in the one eligibility matrix every path must use, and the reasons a complaint or hard bounce produced cannot be revoked. |
| Consent state, preference center and audit trail | plan §5.3 (project requirement, no upstream record type) | **implemented (MA.5)** | Consent is per address × channel × purpose with a state machine, append-only history, `Unknown` never read as consent, and re-consent from an opt-out refused without stated affirmative evidence. |
| One-click public unsubscribe link | Emails user guide (List-Unsubscribe), plan §5.3.1 | **implemented (MA.5)** | Unauthenticated, opaque, hashed, scoped and expiring; a GET never performs the opt-out, a repeated POST is a success, and every failure answers the same sentence so the endpoints cannot confirm an address exists. |
| `{{placeholder}}` message personalization | Emails user guide | **implemented (MA.6)** | Marketing renders from a **restricted, allowlisted context** (`docs/marketing-automation/email-templates.md` §2): recipient simple fields, the campaign's own configuration and documented system links only, read through the actor's ACL so unreadable fields cannot be extracted via templates; unknown placeholders are reported, not leaked. The shared `EmailTemplate` editor is unchanged (no second editor, §6.2). |
| Message content preview (subject/body, test of what goes out) | Emails user guide; plan §5.4 | **implemented (MA.6)** | `POST …/action/campaign/:id/previewContent` renders the sanitised body, a plain-text fallback, resolved/fallback/unknown placeholders and the content findings — against a readable sample contact or with documented fallbacks. The per-recipient opt-out links are sent-time values; preview shows the reserved `.invalid` sentinel and says so. |
| Sanitised message content (no scripts/CSS/unsafe protocols in mail bodies) | Emails security posture; plan §9.4 | **implemented (MA.6)** | One allowlist filter (`marketing-template-render.ts`) rebuilds every tag, drops `script`/`style`/`iframe` and event handlers with their content, validates `href`/`src` schemes after entity-decoding (`javascript:`, `data:`, control-split variants refused), and reports what it removed. |
| Immutable content revision / message-to-content traceability | plan §6.2 | **implemented (MA.6), delivery stamps land with MA.8–MA.9** | `MarketingTemplateRevision` records the raw parts + SHA-256 hash + monotonic revision number per template; sealing is idempotent for identical content and module-write-only (migration 040). MA.7 returns the rendered content hash with a test send; the per-delivery `revisionId`+`contentHash` stamp arrives with MA.8's recipient records. |
| Provider-independent delivery adapter with capability metadata | plan §1.2, §5.8 | **implemented (MA.7)** | `MarketingProviderAdapter` is the only thing that can put a message on the wire; the live adapter wraps the platform `MailTransport`, the registry resolves the configured `provider.key` and **fails closed** to `disabled`, and capabilities (mode, limits, verified From, test-send support, event reporting) are reported without credentials. |
| Sending credentials held by the platform's secret stores | plan §9.4, §13 | **implemented (MA.7)** | Deployment `SMTP_*`/`MAIL_TRANSPORT` settings or an `email_accounts` row whose password is encrypted with `ENCRYPTION_KEY`; no marketing record, API response or log carries a credential. |
| Provider rate limits and normalized provider errors | plan §5.8, §11.2 | **implemented (MA.7), queue use lands MA.9** | One `MarketingProviderLimiter` (rate + concurrency, `429` with a retry hint) and one classifier producing `retryable` / `permanent` / `unknown_submission` with stable reason codes. |
| Explicit, safe test send of a campaign message | Mass Email / Emails user guides (test email); plan §5.4, §10.2, §10.5 | **implemented (MA.7)** | Recipients must be named and administrator-allowlisted, confirmation is server-side, the message is marked (`[TEST] ` subject, `X-Marketing-Test` header, body banner), suppression still applies, and the campaign's status, history, snapshots and events are untouched — §15's "test sends are not counted as campaign sends or journey outcomes". |
| Metadata-driven entity/ACL/API/job conventions | developer docs (metadata, ACL, API, scheduled job) | **existing platform behaviour** | The module uses the same Entity Engine, ACL, API, hook, job and outbox primitives as every other domain; verified by the module health endpoint's evidence list. |

## 4. Explicitly **not** compatible / project-specific

These are this project's own design and must never be presented as EspoCRM features:

- The **journey builder** — versioned graphs, enrollment, waits, branch decisions, goal conditions and
  re-entry policy. Upstream's documented campaign automation is campaign-log and workflow based; the visual
  journey engine here is a project requirement (plan §1.3).
- **`MarketingJourney`, `MarketingSend`, `MarketingConsent`, `MarketingSuppression`,
  `MarketingRecipientDelivery`, `MarketingEvent`, `MarketingForm`** and their records: project names and
  project schema.
- The **provider adapter contract**, its capability negotiation and the classified provider errors
  (`retryable` / `permanent` / `unknown_submission`): no upstream equivalent is claimed. Upstream sends
  through SMTP with per-message recipient limits; the plan requires a provider-independent domain model
  (§1.2), which is a project extension.
- The **test-send allowlist** (`provider.testSend.allowedRecipients`) as a hard server-side gate, and the
  in-process duplicate guard on a repeated test-send key: project design, chosen so an operator can prove the
  sending path without any possibility of reaching the campaign's audience.
- **Inbound provider webhooks** (delivered/bounced/complaint/unsubscribed) with signature verification and
  a dedupe inbox: a project design. Upstream has no equivalent inbox in this checkout (audit §4.4).
- **Signed, opaque public unsubscribe and preference tokens** with expiry and scope, and the preference
  center (built in MA.5): project design; the plan requires it (§5.3.1) and no upstream token contract is
  reproduced.
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
| `TargetListEntry.entityType` / consent `entityType` | **`memberType` + `memberId`**, **`subjectType` + `subjectId`** | `entityType` is the record store's own immutable column and can never be an `attrs` key, so a membership or consent row names the person it points at with its own words. Migration `039` renamed the unique indexes that carry that identity. |

## 6. Verification note

Behaviour rows move to `implemented` only when a test in this checkout proves the stated acceptance rule
against the configured primary database (AGENTS.md §3, plan §12). Documentation of a behaviour is never
evidence that it works.
