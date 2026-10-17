# Customer Success API (Phase 19-CS)

Root: `/api/v1`. Everything below is a real, current route. Entity CRUD follows the platform
convention (`apps/api/src/sales/sales.controller.ts`, `docs/module-guide.md` → "API conventions");
domain actions live under the one PascalCase prefix `/api/v1/CustomerSuccess/action/*`, declared
**before** `ENTITY_CONTROLLERS` in `apps/api/src/app.module.ts` so the generic `:entity` wildcard can
never swallow it.

## Conventions

- **Auth**: `Authorization: Bearer <jwt>` (or `ApiKey` / `CRM-SESSION` as elsewhere). Unsafe methods
  also need the CSRF header the platform already enforces.
- **List envelope**: `{ list, total, offset, count }`. **Record envelope**: flat object —
  `id, name, createdAt, modifiedAt, assignedUserId, createdById, modifiedById, teams, version` plus
  the entity's fields.
- **Errors**: `{ "error": { "code", "message", "details?" } }` with a matching HTTP status.
  - `400 INVALID_QUERY` + `details.issues[]` — a malformed body: a failed Zod shape, a missing or
    non-numeric query parameter, an unknown field (`.strict()`). This is what the shared `parse()`
    helper in `sales.controller.ts`, `projects.controller.ts` and here does for identical input.
  - `422 VALIDATION_FAILED` — a domain rule: invalid transition, missing reason, High risk without a
    mitigation, stale `version`, settings that do not validate.
  - `401` / `403` — no session or no permission; `404` (`NOT_FOUND` / `RECORD_NOT_FOUND`) — the
    record does not exist or the caller may not know it does.
- **Validation**: every body is parsed by a `.strict()` Zod schema in
  `apps/api/src/customer-success/dto/customer-success-shapes.ts`; unknown fields are rejected rather
  than ignored (§8.2).
- **Concurrency**: state transitions accept `version` where the plan requires optimistic concurrency
  (`LifecycleTransitionSchema.version`); the `version` column is the platform's own.
- **Idempotency**: `ensureProfile`, `startPlaybook`, `startOnboarding`, `escalateRisk` and
  `completePlaybookStep` are safe to repeat — the second call reports `created: false` /
  `changed: false` and changes nothing.

## Entity resources (§8.1)

No controller is needed for these: they are served by the generic `/api/v1/:entity` routes with
list, detail, create, edit, delete, search, export, stream and related-records resolution.

| Entity | Notes |
|---|---|
| `/api/v1/CustomerSuccessProfile` | one per Account (partial unique index) |
| `/api/v1/CustomerSuccessHealthSnapshot` | append-only for ordinary users; calculated fields cannot be written from a payload |
| `/api/v1/CustomerSuccessPlan` | |
| `/api/v1/CustomerSuccessGoal` | |
| `/api/v1/CustomerSuccessRisk` | |
| `/api/v1/CustomerSuccessPlaybookTemplate` | |
| `/api/v1/CustomerSuccessPlaybookRun` | |
| `/api/v1/CustomerSuccessPlaybookStepRun` | |
| `/api/v1/CustomerSuccessReview` | success reviews (§5.10) |

```http
GET /api/v1/CustomerSuccessProfile?where=[{"field":"healthStatus","operator":"equals","value":"atRisk"}]&maxSize=20&orderBy=modifiedAt&order=desc
```

```json
{
  "list": [
    {
      "id": "9f0a6d54-1a2b-4c3d-9e8f-112233445566",
      "name": "Northwind Traders",
      "accountId": "3c1f2a10-0000-4000-8000-000000000001",
      "csmUserId": "adminUserId",
      "csmTeamId": null,
      "lifecycleStage": "adoption",
      "segment": "midMarket",
      "healthStatus": "atRisk",
      "calculatedHealthStatus": "atRisk",
      "healthScore": 52,
      "scoreTrend": "declining",
      "healthOverride": null,
      "onboardingStatus": "completed",
      "renewalStatus": "notDue",
      "renewalDate": "2027-01-31",
      "activePlanProgress": 45,
      "openRiskCount": 2,
      "lastMeaningfulTouchAt": "2026-10-02T09:15:00.000Z",
      "version": 7,
      "createdAt": "2026-06-01T10:00:00.000Z",
      "modifiedAt": "2026-10-16T11:42:00.000Z",
      "assignedUserId": null,
      "createdById": "adminUserId",
      "modifiedById": "adminUserId",
      "teams": []
    }
  ],
  "total": 1,
  "offset": 0,
  "count": 1
}
```

