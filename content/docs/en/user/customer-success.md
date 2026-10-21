---
title: Customer success
summary: Health, lifecycle stages, success plans, goals, risks, playbooks and reviews for an account you keep.
audience: user
order: 110
tags: [customer-success, health, renewal, playbook, account]
related: [user/record-page, user/lists-and-views, user/dashboards-and-reports, admin/entities-and-fields]
updated: 2026-10-21
---

Customer success work hangs off one record: the **Customer Success Profile**, which points at exactly one
account. Everything else — plans, goals, risks, playbook runs, reviews — is a separate record type that
references that profile. The sidebar's Customer Success group lists the eight record types this build ships:
profile, plan, goal, risk, review, playbook template, playbook run and step run. Each one is an ordinary
[list](user/lists-and-views) and [record page](user/record-page); there is no separate customer success
workspace screen.

> [!WARNING]
> Most of the numbers on a profile are computed, not typed. The module refuses a form or API write that sets
> a computed field and names the fields it refused. You will see this on `healthScore`, `healthStatus`,
> `openRiskCount`, `activePlanProgress`, `onboardingStatus`, a plan's `progress`, a goal's `progress` and
> `status`, a risk's `resolvedDate`, a run's `status`, and a review's `activityId` and `activityType`.

## Getting a profile

You start a profile by creating one against an account; one active profile per account is enforced. The list
shows name, account, CSM, stage, health, renewal date and open risk count, so a portfolio read is one filtered
list.

## Health

Health is a score from 0 to 100 and one of five statuses. The shipped bands are:

| Status | Score |
| --- | --- |
| `healthy` | 80 to 100 |
| `monitor` | 60 to 79 |
| `atRisk` | 40 to 59 |
| `critical` | 0 to 39 |
| `unknown` | no score |

An administrator can change the bands, the signals and their weights in the module's settings. Two rules are
worth knowing before you argue with a number:

- A score is only published when enough signals actually reported. If the weighted share that produced a value
  falls below the coverage floor (half by default) the result is `unknown` with no score — never a zero.
- Each calculation is stored as a history row naming its signals, values, weights and freshness. That history
  is what makes "why is this customer red" answerable; it is append-only and cannot be written from a form.

`scoreTrend` compares recent history: `improving`, `stable`, `declining` or `unknown`.

You can override the effective status when the inputs are wrong. An override needs a reason, cannot be
`unknown`, records who set it, and expires — 90 days by default. Clearing it returns the profile to the
calculated status, which is never overwritten.

## Lifecycle stage

A profile carries one of `onboarding`, `adoption`, `valueRealization`, `mature`, `renewal`, `atRisk`,
`churned`. Out of the box each stage may only move along a fixed map, `churned` is terminal, and moving to
`atRisk` or `churned` requires a reason that is stored on the profile.

> [!NOTE]
> The map and the reason requirement are enforced by the module's stage-change command, which has no button in
> this build. The stage is also an editable field on the profile form, written exactly as you set it.

## Plans, goals and risks

A **success plan** is a dated set of outcomes for one profile: type, start and end date, a next review date,
outcomes, a baseline, an executive sponsor, an optional project and an optional opportunity. Its status is
`draft`, `active`, `onHold`, `completed` or `canceled`, one plan can be marked primary, and the progress
figure is rolled up from its goals.

A **goal** belongs to a plan and is measured, not described. You pick a direction (`increase`, `decrease`,
`maintain`, `boolean`, `manual`), a baseline, a target, a target date and a unit; the module computes the
percentage and the status (`notStarted`, `inProgress`, `achieved`, `missed`, `canceled`, `blocked`). Record
a new measured value rather than editing the progress field.

A **risk** is a named threat with a type (adoption, engagement, support, stakeholder, value realization,
renewal, commercial, implementation, competitor, unknown), a severity (`low`, `medium`, `high`, `critical`),
an owner, an optional escalation team, a mitigation plan, a next action and a target resolution date. Statuses
run `open`, `mitigating`, `escalated`, `resolved`, `accepted`, `closed`; a resolved or closed risk cannot be
escalated — reopen it first. An open risk drags the health score down while `contributesToHealth` is on.

## Playbooks

A **playbook template** is a named, ordered step list with a trigger mode: `manual`,
`lifecycleTransition`, `healthTransition`, `renewalWindow` or `onboardingStarted`. Step types are `manual`,
`createActivity`, `createTask`, `createRisk`, `createSuccessPlan`, `notifyOwner` and `waitUntil`; each step
can carry a due offset in days, an assignee policy and a list of steps it depends on. A template takes at
least one step and at most 200, and step keys must be unique.

A **run** snapshots the steps at the moment it starts, so editing a template never rewrites work already in
progress. Run statuses are `pending`, `running`, `paused`, `completed`, `canceled`, `failed`; step statuses
`pending`, `inProgress`, `completed`, `skipped`, `failed`, `canceled`. The install ships one default
onboarding playbook — kickoff, stakeholder mapping, administrator training, first value review, handover —
which you can edit or deactivate like any other record.

> [!WARNING]
> Starting a run, completing or skipping a step, and authoring a template's steps are module commands with no
> screen in this build. A template form lets you set its name, type, trigger and active flag, not its steps.
> Auto-triggered runs are off until an administrator enables them.

## Reviews and touchpoints

A **review** is the record of a customer meeting or call: date, sentiment (`positive`, `neutral`,
`negative`, `unknown`), objectives, outcomes, open risks, a goal-progress note, action items, an owner and
the next review date. The link to the activity it documents is set by the module's scheduling command, so on
a hand-created review that field stays empty.

The profile also carries `nextSuccessReviewAt` and a computed `lastMeaningfulTouchAt`, which feed the queue
views that ask "who has no scheduled review" and "who have I not spoken to lately".

## Renewal

`renewalDate` and `renewalStatus` (`unknown`, `notDue`, `preparing`, `inProgress`, `renewed`, `atRisk`,
`churned`) are fields you maintain, and `renewalSource` says where the date came from: `manual`, or synced
from a subscription record when that module is installed. Renewal windows are 30, 60, 90 and 120 days by
default; a date already in the past counts as overdue and inside the smallest window.

## Background work

Eight scheduled jobs keep the numbers honest: recalculate health in batches, expire overrides, mark overdue
goals, evaluate renewal windows, raise risk-review notifications, remind on due reviews, advance playbook
steps that are waiting, and repair runs left stale.

## What this build does not do

- There is no dashboard tile for the twelve portfolio queues; they exist only behind the module's endpoint, so
  a filtered profile list is the substitute.
- Notifications are off by default, as is the adoption signal, which needs an external connector.
- Nothing infers `churned` from a low score, a missing subscription or a critical risk. That is a decision
  somebody makes and reasons for.

## Where to go next

- [Reading and editing a record](user/record-page) — relations and the stream on a profile.
- [Working with lists](user/lists-and-views) — filtering a portfolio by stage, health and renewal date.
- [Dashboards and reports](user/dashboards-and-reports) — a list dashlet over profiles or open risks.
- [Entities, fields and layouts](admin/entities-and-fields) — when a computed field is missing from a form.
