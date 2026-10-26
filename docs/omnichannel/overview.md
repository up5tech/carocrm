# Omnichannel (Phase 19-OM) — overview & implementation log

> Living log for `PLAN_Phase_19_Omnichannel.md` §14 ("after each sub-phase, update
> `docs/omnichannel/overview.md` or an implementation log"). Newest entry first.

## Sub-phase status

| Sub-phase | Status | Deliverables |
| --- | --- | --- |
| OM.0 — Repository audit | ✅ COMPLETE | `repository-audit.md`, `capability-matrix.md`; decisions D1–D3 locked in plan §0.2 |
| OM.1 — Feature contract & channel feasibility | ✅ COMPLETE (documentation only) | `feature-contract.md`, `channel-feasibility.md`, risk log update (contract §12) |
| OM.2 — Module registration & navigation | ✅ COMPLETE | `apps/api/src/omnichannel/` (descriptor, permission matrix, settings document, health, nav, control plane), nav seed, `/omnichannel` SPA shell, i18n en/vi, `omnichannel-module.test.ts` |
| OM.3+ | ⏸ Not started | — |

## Decisions index (locked)

- **D1/D2/D3** (plan §0.2) — canonical record = `voice_conversations` family; queues/routing =
  ServiceDesk extended; realtime = shared publish seam + module-scoped SSE. Carried into OM.1
  unchanged; refined in `feature-contract.md` §2.
- **OM1.1–OM1.7** (first channel set, first E2E path = Twilio SMS/WhatsApp, deferred channels,
  thread cardinality, transport via Voice's adapter, AI drafts-only) — `feature-contract.md` §1.
- **Per-channel verdicts** — `channel-feasibility.md` summary table (GO: CF-1, CF-2;
  conditional: CF-3 context, CF-4 web chat; all others NO-GO/EXCLUDED for the first release).

## Log

### 2026-10-26 — Phase 19-OM.2 (Module registration and navigation)

- Backend: new `Omnichannel` kernel module (`apps/api/src/omnichannel/`) registered in `AppModule`
  before the entity wildcard — descriptor (loadOrder 397, reserved webhook prefix, **zero owned
  tables** per D1), the nine synthetic permission resources of contract §10 (`OmnichannelConversation`,
  `OmnichannelMessage`, `OmnichannelAssignment`, `OmnichannelQueue`, `OmnichannelIdentity`,
  `OmnichannelConnection`, `OmnichannelOps`, `OmnichannelSettings`), the `omnichannel` settings
  document with the `features.workspace` switch, evidence-based health view, navigation visibility
  report, and the control-plane controller (`action/health|capabilities|nav|settings`, OpenAPI tag
  `omnichannel`). No placeholder endpoints.
- Wiring: `NAVIGATION_FEATURE_GATE` branch + `OMNICHANNEL_MENU_INVALIDATOR` resolver in
  `app.module.ts` (lazy `ModuleRef`, the CRMChat pattern); nav seed `omnichannel` (order 75, beside
  the inbox) gated on `OmnichannelConversation:read` + the workspace switch.
- Frontend: `/omnichannel` route + `OmnichannelPage` shell (server-answer tiles: foundation,
  modules built on, my capabilities; administrator workspace switch); `i18n/en|vi/omnichannel.json`.
- Corrections found while verifying: the queue-engine marker is the `CaseQueue` **metadata entity**
  (no `case_queues` table), the realtime seam marker is the `notifications` table, and the AI Agents
  marker is the `ai_agents` table (`AIAgent` is not a registered metadata entity — the same false
  negative exists in the esignature/lead-score markers; noted, not fixed there).
- Checks run: `apps/api/test/omnichannel-module.test.ts` 7/7; `navigation.test.ts` + `i18n.test.ts`
  16/16; api+web typecheck, eslint (touched files), `check-ui-conventions` 4730 keys, web build —
  all clean; live browser pass: page renders in vi with all foundation rows green, and toggling
  `workspace` off hid the sidebar entry on reload and on restored it (the non-admin 403 and menu
  filtering are covered by the API tests, not driven in the browser).
- Follow-up recorded, not done here: granting the new keys to non-admin/demo roles (E18/G21) is the
  OM.13 permission-model decision; E1/E2/E3/E14 preconditions (contract §13) land with OM.3–OM.5.
- Files: `apps/api/src/omnichannel/*` (7), `apps/api/src/app.module.ts`,
  `apps/api/src/admin-panel/navigation-defaults.ts`, `apps/web/src/AppRoutes.tsx`,
  `apps/web/src/api/client.ts`, `apps/web/src/api/types.ts`, `apps/web/src/pages/OmnichannelPage.tsx`,
  `i18n/en/omnichannel.json`, `i18n/vi/omnichannel.json`, `apps/api/test/omnichannel-module.test.ts`,
  plan §14 (OM.0/OM.1 notes + OM.2 status), this log.

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
