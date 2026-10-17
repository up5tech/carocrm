# Customer Success — administrator guide

Who this is for: the administrator who configures lifecycle policy, health scoring, playbooks,
renewal windows, notifications and defaults. Everything here is done through
`GET/POST /api/v1/CustomerSuccess/action/settings` (administrator) or the generic entity API; nothing
requires SQL.

## 1. The settings document

One validated, versioned row named `customerSuccess` in `app_settings`
(`CustomerSuccessSettingsService`). `GET …/action/settings` returns the effective settings, the
computed defaults, the stored `version` and `updatedBy`, plus **warnings** for configurations that
are accepted but inert (for example health scoring on with no weighted signal). `POST …/action/settings`
takes a partial patch, validates it with Zod, deep-merges it over the current row, refuses unknown
keys, and bumps the version on every accepted change — a stored health snapshot names the version it
was produced under, so history stays explainable after a rule changes (§5.4.3).

Defaults are idempotent: the row is never reset on boot or by a migration, and the seed only inserts
what is missing (`ON CONFLICT DO NOTHING`), so an operator's edits survive a re-seed.

## 2. Lifecycle stages and transitions

`lifecycle.stages` ships with `onboarding → adoption → valueRealization → mature → renewal → atRisk
→ churned`, each with a label and an order. `lifecycle.transitions` is the allowed-edge map;
`lifecycle.reasonRequired` lists stages that demand a non-empty reason on entry (`atRisk`, `churned`
by default). `churned` is terminal by default: §13.7 forbids inferring it from a score, a missing
subscription, a missing opportunity or a Critical risk, and reopening it is a separate configured
decision. Transitions are validated server-side on every path — single, bulk and preview — so a
client-side dropdown is never the access control (§5.3).

## 3. Health scoring

The score is a deterministic, weighted calculation over configurable signals. Configure under
`health`:

| Setting | Meaning | Default |
|---|---|---|
| `thresholds` | status bands; must be whole numbers, inside 0–100, non-overlapping and tiling the whole range with no gaps | critical 0–39, atRisk 40–59, monitor 60–79, healthy 80–100 |
| `signals` | per-signal `weight`, `enabled`, `freshnessDays` | engagement 25, successPlan 20, relationship 15, onboarding 15, risks 15, renewal 10, adoption 0 (off), support 0 (off) |
| `minimumCoverage` | minimum share of configured weight that must be valid for a score | 0.5 |
| `missingDataPolicy` | `excludeAndRenormalize` (default) or `unknownWhenIncomplete` | exclude and renormalize |
| `rounding` | `round` (default), `floor` or `ceil` — one algorithm for API, jobs, UI and tests | round |
| `overrideExpiryDays` | an override with no explicit expiry expires after this | 90 |
| `overrideRequiresReview` | an override must be reviewed before it can be cleared | false |

Rules an administrator can rely on:

- **Missing data is never zero.** A signal with no data is `missing`, a stale one is `stale`, an
  unavailable optional source is reported `unavailable` — none of them is scored as 0 (§5.4.3).
- Below `minimumCoverage` the score is `null` and the status is `unknown` — a *state*, not a low
  score. Dashboards and queues distinguish the two.
- Weights are non-negative; the score renormalises over the *valid* weight and rounds once, with the
  same rounding policy everywhere.
- `support` (no Service Desk installed) and `adoption` (no connector installed) stay in the
  configuration surface so they can be enabled later; while their source is absent they report
  `unavailable`, and a warning says so.
- Preview before you commit: `POST …/action/bulkRecalculateHealth` (administrator) runs a bounded
  batch through the normal job path and reports processed/skipped/errors counts, so the effect of a
  new configuration is observable before it is trusted.

## 4. Segments, assignment and defaults

- `segments` — the segment vocabulary offered on profiles.
- `assignment.defaultPolicy` — `unassigned` (default) or `accountOwner`, which seeds a new profile's
  CSM from the Account's owner.
- The default onboarding playbook is an ordinary `CustomerSuccessPlaybookTemplate` record with the
  fixed id `csTemplateOnboarding`, installed once by the seed. Edit, replace or deactivate it like
  any other template; `startOnboarding` prefers it when no template is named.

## 5. Playbooks

Templates are created with `POST …/action/createPlaybookTemplate` (administrator). A step is one of
the allow-listed types — `manual`, `createActivity`, `createTask`, `createRisk`,
`createSuccessPlan`, `notifyOwner`, `waitUntil` — with a stable key, an order, a required flag, a
due-date offset, an assignee policy (`profileCsm` | `accountOwner` | `none`) and dependencies. Step
bodies are never code: no raw SQL, no unrestricted JavaScript (§5.11.1); `maxStepsPerRun` bounds a
run and `enforceIdempotency` derives the deterministic trigger key per account+template+window so a
retried event cannot create a duplicate run.

`playbooks.autoTriggersEnabled` is **off** by default. Turning it on lets lifecycle, health,
renewal-window and onboarding-started events start runs; the guardrails above still apply, and every
run records which trigger started it.

## 6. Renewal windows and source precedence

`renewal.windows` (default 30/60/90/120 days) drives the queues and the `evaluateRenewalWindows`
scan. `renewal.sourcePrecedence` decides whether a Subscription/Opportunity-supplied date may
overwrite a typed one: the default `manualFirst` keeps a manual date unless a source is explicitly
preferred, and the profile always shows the source and the last sync time. A source failure never
erases a valid value (§5.9).

## 7. Notifications and feature flags

- `notifications.enabled` (off) lets the module write in-app rows; `notifications.cadenceDays`
  (default 7) is the minimum spacing between two messages for the same condition. Outbound delivery
  is never triggered by this module.
- The `features.*` flags are the module's only on/off switches (the platform has no kernel-module
  toggle). Deactivating a feature never deletes history: profiles keep their last stored score,
  completed plans stay readable, and snapshots stay queryable.
- `jobs.batchSize` bounds every scheduled scan and `jobs.refreshIntervalDays` decides which profiles
  are due for a health refresh.
