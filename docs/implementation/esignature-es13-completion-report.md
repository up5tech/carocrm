# Phase 19-ES.13 — Remote Signing Progress UI

> `PLAN_Phase_19_ESignature.md` §13.2, §13.4, §18 `Phase 19-ES.13`.
> Acceptance: a user can track signer progress without the provider dashboard for routine cases;
> restricted users cannot view hidden recipient data, source records or event payloads.
>
> Prerequisites read: `esignature-es6-completion-report.md` (the list/detail drawer),
> `esignature-es12-completion-report.md` (the projection this screen shows).

ES.13 is the read side of the post-send story: list-level progress, a detail timeline, and actions that
match the current state and the caller's rights. The server remains the enforcement; the buttons only
mirror what the endpoints will admit.

---

## 1. Files

| File | What it owns |
| --- | --- |
| `esignature-request.service.ts` — `list`, `timeline`, `view` | `progressForRequests` in one grouped query; a merged provider-event + audit timeline, newest first; raw diagnostics only for `auditRead` holders. |
| `signature-recipient.repository.ts` | `progressForRequests`, the grouped summary used by the list. |
| `esignature-request.controller.ts` | `GET /api/v1/ESignature/requests/:id/events?limit=…`. |
| `pages/esignature/ESignatureRequestsPanel.tsx` | Signer column, recipient statuses and signing mode, the action card and the activity timeline. |
| `pages/ESignaturePage.tsx` | Passes `canVoid`, `canDownload`, `canCorrect` beside the existing prepare/send rights. |
| `i18n/{en,vi}/esignature.json` | Status, mode, action and timeline labels. |

**No migration.**

---

## 2. How each acceptance criterion is held

**Progress without the provider dashboard.** The list row carries `progress` (`completed` of `signers`)
computed from the local recipient projection, so a page of requests costs one grouped query. The detail
shows every recipient in routing order with a normalized status and signing mode, plus a timeline of
normalized provider events and lifecycle audit entries. The *Refresh from provider* action runs the
ES.12 reconciliation for a caller who holds the send right.

**Restricted readers.** The record ACL is applied before either answer (`loadScoped`): an unrelated
caller gets a 403 that says nothing about the id. Linked source records keep the ES.6 rule — inaccessible
or missing, never a leaked name. Provider event payloads are the minimized fields (identity and status,
no document, email or name). Raw provider status words are returned only to a caller holding
`auditRead`; every other reader sees the normalized status.

**Actions match the state.** The UI offers reconciliation for in-flight and terminal provider states,
reminders for an open envelope when the caller may send, a reason-bearing void for `void` holders, and
artifact retrieval for a completed request when `downloadCompleted` is held. Correction is rendered
disabled with the reason, because ES.16 keeps it capability-false until ES.22.

---

## 3. Decisions taken here

- **The timeline is part of the request, not the audit console.** It uses `use` + the record ACL, while
  the raw provider word is still gated by `auditRead`. The full append-only audit remains its own right.
- **`last_reconciled_at` is visible through the record, not a separate endpoint.** A reader checks the
  list/detail refresh; the audit timeline records each reconciliation.
- **No new list filter.** The existing `needsAttention` query covers stuck requests; a dedicated
  workbench and richer filters are ES.20's.
- **Empty states are explicit.** No recipients, no events and a failed timeline each say so; the action
  card is absent when no action applies rather than showing disabled noise.

---

## 4. Verification

- `apps/api/test/esignature-lifecycle.test.ts` — list progress (`1/2 signed`), timeline containing a
  provider and an audit entry, unrelated-scope refusals, and the detail's recipient statuses.
- Browser pass on the running dev stack: list shows the signer column; the drawer shows recipient
  status/mode, the action card (refresh/remind/void/correction-disabled) and the activity timeline; no
  console errors. The fixture and settings were removed afterwards.
- Typecheck, lint and web build: see ES.16 report §4.

## 5. Still open

- A dedicated "Failed / needs reconciliation" page and recipient-based list filter are ES.20.
- Signer emails are shown to any reader the record ACL admits; there is no field-level rule for them
  beyond the request ACL in this release.
