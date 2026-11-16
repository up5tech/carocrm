# Phase 24.9 — Provider Sandbox Certification

> **Status:** In progress — the experimental-adapter inventory and the per-adapter sandbox test plans are
> recorded here (2026-11-16); **no adapter has been certified** and no live or sandbox provider call has
> been made in this pass. Live certification is owner-gated and manual; automated suites stay on
> fakes/fixtures and CI stays nightly-only.
> **Plan:** `plans/PLAN_Phase_24_Product_Completion.md` §15 (Phase 24.9 — Provider Sandbox Certification, P1)
> **Predecessor:** Phase 24.7 — installation-wide inbound email/calendar sync
> (`docs/quality/phase-24-test-evidence.md` §24.7); Phase 24.8 — outbound events and developer surface
> (`docs/outbound-events.md`).

## 1. Objective

Replace "experimental until exercised against a real account" with recorded evidence, without turning CI
into a live-vendor dependency.

## 2. Inventory — adapters flagged experimental or delivered unverified (task 1)

| Adapter | Module | Recorded state | Source |
| --- | --- | --- | --- |
| Twilio (`twilio`) | Voice & Communications | **Experimental** — implemented at the adapter boundary, not verified against a live account | `docs/modules/voice-communications/providers.md` §1–2; `README.md`; `content/docs/en/admin/voice.md` |
| Asterisk (`asterisk`) | Voice & Communications | **Experimental** — implemented at the adapter boundary; not verified; voice-only, no message channels, no recording download | `docs/modules/voice-communications/providers.md` §2 |
| DocuSign (`esignature`) | E-Signature | **Delivered (ES.4 live adapter), unverified against a live account**; live fixtures pending ES.22 | `docs/compatibility/esignature.md` |
| Marketing Automation live send (platform `MailTransport` adapter) | Marketing Automation | **Implemented (MA.7–MA.10), live send verification pending** operator configuration and test-send allowlist | `docs/runbooks/marketing-send-operations.md`; `docs/compatibility/marketing-automation.md` |
| Voice media capabilities (messaging / recording) | Voice & Communications | **Experimental / not-implemented** per the capability matrix | `docs/modules/voice-communications/providers.md` §2 |
| Sync adapters from 24.7 (Google Calendar full + incremental; Microsoft 365 Graph delta + webhook inbound) | Advanced Integrations | **Delivered, not exercised against a live mailbox or calendar** | `docs/releases/2026-11-15-phase-24.md` (§24.6/24.7); `docs/compatibility/advanced-integrations/sync-semantics.md` |
| Generic outbound event/webhook connector | Advanced Integrations | **Not started** (Phase 24.8 scope; owner decision D6) | `docs/compatibility/advanced-integrations/provider-matrix.md` |

## 3. Sandbox test plans (task 2)

Per adapter group — drafts only. Execution is manual, owner-gated, and never part of `pnpm ci:gate`.

- **Twilio:** test credentials / test account; outbound origination + status callbacks, inbound via TwiML,
  SMS and WhatsApp send/receive through the messaging service; expected side effects are provider-side legs
  and signed webhook deliveries (`X-Twilio-Signature`).
- **Asterisk:** ARI bridge test instance; originate/answer/hangup, inbound bridge events, signature
  validation; expected side effects are ARI events and call legs.
- **DocuSign:** developer sandbox / test account with confidential client; OAuth consent, send, webhook,
  reconciliation; expected side effects are envelope sends and verified deliveries.
- **Marketing sends:** allowlisted sending mailbox (provider test mode); test send, dry run, validate,
  approve, queue, delivery, dead letter, provider events.
- **Voice media and 24.7 sync adapters:** recorded above per adapter; flows limited to what the delivered
  scope allows.

## 4. Recorded states and blocked marks (task 4)

Where a sandbox is unavailable, mark the adapter **`Blocked — no sandbox`** rather than claiming success;
keep the existing **`experimental`** wording for adapters whose sandbox is available but not yet booked.

Currently recorded: no adapter has moved past `experimental` / delivered-unverified, and no live or sandbox
call was made in this pass — therefore no certification is claimed.

## 5. Acceptance criteria status (task 5 / plan §15)

| Criterion | Status |
| --- | --- |
| Every adapter has a recorded state: certified, failed, or blocked with an owner and a date. | **Open** — inventory and plans recorded; per-adapter owner and sandbox booking pending. |
| No production customer data, real message, real payment, or real signature request was used. | **Met by construction** in this pass — no live call was made; automated suites use fakes/fixtures. |
| CI remains free of provider credentials and network-dependent mandatory checks. | **Met** — nightly-only CI; live/sandbox verification is a manual, documented step. |

## 6. Outstanding work

1. Book sandboxes / approved test accounts for the adapters above (owner-gated).
2. Execute the drafted flows; record sanitised evidence, correlation IDs and outcomes in
   `docs/quality/phase-24-test-evidence.md`.
3. Update module compatibility notes and the README flag list with the real results, including failures.

## 7. Verification

- `node scripts/check-ui-conventions.mjs` — docs gate, run after this record landed.
- No code, migration, database, provider or deployment change in this pass.
