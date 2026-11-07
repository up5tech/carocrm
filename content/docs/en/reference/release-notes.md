---
title: What's new
summary: There is no changelog screen in this application. Release notes are repository documents — here is where they are and how to read one.
audience: user
order: 50
tags: [release, notes, version, changelog]
aliases: ["ghi chú phát hành", "thay đổi theo phiên bản"]
related: [reference/glossary, admin/settings-overview, getting-started/find-your-way]
updated: 2026-11-06
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

The newest module releases are CRM Chat v1.3.0 and AI Agents v1.3.0, both 2026-11-06. The Chat release
adds read-side domain tools (project status, commercial summary, campaign performance, email list) and
inline AI: the quick-chat panel now opens from a record header and a list bulk bar with the record or
selection as context, the email template designer links to **Draft with AI**, and home gains a
deterministic briefing card. AI Agents v1.3.0 adds the three trigger kinds — event, scheduled and
integration — so a published agent can start runs without anyone pressing **Run**. What changed for a
reader of [CRM chat](/crm-chat):

| What you see at [CRM chat](/crm-chat) | What it means |
| --- | --- |
| An answer can draw on project, sales and campaign figures | The read-side domain tools are in the catalogue, running under your own permission. |
| The **Ask AI** panel opens from a record or a list with suggestions | Inline AI reuses the same turn API and ACL; the context is in the prompt, not a wider permission. |
| A run appears that nobody started by hand | A trigger fired it, as the user who published the agent. See [AI agents](user/ai-agents). |

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
