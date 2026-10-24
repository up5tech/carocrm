# Phase 19-LS.1 — Domain boundaries, naming, and module registration

> `PLAN_Phase_19_LeadScore.md` §16 `Phase 19-LS.1`, on the feature contract in
> [`lead-score-audit.md`](lead-score-audit.md) and the behavior record in
> [`../compatibility/lead-score.md`](../compatibility/lead-score.md).
> Acceptance: the module loads, is discoverable, and does not conflict with existing Lead behavior.
> Followed by: `lead-score-ls2-completion-report.md` (19-LS.2, schema and metadata).

Delivered **2026-10-24**. Canonical module name `LeadScore` — no `Ua` prefix appears in any module
identifier, route, settings key, capability, job namespace or document name added here (plan §0.1-1).

---

## 1. What landed

### 1.1 The module directory

`apps/api/src/lead-score/` is a kernel domain directory, registered by barrel rather than by a
per-domain `@Module` class (see §3.2):

| File | Responsibility |
| --- | --- |
| [`lead-score-domain.ts`](../../apps/api/src/lead-score/lead-score-domain.ts) | The names the platform addresses this module by: settings row `leadScore`, module key, event/job namespace, the synthetic ACL resources, the four entities LS.2 will register, the core entities it extends, and the `Converted` / `Dead` Lead status values it reuses |
| [`lead-score-module.ts`](../../apps/api/src/lead-score/lead-score-module.ts) | The descriptor: id/version/prefix/load order/implemented phases/entity sets, the 14-entry capability matrix, the 15 feature switches **each carrying the sub-phase that implements it**, the required platform capabilities with their evidence, the optional integrations with their marker entities, and the error-code union |
| [`lead-score-errors.ts`](../../apps/api/src/lead-score/lead-score-errors.ts) | `LeadScoreError` on the platform `AppError` (stable `code`, localized through `errors.<CODE>`), plus `LEADSCORE_MODULE_DISABLED` (403) and `LEADSCORE_PHASE_PENDING` (409) |
| [`lead-score-settings.service.ts`](../../apps/api/src/lead-score/lead-score-settings.service.ts) | The validated, versioned `leadScore` row in `app_settings`: `enabled` + `features`, with `effective`, `pendingFeatures`, warnings and defaults |
| [`lead-score-permission.service.ts`](../../apps/api/src/lead-score/lead-score-permission.service.ts) | The only place a route asks about a capability: `level` / `can` / `assert` / `describe` / `capabilities` over `AclApiService.canUser(resource, action)` |
| [`lead-score-feature-gate.service.ts`](../../apps/api/src/lead-score/lead-score-feature-gate.service.ts) | The single gate every later command calls: 11 operations, each mapped to a capability + a feature + the phase that owes it; `assess` (non-throwing, for health/UI) and `assertOperation` (refusal) |
| [`lead-score-module-health.service.ts`](../../apps/api/src/lead-score/lead-score-module-health.service.ts) | Health read from the running system: `information_schema`, the metadata registry, the hook registry, the settings row, the caller's capabilities and the gate's answers, plus four registration invariants |
| [`dto/lead-score-shapes.ts`](../../apps/api/src/lead-score/dto/lead-score-shapes.ts) | Strict Zod shapes: the settings patch (fields enforced by the settings schema) and the operation probe (enum of the 11 known operations) |
| [`lead-score.controller.ts`](../../apps/api/src/lead-score/lead-score.controller.ts) | `/api/v1/LeadScore` — `action/health`, `action/capabilities`, `action/permissions`, `action/settings` (GET+POST), `action/operation-gate` |
| [`index.ts`](../../apps/api/src/lead-score/index.ts) | `LEADSCORE_CONTROLLERS`, `LEADSCORE_PROVIDERS`, and the module's public surface |

