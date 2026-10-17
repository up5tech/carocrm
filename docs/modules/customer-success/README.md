# Customer Success module (Phase 19-CS)

Implemented in `apps/api/src/customer-success` (backend), registered once in
`apps/api/src/app.module.ts`, with metadata in `database/seed-metadata.ts`, the idempotent seed rows
in `database/seed.ts` and one additive migration,
`database/migrations/032_phase19_customer_success.sql`. Functional reference: the documented product
requirements in [`PLAN_Phase_19_Customer_Success.md`](../../PLAN_Phase_19_Customer_Success.md),
reproduced as clean-room TypeScript behaviour — no upstream source, asset, translation or schema is
copied.

**Status: phases 19-CS.0 – 19-CS.11, 19-CS.13 and 19-CS.14 are implemented.** The list of phases
actually claimed is `CUSTOMER_SUCCESS_MODULE.implementedPhases`
(`apps/api/src/customer-success/customer-success-module.ts`), which `/api/v1/CustomerSuccess/action/health`
reports. **19-CS.12 (dedicated React screens) is deliberately not built**: per §10 of the plan,
entities registered with `layouts` render through the generic metadata-driven UI with no custom
React, and dedicated screens are optional polish. Every entity below therefore already has list,
detail and edit screens in the SPA; what is missing is a dedicated *Customer Success* submenu and the
purpose-built panels described in §10.2–§10.4 — see
[compatibility.md](compatibility.md) and the [completion report](../../implementation/customer-success-completion-report.md).

| Read next | What it answers |
|---|---|
| [api.md](api.md) | every entity resource and domain action, with sample payloads |
| [data-model.md](data-model.md) | entities, fields, relations, indexes, migration, JSON contracts |
| [permissions.md](permissions.md) | permission scopes, record/field access, worker capability, privacy |
| [admin-guide.md](admin-guide.md) | lifecycle stages, scoring weights and thresholds, playbooks, renewal windows, notifications |
| [operations.md](operations.md) | scheduled jobs, worker capability, failed runs, recalculation, diagnostics, retention |
| [compatibility.md](compatibility.md) | deviations from the EspoCRM baseline and from plan wording, with reasons |
| [../../implementation/customer-success-repository-audit.md](../../implementation/customer-success-repository-audit.md) | the 19-CS.0 audit: what the repository already offered and the decisions taken |
| [../../implementation/customer-success-completion-report.md](../../implementation/customer-success-completion-report.md) | sub-phase → files, checks actually run, results, gaps, data writes |

## What it gives a user

| Capability | Where |
|---|---|
| One Customer Success profile per Account: lifecycle stage, CSM/team, segment, health summary, onboarding and renewal roll-ups | `GET/POST /api/v1/CustomerSuccessProfile` and `POST /api/v1/CustomerSuccess/action/ensureProfile` |
| Portfolio queues (my portfolio, team, unassigned, at risk, renewal soon, overdue risks) and an ACL-scoped aggregate | `GET /api/v1/CustomerSuccess/action/portfolioQueues`, `/portfolioSummary` |
| Validated lifecycle transitions with a reason for `atRisk`/`churned`, single or bulk, plus a preview | `POST /api/v1/CustomerSuccess/action/transitionLifecycle[|Bulk|Preview]` |
| Health scoring from configured signals, append-only snapshots, component-level explanation, history and trend | `POST …/recalculateHealth`, `GET …/healthExplanation`, `GET …/healthHistory` |
| Manual health override with reason and optional expiry; the calculated result is never overwritten | `POST …/setHealthOverride`, `POST …/clearHealthOverride` |
| Success plans with owner, timeframe, status and a rolled-up progress; goals with direction-aware progress | `POST …/createPlan`, `…/activatePlan`, `…/completePlan`, `…/createGoal`, `…/updateGoalProgress` |
| Risks with mitigation requirements, validated transitions, idempotent escalation and resolution with an outcome | `POST …/createRisk`, `…/escalateRisk`, `…/resolveRisk`, `…/reopenRisk`, `…/transitionRisk` |
| Playbook templates and runs with stable step keys, dependencies, due dates, wait steps, retries and a retry-safe failure state | `POST …/createPlaybookTemplate`, `…/startPlaybook`, `GET …/playbookRun`, `POST …/completePlaybookStep` |
| Onboarding driven by a playbook (a seeded default template), idempotent per profile | `POST …/startOnboarding`, `POST …/completeOnboarding` |
| Renewal readiness from the profile, a Subscription or an Opportunity, with configured windows | `GET …/renewalSummary`, `POST …/setRenewal`, `POST …/syncRenewal` |
| Success reviews and touchpoints built on the existing Activity records — no second scheduler | `POST …/scheduleReview`, `GET …/reviews`, `GET …/recentTouchpoints` |
| Dashlets for the shared dashboard engine | `GET /api/v1/CustomerSuccess/action/dashlets` |
| Module diagnostics, dependency evidence and the validated settings document | `GET …/health`, `GET/POST …/settings` |

