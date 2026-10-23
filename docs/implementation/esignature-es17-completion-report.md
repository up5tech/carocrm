# Phase 19-ES.17 — Approval Workflow and Policy Engine

> `PLAN_Phase_19_ESignature.md` §11.1, §11.2, §18 `Phase 19-ES.17`.
> Acceptance: a request cannot be sent while a required approval is pending or rejected; an approval
> applies only to the exact reviewed snapshot; every decision is auditable.
>
> Prerequisites read: `esignature-es8-completion-report.md` (the immutable preview and digest),
> `esignature-es10-completion-report.md` (the send guard this phase completes),
> `esignature-es16-completion-report.md` (the lifecycle actions and audit trail).

ES.17 turns the approval placeholders into a workflow: a configurable policy decides whether a
prepared request needs a second person, the decision binds to the exact digest and request version, and
the send guard refuses everything else. It also adds the first **value/risk** policy evaluation, so the
decision is not tied to a source entity name alone.

---

## 1. Files

| File | What it owns |
| --- | --- |
| `database/migrations/067_phase19_esignature_approvals.sql` | Additive columns: `approval_requested_at`, `approval_requested_by_id`, `approval_reviewed_version`, `approval_reviewed_digest`. Applied to the configured `carocrm_dev` database. |
| `esignature-approval-policy.ts` | The pure policy engine: required source entities, value/risk rules (`equals`, `not_equals`, `gte`, `lte`, `contains`), fail-closed handling for unreadable/empty fields, and the policy basis that is hashed into the snapshot. |
| `esignature-settings.service.ts` | `approval.rules`, `approval.preventSelfApproval`, metadata validation of every rule target, and the `approvalsNoPolicy` warning. |
| `esignature-preview.ts` | Uses the engine for `approvalRequired`/`approvalReasons`; adds `approvalBasisDigest` to the snapshot policy so a change to reviewed source terms makes a stored approval stale. |
| `signature-request.repository.ts` | `approval_requested_*`/`reviewed_*` fields, `requestApproval`, `recordApproval` (status/digest/version checks), and preparation/invalidation rules that preserve a decision only for the same digest. |
| `esignature-request.service.ts` | `requestApproval`, `approve`, `reject`; separation-of-duties enforcement; the prepare target-status fix; the explicit approval-status check in `send`; the `approvalStatus` list filter. |
| `esignature-request.controller.ts` / DTOs | `POST /:id/request-approval`, `/:id/approve`, `/:id/reject`, and the `approvalStatus` list filter. |
| `esignature-errors.ts` / module | `SIGNATURE_APPROVAL_SEPARATION_REQUIRED` with its i18n entries. |
| `pages/esignature/ESignatureRequestsPanel.tsx` | The approval panel (digest/version, requested/decided metadata, approve/reject modal), the pending-approval list filter, the optional *Request approval* action, and policy reasons in the preview. |
| `admin/tabs/ESignatureSettingsTab.tsx` | The policy editor: required source entities, separation-of-approver switch, and the value/risk rule rows. |
| `apps/api/test/esignature-approval-policy.test.ts`, `esignature-approvals.test.ts` | The engine cases and the API lifecycle below. |

---

## 2. How each acceptance criterion is held

**Cannot send while pending/rejected.** Preparation records the *effective* requirement. A covered
request is moved to `pending_approval`; the send command only accepts `ready_to_send`, and an approved
request additionally requires `approval_status = 'approved'` **and** an approved digest equal to the
outgoing digest. A rejection keeps the request in `pending_approval` with `approval_status = 'rejected'`,
so every send attempt is refused before any provider contact.

**Approval applies only to the exact snapshot.** The reviewer acts on `outgoing_digest` and records the
request version they saw (`approval_reviewed_version`). `recordApproval` refuses a digest that no longer
matches and only permits a request that is actually waiting. Any draft edit (documents, recipients,
mapping, subject/message) runs the existing preparation invalidation: the snapshot and digest are
dropped, the reviewed fields and the approval are cleared, and the request returns to `draft`. The
snapshot's `approvalBasisDigest` additionally makes a change to the **source values the policy read**
(a threshold/risk/type) change the digest, so sending refuses a stale review until it is prepared again.

