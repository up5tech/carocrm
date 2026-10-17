# Customer Success — permissions and security model

Scope: how the module authorises reads, writes, transitions and automation. Normative references are
sections of `PLAN_Phase_19_Customer_Success.md`; code locations are on the line numbers of the
shipped files. **Nothing here is UI-only** — every rule below runs on the server before a row moves.

## 1. The one rule everything else follows

A user-visible read or write goes through `EntityCrudService`
(`apps/api/src/entity/entity.service.ts`), which calls `AclApiService`
(`apps/api/src/acl/acl-api.service.ts`) for the entity-level permission and then the record-level
predicate. The module never evaluates a role rule locally and never builds its own allow/deny table.
Domain commands additionally re-check the *specific* record they act on:

```ts
const decision = await acl.canAccessRecord(entity, action, { id, data, assignedUserId, createdById, teams });
```

`CustomerSuccessController.assertProfile` / `assertRecord` / `assertRecordOrThrow`
(`apps/api/src/customer-success/customer-success.controller.ts`) do exactly that for every command:
load the record through the entity API (read ACL), then re-check `edit`. A record the actor may read
but not edit is refused. `admin` principals bypass under the documented platform semantics
(`RequestScope.isAdmin`).

## 2. Entity ACL defaults

Registered in `database/seed-metadata.ts` with each entity's `acl.permissions` (the vocabulary is
the kernel's `yes | all | team | own | no`):

| Entity | create | read | edit | delete | stream |
|---|---|---|---|---|---|
| `CustomerSuccessProfile` | yes | all | own | own | own |
| `CustomerSuccessPlan` | yes | all | own | own | own |
| `CustomerSuccessGoal` | yes | all | own | own | own |
| `CustomerSuccessRisk` | yes | all | own | own | own |
| `CustomerSuccessReview` | yes | all | own | own | own |
| `CustomerSuccessPlaybookTemplate` | yes | all | yes | no | all |
| `CustomerSuccessPlaybookRun` | yes | all | own | no | own |
| `CustomerSuccessPlaybookStepRun` | yes | all | own | no | own |
| `CustomerSuccessHealthSnapshot` | yes | **no** | **no** | **no** | **no** |

Notes:

- `read: all` on the CSM entities means "visible to the roles that hold the permission"; the
  **record** level still decides which rows a non-admin sees, so a CSM does not automatically read
  another CSM's profiles.
- `CustomerSuccessHealthSnapshot` has no user read at entity level by design: scores and history are
  exposed through `GET …/action/healthHistory` and `…/healthExplanation`, which take the *profile's*
  ACL first. Combined with the write guard (§4) the snapshots are append-only and module-written.
- Field-level restrictions use the kernel's `roles.field_permissions`; the ACL evaluator reads the
  role row's own value, which is declarative until set (same rule as the Document module).

## 3. Command-level access (`/api/v1/CustomerSuccess/action/*`)

| Route group | Check before the work runs |
|---|---|
| `action/health` | `requireAdmin` |
| `POST action/settings` | `requireAdmin` |
| `action/bulkRecalculateHealth` | `requireAdmin` |
| `action/createPlaybookTemplate` | `requireAdmin` |
| `action/setHealthOverride` / `clearHealthOverride` | `requireElevated`: administrator, or the profile's own CSM/assignee |
| `action/recalculateHealth`, `healthHistory`, `healthExplanation` | `assertProfile(…, "edit" \| "read")` |
| `action/transitionLifecycle`, `assignProfile`, `startOnboarding`, `completeOnboarding`, `setRenewal`, `syncRenewal`, `scheduleReview` | `assertProfile(…, "edit")` |
| `action/transitionLifecycleBulk`, `transitionPreview` | every selected id is checked; a single refusal fails the whole call before any write |
| `action/activatePlan`, `completePlan`, `duplicatePlan`, `planSummary` | `assertRecord`/`assertProfile` on the plan or its profile |
| `action/createGoal`, `updateGoalProgress` | `assertRecord` on the plan/goal |
| `action/createRisk`, `transitionRisk`, `escalateRisk`, `resolveRisk`, `reopenRisk` | `assertRecord` on the risk |
| `action/startPlaybook`, `playbookRun`, `completePlaybookStep`, `skipPlaybookStep`, `waitPlaybookStep`, `cancelPlaybookRun`, `retryFailedSteps` | `assertProfile`/`assertRecord` on the run or its step run |
| `action/portfolioQueues`, `portfolioSummary`, `renewalSummary`, `reviews`, `recentTouchpoints`, `dashlets`, `settings` GET | authenticated; rows are ACL-scoped by the entity list itself |
| `action/*` worker twins (`recalculate-batch`, `expire-overrides`, …) | `@Public()` + `x-worker-secret` (§6) |