Everything a *user* sees goes through the generic Entity Engine and `AclApiService`: list, detail,
search, export, stream, audit and record/field ACL behave exactly as they do for Account or
Opportunity. The domain actions above exist only for what one record cannot express.

## Entities

Nine metadata entities (registered in `database/seed-metadata.ts`, stored in `entity_records`):

`CustomerSuccessProfile`, `CustomerSuccessHealthSnapshot` (append-only), `CustomerSuccessPlan`,
`CustomerSuccessGoal`, `CustomerSuccessRisk`, `CustomerSuccessPlaybookTemplate`,
`CustomerSuccessPlaybookRun`, `CustomerSuccessPlaybookStepRun`, `CustomerSuccessReview`.

Scoring configuration is *not* a tenth entity: §6.1 C prefers the existing versioned `app_settings`
document, which is what `GET/POST /api/v1/CustomerSuccess/action/settings` reads and writes. There is
no separate onboarding table (§6.1 K): onboarding is Profile + Playbook Run + Step Runs.

## Jobs and notifications

Eight scheduled jobs, installed by `database/seed.ts` and handled in the worker
(`apps/worker/src/handlers/customer-success-handlers.ts`); each calls **its own**
worker-authorised endpoint and reports its own processed/skipped/error counts and duration:

`customerSuccess.recalculateHealthBatch`, `customerSuccess.expireHealthOverrides`,
`customerSuccess.updateGoalOverdueState`, `customerSuccess.evaluateRenewalWindows`,
`customerSuccess.evaluateRiskEscalations`, `customerSuccess.evaluateReviewReminders`,
`customerSuccess.processPlaybookWaitSteps`, `customerSuccess.repairStalePlaybookRuns`.

See [operations.md](operations.md) for schedules, authority and failure handling. In-app
notifications only — never outbound mail, SMS or webhooks (§11.2, §11.3), written by a module-local
writer with dedup keys and cadence, off by default until `features.notifications` is switched on.

## Optional integrations (§3.7, §12.7)

| Integration | Status | Evidence |
|---|---|---|
| Sales — Subscriptions (`sales-subscriptions`) and Opportunities (`opportunities`) | available when those entities are registered | detected adapters (`CustomerSuccessRenewalService.syncFromSource`); `GET /api/v1/Sales/action/health` reports `customer-success: available` (§12.8, asserted by a test) |
| Projects (`projects`) | available as a *source* of delivery links when `Project` is registered | relations are registered only when the target entity exists |
| Activities (Task/Call/Meeting/Email), Contacts, Accounts | available — kernel records | signal providers read them through the structural reader |
| Cases / Service Desk (`service-desk`) | **not available** (§12.6) | reported as an unavailable optional integration in `/action/health` |
| External adoption analytics (`adoption-analytics`) | **not available** (§12.7) | `features.adoptionSignal` stays off; the signal reports `unavailable`, never a fake score |

## Setup

No extra environment variable is required to use the module. The worker-authorised endpoints use the
existing `REPORT_WORKER_SECRET` capability (the same one the Reports module uses); with no
capability configured, the scheduled Customer Success jobs are **inert — completed with
`{disabled: true}` — not failed**. Enabling in-app notifications is a settings change, not a
deployment change (`features.notifications`, admin guide).
