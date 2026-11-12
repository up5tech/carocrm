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
