# Customer Success data model (Phase 19-CS)

Storage follows the platform decision the repository already made: **every Customer Success record
is a row in `entity_records`** (physical columns `id`, `entity_type`, `name`, `attrs JSONB`,
`version`, `deleted_at`, `created_at`, `modified_at` …), so the Entity Engine keeps ownership of
CRUD, validation, audit, stream, hooks and record ACL. There is no second persistence layer, no
service-specific table and no ORM for this module.

- Registered in `database/seed-metadata.ts` (§6.2) with `standardFields`-equivalent common fields via
  the module's `csFields()` helper, `layouts` for the generic UI, `acl.permissions` defaults and
  `indexes` as **metadata only** (physical indexes are created by the migration).
- One additive migration: `database/migrations/032_phase19_customer_success.sql` (§6.4). It creates
  indexes only — no table, no column, no row is created, dropped or rewritten.
- JSON payloads (`attrs`) that carry a versioned structure — health `components`, playbook
  `stepSnapshot`, `steps`, `resolutionHistory` — are written and read by the module only, never
  interpolated into SQL, and every value reaches PostgreSQL as a bind parameter (§6.5, AGENTS §5.2).

## Entities (§6.1)

### A. `CustomerSuccessProfile` — one per Account

| Group | Fields |
|---|---|
| Ownership | `accountId`, `csmUserId`, `csmTeamId`, `segment`, `customerSince` |
| Lifecycle | `lifecycleStage`, `lifecycleStageReason`, `lifecycleStageChangedAt` |
| Health summary (read-optimised) | `healthStatus`, `calculatedHealthStatus`, `healthScore`, `healthScoreAt`, `scoreTrend`, `activePlanProgress`, `openRiskCount`, `lastMeaningfulTouchAt` |
| Override | `healthOverride`, `healthOverrideReason`, `healthOverrideByUserId`, `healthOverrideAt`, `healthOverrideExpiresAt` |
| Onboarding | `onboardingStatus`, `onboardingStartedAt`, `onboardingTargetDate`, `onboardingCompletedAt`, `activePlaybookRunId` |
| Renewal | `renewalDate`, `renewalStatus`, `renewalSource`, `renewalSyncedAt`, `notifiedRenewalWindows` |
| Cadence | `nextSuccessReviewAt`, `lastHealthReviewAt`, `primaryPlanId`, `executiveSponsorContactId` |

The summary fields are a **cache**: `CustomerSuccessHealthSnapshot` rows remain the source for
explaining a change (§6.1 A). `ensureProfile` is idempotent, and the partial unique index below makes
a duplicate impossible even for a hand-written insert.

### B. `CustomerSuccessHealthSnapshot` — append-only

`profileId`, `accountId`, `score`, `status`, `effectiveStatus`, `coverage`, `configurationVersion`,
`source` (`manual|scheduled|event|rebuild`), `resultState`, `errorSummary`, `durationMs`,
`components` (JSONB, versioned), `signature`, `triggerReason`, `idempotencyKey`, `calculatedAt`.

`signature` = configuration version + calculation identity: a recalculation whose inputs did not
materially change does **not** write a second row unless `force: true` (§5.4.4). Ordinary users cannot
create or edit these records; `action/recalculateHealth` is the only writer.

### C. Scoring configuration — the settings document, not a table

§6.1 C asks for `CustomerSuccessScoringConfig` *or* a versioned slice of the module settings row and
prefers the existing `app_settings` store (§3.5). This module uses the settings document:
`GET/POST /api/v1/CustomerSuccess/action/settings`, validated by a strict Zod schema and versioned
(`version` bumps on every accepted patch). It holds signal definitions and weights, status
thresholds, freshness windows, minimum coverage, missing-data policy, rounding, feature flags,
lifecycle stages and allowed transitions, renewal windows, playbook limits, notification cadence and
job batch sizes. No executable script body is ever stored (§6.1 C).

### D. `CustomerSuccessPlan`

`profileId`, `accountId`, `ownerUserId`, `status` (`draft|active|onHold|completed|canceled`),
`isPrimary`, `planType`, `startDate`, `endDate`, `nextReviewDate`, `completedDate`,
`closeOutSummary`, `outcomes`, `baselineSummary`, `progress`, `executiveSponsorContactId`,
`projectId`, `contactIds`, `opportunityId`.

