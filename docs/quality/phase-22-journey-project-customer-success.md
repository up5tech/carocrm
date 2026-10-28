# Phase 22.10 — Journey: project onboarding, Customer Success, and renewal

> **Date:** 2026-10-28
> **Plan:** `PLAN_Phase_22_Integration_E2E_Hardening.md` §13.3 (steps 1–9) and its acceptance assertions
> **Test:** `apps/api/test/phase22-journey-project-customer-success.test.ts` (11 ordered steps)
> **Depends on:** `docs/quality/phase-22-journey-lead-to-customer.md` (22.8), `docs/quality/phase-22-journey-quote-to-signature.md` (22.9)
> **Status:** Implemented. The journey runs end to end against the configured primary database; the two acceptance assertions hold.

---

## 1. The journey in one sentence

An Account gets a Customer Success profile and a CSM, an onboarding playbook starts, the success
plan references a Project that carries a milestone, the onboarding step produces a real customer
task — and **completing the Project milestone moves nothing in Customer Success**. The health moves
only when the evidence that belongs to Customer Success moves, and the renewal and risk scans notify
exactly once.

That gap — between "the delivery is done" and "the customer's health changed" — is the whole point:
a `ProjectTask` is not a customer touch, and the platform keeps that line.

## 2. Preconditions and required capabilities

| Precondition | How the journey gets it | Required? |
|---|---|---|
| The `customerSuccess` settings row | `features.notifications: true` and `notifications.enabled: true` — **both default to `false`**, so the renewal and risk branches are inert in a default installation | **Required** for the notification steps |
| An Account | created through the public entity API | **Required** |
| A CSM | `POST /action/assignProfile` with a live user id — the renewal notification needs `profile.csmUserId` | **Required** for the notification steps |
| A Project, a group and a milestone | the Projects module's own API (`POST /api/v1/Project`, `action/groupCreate`, `action/milestone`) on the seeded default board | **Required** |
| A Sales/subscription record | **not required** — the renewal date is set through the Customer Success command (`action/setRenewal`), which is the supported path when there is no subscription | Optional |
| A Customer Success profile | `POST /action/ensureProfile` (idempotent; one profile per Account, enforced by a unique index) | **Required** |

## 3. The actors

| Actor | Rights | What the journey proves with it |
|---|---|---|
| The administrator | everything | the happy path |
| An outsider | `Account: read own` only | cannot read the Customer Success risks, the project or its milestone |

## 4. The test-owned data

Every record carries the `AGENT_TEST_LS22C_` marker: the Account, the profile, the plan, the goal,
the risk, the playbook run and its step runs, the health snapshots, the Project, the group, the
milestone, the produced Task, the role and the user. The cleanup removes **exactly those ids**, plus
the notifications and the Customer Success events this run wrote (both scoped by the run's start
time), and the settings row is restored byte for byte.

## 5. The steps, and what each one asserts

| Step | What happens | What the journey asserts |
|---|---|---|
| 1 | The Account gets a profile | `ensureProfile` creates it; a second call returns the **same** profile with `created: false`; the defaults are `onboarding` / `notStarted` / `unknown` / no score |
| 2 | A CSM is assigned | the profile's `csmUserId` is the assigned user — somebody owns the renewal |
| 3 | The Project, its group, its milestone and the plan | the plan's `projectId` points at the Project the CRM owns (a **reference**, not a copy); the plan is activated and a goal is created — the success-plan signal needs both |
| 4 | The onboarding starts | the run id is returned; a second start returns the **same** run (`created: false`) — the trigger key is the dedup key; the profile moves to `onboardingStatus: inProgress` |
| 5 | The first onboarding step completes | the step produced a real CRM `Task`; completing the **same** step again produces **no** second task |
| 6 | The Task is completed | the customer touch is persisted, so the health engine has something to read |
| 7 | The Project milestone completes | the milestone is `Completed` on the Project side, and the Customer Success profile is **byte for byte where it was**: `healthScore`, `healthStatus`, `healthScoreAt`, `activePlanProgress` and `onboardingStatus` are unchanged |
| 8 | The health is recalculated | now the score is a number, `healthScoreAt` is set, and the history's newest entry carries that score |
| 9 | The renewal window is scanned | the scan enters one window and writes **one** notification; a second scan writes **none** — the profile's `notifiedRenewalWindows` and the notification's dedup key both hold |
| 10 | An unresolved critical risk is scanned | the scan writes **one** notification for this risk; a second scan writes **none** |
| 11 | The outsider looks around | the risks, the project and the milestone are all refused (403) |