Bulk operations validate **every** selected record before the first write and return per-record
successes and failures; they never fail partially silently.

## 4. Server-owned fields — a client cannot forge a calculation

`CustomerSuccessWriteGuardService` registers a `beforeValidate` hook
(`apps/api/src/customer-success/customer-success-write-guard.service.ts`) that runs on **every**
write, including the generic `/api/v1/:entity` paths, and refuses a client write that changes a
field the module computes:

- profile: `healthStatus`, `calculatedHealthStatus`, `healthScore`, `healthScoreAt`,
  `healthOverrideByUserId`, `healthOverrideAt`, `lastMeaningfulTouchAt`, `lastHealthReviewAt`,
  `scoreTrend`, `openRiskCount`, `activePlanProgress`, onboarding roll-ups, `activePlaybookRunId`,
  `renewalSyncedAt`;
- plan: `progress`; goal: `progress`, `progressAt`, `status`; risk: `resolvedDate`;
- playbook template: `steps`; run and step run: status, counters, snapshot, error summary, link;
- review: `activityId`, `activityType`.

Writes made by a domain service are marked with `runAsCustomerSuccessInternal`
(`customer-success-internal.ts`, an async-local flag mirroring `sales-internal.ts`) and pass.
`CustomerSuccessHealthSnapshot` is refused to ordinary writes outright: append-only, module-written
(§5.4.4, §13.4). A create/update that *mentions* such a field without changing it is not an error —
the guard compares values (`changedKeys`), so a read–modify–write round trip is safe.

## 5. Destination and relation checks (IDOR)

- **Destinations.** `assertDestination` refuses a CSM, team, goal owner or escalation team that does
  not exist or is deleted. `User` and `Team` are identity rows in their own tables, so the check
  reads `users` / `teams` directly — the same read `project-member.service.ts` performs for project
  members — rather than the entity API, which refuses those entities. An explicit `null` clears the
  field and has no destination to check.
- **Account-named commands.** `createPlan` and `createRisk` may name an Account instead of a profile.
  `resolveProfileForCommand` resolves the profile **before** the permission check, so holding an
  Account id can never reach a profile the actor may not edit; an Account with no profile is an
  explicit `422`, never a record created with no owner.
- **Related records keep their own ACL.** Activities, Contacts, Opportunities, Subscriptions and
  Projects linked from a profile or a playbook step are read through their own entities; a visible
  profile never grants access to an otherwise inaccessible related record. The health signals read
  structural rows through `CustomerSuccessRecords`, whose entity allow-list never includes a record
  type the module does not own, and explanations carry at most a permitted source reference — never
  an activity body (§9.4).
- **Aggregates scope before aggregating.** `CustomerSuccessPortfolioService` lists through
  `EntityCrudService.list`, so the record ACL predicate runs in SQL; date and null predicates then
  narrow an already-authorised, bounded page in memory. A shared dashlet can never leak a count or a
  name the reader could not open.

## 6. The worker capability

The worker has no user session. Each scheduled operation calls its own `@Public()` endpoint with
`x-worker-secret`, compared in constant time against `config.reportWorkerSecret`; an empty or wrong
capability is an authentication failure, and the endpoint runs under the documented service principal
(`runAsSystem`, a `system` user holding the built-in `sysAdmin` role —
`customer-success-authority.ts`). This is the same seam the reports jobs already use
(`apps/api/test/phase17-reports.integration.test.ts` sets it as an environment-level test seam), so
no second worker-authentication mechanism exists. When no capability is configured the jobs report
`disabled` rather than failing.

## 7. Notification privacy

`CustomerSuccessNotificationService` writes in-app `notifications` rows only — never outbound mail
or webhooks — and only when `features.notifications` and `notifications.enabled` are both on. Every
message is deduplicated by a stable `dedupKey` plus the configured cadence, so a recurring condition
cannot become a storm. The body names the profile and links to its record; a user without access to
that profile sees nothing, because the row is addressed to a specific user id and no aggregate
includes it.

## 8. Retention and deletion

Soft delete (`deleted_at`) is the platform's model and applies to every CS entity. Completed and
canceled plans, resolved risks, health snapshots and finished playbook runs are **history**: no
routine cleanup hard-deletes them, and no bulk destructive delete is exposed for them by default
(§5.14). A soft-deleted profile does not block a new profile for the same Account — the unique index
in `032_phase19_customer_success.sql` is partial on `deleted_at IS NULL`.