`progress` is recomputed from the plan's goals (direction-aware) whenever a goal changes; only one
plan per profile is `active` (enforced by `activatePlan`, §5.6).

### E. `CustomerSuccessGoal`

`planId`, `profileId`, `accountId`, `direction` (`increase|decrease|maintain|boolean|manual`),
`category`, `baselineValue`, `baselineDate`, `targetValue`, `targetDate`, `currentValue`,
`currentDate`, `unit`, `tolerance`, `status`, `progress`, `progressAt`, `progressExplanation`,
`overdue`, `checkpointNotes`, `ownerUserId`, `contactId`.

Progress is computed by the pure `computeGoalProgress` for every direction, bounded 0–100 and safe
against division by zero; `progressExplanation` states the arithmetic in words. `overdue` is a
**derived flag** maintained by `customerSuccess.updateGoalOverdueState` — the job writes it only when
it differs from the computed value.

### F. `CustomerSuccessRisk`

`profileId`, `accountId`, `planId`, `riskType`, `severity` (`low|medium|high|critical`), `status`
(`open|mitigating|escalated|resolved|accepted|closed`), `ownerUserId`, `escalationTeamId`,
`contactId`, `opportunityId`, `subscriptionId`, `detectedDate`, `nextReviewDate`,
`targetResolutionDate`, `resolvedDate`, `evidenceSummary`, `mitigationPlan`, `nextAction`,
`resolutionReason`, `resolutionHistory`, `contributesToHealth`, `probability`, `impact`.

A High/Critical risk needs a mitigation plan **or** a documented next action (§5.8), validated in the
domain service. A risk never sets the lifecycle by itself (§13.7); it contributes to health through
the `risks` signal when `contributesToHealth` is true.

### G–I. Playbook records

| Entity | Fields |
|---|---|
| `CustomerSuccessPlaybookTemplate` | `playbookType`, `triggerMode`, `triggerConfig`, `isActive`, `version`, `steps` (JSON: `key`, `name`, `stepType`, `order`, `required`, `dueOffsetDays`, `assigneePolicy`, `dependsOn`, `instructions`) |
| `CustomerSuccessPlaybookRun` | `profileId`, `accountId`, `templateId`, `templateVersion`, `status`, `onboarding`, `startedAt`, `completedAt`, `canceledAt`, `cancelReason`, `triggerSource`, `triggerKey`, `stepSnapshot`, `stepCount`, `completedStepCount`, `errorSummary` |
| `CustomerSuccessPlaybookStepRun` | `runId`, `profileId`, `accountId`, `stepKey`, `stepOrder`, `stepType`, `status`, `isRequired`, `dependsOn`, `dueDate`, `assigneeUserId`, `linkedEntityType`, `linkedEntityId`, `completedAt`, `completionNote`, `errorSummary`, `attemptCount`, `skipReason`, `waitUntil`, `instructions` |

The run stores a **snapshot of the template's steps** (`stepSnapshot`) plus the template version, so
editing a template never rewrites history (§5.11.2). Step `status` is
`pending|inProgress|completed|skipped|failed|canceled`; `failed` carries `errorSummary` +
`attemptCount` and is what `retryFailedSteps` retries (§5.11.3). `waitUntil` steps park as
`inProgress` until their date.

The installation's default onboarding playbook is seeded once as `csTemplateOnboarding`
(`customer-success-defaults.ts` + `database/seed.ts`, `ON CONFLICT DO NOTHING`).

### J. `CustomerSuccessReview` (implemented, §5.10)

`profileId`, `accountId`, `activityType`, `activityId`, `reviewDate`, `sentiment`, `objectives`,
`outcomes`, `openRisks`, `goalProgressNote`, `actionItems`, `nextReviewDate`, `ownerUserId`,
`contactIds`. A review **links** to an existing Activity (`activityId`) instead of duplicating
scheduling — no second calendar, no second reminder (§3.6).

### K. Onboarding — no extra tables (§6.1 K)

Onboarding is `CustomerSuccessProfile` (`onboarding*` fields, `activePlaybookRunId`) plus a
`CustomerSuccessPlaybookRun` flagged `onboarding: true` and its Step Runs. Nothing was added that
the playbook model already represents.

