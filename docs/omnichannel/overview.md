# Omnichannel (Phase 19-OM) — overview & implementation log

> Living log for `PLAN_Phase_19_Omnichannel.md` §14 ("after each sub-phase, update
> `docs/omnichannel/overview.md` or an implementation log"). Newest entry first.

## Sub-phase status

| Sub-phase | Status | Deliverables |
| --- | --- | --- |
| OM.0 — Repository audit | ✅ COMPLETE | `repository-audit.md`, `capability-matrix.md`; decisions D1–D3 locked in plan §0.2 |
| OM.1 — Feature contract & channel feasibility | ✅ COMPLETE (documentation only) | `feature-contract.md`, `channel-feasibility.md`, risk log update (contract §12) |
| OM.2+ | ⏸ Not started | — |

## Decisions index (locked)

- **D1/D2/D3** (plan §0.2) — canonical record = `voice_conversations` family; queues/routing =
  ServiceDesk extended; realtime = shared publish seam + module-scoped SSE. Carried into OM.1
  unchanged; refined in `feature-contract.md` §2.
- **OM1.1–OM1.7** (first channel set, first E2E path = Twilio SMS/WhatsApp, deferred channels,
  thread cardinality, transport via Voice's adapter, AI drafts-only) — `feature-contract.md` §1.
- **Per-channel verdicts** — `channel-feasibility.md` summary table (GO: CF-1, CF-2;
  conditional: CF-3 context, CF-4 web chat; all others NO-GO/EXCLUDED for the first release).

## Log

### 2026-10-26 — Phase 19-OM.1 (Feature contract and channel feasibility)

- User-confirmed scope choice: **path A** (voice channels first, web chat second, email deferred)
  and channel set **SMS + WhatsApp + web chat**.
- Files added: `docs/omnichannel/feature-contract.md`, `docs/omnichannel/channel-feasibility.md`,
  this log. Plan §14 OM.1 marked COMPLETE. **No code, no migration, no metadata changed.**
- The two "decided here, not deferred" questions were answered: anonymous-visitor identity
  (contract §7) and the Email↔Email-to-Case non-competition contract (contract §15). Open
  question E15 closed in favour of Voice's own adapter (contract §1 OM1.6).
- Checks: documentation-only change — nothing to build or test; consistency cross-checked against
  audit §7–§9 and the live schema (`051_phase19_voice_communications.sql`, error taxonomy in
  `voice-communications-domain.ts:462`). Feasibility records carry an explicit re-verification
  duty before adapter coding.
- Next (OM.2): module skeleton per contract §3 F1 + preconditions §13 (E1/E2/E3/E14 are the
  earliest edits; E1 gates everything).

### 2026-10-25/26 — Phase 19-OM.0 (Repository audit)

- Audit + capability matrix written; D1–D3 locked in plan §0.2. No code changed.