## Domain actions (§8.2)

### Diagnostics and settings

| Method | Route | Access |
|---|---|---|
| `GET` | `/api/v1/CustomerSuccess/action/health` | administrator |
| `GET` | `/api/v1/CustomerSuccess/action/settings` | authenticated |
| `POST` | `/api/v1/CustomerSuccess/action/settings` | administrator |

```http
POST /api/v1/CustomerSuccess/action/settings
{ "health": { "minimumCoverage": 0.4, "signals": [{ "key": "engagement", "weight": 30 }] } }
```

```json
{
  "settings": { "features": { "healthScoring": true, "notifications": false }, "health": { "…": "…" } },
  "version": 4,
  "warnings": [{ "code": "noEnabledSignals", "message": "…" }]
}
```

### Profiles, lifecycle and portfolio

| Method | Route | Access | Purpose |
|---|---|---|---|
| `POST` | `/action/ensureProfile` | record create ACL | idempotent profile per Account |
| `GET` | `/action/profileSummary` | record read ACL | the §10.2 profile summary |
| `POST` | `/action/assignProfile` | record edit ACL | set/clear CSM and team |
| `POST` | `/action/transitionLifecycle` | record edit ACL | validated transition + reason |
| `POST` | `/action/transitionLifecycleBulk` | record edit ACL (per id) | ≤ 200 ids, per-record result |
| `POST` | `/action/transitionPreview` | authenticated | what would change, without changing it |
| `GET` | `/action/portfolioQueues` | authenticated, ACL-scoped | the §5.2 queues |
| `GET` | `/action/portfolioSummary` | authenticated, ACL-scoped | aggregate by health/lifecycle/queue |

```http
POST /api/v1/CustomerSuccess/action/transitionLifecycle?profileId=9f0a6d54-…
{ "to": "atRisk", "reason": "Weekly active users down for three weeks.", "version": 7 }
```

```json
{ "profileId": "9f0a6d54-…", "from": "adoption", "to": "atRisk", "changed": true, "version": 8 }
```

```http
GET /api/v1/CustomerSuccess/action/portfolioQueues?queue=atRisk&limit=20&offset=0
```

```json
{ "queue": "atRisk", "list": [ { "id": "…", "name": "Northwind Traders", "healthStatus": "atRisk" } ],
  "count": 1, "total": 1, "truncated": false }
```

### Health (§5.4, §5.5)

| Method | Route | Access |
|---|---|---|
| `POST` | `/action/recalculateHealth` | record edit ACL |
| `GET` | `/action/healthHistory` | record read ACL |
| `GET` | `/action/healthExplanation` | record read ACL |
| `POST` | `/action/setHealthOverride` | administrator **or** profile owner |
| `POST` | `/action/clearHealthOverride` | administrator **or** profile owner |
| `POST` | `/action/bulkRecalculateHealth` | administrator (enqueues a job) |

```http
POST /api/v1/CustomerSuccess/action/recalculateHealth
{ "profileId": "9f0a6d54-…", "force": true }
```

```json
{
  "profileId": "9f0a6d54-…", "accountId": "3c1f2a10-…",
  "score": 52, "status": "atRisk", "effectiveStatus": "atRisk",
  "override": { "status": null, "reason": null, "expiresAt": null, "active": false },
  "coverage": 0.72, "configurationVersion": 4, "calculatedAt": "2026-10-17T07:20:00.000Z",
  "trend": "declining", "snapshotWritten": true, "degraded": false,
  "components": [
    { "key": "engagement", "label": "Engagement", "weight": 25, "score": 38,
      "applicability": "applicable", "contribution": 9.5, "measuredAt": "2026-10-16T09:00:00.000Z" }
  ]
}
```

