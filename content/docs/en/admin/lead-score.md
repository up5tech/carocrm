---
title: Configuring Lead Score
summary: Build and publish a scoring model, choose the active version, rebuild stored scores and switch the module's features on in the right order.
audience: admin
order: 137
tags: [lead-score, scoring, model, bands, rules, features, conversion]
aliases: ["cấu hình điểm lead", "quản trị lead score", "mô hình chấm điểm", "bật chấm điểm lead"]
related: [admin/settings-overview, admin/users-teams-roles, admin/audit-jobs-and-operations, user/lead-score]
updated: 2026-10-25
---

Lead Score is one validated settings document (`leadScore`), one or more versioned scoring models, and
the stored result on each Lead. The module is **switched off by default**: installing it adds the fields and
the workspace but changes no Lead and computes no score until an administrator turns it on. What a user sees
is covered in [Lead scoring and conversion](user/lead-score); this page is the configuration side.

## The workspace

Open **Lead Score** in the administration area, or go directly to `/lead-score`. The screen has four tabs:

| Tab | What it is for |
| --- | --- |
| Models | Create, edit, validate, publish, archive and fork scoring models, and rebuild the Leads under one version |
| Preview | Score a bounded sample with a model without writing anything |
| Operations | Start and watch a rebuild under the active model |
| Settings | The module switch, the feature switches, the active model, the debounce, the decay sweep and the AI agent |

Tabs and buttons come from the server's capability answer. An administrator holds every right; another
account sees only the tabs its rights allow, and the same commands are refused if called directly. The page
opens while the module is still off, because it is where you turn it on.

## Turning it on, in order

Each switch depends on the previous one, and a chain with a hole stays inactive: the settings table shows
**Waiting** and the document carries a warning.

| Feature | Default | Requires |
| --- | --- | --- |
| Score model administration | off | — |
| Score model preview | off | model administration |
| Rule-based scoring | off | model administration |
| Manual recalculation | off | scoring |
| Score explanation and history | off | scoring |
| Event-driven recalculation | off | scoring |
| Batch recalculation | off | scoring |
| Band-change notifications | off | scoring |
| Marketing engagement signals | off | scoring |
| Duplicate candidate review | off | — |
| Conversion field mapping | off | — |
| Conversion preview | off | field mapping |
| Lead conversion | off | conversion preview |
| Conversion operation recovery | off | lead conversion |
| Opportunity conversion | off | lead conversion |
| AI-assisted fit insight | off | scoring |

The practical order is: publish a model, choose it as **Active model**, turn on **Rule-based scoring**, then
the recalculation paths you need. Only after that, enable the conversion chain — field mapping, conversion
preview, lead conversion, recovery — and finally the optional engagement signals and AI insight.

Turning the module off closes its screens, commands and jobs, but a score already stored on a Lead stays.
It is a record of what happened, not a live value.

## Models

A model **is a version**: publishing freezes it, and changing it means opening a new version that copies its
rules. The list shows every model, its version, its state (`draft`, `published`, `archived`) and which one is
active.

### What a model carries

| Field | Meaning |
| --- | --- |
| Scale minimum and maximum | The range a score can express; 0 and 100 by default |
| Base score | The number before any rule answers, inside the floor and ceiling |
| Floor and ceiling | The lowest and highest value a result may be stored as |
| Bands | Score ranges that decide a band, each with a name, a from and a to |
| Dimension weights | How much each dimension counts: fit, intent, engagement, completeness, recency, negative |
| Field grant | The Lead fields a rule may read, as an allowed list and a block list |

A band range must sit inside the scale and bands must not overlap. A gap is allowed but only produces a
warning: a score that lands in a gap does not change the band. `Unknown` and `Disqualified` are **never**
numeric thresholds — `Unknown` belongs to a Lead that was never scored, and disqualification comes from a
rule, including a rule that maps the core `Dead` status. A low number never disqualifies a Lead.

The field grant is a real restriction, not documentation: the validator refuses a rule outside it, the
protected-characteristic and scoring-output lists always win over the allowed list, and the engine re-checks
the grant when it evaluates.

### Rules

A rule names what it adds or subtracts, and when:

- **Reason code** — stable, unique inside the version, lower-case letters, digits and underscores, and what a
  stored evaluation refers back to.
- **Dimension** — fit, intent, engagement, completeness, recency or negative signals.
- **Effect and points** — `add` or `subtract` with −50 to 50 points, or `setBand` with a target band.
- **Order** — lower runs first; a matching `setBand` rule stops the model.
- **Condition** — built with the field/operator/value builder. Groups can be all, any or not, and the form
  shows the comparison and depth budgets. A rule cannot carry a formula, a dotted path, a table name, a
  relationship traversal or an unknown condition key.
- **Missing data** — `ignore` leaves the rule out of coverage; `neutral` counts it as unknown. Neither
  silently subtracts.
- **Signal source** — a Lead field, or an engagement source read from Marketing Automation: `marketingEvents`
  or `emailLinks`, with an event type, a lookback of 1 to 365 days, an optional decay (`linear` or
  `half-life`) and one of the metrics that source offers.

An engagement rule reads at most 200 events per Lead per window and only rows addressed to that Lead. If
Marketing Automation is absent, or engagement signals are off, the rule skips and the evaluation records
which of those states produced the answer — the score still computes from the Lead's own fields.

Up to 200 rules and 200 versions are allowed per model. The stored condition can be inspected as read-only
JSON, but never typed directly.

### Validate, publish and archive

