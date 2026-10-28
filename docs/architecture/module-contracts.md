# Phase 22.2 — Module Ownership & Dependency Map

> **Date:** 2026-10-28
> **Depends on:** `docs/quality/phase-22-capability-inventory.md` (22.0), `docs/quality/test-strategy.md` (22.1)
> **Method:** static import analysis of `apps/api/src/*` + `apps/worker/src/*` (Explore agent + direct grep). Read-only; no code executed against the database.

---

## 1. Intended layering (the rule)

```
                 ┌──────────────────────────────┐
   optional      │  advanced-integrations/      │  (connector bridge; the ONLY module
   bridges ───▶  │  contracts/*  (adapter layer)│   allowed to call other domains directly)
                 └──────────────┬───────────────┘
                                │ calls canonical owner APIs
   ┌─────────────┐   ┌──────────▼───────────┐   ┌────────────────────────┐
   │ SHARED CORE │   │ BUSINESS DOMAINS      │   │ WORKER (consumer side) │
   │ entity,acl, │   │ sales, projects,      │   │ outbox poller → domain │
   │ jobs,events,│   │ customer-success,     │   │ event handlers + jobs  │
   │ search,     │   │ service-desk, ma,     │   │                        │
   │ reports,    │   │ ai-agents, crm-chat,  │   │ consumers are LEAVES: │
   │ attachment, │   │ voice, esignature,    │   │ they do not import     │
   │ email,...   │   │ lead-score, omni,     │   │ domain modules back    │
   └──────┬──────┘   │ portal, processes,    │   └────────────────────────┘
          │         │ workflows              │
          │ owns    └───────────────────────┘
          ▼
   entity_records / metadata / outbox_events / jobs  (shared persistence)
```

**Hard rules verified in this audit:**
- The shared core MUST NOT import business-domain modules. → **2 violations found (§5).**
- A domain is authoritative for its own records and state transitions.
- Cross-module reads happen through (a) the generic Entity/metadata API, (b) a domain's canonical service API via the `advanced-integrations/contracts/*` adapter layer, or (c) domain events consumed by the worker.
- Event coupling is fire-and-forget: consumers reload authoritative data and re-check policy; event payloads are never trusted as authorization.

---

## 2. Module ownership table (canonical owner)

For each responsibility the authoritative owner module and the public API other modules may call.

| Responsibility | Owner module | Sanctioned caller-facing API | Consumed by |
|---|---|---|---|
| Account/Contact/Lead/Opportunity/record CRUD | `entity` (generic) | `EntityController` `/api/v1/:entity` | all |
| Lead + scoring model | `lead-score` | `LeadScoreRecords`, `LeadScoreCalculationService`, `LeadScoreSettingsService` | `advanced-integrations/contracts/lead-score-contracts` |
| Lead conversion → Contact/Account | `lead-score` (`LeadConversionService`) — orchestration owner | `LeadConversionService` | `sales` (target), `advanced-integrations` |
| Quote/Order/Invoice/Payment/Subscription | `sales` | `SalesIntegrationService`, `PaymentService`, `SalesRecords` | `advanced-integrations/contracts/sales-contracts`, `esignature` |
| Project/Task/Board | `projects` | `ProjectTaskService`, `ProjectDashletService` | `crm-chat` (help), `advanced-integrations/contracts/projects-contracts`, `search` (dashlet) |
| Customer Success profile/health | `customer-success` | `CustomerSuccessProfileService`, `CustomerSuccessRecords` | `advanced-integrations/contracts/customer-success-contracts` |
| Case lifecycle / SLA | `service-desk` | `CaseLifecycleService`, `CaseHandoffService`, `CaseAssignmentService` | `omnichannel` (handoff), `advanced-integrations/contracts/service-desk-contracts` |
| Marketing consent/suppression | `marketing-automation` | `MarketingConsentService`, `MarketingSuppressionService` | `advanced-integrations/contracts/marketing-contracts` |
| AI agent run / approval / tools | `ai-agents` | `AIAgentRunService`, `AIAgentApprovalService`, `AIToolRegistry` | `crm-chat`, `omnichannel`, `lead-score`, `voice-communications` |
| Conversational UX over agents | `crm-chat` | `CRMChat*Service` | SPA only (owns no store) |
| Voice calls/messaging/inbox | `voice-communications` | `VoiceInboxService`, `VoiceMessagingService`, `VoiceCallService` | `omnichannel` (primary consumer) |
| Omnichannel workspace | `omnichannel` | `OmnichannelConversationService`, `OmnichannelRoutingService` | SPA only |
| E-signature request lifecycle | `esignature` | `ESignatureRequestService`, `SignatureProviderRegistry` | `sales`, `search` (report) |
| Portal scope / policy | `portal` | `PortalPolicyService` | `acl` (VIOLATION §5), portal SPA |
| Workflow / BPM | `workflows` / `processes` | `Workflow*Service`, `ProcessRuntimeService` | event subscribers |
| Dashboards / reports | `search` / `reports` | `DashboardService`, `ReportService` | SPA |

---

## 3. Dependency direction map

**Importers of business-domain modules (verified):**