Registration: [`app.module.ts:153`](../../apps/api/src/app.module.ts#L153) spreads the controllers
**before** `...ENTITY_CONTROLLERS` ([`app.module.ts:160`](../../apps/api/src/app.module.ts#L160)), and
[`app.module.ts:208`](../../apps/api/src/app.module.ts#L208) spreads the providers before
`...ENTITY_PROVIDERS` ([`app.module.ts:212`](../../apps/api/src/app.module.ts#L212)) — the position `ESignature`
holds, immediately ahead of the generic entity wildcard.

### 1.2 The capability matrix (plan §9.1)

Fourteen synthetic ACL resources, evaluated by the platform's existing engine — no new permission
table, no second evaluator:

| Capability | Resource / action | Capability | Resource / action |
| --- | --- | --- | --- |
| `viewScore` | `LeadScore` / `read` | `convertPreview` | `LeadConversionPreview` / `read` |
| `explainScore` | `LeadScoreExplain` / `read` | `convertExecute` | `LeadConversion` / `edit` |
| `recalculate` | `LeadScoreRecalculate` / `edit` | `duplicateOverride` | `LeadConversionOverride` / `edit` |
| `modelRead` | `LeadScoreModel` / `read` | `applyFieldChanges` | `LeadConversionFieldMerge` / `edit` |
| `modelManage` | `LeadScoreModel` / `edit` | `conversionAuditRead` | `LeadConversionOperation` / `read` |
| `modelPublish` | `LeadScoreModelPublish` / `edit` | `conversionRecover` | `LeadConversionRecover` / `edit` |
| `batchRecalculate` | `LeadScoreBatch` / `edit` | `settingsManage` | `LeadScoreSettings` / `edit` |

Deliberately **not** in the matrix: *Create Contact*, *Create Account*, *Link existing Contact/Account*
and *Convert Lead to Opportunity* (plan §9.1). Those are the core entities' own ACL and conversion
enforces them through `AclApiService` at execution time; a Lead-Score-shaped copy of them would be the
second permission system plan §0.1-16 forbids and could disagree with the first.

### 1.3 Feature switches and the phases that owe them

`enabled` (master, default **off**) plus 15 switches, each carrying its `pendingPhase`:
`modelAdministration` (LS.3), `scoring` (LS.4), `scoreExplanation` (LS.5), `manualRecalculation` /
`eventRecalculation` / `batchRecalculation` (LS.6), `thresholdNotifications` / `engagementSignals`
(LS.9), `duplicateDetection` (LS.11), `fieldMapping` / `conversionPreview` (LS.12), `leadConversion` /
`conversionRecovery` (LS.13), `opportunityConversion` (LS.16), `aiInsight` (LS.17).

`effective[key]` is `enabled && settings.enabled && every requirement effective && pendingPhase === null`.
A plan that describes a capability is not evidence that it exists (plan §0.1-4), so a switch whose
phase has not shipped is never effective, and the settings document emits a `phasePending` warning that
names the phase instead of letting an administrator believe scoring is live.

### 1.4 Dependencies, explicit and optional

Required (each verified against the running database by the health view): entity engine, the four core
CRM records, ACL, the hook registry, audit/stream/outbox, jobs and schedules, the instance settings
store.

Optional, detected by the **marker entity** the other module registers — never by an import, so an
absent module is a `false` answer rather than a broken boot: Marketing Automation (`Campaign`),
Email↔Lead links (`Email`), AI Agents (`AIAgent`), Workflows (`Workflow`). The `provides` text records
what the audit actually resolved about each: Marketing Automation engagement is a **table read**
because no open/click event is emitted; AI Agents answers **manual runs only**.

### 1.5 Metadata, events, jobs — registered where they belong

`LEADSCORE_MODULE.entityTypes` is `[]` and the health view asserts it. The four records
(`LeadScoreModel`, `LeadScoreRule`, `LeadScoreEvaluation`, `LeadConversionOperation`) are metadata
entities registered through `database/seed-metadata.ts` in **LS.2** — the phase that also owns
`073_phase19_lead_score.sql`. No event type and no job name is announced here either: they are declared
in the commit that emits or handles them (LS.6, LS.9), matching how `Sales` and `ESignature` grew.
Inventing a "registration" file for behavior that does not exist yet would be a contract nothing keeps.

---

## 2. Acceptance criteria, each with the check that was actually run

`15 passed (15)` in `apps/api/test/lead-score-module.test.ts`, against the configured primary database
through the real HTTP API (`apps/api/test/support/boot-api.ts`), no test database created.

| Criterion | Evidence |
| --- | --- |
| **The module loads** | `GET /api/v1/LeadScore/action/health` → 200 with the descriptor; the boot log resolves the full DI graph with `LEADSCORE_PROVIDERS` registered |
| **…and is discoverable** | `ok: true` with all seven required capabilities reported `present` from `information_schema` and the metadata registry; `module.implementedPhases` = `['19-LS.0','19-LS.1']`; the five routes appear in the generated `GET /api/v1/OpenApi` document (asserted per path and verb) |
| **No scoring or conversion is reachable yet** | `ready: false`, `reason` names the module switch; all 11 operations refused; with the module switched **on**, the same probe returns `LEADSCORE_PHASE_PENDING` with the right phase for `readScore` (LS.4), `publishModel` (LS.3), `conversionExecute` (LS.13) and `aiInsight` (LS.17) |
| **Authorization is server-side** | a role with only `Lead` permissions gets **403** on all five routes; a role holding `LeadScore:read` + `LeadScoreSettings:edit` gets 200 on the control plane and still `granted: false` for `convertExecute` and `modelPublish`; the capability matrix route is gated too |
| **The gate fails closed** | `assertOperation` called in-process with no request principal throws the capability refusal rather than falling through to configuration |
| **Settings cannot store a typo or speculation** | `features.scingg` → 422 and nothing persisted; a top-level `scaleMax` (a value nothing reads yet) → 422; an accepted patch bumps `version` and writes the `leadScore` row in `app_settings` |
| **No conflict with existing Lead behavior** | `checks.core-lead-lifecycle.ok` with the real `New, Assigned, In Process, Converted, Dead` enum; `checks.lead-fields-untouched.ok` proves no score or `converted*` attribute leaked onto `Lead`; `GET /api/v1/LeadScore` is **not** served as an entity (≥ 400) while `action/health` is |
| **Lead, Contact, Account, Opportunity CRUD unchanged** | with the module registered *and switched on*, the suite creates a Lead/Contact/Account/Opportunity through the generic API, reads the Account's `contacts` relation, patches the Lead's status, and deletes all four — every call succeeds |
| **Module disablement breaks nothing** | the same CRUD assertions run with `enabled: true` and `features.leadConversion: true`; the master switch only closes the module's own surface |

Adjacent suites re-run after the `AppModule` change, all green:
`entity-crud` `entity-row-actions` `entity-manager-metadata` `navigation` `i18n` (55 tests), then
`sales-module` `admin-internal` `docs` `crm-chat` (54 tests).

Repository checks: `npm run typecheck` (both projects) exit 0;
`npx eslint apps/api/src/lead-score apps/api/test/lead-score-module.test.ts apps/api/src/app.module.ts
--max-warnings=0` exit 0.

Database policy (AGENTS.md §3): the only non-record write is the `leadScore` settings row, restored to
its exact previous content (or removed, when the run created it) in `afterAll`. Test records are
`AGENT_TEST_LS1_`-prefixed, removed by their own ids together with their `entity_links`, and the suite
now warns if any of its own rows survive. Verified afterwards: `0` records, `0` roles, `0` users and
no `leadScore` row in the development database. No migration, no DDL, no truncate, no new database.

---

## 3. Decisions taken in this phase

### 3.1 The settings document holds only what this build reads

Plan §5.1 lists a scale, base score, floors/ceilings and band thresholds on a *model*; the natural
place for the module-wide defaults would be this row. They are **not** here: no code consults them
until LS.3/LS.4, and a switch that nothing reads is configuration that lies (the `AI Agents` module
carries exactly that defect). Each later phase adds the section it reads, in its own commit. The
422 test on `scaleMax` pins this rule down so a future phase cannot quietly park a value there.

### 3.2 No `LeadScoreModule` class

The plan header names `LeadScoreModule` as the NestJS module class. This repository has no per-domain
`@Module` class at all — a domain module *is* its barrel plus the two spreads in `AppModule`
(`Sales`, `Projects`, `ServiceDesk`, `CustomerSuccess`, `ESignature` all follow this). Creating one
class for `LeadScore` alone would fork the convention and give `AppModule` a second, inconsistent way
to wire a module. The identity lives in `LEADSCORE_MODULE`.

### 3.3 No navigation entry and no admin settings tab yet

Plan §16 LS.1 says "add `lead-score` navigation/settings surfaces **only if appropriate**". The sidebar
entry would point at an SPA route that does not exist until LS.7/LS.8, so it is not added, and the
`NAVIGATION_FEATURE_GATE` case for `leadScore`/`enabled` comes with it — a gate branch that guards no
entry is dead code. The server-side answer the menu will use already exists
(`action/capabilities`: `enabled`, `effective`, `pendingFeatures`), so the UI phase renders from a
settled contract instead of inventing one.

### 3.4 Health separates `ok` from `ready`, and reports the phase that owes the work

`ok` = platform foundation **and** the registration invariants. `ready` = at least one operation is
admitted for this caller. An operator must be able to tell "a dependency is missing" from "this is not
built yet", so a closed feature answers with `LEADSCORE_PHASE_PENDING` and the phase id
(`19-LS.13`), never with a generic "feature disabled".

### 3.5 The refusal reason is not carried in `details.reason`

`details.feature` / `details.pendingPhase` / `details.blockedBy` — the global exception filter
overwrites `details.reason` with the localized message (learned in ES.20 and re-confirmed here).

### 3.6 `conversionAuditRead` already names `LeadConversionOperation`

That resource is the LS.2 entity's name on purpose: when the metadata entity is registered the same
role grant keeps working, and the check degrades to a plain entity ACL rather than a rename event.

---

## 4. Known limitations of this build

* **No scoring, no conversion, no metadata entity, no migration.** LS.1 is the control plane only.
  `ready` is `false` by design and every operation refuses with the phase that owes it.
* The module is **off by default** and there is no UI to turn it on; an administrator sets
  `POST /api/v1/LeadScore/action/settings { "enabled": true }` until LS.8 ships the settings tab.
* Role grants for the synthetic resources must be written into `roles.permissions` by name; the
  administration role screen lists metadata entities, so a friendlier picker arrives with LS.8
  (the same limitation `ESignature` and `AIAgents` carry).
* No OpenAPI examples yet: the spec is generated from the route decorators and now lists the five
  paths; request/response schemas are exercised, not illustrated. Samples with synthetic values come
  with the phases that produce payloads.
* `assessAll()` answers 11 capability checks per health call. At this size that is fine; if the
  operation list grows enough to matter, the ACL snapshot is already request-scoped and cached.

## 5. What LS.2 must not forget

* `073_phase19_lead_score.sql` is additive and index-only (audit §4); review the SQL before applying,
  and never re-run it as a reset.
* The score and `converted*` fields go on the **core `Lead` entry** in `database/seed-metadata.ts` —
  `database/seed.ts:458-469` rewrites `metadata_entries` on every seed, so an admin runtime patch to
  those scopes would not survive (audit §8, gap G4).
* `LEADSCORE_MODULE.entityTypes` and the `lead-fields-untouched` health check both encode "LS.1 state"
  and must be updated in the LS.2 commit, or LS.2 will fail its own invariant.
* The four resources named `LeadScore*` / `LeadConversion*` are already the intended entity names;
  registering the metadata entities must reuse them exactly.
