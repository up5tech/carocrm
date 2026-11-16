# Phase 24.12 — Product Release Review and Go/No-Go

> **Status:** In progress — the release-review inventory and the task status are recorded here (2026-11-16);
> the release gate has not been re-run and no go/no-go decision has been made. **No release action has been taken.**
> **Plan:** `plans/PLAN_Phase_24_Product_Completion.md` §18 (Phase 24.12 — Product Release Review and Go/No-Go, P0)
> **Predecessor:** Phase 24.11 — quality debt and single-tenant scale (`docs/quality/phase-24-11-quality-debt-scale.md`).

## 1. Objective

Re-run the release gate with the P0 evidence and give an honest decision for a single-tenant installation.

## 2. Task status

1. Re-run `pnpm ci:gate` (now including `pnpm ci:api-spec`), `pnpm ci:api-spec --strict`, the focused integration batch and the relevant browser specs; record actual results and skipped checks. **Not started.**
2. Verify the P0 exit conditions: single-tenant charter ratified; G80/G81 closed or owner-accepted; distribution decision recorded; production install/upgrade exercised; G1 disposition signed; release docs truthful. **Not started.**
3. Verify no secrets, real customer records, database dumps, browser storage or unsafe artifacts were committed, and that no live provider action occurred in CI. **Not started.**
4. Verify all optional providers, OIDC profiles and extension trust settings default to safe modes; an unconfigured provider must fail clearly. **Not started.**
5. Produce the release review: evidence links, closed gaps, accepted exceptions with owners and review dates, residual P1/P2 risks, and a go/no-go recommendation. **In progress** (this file).
6. Update `plans/PLAN.md` §57 status and the release notes. Do not claim complete EspoCRM parity. **Not started.**

## 3. Release gate

**GO** only when all P0 criteria are met, or an authorised owner explicitly accepts a documented exception with mitigation and deadline:

- The single-tenant boundary is ratified and no tracked document contradicts it.
- G80/G81 have restore evidence or a written owner acceptance; the distribution/licence question has a recorded outcome.
- `pnpm ci:api-spec --strict` passes in the existing nightly gate and the public API contract has one canonical source; the reviewed initial typed-client scope has schema-backed generated types and a verified consumer.
- A production installation can be installed, upgraded and recovered from the documented artifacts without dev defaults.
- No High/Critical exception is unsigned; no security control was weakened for this phase.
- No extra database was created and no destructive setup was introduced.

## 4. Acceptance criteria status (task / plan §18)

| Criterion | Status |
| --- | --- |
| Final go/no-go review written with residual P1/P2 risks and owners. | **Open** — task 5 in progress; tasks 1–4 outstanding. |
| Release gate green / owner-accepted exceptions recorded; no unsigned High/Critical exception. | **Open** — not run yet. |

## 5. Outstanding work

1. Re-run the release gate and record actual results.
2. Verify the P0 exit conditions.
3. Verify no unsafe artifacts / no live provider action in CI.
4. Verify safe default modes for optional providers, OIDC and extension trust.
5. Complete the release review (evidence, closed gaps, exceptions, residual risks, recommendation).
6. Update PLAN.md §57 status and release notes.

## 6. Verification

- `node scripts/check-ui-conventions.mjs` — docs gate, run after this record landed.
- No code, migration, database, provider or deployment change in this pass; no release decision made.