**Validate** returns errors and warnings. Errors block publishing; warnings do not. **Publish** validates
again and freezes the version — no client, administrator included, may write a published model or its rules.
From a published version, **New version** opens the next draft, and **Compare versions** diffs the two by
reason code.

**Archive** stops a version from being used for new scores; every evaluation already stored keeps naming the
version that produced it. If the archived version was the active one, scoring stops with a clear refusal until
another published version is chosen.

**Recalculate Leads** appears on the active published version and queues a bounded rebuild under it, up to
2,000. Publishing a version does not move the scores already on Leads, and publishing does not make a version
active: choose it in Settings first, then rebuild. A request that names a version other than the active one is
refused, because the run must score under the version it names. The evaluations it writes record the model
publication as their reason.

## Preview

**Preview** scores a sample of at most 25 Leads the caller may read, either a bounded sample or Leads you
pick. It writes nothing: no projection, no evaluation row, no event. It reports the scores, bands, coverage,
reasons, the band distribution and a signature — two runs with the same signature produced the same score.
Leads in the sample that you cannot read are counted, not named, and the preview does not confirm whether an
id exists.

## Operations

**Operations** rebuilds scores under the **active** model only. A rebuild is bounded to 2,000 Leads with at
most 50 per chunk; a smaller limit is allowed, a larger request is capped. An optional field filter narrows which
Leads are processed. The table below lists the module's jobs with their state, attempts, progress, message
and creation time, and a running job can be cancelled. The same records appear in
[the audit log, jobs and operations](admin/audit-jobs-and-operations) at `/admin/jobs`.

Rebuilds are idempotent: a Lead whose inputs did not change records nothing, so re-queueing a run after a
failure is safe. A failed Lead is reported with its code and the run continues.

## Settings

**Settings** edits the module document and saves it whole with **Save settings**:

- **Lead Score switch** — the master switch. Off closes the screens, jobs and commands.
- **Active model** — a published version only. Until one is chosen, scoring refuses with a message that says
  whether the model is missing, unpublished or archived.
- **Recalculation delay** — 0 to 900 seconds, default 60. An event-driven recalculation waits this long, so
  a busy Lead is scored once rather than on every save.
- **Decay sweep** — off by default. When on, a daily job queues a bounded rebuild (limit 1 to 2,000, chunk 1
  to 50) only if the active model has a time-dependent rule. It says whether Marketing Automation's event
  table is present, because a sweep without it would score nothing new.
- **AI agent for fit insight** — a published AIAgents agent that reads a text task and holds read-only tools.
  **No agent chosen** is a valid configuration: the feature is then configured but idle, and the card says so
  instead of failing at the click.

The feature table sits below those fields with each switch, its requirements and its state: **In effect**,
**Waiting** for a requirement, or **Off**.

## Conversion policy

There is no conversion screen in this build: the targets, the field map and the merge policy are part of the
same `leadScore` document and are changed through `POST /api/v1/LeadScore/action/settings`.

| Setting | Default | Effect |
| --- | --- | --- |
| `conversion.targets` | Contact, Account, Opportunity | Which targets the wizard and the server may build; the list may not be empty |
| `conversion.fieldMergeAllowed` | off | Whether a Lead value may overwrite a non-empty field on a linked record |
| `conversion.mapping` | the shipped map | Which Lead field feeds which Contact, Account and Opportunity field |
| `conversion.recovery` | bounded scan, off | The sweep that settles conversion rows a crash left in `processing` |

The map is validated against metadata when it is written: the source must exist on Lead and be mappable, the
target must exist and accept the type, and a changed map **must raise its `version`** — that version is what
a stored conversion names. Never copied by any map: ownership, consent, files, notes, the Lead's stream and
its score fields.

`Opportunity` is in `targets` by default, but the wizard only offers it when **Opportunity conversion** is
effective. Disabling a target is a refusal, not a silent downgrade: a request that names it is rejected.

## What is server-owned

A Lead's score fields, its conversion result fields and every `LeadScoreEvaluation`,
`LeadConversionOperation` and `LeadScoreInsight` row are written only by the module. The write guard refuses a
client write — including an administrator's — because those rows are the record of what the system did. Edit
the model or retry the operation through the module's own commands instead.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Scoring refuses with no active model | Choose a published version in Settings; publishing alone does not activate it |
| Existing scores did not move after a publish | Choose the version as active in Settings, then use **Recalculate Leads**, or start a rebuild in Operations |
| A feature stays **Waiting** | One of its requirements is off; the Requires column names it |
| Rebuild is queued but makes no progress | Look at the job row and `/admin/jobs`; the worker runs the chunks |
| A rule blocks publishing | The validation report lists the errors; warnings are allowed |
| A band cannot be saved | `Unknown` and `Disqualified` cannot be thresholds, bands must fit the scale and must not overlap |
| A rule cannot read a field | It is outside the field grant, protected, a scoring output, or a relationship |
| Conversion is unavailable | The conversion chain is incomplete, the target is disabled, or the right is missing |
| AI insight is not offered | The feature is off, no agent is configured, or AIAgents cannot be read |

The module also answers `GET /api/v1/LeadScore/action/health` with its records, indexes, write guard, feature
state and the operations admitted for the caller. It is the first thing to read when the screen itself looks
wrong.

## Where to go next

- [Lead scoring and conversion](user/lead-score) — what a salesperson sees and does.
- [Entities, fields and layouts](admin/entities-and-fields) — the computed fields the model fills.
- [The audit log, jobs and operations](admin/audit-jobs-and-operations) — rebuilds, failures and cancellations.
- [Users, teams and roles](admin/users-teams-roles) — who may see and change a score.
