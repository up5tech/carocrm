# Distribution compliance — clean-room/AGPL review and LICENSE

> **Owner:** repository owner, with legal/compliance review
> **Recorded:** Phase 23.9 (2026-11-12), `plans/PLAN_Phase_23_Security_Hardening.md` §15 task 6.
> **Status:** **Blocked — release blocker.** No distribution claim is made. This record does not give
> legal advice and does not create a licence.

## 1. What the repository says today

`README.md` §Licensing states:

- EspoCRM upstream is **AGPL-3.0-or-later**.
- This repository is described as a **clean-room reimplementation**: behaviour and public API contracts
  were used as reference; no upstream source, assets or translations were copied.
- A **formal compliance review is required before distribution**.

There is **no `LICENSE` file** in the repository root. A repository without a licence is not
open-source, and "no licence" does not mean "public domain": default copyright applies. Potential users
and contributors therefore have no granted rights, and the project cannot honestly describe itself as
distributable.

`AGENTS.MD` §6 already treats licensing/compliance as an owner action, not an agent code change. Phase
23.9 confirms that status; it does **not** pick a licence, copy an upstream notice, or conclude that the
clean-room claim is legally sufficient.

## 2. Why this is a release blocker

| Issue | Risk if unresolved |
|---|---|
| No repository `LICENSE` | No clear grant to use, modify or redistribute; contributors and customers cannot rely on a licence. |
| Clean-room/AGPL review not performed | If any upstream code, assets or translations were in fact copied, AGPL-3.0 obligations may attach to the distributed work. The project's own description is a claim, not a legal conclusion. |
| Third-party dependency licences not reviewed as a distribution artifact | A bundled dependency may carry notice/source obligations that the distribution does not meet. |
| No named owner/decision | The blocker cannot be closed, waived or scheduled; it silently rolls into the next release. |

This is why Phase 23.9's acceptance records it as an explicit blocker rather than marking the phase
complete on the strength of the README paragraph.

## 3. What the owner/legal review must decide

1. **Licence for this repository.** Choose and add a `LICENSE` (or an explicit "all rights reserved"
   proprietary notice if distribution is not intended). This is an owner decision; the coding agent
   must not guess it.
2. **Clean-room evidence.** Confirm the development record: who wrote which modules, what reference
   material was used, and whether any upstream source/assets/translations entered the tree. If the
   answer is uncertain, treat it as unresolved.
3. **AGPL obligations, if any.** If the review finds copied AGPL material, decide whether to remove and
   rewrite it, or to comply with AGPL for the distributed work. Do not rely on the README wording
   alone.
4. **Dependency notices.** Produce the third-party notice/source-offer artifact the chosen licence and
   the dependencies require. The lockfile is the inventory; the review is legal, not just a scan.
5. **Distribution channels and trademarks.** Decide what is published, under which name, and whether
   the upstream marks are used in a way that implies endorsement.
6. **Contributor terms.** Decide whether contributions need a DCO/CLA; this affects the ability to
   relicense later.

## 4. What Phase 23.9 did and did not do

**Did:**

- Re-read `README.md` §Licensing, `AGENTS.MD` §6, and the plan's task 6.
- Confirmed no root `LICENSE` exists and that no legal review is recorded.
- Recorded the blocker here, with the owner and the decision list above.
- Kept the release gate's distribution status explicit rather than implying compliance.

**Did not:**

- Create a `LICENSE`, copy an upstream licence/notice, or choose a licence.
- Conclude that the clean-room claim is correct.
- Contact a lawyer, customer or regulator.
- Change any dependency or distribution artifact.

## 5. Closure criteria

This blocker closes only when:

- [ ] A root `LICENSE` (or an explicit proprietary notice) is committed by the owner.
- [ ] The clean-room/AGPL review has a named reviewer and a recorded outcome, including any required
      removals or notices.
- [ ] Third-party notice/source obligations for the distribution are satisfied.
- [ ] The outcome is linked from `README.md` §Licensing and from the release go/no-go record.
- [ ] If the outcome is "do not distribute", the release record says so explicitly.

Until then, the release review must carry **distribution compliance: Blocked** and must not publish a
distribution artifact on the strength of this repository.

## 6. Phase 24.2 — prepared records (no owner/legal decision made)

Phase 24.2 §8 task 4 asks the coding agent to **prepare** the records, not to choose a licence, name a
reviewer, or declare the clean-room review complete. This section is a blank decision record plus a
reproducible inventory. No `LICENSE`, `NOTICE` or distribution artifact was created, and no box in §5
was ticked.

### 6.1 Owner/legal decision record

| Field | Required by | Status on 2026-11-14 |
|---|---|---|
| Decision ID | release gate | `DIST-24.2-01` (proposed identifier only) |
| Repository `LICENSE` or explicit proprietary notice | §3 item 1, §5 | **PENDING — owner/legal.** No `LICENSE` created; none may be chosen by an agent |
| Named clean-room reviewer and recorded outcome | §3 item 2, §5 | **PENDING — owner/legal.** No reviewer named, no outcome recorded |
| AGPL obligation determination (and any required removal/rewrite) | §3 item 3 | **PENDING — owner/legal** |
| Third-party notice / source-offer artifact | §3 item 4, §5 | **PENDING — owner/legal.** The inventory in §6.2 is prepared; the legal review and artifact are not |
| Distribution channels and trademark use | §3 item 5 | **PENDING — owner/legal** |
| Contributor terms (DCO/CLA) | §3 item 6 | **PENDING — owner/legal** |
| Owner signature and date | Phase 24.2 §8 task 5 | **UNSIGNED.** An agent may not accept or sign a High/Critical exception |
| Outcome carried into the release record | §5 | **"Do not distribute"** until a decision is recorded (see `docs/quality/phase-24-test-evidence.md` §24.2) |

### 6.2 Third-party inventory (prepared, not a legal conclusion)

Command run on 2026-11-14, offline, from the repository root: `pnpm licenses list --json`.

- **13 licence groups across 716 installed packages** with a declared `license` field; 759 package
  directories exist under `node_modules/.pnpm`, so this is not a complete legal inventory.
- 25 workspace `package.json` files declare **205** direct dependencies including dev dependencies.
- `pnpm-lock.yaml` remains the authoritative inventory.

| Declared licence group | Packages |
|---|---|
| MIT | 614 |
| Apache-2.0 | 51 |
| ISC | 24 |
| BSD-3-Clause | 11 |
| BSD-2-Clause | 7 |
| MPL-2.0 | 2 |
| Python-2.0, CC-BY-4.0, BlueOak-1.0.0, MIT-0, 0BSD, `(MIT AND Zlib)`, `(MIT OR CC0-1.0)` | 1 each |

This count is a **mechanical scan**, not a notice artifact: it does not resolve dual-licence choices,
source-offer obligations for MPL/Apache packages, vendored assets, packages without a declared licence,
or compatibility between the chosen repository licence and the dependencies. The owner/legal review
must produce the actual notice/source-offer artifact under the licence it selects.

### 6.3 What this section does not do

- It does not create a `LICENSE`, copy an upstream licence, or infer that the clean-room claim is
  legally sufficient.
- It does not conclude the AGPL review, accept an exception, or sign anything on the owner's behalf.
- It does not change any dependency or distribution artifact. `pnpm-lock.yaml` and `package.json`
  were read, not modified.
- The release status remains **distribution compliance: Blocked / NO-GO**.
