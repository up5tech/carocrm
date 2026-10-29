---
title: What's new
summary: There is no changelog screen in this application. Release notes are repository documents — here is where they are and how to read one.
audience: user
order: 50
tags: [release, notes, version, changelog]
aliases: ["ghi chú phát hành", "thay đổi theo phiên bản"]
related: [reference/glossary, admin/settings-overview, getting-started/find-your-way]
updated: 2026-10-30
---

Nothing inside the application opens a list of what changed. There is no **What's new** screen, no version
banner and no upgrade notice: the handbook you are reading describes the build as it behaves today, and says
plainly where a feature is absent rather than promising it later.

## Where the release notes live

They are engineering documents in the source repository, not pages of this handbook, so they are written for
whoever maintains your instance.

| Document | What it is | Latest dated entry |
| --- | --- | --- |
| `docs/releases/2026-10-29-phase-22.md` | The hardening release note for the whole product: verified scope, migrations, operational actions and the remaining release blockers. | 2026-10-29. |
| `docs/modules/crm-chat/RELEASE_NOTES.md` | The release notes for one module, by version. | v1.1, released 2026-10-21. |
| `docs/implementation/service-desk-release.md` | A release checklist for one module: every sub-phase, its state, and the commands that prove it. | Release reference date 2026-10-17. |
| `docs/reference/alpha-status.md` | The status report for the whole product: each capability, its state and its evidence, then the deliberate deviations. | 2026-10-12, with later phases appended. |
| `docs/compatibility/<area>.md` | The known-limitations note for one area: what is deliberately not equivalent, and what is not built. | Written per area, so no single date. |

## How to read one

A note in this repository is written as evidence, not as marketing. Four parts are worth the trip:

- **The verification table.** The commands that were actually run and the count that came back. A claim with
  no row here was reviewed, not tested — the notes say so when that is the case.
- **The finding-and-fix table.** Where a previous note claimed something that was not built, the new note
  names the gap and what was changed. That is why the prose can be blunt.
- **The not-built and known-limitations lists.** The most useful section for a reader: what the product does
  not do, stated as fact.
- **Version pairs.** A module version and a contract version are separate numbers, so a feature can arrive
  against the same contract. Read both before concluding anything about compatibility.

## The most recent release

The newest dated note is the **Phase 22 hardening release**, 2026-10-29. It adds no new module screen. It
changes how the product fails, and what an operator must do before carrying real customer data. What a
reader can notice:

| What you see | What it means |
| --- | --- |
| An unexpected error shows a plain 5xx message | The driver or connector text no longer reaches the browser. |
| Dates and numbers look the same on every screen | Both render through the shared helpers instead of per-screen formatting. |
| Loading, empty, error and permission-denied states behave alike | The screens share one set of states, with a retry where retrying is meaningful. |
| A production instance refuses to start with the development JWT secret | The fallback secret is development-only; a deployment must set its own. |
| A backup writes a checksummed, encrypted artifact | `pnpm backup` is safe to schedule; `pnpm verify:backup` checks an artifact. |

> [!WARNING]
> The Phase 22 note records the release as **blocked for production**: there is no restore rehearsal and no
> approved RPO/RTO yet. A backup exists; a tested restore does not. The release note names the other open
> gaps with an owner and a review date.

### The last module release

The newest module-specific note is CRM Chat v1.1, released 2026-10-21 with contract version 1.2.0. It is a
correction release: the earlier notes declared work that the review found unbuilt, and the application did
not compile. What changed for a reader of that screen:

| What you see at [CRM chat](/crm-chat) | What it means |
| --- | --- |
| An answer arrives with its tool steps and usage, rather than an empty reply | The stream now maps the runtime's real run timeline onto the chat vocabulary. |
| A citation list you can actually follow | Citations are re-read under your own permission. A record you may no longer read produces no citation at all. |
| A refused filter instead of a surprising result set | A filter the server cannot translate is answered as a client error. It used to be dropped, which quietly widened the answer. |
| Prompt templates, and a rating on an answer | Save your own templates and rate the answer a turn produced, one rating per person per answer. |
| Cross-module analysis with partial results | The scenarios are server-owned and bounded, and a failed step returns a sanitised reason rather than an internal message. |

## What this handbook does instead

Because there is no changelog to read, the handbook carries the freshness signals itself:

- Every page ends with a **Last reviewed** date, and the landing page's recently-reviewed list is sorted on
  it, so a page nobody has re-read in a while is visible as exactly that.
- Absence is written down rather than glossed over. The pages state that there is no notification bell, no
  self-service password reset, no file picker on import and no bulk update — the things a release note would
  normally be blamed for omitting.
- An administrator can see how much of the corpus is translated and which pages carry content-contract
  warnings on the [Docs tab](/admin/settings/docs) of the administration area.

> [!NOTE]
> A release note is not a promise about your instance. These documents describe the source; what you can
> click depends on the build your administrator deployed and on the switches that instance has turned on. If
> a release note and your screen disagree, the screen is the fact — and [the administration
> area](admin/settings-overview) explains which screens are gated per instance.

## Where to go next

- [Glossary](reference/glossary) — the words a release note uses for the things it changed.
- [Frequently asked questions](reference/faq) — the questions a new release tends to raise.
- [The administration area](admin/settings-overview) — how settings are versioned and published on your instance.