| Importer | Imports from | Nature |
|---|---|---|
| `search/dashboard.service.ts` | `esignature`, `lead-score`, `projects` | **violation** (shared → domain) |
| `acl/acl-api.service.ts` | `portal`, `projects` | **violation** (shared → domain) |
| `esignature/*` | `advanced-integrations` (provider kit), `crm-chat` | sanctioned (provider/integration kit + menu invalidator) |
| `voice-communications/*` | `ai-agents` | sanctioned (transcription via AI gateway) |
| `crm-chat/*` | `ai-agents`, `service-desk` | sanctioned (delegates to AIAgents; reads KB) |
| `advanced-integrations/contracts/*` | `sales`, `customer-success`, `marketing-automation`, `projects`, `service-desk`, `voice-communications` | **intended adapter layer** (see §1) |
| `omnichannel/*` | `service-desk`, `voice-communications`, `ai-agents` | sanctioned (workspace over Voice + SD) |
| `lead-score/*` | `ai-agents` | sanctioned (AI explanation) |

**Sanctioned event-driven coupling (producer → consumer in worker):**
- `sales` (Lead owner) → `lead-score` (`apps/worker/src/handlers/lead-score-handlers.ts` subscribes `entityType:'Lead'`).
- all outbound-sync-configured modules → `advanced-integrations` (`apps/worker/src/handlers/advanced-integrations-handlers.ts` subscribes `entity.created/updated/deleted`).
- Every generic record mutation → `outbox_events` (auto via `apps/api/src/events/entity-event.hook.ts`).

**Does NOT import any domain module:** `ai-agents`, `sales`, `projects`, `service-desk`, `marketing-automation`, `customer-success` (confirmed zero domain imports — so the graph is a DAG, not circular).

---

## 4. Circular / bidirectional dependencies

**None found.** No pair of domain modules imports each other; the heaviest importer targets (`ai-agents`, `advanced-integrations`, `voice-communications`, `service-desk`) do not import their importers back. The only shared-core ← domain edges are the two violations below.

---

## 5. Findings requiring action

### F1 — Shared core imports business domains (plan §7 task 9 violation)

| Shared file | Imports | Fix |
|---|---|---|
| `apps/api/src/acl/acl-api.service.ts:13-15` | `PortalPolicyService`, `ProjectPolicyService`, `projectScopeFor` from `portal`/`projects` | Move `PortalPolicyService`/`ProjectPolicyService` (and `projectScopeFor`) into a shared `packages/acl-policy` or `apps/api/src/acl/policy/` boundary that both `acl` and the domains depend on, so the dependency points **down**, not up. |
| `apps/api/src/search/dashboard.service.ts:12-18` | `ESignatureReportService`, `LeadScoreReportService`, `ProjectDashletService`, and their DTO schemas from `esignature`/`lead-score`/`projects` | Invert: expose dashlet/report contributions via a **contribution interface** (each domain registers a `DashletContributor`/`ReportContributor` at boot) instead of `search` importing every domain. This is the same pattern the module-enable gating already uses. |

These are **documented, reviewed exceptions** pending the refactor; they are allow-listed in `scripts/check-architecture-boundaries.mjs` (`KNOWN_VIOLATIONS`) so the guard only fails on NEW violations.

### F2 — `advanced-integrations/contracts/*` is direct-call (acceptable, but formalize)

This is the intended cross-domain call surface, yet it is implemented as raw service imports. Recommendation: keep it as the single sanctioned seam, but add an explicit `ContractClient` interface per domain so the call direction is contract-defined, not implementation-coupled. Low priority — does not block.

### F3 — No dead `EventBus.subscribe` cross-module wiring in API

All cross-module reactions live in the worker, which is correct (at-least-once, transactionally safe). The Phase 22.0 note that "most domain events have no consumer" remains valid: producers `customerSuccess.*`/`serviceDesk.*`/`esignature.*`/`leadScore.*` currently terminate at the noop/log handlers. New journeys (22.8–22.13) must not assume a reaction exists until a consumer is registered.

---

## 6. Transactional boundaries (owner summary)

- The outbox write is **in the same transaction** as the business mutation (`apps/api/src/common/outbox.service.ts`), so events are never emitted for a rolled-back transaction. Keep this invariant; do not split outbox writes into a separate non-transactional step.
- Domain module side effects (jobs enqueue, file upload, email) are **not** rolled back by the DB transaction — verify each journey's recovery path in its sub-phase.
- Optional dependencies are feature-detected and degrade safely (see §7); a disabled module must not prevent bootstrap.

---

## 7. Optional-integration feature detection (evidence)

- Provider adapters withheld in prod: `esignature/index.ts:107-114` binds real adapters only in production; fakes otherwise.
- Workspace page gated off when module disabled: `app.module.ts:254-270` reads `.enabled`/`.features.workspace` and drops the route (fail-closed).
- Safe default for optional cross-module dependency: `omnichannel/index.ts:46` binds `OMNICHANNEL_MENU_INVALIDATOR` → `noopMenuInvalidator`; `app.module.ts:287` overrides with the real `CRM_CHAT_MENU_INVALIDATOR`.
- Per-feature degradation: `esignature-settings.service.ts:279-299`, `customer-success-settings.service.ts:233`, `ai-agent-tools.ts:439`.

---

## 8. Static boundary check (enforcement)

Added `scripts/check-architecture-boundaries.mjs` + `pnpm lint:arch`. It scans shared-core directories for imports into business-domain directories and fails on any violation **not** in `KNOWN_VIOLATIONS`. Run it in CI as a Layer-1 architecture gate. Verified passing today with the 2 known exceptions.

---

## 9. Acceptance criteria (plan §7)

- [x] Architecture diagram + module ownership table exist (§1, §2).
- [x] No newly introduced circular dependency (§4 — none exist).
- [x] Cross-module writes occur through owner services/contracts (§2, §3; F2 notes the one sanctioned seam).
- [x] Optional modules can be disabled without the app failing to bootstrap (§7).
- [x] Shared-core purity enforced by a static check (`pnpm lint:arch`), with 2 reviewed exceptions tracked in §5/F1.