**Every decision is auditable.** `approval.requested` (prepare or explicit command),
`approval.granted` and `approval.rejected` carry the actor, the reason, the digest and the reviewed
version. The request row keeps the reviewer, decision time, reviewed digest/version and the reason even
for a rejection; `approved_digest` remains the positive gate only.

**Policy examples from §11.1.** A source entity list covers "selected source entities"; rules cover a
monetary threshold (`gte` on an amount field), a contract/risk category (`equals`/`not_equals`) and a
sensitive text category (`contains`). The policy engine is data-only — no expression evaluation and no
SQL interpolation. Rules are validated against the metadata registry when saved, so a typo cannot
create a rule that silently never matches.

**Approver eligibility and separation of duties.** The `approve` capability (synthetic
`SignatureApprove` ACL resource) is the explicit right; the record scope still applies. With
`preventSelfApproval` on (the default), the creator or preparer cannot decide their own request; this is
not an administrator bypass. The setting can be turned off deliberately for a one-approver
installation, and the decision's actor is always recorded.

**A previously approved identical preparation is not re-queued.** `prepare` sends a request back to
`ready_to_send` when the same digest already carries an approval; a *new* review is required only when
the bytes or the policy basis changed.

---

## 3. Decisions taken here

- **The policy is data, not a formula.** A rule names one metadata field and one closed operator; the
  engine reads the linked record's values through the same ACL-checked source read the preview already
  performs. An unreadable record, an empty field or a non-numeric threshold input fails closed: approval
  is required rather than skipped.
- **The policy basis is hashed, not copied.** The snapshot carries a SHA-256 of the reasons and the rule
  values, not the amount/risk itself, so a source-term change invalidates the approval without leaking
  business data to every request reader.
- **A rejection is not a terminal state.** It refuses send but leaves the reviewed bytes; an approver may
  reconsider, and an edit drops the rejection with the preparation. This follows the plan's "cannot be
  sent while pending/rejected" without inventing a second lifecycle.
- **Approval commands are local.** They never call the provider and are gated by the module, the
  `approvals` feature and the capability; the existing send gate is unchanged.
- **Separation is on by default.** The admin can switch it off, and doing so is visible in the settings
  document; no role is silently exempt.
- **Approver-facing navigation is a list filter.** `approvalStatus=pending` is the "Requests I need to
  review" path; a separate inbox/dashlet is ES.19/ES.20.

---

## 4. Verification

- `apps/api/test/esignature-approval-policy.test.ts` — 6 cases: source entity, numeric threshold,
  equals/not_equals/contains, fail-closed source/field/non-numeric, feature-off and explicit request.
- `apps/api/test/esignature-approvals.test.ts` — 9 lifecycle cases: pending blocks send; approver
  decision opens send; rejection stays refused; edit returns to draft; stale version; no approval right;
  rule covers one Account and not another; explicit request-approval; self-approval refusal and
  opt-out; audit requested/granted/rejected; invalid rule field refused at save.
- `npx vitest run apps/api/test/esignature-*.test.ts` — **16 files, 269 tests passing** after the
  change (the ES.1–ES.16 suite plus the two approval suites).
- Both-project typecheck, ESLint on every touched file, and `pnpm --filter @carocrm/web build` are clean.
- Browser pass on the dev stack: the list shows the approval state and the new filter; the detail shows
  the approval panel with digest, reviewed version, policy reasons and Approve/Reject; clicking Approve
  moved the request to `ready_to_send`, changed `approvalStatus` to `approved`, recorded the reason and
  refreshed the timeline; the settings tab renders the policy/rule editor. Fixture rows and settings
  were removed afterwards.
- Migration `067_phase19_esignature_approvals.sql` applied to the configured database; columns verified
  in `information_schema`.

## 5. Still open

- No notification is written when a request enters the approval queue; the pending filter is the
  review path. In-app approval notifications are ES.19/ES.20's operational surface.
- A source-term change is detected on the next preview/send (via the digest basis); there is no event
  subscriber that proactively re-opens an already-approved request when the source record changes
  (ES.18 wires domain events).
- The approval panel shows actor ids; resolving display names is a UI refinement, not an authorization
  gap.
- No delegation, expiry or multi-step approval chain is modelled; the plan asks for one decision bound
  to the reviewed snapshot.
