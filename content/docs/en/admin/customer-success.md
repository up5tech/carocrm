---
title: Configuring Customer Success
summary: Configure lifecycle rules, health signals and bands, renewal windows, playbook automation and background jobs from one validated document.
audience: admin
order: 133
tags: [customer-success, settings, health-scoring, playbooks, renewal]
aliases: ["cấu hình chăm sóc khách hàng", "chỉ số sức khỏe khách hàng", "cấu hình CSAT"]
related: [admin/settings-overview, admin/module-settings, admin/entities-and-fields, user/customer-success]
updated: 2026-10-22
---

Customer Success keeps one validated settings document named `customerSuccess`: which capabilities run,
how health is calculated, when a renewal enters a window, and what the jobs do. What a user sees is
covered in [Customer success](user/customer-success); this page is the configuration side.

## The tab and how saving works

[Settings → Customer Success](/admin/settings/customerSuccess) is a tab of
[the administration area](admin/settings-overview). It shows the version and a warning banner built from
its own warnings. **Save** posts the whole draft to `POST /api/v1/CustomerSuccess/action/settings`; the
module merges it over the stored document, validates the merged result against its strict schema, and
refuses the write whole if a value is invalid or a key is unknown. The stored version stays untouched and
shows the refusal. An accepted save increments the version and records who saved it. **Discard** returns
to the loaded version; **Reload** fetches the stored one.

The tab is mostly a switch-and-number editor. Booleans get a switch, numbers a number box, and only a
null value a text box; a string is a single-option select and a list one JSON value, so neither can be
edited there. Post the leaf instead to `POST /api/v1/CustomerSuccess/action/settings`, for example
`{"health":{"rounding":"floor"}}`.

> [!NOTE]
> There is no conflict check. Save writes the draft you loaded, so Reload first if another administrator
> may have edited the document. Warnings do not block Save.

## What starts on and off

| Feature | Default | Where the code checks it |
| --- | --- | --- |
| Health scoring | on | Recalculation refuses when off |
| Health history | on | Not checked; snapshots and history are served either way |
| Success plans | on | Plan health signal only; plan records are not refused |
| Success goals | on | Plan signal only; that signal also needs success plans |
| Risk management | on | Risk health signal only; risk records and jobs are not refused |
| Onboarding | on | Onboarding signal only; onboarding commands are not refused |
| Playbooks | on | Starting a run refuses when off |
| Success reviews | on | Not checked |
| Renewal readiness | on | Renewal signal only; renewal jobs still run |
| In-app notifications | off | Notification writes need this and `notifications.enabled` |
| Playbook automation | off | Not checked; nothing starts runs automatically |
| Adoption signals | off | Not checked; the provider reports unavailable either way |

Only health scoring, playbooks and notifications are checked before an action; the other flags either
contribute a health signal or are stored without a reader. The signal flags (success plans, goals, risks,
onboarding, renewal readiness) can change a score by removing a signal, and losing enough weight turns the
result `unknown`, but they do not refuse records. The `requires` lists are advisory; any combination saves.

## Lifecycle

`stages` is a list of objects with a `key`, a `label` (1–64 characters) and an `order` (whole number
0–1000). Keys are restricted to the seven shipped stages and may not repeat; the list is stored and
validated but no calculation reads the labels or order. `transitions` maps a stage to the stages it may
move to and is read by the module's stage-change command; the shipped map makes `churned` terminal and
lets `atRisk` move back to any earlier stage. `reasonRequired` lists target stages that need a reason,
default `atRisk` and `churned`, and the same command reads it. An unknown stage is always refused.

## Segments

`segments` is a list of up to 50 labels, each 1–64 characters, default empty. No server path reads it,
and the profile's `segment` field is free text rather than a lookup into this list.

## Assignment

`defaultPolicy` accepts `unassigned` (the default) or `accountOwner`. It is read only when a profile is
created: `accountOwner` copies the Account's owner if one is set, otherwise the profile stays unassigned.
Existing profiles are not reassigned.

## Health

| Field | Range or default | Effect |
| --- | --- | --- |
| `thresholds` | whole numbers 0–100; defaults healthy 80–100, monitor 60–79, atRisk 40–59, critical 0–39 | Classifies a score; bands must tile 0–100 without gaps or overlaps, one band per status |
| `minimumCoverage` | 0–1, default 0.5 | Below this share of valid weight the result is `unknown` with no score |
| `missingDataPolicy` | `excludeAndRenormalize` or `unknownWhenIncomplete`, default the first | Renormalize over valid weight, or make any excluded signal force `unknown` |
| `rounding` | `round`, `floor` or `ceil`, default `round` | Applied to the weighted score before the bands |
| `overrideExpiryDays` | whole number 1–3650, default 90 | Stored only; see below |
| `overrideRequiresReview` | boolean, off | Stored only; clearing an override is not gated by it |
| `signals` | list of signal objects | Weighted inputs to the score |