## Relations (§6.3)

Declared in metadata so the generic related-records endpoints resolve:

- `CustomerSuccessProfile` → `plans`, `goals`, `risks`, `snapshots`, `playbookRuns`, `reviews`
  (oneToMany), `contacts` (to `Contact`).
- `CustomerSuccessPlan` → `goals`, `risks` (oneToMany).
- `CustomerSuccessPlaybookRun` → `steps` (oneToMany, `mappedBy: 'run'`).
- Link fields on Goal/Risk/Plan/Review point at `Contact`, `Opportunity`, `Subscription` and
  `Project` — relations to entities that exist in this repository only (§3.7, §6.3).

Relations obey ACL at both ends: seeing a Profile never grants access to an unrelated related record
(§6.3, §9.2).

## Constraints and indexes (§6.4)

`032_phase19_customer_success.sql` (additive, `IF NOT EXISTS`, reviewed before it was applied):

| Index | Purpose |
|---|---|
| `uq_customer_success_profile_account` — UNIQUE on `(attrs->>'accountId')` **partial** `entity_type='CustomerSuccessProfile' AND deleted_at IS NULL` | one *active* profile per Account; an archived profile does not block a new one (§13.1) |
| `uq_customer_success_run_trigger` — UNIQUE on `(attrs->>'triggerKey')` partial, `triggerKey IS NOT NULL` | a triggered playbook runs once per key (§5.11.3) |
| `idx_entity_records_cs_profile_{csm,team,health,lifecycle,onboarding,renewal}` | portfolio queues and filters (§5.2) |
| `idx_entity_records_cs_snapshot_profile_time` on `(profileId, calculatedAt)` | history and trend reads (§5.4.4) |
| `idx_entity_records_cs_plan_profile` on `(profileId, status)` | plan roll-ups (§5.6) |
| `idx_entity_records_cs_goal_plan`, `idx_entity_records_cs_goal_due` | goal lists and the overdue scan (§5.7, §11.1) |
| `idx_entity_records_cs_risk_profile` on `(profileId, status, severity)`, `idx_entity_records_cs_risk_due` | open-risk queues and the escalation scan (§5.8, §11.1) |
| `idx_entity_records_cs_run_profile`, `idx_entity_records_cs_step_run`, `idx_entity_records_cs_step_assignee` | playbook reads and job scans (§5.11, §11.1) |
| `idx_entity_records_cs_review_profile` on `(profileId, reviewDate)` | review cadence (§5.10) |

`database/seed-metadata.ts` also declares matching *metadata* indexes for the query engine; they are
declarations, never DDL (§6.2). The migration contains nothing beyond the indexes listed above —
no column, no table, no rewritten row.

## JSON and structured fields (§6.5)

| Field | Contract |
|---|---|
| `CustomerSuccessHealthSnapshot.components` | array of `{ key, weight, score, applicability, contribution, measuredAt, explanationCode }`, produced and consumed by the module only; `configurationVersion` ties it to the settings version |
| `PlaybookTemplate.steps` / `PlaybookRun.stepSnapshot` | JSON string of `{ key, name, stepType, order, required, dueOffsetDays, assigneePolicy, dependsOn, instructions }`; `parseSteps()` tolerates a missing key so an edited row degrades to `manual` rather than crashing |
| `Risk.resolutionHistory` | append-only text lines with an ISO timestamp prefix |
| `Profile.notifiedRenewalWindows` | array of window sizes already notified, so a window is announced once (§11.2 cadence) |
| `PlaybookStepRun.dependsOn` | JSON string array of step keys |

No activity bodies, no large customer blobs and no unbounded attachments are stored in a snapshot
(§6.5).

## Migration strategy (§6.6)

- One additive migration, reviewed before applying to the configured primary database; **no second
  database or schema was ever created** (AGENTS §3).
- Backfill of profiles is *not* done on boot: `ensureProfile` is the explicit, idempotent, resumable
  path a workflow, job or administrator calls (§6.6). There is no silent per-Account creation.
- Seed rows use fixed ids + `ON CONFLICT DO NOTHING` (default onboarding template, eight
  `scheduled_jobs` rows), so a re-run never duplicates them and never overwrites an operator's edit.