```http
POST /api/v1/CustomerSuccess/action/setHealthOverride
{ "profileId": "9f0a6d54-…", "status": "healthy", "reason": "Agreed a green status with the exec sponsor.",
  "expiresAt": "2026-11-30" }
```

```json
{ "profileId": "9f0a6d54-…", "override": "healthy", "calculatedStatus": "atRisk" }
```

```http
POST /api/v1/CustomerSuccess/action/bulkRecalculateHealth
{}
```

```json
{ "job": { "id": "5c1f2a10-…", "job": "customerSuccess.recalculateHealthBatch", "status": "pending",
           "createdAt": "2026-10-17T07:30:00.000Z" } }
```

### Plans, goals and risks

| Method | Route | Access |
|---|---|---|
| `POST` | `/action/createPlan` | record create ACL (profile or account) |
| `POST` | `/action/activatePlan`, `/action/completePlan` | record edit ACL on the plan |
| `POST` | `/action/duplicatePlan` | record edit ACL |
| `GET` | `/action/planSummary` | record read ACL on the profile |
| `POST` | `/action/createGoal` | record edit ACL on the plan |
| `POST` | `/action/updateGoalProgress` | record edit ACL on the goal |
| `POST` | `/action/createRisk` | record create ACL |
| `POST` | `/action/transitionRisk` | record edit ACL |
| `POST` | `/action/escalateRisk`, `/action/resolveRisk`, `/action/reopenRisk` | record edit ACL |

```http
POST /api/v1/CustomerSuccess/action/createGoal
{ "planId": "…", "name": "Weekly active users to 120", "direction": "increase",
  "baselineValue": 80, "targetValue": 120, "currentValue": 90, "targetDate": "2026-12-31" }
```

```json
{ "id": "…", "progress": 25, "status": "inProgress", "progressExplanation": "90 of 120 from a baseline of 80." }
```

```http
POST /api/v1/CustomerSuccess/action/createRisk
{ "profileId": "9f0a6d54-…", "title": "Sponsor changed", "severity": "high", "riskType": "stakeholder",
  "nextAction": "Book an introduction with the new sponsor." }
```