## 6. Expected persisted state and evidence

| What | Where | What the journey asserts |
|---|---|---|
| the profile projection | `CustomerSuccessProfile` | the score, the status, `healthScoreAt`, `activePlanProgress`, `onboardingStatus`, `notifiedRenewalWindows` |
| the score history | `CustomerSuccessHealthSnapshot` (append-only, unreadable by ordinary users) | one row per recalculation, each carrying the score, the coverage and the components |
| the onboarding run | `CustomerSuccessPlaybookRun` + `CustomerSuccessPlaybookStepRun` | one run, one step run per step, and the step's `linkedEntityType`/`linkedEntityId` |
| the produced task | the CRM `Task` entity, linked to the Account | exactly one task, even after the step is completed twice |
| the notifications | `notifications` | one renewal notification (`renewal:<profileId>:<window>`) and one risk notification (`riskReview:<riskId>:<reason>`) |

## 7. Deduplication and provider interactions

There is no provider in this journey — it is CRM to CRM. The dedup keys are the ones the module
already uses, and the journey proves each of them: the playbook run's `triggerKey`, the step's
status (the producer runs at most once), the profile's `notifiedRenewalWindows`, and the
notification's `dedupKey` plus its cadence.

## 8. Findings

| # | Finding | Severity | Disposition |
|---|---|---|---|
| F1 | **Customer Success never creates or reads `Project`/`ProjectTask`.** The only link is `CustomerSuccessPlan.projectId`, a reference. The health engine's facts (`loadFacts`) contain no project read, and no signal provider looks at one | Medium | Recorded as gap G27. The journey proves the negative the plan asks for (step 7): a completed milestone changes nothing |
| F2 | The renewal and risk branches produce **notifications**, not tasks, and the notification writer is **off by default** (`features.notifications` and `notifications.enabled` are both `false`) | Info | Not a defect — a deliberate default. The journey enables it explicitly and says so |
| F3 | The plan's step 9 ("project creation succeeds but the downstream customer-success update/job fails") **cannot happen**: there is no downstream Customer Success update from a project. The implemented partial-failure path is a playbook step whose producer fails, and the platform's answer is a visible `failed` step with an error summary and an attempt count, plus a retry that produces no duplicate | Medium | The failure branch exists (`completeStep` → `failed` → `retryFailedSteps`) but cannot be triggered deterministically without a broken dependency, so the journey proves the **retry-safety** half (step 5) and records the rest |
| F4 | The health produces **no score at all** until the applicable signals cover half of the enabled weight (`health.minimumCoverage`, default 0.5) | Info | A design rule, not a defect — a customer with nothing on file is `unknown`, not badly off. The journey assembles the evidence (an active plan with a goal, a completed customer task, a renewal date) before the score appears |

## 9. Evidence

| Command | Result |
|---|---|
| `npx vitest run apps/api/test/phase22-journey-project-customer-success.test.ts` | **11 passed** (the 11 ordered steps) |
| `pnpm verify` | **green** — `lint` exit 0, `typecheck` exit 0, `test` 240 files / 3229 tests passed, `test:web` 5 files / 21 tests passed |
| `pnpm lint:changed` | 0 errors, 0 warnings |

**Database discipline.** The configured primary database only (`AGENTS.md` §3.1); no database, schema
or container was created; nothing was truncated, dropped or reset. Every row this run created is
deleted by exact id, and the notifications and the Customer Success events are deleted by the run's
start time and the row's own key.

**External effects.** None. No provider, no mail, no network.

## 10. Known limitations

1. **The journey is not a browser journey.** It drives the public API contracts, which is what the
   plan asks for.
2. **The steps are ordered on purpose.** Each `it` states what the previous one left behind.
3. **The renewal date is set manually**, not synced from a Subscription. The sync path
   (`action/syncRenewal`) exists and reads the `Subscription` entity; a full commercial journey
   would need a subscription, which the Sales fixture does not create.
4. **The health score depends on the evidence the journey assembles.** A different installation — a
   different model, a different minimum coverage — would score differently; the journey proves the
   *mechanism*, not a number.

## 11. Acceptance criteria (plan §13.3)

- [x] **Project and CustomerSuccess records remain consistent with their ownership contracts.** The Project owns the milestone and the Customer Success profile owns the health; the only link between them is the plan's reference, and the journey proves that neither module writes the other's records.
- [x] **Duplicate milestone events do not produce duplicate tasks or notifications.** The onboarding step completed twice produces one task; the renewal scan run twice produces one notification; the risk scan run twice produces one notification.
