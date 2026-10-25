---
title: Lead scoring and conversion
summary: Read a Lead's score, band and reasons, refresh it, and turn a qualified Lead into a Contact, an Account or a deal.
audience: user
order: 115
tags: [lead, lead-score, scoring, qualification, band, conversion]
aliases: ["điểm lead", "chấm điểm lead", "chuyển đổi lead", "xếp hạng lead"]
related: [user/record-page, user/lists-and-views, user/dashboards-and-reports, admin/lead-score]
updated: 2026-10-25
---

A Lead carries a score and a qualification band. The score is computed by the instance's active scoring
model — you never type it, and saving a form cannot change it. Lead scoring is an extension of this build,
not something the reference CRM documents; everything on this page describes how it behaves here.

The Lead record also carries a conversion card. A conversion creates or links a Contact, an Account and an
Opportunity without deleting the Lead, which keeps its history and its `Converted` status.

## Where the score appears

- **On the Lead record.** Open any Lead from [the Lead list](/Lead). The Lead Score card sits under the
  record's fields. It shows the number, the band, how fresh the result is, the rule-by-rule reason and the
  model version that produced it.
- **In a Lead list.** `Score Value` and `Score Band` are columns, both sortable. `Score Band` and
  `Score Status` are also filters, so a queue can be narrowed to hot Leads or to Leads whose score is out of
  date. See [working with lists](user/lists-and-views).
- **On a dashboard.** A Lead Score dashlet shows one of four views: scored Leads, Leads by band, score
  freshness or conversions. The numbers are computed under your own record access, not the dashboard
  owner's. See [dashboards and reports](user/dashboards-and-reports).

> [!NOTE]
> If the card and the columns are missing, the module is switched off on this instance or your account does
> not hold the right to see scores. The record itself is unchanged either way.

## Reading the card

The headline is the stored score, the band pill and, when the score moved, the change from the previous
value. **Coverage** is the share of the model's weight that actually had an answer: a score of 70 built on
20% coverage means most rules could not be evaluated, and it should not be read like a 70 built on
everything.

Under the headline the card names the model version, when the score was calculated and what inputs it was
calculated from. It also carries one of five states:

| State | What it means |
| --- | --- |
| Current | The stored score matches the Lead and the active model |
| Out of date | Something changed after the score was calculated; the alert names what |
| Waiting to be scored | A recalculation is queued or running |
| Could not be scored | The calculation failed; the reason is shown |
| Not scored yet | No score has been stored for this Lead |

**Why this score** lists every rule the model tried. Each row carries the rule's name, the points it added
or subtracted, and its outcome: applied, did not apply, not enough information, not evaluated, outside its
time window, or could not be evaluated. A rule that sets the band says which band instead of points. A rule
that could not be evaluated shows a stable code — that is the diagnostic, and it never exposes the field
value it would have read.

An engagement rule also names its source, the window it looked at and the value it found, for example
`Signal · Marketing events · clicked · last 30 days · Engagement count = 2`. When engagement signals are
switched off, or Marketing Automation is not installed here, the card says so: those rules were skipped, not
answered as zero.

### Bands

The vocabulary is fixed; the ranges belong to the model.

| Band | Set by |
| --- | --- |
| Unknown | No band can be decided, or the Lead has not been scored |
| Cold | The model's range for a cold Lead |
| Warm | The model's range for a warm Lead |
| Hot | The model's range for a hot Lead |
| Sales ready | The model's range for a qualified Lead |
| Disqualified | A rule that sets this band, including one that maps the core `Dead` status |

A low number never disqualifies a Lead by itself. `Disqualified` is always the result of a rule, and the
card names that rule in **Why this score**.

## Refreshing a score

**Recalculate** scores this Lead now. It only appears when your account holds the right, and the server
refuses the call otherwise. If nothing that feeds the model changed, the answer is
**Nothing changed, so no history was recorded** — a recalculation is safe to repeat.

When event-driven recalculation is on, a change to the Lead queues a recalculation automatically after a
short delay. An edit that cannot move the score queues nothing.

## History

**History** opens the stored evaluations, newest first: score, band, state, model version, what requested
the calculation, and when. Expand a row to see the breakdown that produced that result. The list is
append-only — a past evaluation is what the system said then, and no later edit rewrites it. Use **Load more**
to page through older results.

## AI insight

When the optional AI insight is configured, the card offers **Explain fit with AI**. One click spends one
AI agent run, and the answer is stored and labelled **AI-generated**. It is grounded in the stored score and
a small set of business fields — not in e-mail addresses, phone numbers, names, notes or consent records.
The text never changes the score.

If the answer was built from a field you may not read, its text is withheld and the card tells you so. If the
score has moved since the answer was generated, a warning says the explanation describes an earlier score.

## Converting a Lead

The Conversion card is the only entry point. It shows the button **Convert this Lead** when the server says
you may convert, and otherwise states the reason. The wizard has three steps.

1. **Targets.** For each type this installation offers — Contact, Account and/or Opportunity — choose
   **Create new**, **Link existing** or **Do not build**. Only records you may read are offered, and the
   suggested matches from the duplicate check come first.
2. **Review.** Nothing has been written yet. The preview lists what **will be written**, what **will not be
   copied** and why, values that are **required and still empty**, and values that **differ from the linked
   record**. Applying a differing value to an existing record needs its own right and is an explicit tick.
   Possible duplicates name their match class — same person or same organization — and a count of matches
   you cannot see; the count is never a name. Before confirming, the wizard restates the consequences: a
   record will be created or linked, values will be skipped, a Contact will move to another Account, or an
   Opportunity will be created.
3. **Result.** The result separates **Created** from **Linked** and links to each record. **Done** returns to
   the Lead.

If the Lead changed while you were reviewing, the preview is taken again and you must review and confirm
the new version. Converting twice is refused: one Lead converts once. If a response is lost after you press
**Convert**, the card offers to resume the same operation, which cannot create a second set of records.

Afterwards the Lead stays in the system with the `Converted` status. The Conversion card and the **Converted
To** panel link to what was made, and the conversion is recorded with who ran it and when.

> [!WARNING]
> Conversion copies no consent, sends no e-mail or message, and moves no note, stream item, attachment or
> activity out of the Lead. Ownership is not copied either; assign the new records deliberately. The Lead
> keeps its thread and stays reachable.

## When something looks wrong

| Symptom | Likely cause |
| --- | --- |
| The card is missing | The module is off, or your account lacks the score right |
| The Lead is not scored yet | Scoring is off, or no published model is chosen as active |
| The score is out of date after an edit | Event-driven recalculation is off, or the debounce delay has not passed; use Recalculate |
| A recalculation changed nothing | The inputs are unchanged; no history is written for an identical result |
| A rule says not enough information | The field is empty, or your field permission hides it from the calculation |
| Engagement rules were skipped | Engagement signals are off, or Marketing Automation is absent |
| The AI section is absent or disabled | AI insight is off, no agent is configured, or you lack the right |
| The conversion button is disabled | Conversion is off, a target is disabled, the Lead is already converted, or a required value is empty |

## Where to go next

- [Reading and editing a record](user/record-page) — the record page the card sits on.
- [Working with lists](user/lists-and-views) — sorting and filtering a Lead queue by score and band.
- [Dashboards and reports](user/dashboards-and-reports) — the Lead Score dashlet.
- [Configuring Lead Score](admin/lead-score) — the model, its bands and the switches behind the number.
