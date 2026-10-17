# Customer Success — compatibility and known deviations

What this module deliberately does differently from the EspoCRM baseline and from the plan's own
wording, and why. The module is a clean-room TypeScript/NestJS implementation informed by common CSM
practice: no upstream source code, frontend asset, translation, icon or schema was copied, and no
feature parity with any upstream extension is claimed (the EspoCRM extension catalog has no
first-party Customer Success product).

## 1. Deliberate scope decisions

| Decision | Reason |
|---|---|
| Kernel domain directory, not an extension package | The extension SDK exposes no entity CRUD facade; a package owning `CustomerSuccessProfile` could only write rows with raw SQL, bypassing ACL, validation, audit, stream and domain events (§0 of the plan, AGENTS.md §5.2). No `manifest.json`; nothing under `modules/`. |
| Onboarding is a Playbook Run, not separate tables | Playbook Run + Step Run already express ordered steps, dependencies, due offsets, owners, pause/cancel/restart and skip-with-reason. Separate onboarding tables would duplicate that machinery. The plan's conditional option K allows this. |
| Scoring configuration is a slice of the `customerSuccess` settings row | The versioned `app_settings` store already exists; a redundant `CustomerSuccessScoringConfig` table would be a second source of truth for the same policy (plan option C). |
| A module-local notification writer instead of a platform service | There is no notification service. The writer follows the `system.sendReminders` table shape (`apps/worker/src/handlers/job-handlers.ts:132`), writes in-app rows only and is documented as a module-local facility — the smallest reusable dependency, not a kernel service invented for one consumer. |
| 19-CS.12 (dedicated React screens) is **not** built | Per §10 of the plan, entities registered with `layouts` render through the generic metadata-driven UI; dedicated screens are optional polish. Every entity has list/detail/edit screens; what is missing is a dedicated *Customer Success* submenu and purpose-built panels. Feature parity with §10.2–§10.4 panels is the known gap. |
| No support or adoption signals | No Service Desk module and no usage connector exist. Both families are present in the configuration surface and report `unavailable`, so enabling them later needs no schema change (§12.6, §12.7). |

## 2. Small platform changes this module required

Both are widenings, not new subsystems, and both are documented in
`docs/implementation/customer-success-repository-audit.md`:

1. `EVENT_TYPE` (`apps/api/src/events/event-bus.ts`) accepted only lower-case segments; the module's
   event names are camelCase after a dot (`customerSuccess.health.statusChanged`). The pattern now
   allows an upper-case letter in any segment — the shape `JOB_NAME` already used.
2. `JOB_NAME` (`apps/api/src/jobs/jobs.service.ts`) was widened identically so
   `customerSuccess.recalculateHealthBatch` is accepted by the API and the worker alike.

## 3. Behaviour worth knowing (deviations from naive expectations)

- **A shape failure is `400`, a rule failure is `422`.** The shared `parse()` helper renders a failed
  Zod shape as `400 INVALID_QUERY` with an issue list (an unknown field is rejected, not ignored); a
  domain rule — an invalid transition, a missing reason, a High risk without mitigation, settings
  that do not validate — is `422 VALIDATION_FAILED`. The plan's §8.2 mentions 422 for validation
  failures; the split follows the repository's existing controllers.
- **`User` and `Team` destinations are checked against the identity tables**, not the entity API:
  they are identity rows (`users`, `teams`), and the entity API refuses them with "Entity does not
  exist". This matches `apps/api/src/projects/project-member.service.ts`. An explicit `null` in an
  assignment clears the field and needs no destination check.
- **The health snapshot entity has no user read level.** Scores and history are exposed through the
  `healthHistory` / `healthExplanation` actions, which take the profile's ACL first; the record API
  refuses ordinary snapshot writes outright.
- **A no-op write is not an error.** The write guard compares values, so a read–modify–write round
  trip that re-sends a server-owned field without changing it succeeds; only an actual change is
  refused.
- **Portfolio pages are bounded.** The queue and summary reads scan a bounded, ACL-scoped window
  (500 rows) and narrow in memory for predicates the generic query cannot express; `truncated` says
  so rather than silently pretending the window is everything.
- **Trend windows are explicit.** A trend compares the current score with the previous snapshot over
  the module's documented threshold (5 points), and two points are required at all — otherwise the
  trend is `unknown`, not "stable".
- **Renewal dates are calendar days in UTC**, so a scheduler, a job and an API caller agree on
  "today" and on the window boundary regardless of the caller's timezone.

## 4. Known limitations

1. **No dedicated Customer Success UI shell** (see 19-CS.12 above). Navigation is the generic entity
   navigation; the dashlet catalogue (`GET …/action/dashlets`) feeds the shared dashboard engine.
2. **The `CustomerSuccessReview` is a thin structured layer.** It links to an existing Activity and
   carries the review fields the platform's Task/Call/Meeting cannot safely express; it does not
   replace the Activity, and scheduling stays with the platform.
3. **Health is batch-loaded per profile.** Scoring reads the facts for one profile per calculation;
   the batch job amortises this across profiles. There is no cross-profile cache to invalidate.
4. **Aggregate scans are bounded** (500 rows per queue/summary read) as stated above; a portfolio
   larger than the window is reported as truncated.

## 5. Baseline statement

EspoCRM 9.3.x is the platform compatibility baseline. Where this module names a concept that exists
upstream (Account, Activity, ACL level vocabulary), the observable behaviour follows the platform;
everything else — lifecycle stages, health semantics, playbook step types, risk types, renewal
windows — is this project's own design and is documented as such.