The shipped signals are engagement 25, successPlan 20, relationship 15, onboarding 15, risks 15, renewal
10, plus adoption and support at 0 and disabled. Weights are relative (0–1000), not percentages. Each
signal has `enabled` and `freshnessDays` (1–3650, default 90); an older measurement is stale. Duplicate
keys are refused. A key that is not a shipped provider reports `missing` and its weight still counts
against coverage, so do not invent keys. Support and adoption are reported even when disabled.

`unknownWhenIncomplete` is strict: any excluded signal forces `unknown`, while the default policy drops
it and renormalizes over the valid weight. Because adoption and support are always reported and usually
missing, the strict policy often returns `unknown` with the shipped configuration. Health scoring off
refuses recalculation, so profiles keep their last score and the daily batch counts those attempts as
errors. A snapshot is appended when the calculation signature changes, whatever the health history flag says.

An override stores the status and the expiry supplied with the request; no expiry means it stays until
cleared, and the expiry job clears dates that have passed. `overrideExpiryDays` is not applied when an
override is set, and `overrideRequiresReview` is not read when one is cleared.

## Renewal

`windows` is a list of up to 12 whole numbers from 1 to 3650, default 30, 60, 90 and 120. Values are
sorted and deduplicated, and feed the health signal, the portfolio queues and the renewal job. A date in
the past counts as overdue and inside the smallest window; the job skips overdue profiles, while the
portfolio counts them. An empty list means no window, and the document warns when renewal readiness is on.

`sourcePrecedence` accepts `manualFirst` (default) or `sourceFirst`. When a subscription can supply a
renewal date, `manualFirst` refuses to overwrite a manually maintained date unless the sync is forced;
`sourceFirst` takes the source value.

## Playbooks

`autoTriggersEnabled` is off. No service reads it to start a run; there is no automatic start on a
lifecycle, health or renewal event, and the switch only feeds the automation warning. Manual start and
onboarding start are the two entry points.

`maxStepsPerRun` accepts 1–500, default 200, and is not read. Template validation applies its own fixed
cap of 200 steps. `enforceIdempotency` is on: when a start carries a `triggerKey`, an existing run with
that key is returned instead of a second run. The onboarding start supplies a key; a manual start without
one is not deduplicated. With playbooks off, starting a run is refused; onboarding then has to be tracked
by hand.

## Jobs and notifications

`jobs.batchSize` is 1–1000, default 200, and caps how many profiles one health batch processes; a caller's
smaller limit wins. `jobs.refreshIntervalDays` is 1–365, default 7, and decides which profiles are due: no
score timestamp, or one older than the interval. The eight jobs are scheduled daily; these fields tune the
health batch, not the schedule.

`notifications.enabled` is off and must be on together with `features.notifications` before any
notification row is written. `notifications.cadenceDays` is 1–365, default 7, and suppresses a second
notification with the same deduplication key for the same user inside the window.

The `touchpoints` group's `recencyDays` (1–3650, default 30) sets how long a customer touch keeps the
engagement signal at 100; older touches decay. It does not change the stored last-touch timestamp.

## What is stored but not enforced

| Setting | What actually happens |
| --- | --- |
| `segments` | No server path reads the list; the profile segment is free text |
| `lifecycle.stages` labels and order | Stored and validated; only transitions and reasonRequired are read |
| `health.overrideExpiryDays` | Not read; an override expires only from the date sent with it |
| `health.overrideRequiresReview` | Not read; clearing an override is not gated by it |
| `playbooks.maxStepsPerRun` | Not read; template validation caps at 200 |
| `playbooks.autoTriggersEnabled` | Only feeds the automation warning; no run starts automatically |
| `features.healthHistory`, `features.reviews`, `features.automation`, `features.adoptionSignal` | No server path checks them |
| `features.successPlans`, `features.goals`, `features.risks`, `features.onboarding`, `features.renewalReadiness` | Only health signals; records and jobs are not refused |

## Troubleshooting

| Symptom | Field or prerequisite |
| --- | --- |
| Every score is `unknown` | No enabled weighted signal, coverage below `minimumCoverage`, or `unknownWhenIncomplete` with a missing signal |
| A score did not change after an edit | Scoring is off, or the profile is not yet due under `refreshIntervalDays`; recalculate it explicitly |
| A profile has no CSM | `assignment.defaultPolicy` is `unassigned`, or the Account has no owner |
| A lifecycle move is refused | The `transitions` map has no edge, or `reasonRequired` wants a reason |
| Renewal events never fire | `renewal.windows` is empty, the profile has no date, or the date is already overdue |
| Automation never starts a run | No automatic trigger exists; start the run from the profile or onboarding action |
| No notifications arrive | Either notification switch is off, or `cadenceDays` is suppressing a repeat |
| An override never expires | No expiry was sent with it; `overrideExpiryDays` is not applied |

## Where to go next

- [Customer success](user/customer-success) — health, plans, risks, playbooks and reviews from the user side.
- [Entities, fields and layouts](admin/entities-and-fields) — the computed fields these settings feed.