A High/Critical risk without a mitigation plan **or** a next action answers
`422 VALIDATION_FAILED` ("A High or Critical risk needs a mitigation plan or a documented next
action.").

```http
POST /api/v1/CustomerSuccess/action/resolveRisk
{ "riskId": "…", "outcome": "New sponsor met; plan re-confirmed for the renewal." }
```

```json
{ "riskId": "…", "status": "resolved" }
```

### Playbooks and onboarding (§5.5, §5.11)

| Method | Route | Access |
|---|---|---|
| `POST` | `/action/createPlaybookTemplate` | template create ACL (administrator in practice) |
| `POST` | `/action/startPlaybook` | record edit ACL on the profile |
| `GET` | `/action/playbookRun` | record read ACL on the run |
| `POST` | `/action/completePlaybookStep` | record edit ACL on the step |
| `POST` | `/action/skipPlaybookStep` | record edit ACL; administrator to skip a required step |
| `POST` | `/action/waitPlaybookStep` | record edit ACL (only `waitUntil` steps) |
| `POST` | `/action/cancelPlaybookRun`, `/action/retryFailedSteps` | record edit ACL on the run |
| `POST` | `/action/startOnboarding`, `/action/completeOnboarding` | record edit ACL on the profile |

```http
POST /api/v1/CustomerSuccess/action/createPlaybookTemplate
{
  "name": "Enterprise onboarding",
  "playbookType": "onboarding",
  "triggerMode": "manual",
  "isActive": true,
  "steps": [
    { "key": "kickoff", "name": "Kickoff call", "stepType": "createTask", "order": 0,
      "required": true, "dueOffsetDays": 3 },
    { "key": "training", "name": "Administrator training", "stepType": "manual", "order": 1,
      "dependsOn": ["kickoff"], "dueOffsetDays": 21 }
  ]
}
```

```json
{ "id": "…", "version": 1, "steps": 2 }
```

```http
POST /api/v1/CustomerSuccess/action/startPlaybook
{ "profileId": "9f0a6d54-…", "templateId": "csTemplateOnboarding",
  "triggerKey": "onboarding:9f0a6d54-…:csTemplateOnboarding" }
```

```json
{ "runId": "…", "created": true, "steps": 5 }
```

A `triggerKey` that already exists answers `created: false` with the **same** `runId` — no second
run, no second set of steps (enforced again by the partial unique index).

```http
POST /api/v1/CustomerSuccess/action/completePlaybookStep
{ "stepRunId": "…", "note": "Held on 14 Oct with the ops lead." }
```

```json
{ "stepRunId": "…", "status": "completed",
  "produced": { "entityType": "Task", "id": "a9d0a6d54-…" } }
```

When the step's producer fails (for example the profile was deleted), the step becomes `failed`
with `errorSummary` and `attemptCount`, `customerSuccess.playbook.failed` is emitted and the owner is
notified — and the **original error still reaches the caller** (typically `404 NOT_FOUND`):

```json
{ "error": { "code": "NOT_FOUND", "message": "CustomerSuccessProfile \"…\" does not exist." } }
```

### Renewals, touchpoints and reviews (§5.9, §5.10)

| Method | Route | Access |
|---|---|---|
| `GET` | `/action/renewalSummary` | record read ACL |
| `POST` | `/action/setRenewal`, `/action/syncRenewal` | record edit ACL |
| `GET` | `/action/recentTouchpoints` | record read ACL |
| `POST` | `/action/scheduleReview` | record edit ACL |
| `GET` | `/action/reviews` | record read ACL |

```http
POST /api/v1/CustomerSuccess/action/setRenewal
{ "profileId": "9f0a6d54-…", "renewalDate": "2027-01-31", "status": "preparing" }
```

```json
{ "profileId": "9f0a6d54-…", "renewalDate": "2027-01-31", "status": "preparing",
  "daysToRenewal": 106, "windowDays": 120, "source": "manual" }
```

### Dashlets (§5.12)

| Method | Route | Access |
|---|---|---|
| `GET` | `/action/dashlets` | authenticated (definitions; each run is ACL-scoped) |

```json
{ "list": [
  { "key": "atRisk", "label": "At-risk customers", "entity": "CustomerSuccessProfile", "kind": "portfolio" },
  { "key": "summary", "label": "Portfolio health", "kind": "summary" },
  { "key": "successPlans", "label": "Success plans", "entity": "CustomerSuccessPlan", "kind": "entityList" }
] }
```

## Worker-authorised routes (internal, §11.1)

`@Public()` (no session) **and** `x-worker-secret` compared in constant time against
`REPORT_WORKER_SECRET`; refused with `401` when the header is missing, wrong, or when no capability
is configured. Each runs under the documented service principal and returns its own counts.

| Route | Job |
|---|---|
| `POST /action/recalculate-batch` | `customerSuccess.recalculateHealthBatch` |
| `POST /action/expire-overrides` | `customerSuccess.expireHealthOverrides` |
| `POST /action/update-goal-overdue-state` | `customerSuccess.updateGoalOverdueState` |
| `POST /action/evaluate-renewal-windows` | `customerSuccess.evaluateRenewalWindows` |
| `POST /action/evaluate-risk-escalations` | `customerSuccess.evaluateRiskEscalations` |
| `POST /action/evaluate-review-reminders` | `customerSuccess.evaluateReviewReminders` |
| `POST /action/process-playbook-wait-steps` | `customerSuccess.processPlaybookWaitSteps` |
| `POST /action/repair-stale-playbook-runs` | `customerSuccess.repairStalePlaybookRuns` |

Body: `{ "today": "2026-10-17", "limit": 500 }` (`today` and `limit` optional; `recalculate-batch`
takes `limit` only).

```json
{ "processed": 25, "skipped": 24, "errors": 0, "durationMs": 41 }
```

## Not exposed on purpose (§8.3)

- Health snapshot writes and every calculated field (`healthScore`, `calculatedHealthStatus`,
  `scoreTrend`, `openRiskCount`, …) are rejected from ordinary create/edit payloads.
- There is no route that returns a profile's Account, Contacts or Activities without the caller's
  ACL on those records: holding a profile id grants nothing extra (IDOR, §9.3).
- Bulk recalculation is administrator-only and runs as a job, never as an unbounded loop inside a
  request (§11.1).
