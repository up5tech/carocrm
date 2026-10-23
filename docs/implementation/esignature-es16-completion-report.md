# Phase 19-ES.16 — Reminders, Resend, Void and Correction

> `PLAN_Phase_19_ESignature.md` §4.3, §16, §18 `Phase 19-ES.16`.
> Acceptance: unsupported or terminal-state actions fail clearly and do not call the provider;
> void/correction actions are audited with actor and reason; completion cannot be reversed by a local
> status edit.
>
> Prerequisites read: `esignature-es10-completion-report.md` (send state and the deliberate-action rule),
> `esignature-es12-completion-report.md` (provider-owned terminal states).

ES.16 closes the post-send action set. The rule is the same for every action: the capability, the state,
the module policy and the provider capability are checked **before** the adapter is reached; an action
that cannot apply is a named refusal with no provider call.

---

## 1. Files

| File | What it owns |
| --- | --- |
| `providers/signature-provider.port.ts` | `resendNotifications` and `voidEnvelope` become first-class operations; correction stays a declared-but-unsupported operation. |
| `providers/docusign/docusign-adapter.ts` | Resend: `PUT /envelopes/{id}/recipients` with `resend_envelope`. Void: `PUT /envelopes/{id}` with `status: voided` and `voidedReason`. Correction: not implemented; `correctEnvelope` remains `false`. |
| `providers/fake-signature-provider.adapter.ts` | A reminder is recorded and answered for an open envelope; a void closes it and cancels unfinished recipients; both refuse a closed envelope. |
| `esignature-settings.service.ts` | `signing.resendCooldownMinutes` (0–1440, default 5) beside `remindersEnabled`. |
| `esignature-request.service.ts` | `resendNotification`, `voidRequest`, `correctRequest`: permission, state, policy/cooldown, adapter call, audit. |
| `esignature-request.controller.ts` | `POST /:id/resend-notification`, `/:id/void`, `/:id/correct`. |
| `pages/esignature/ESignatureRequestsPanel.tsx` | Remind / Void (reason modal) / disabled Correct actions for the states and rights that allow them. |
| `i18n/{en,vi}/errors.json` | `SIGNATURE_ACTION_NOT_AVAILABLE`, `SIGNATURE_RESEND_RATE_LIMITED`. |

**No migration.** The cooldown is settings policy; the audit trail already dates each action.

---

## 2. How each acceptance criterion is held

**Unsupported or terminal actions fail before the provider.** Resend requires `send`, an open envelope
and `remindersEnabled`; void requires the `void` right and one of `sent`/`delivered`/`partially_signed`;
correction requires the `correct` right and an open envelope. A completed, declined, voided or expired
request is refused with `SIGNATURE_REQUEST_INVALID_STATE`. Correction then asks the bound adapter: with
`correctEnvelope: false` it raises `NOT_SUPPORTED_BY_PROVIDER` without a provider call, after writing a
refused audit row. The test counts provider calls around every refusal.

**Actor and reason are audited.** A void writes `void.requested` with the reason before the call and
`void.completed` with the reason and provider status after it; a refused provider void writes
`void.completed` with outcome `refused` and a safe category. Correction writes `correct.requested` with
the reason and `provider_not_supported`. The actor comes from the request scope, never from the body.

**Completion cannot be reversed locally.** There is no route or repository verb that edits a status:
the state machine owns every move, and a completed request is not in the void/correct command's accepted
states. Reconciliation is the only guarded exit, and it must be an explicit provider-backed command.

**Reminders respect a rate policy.** Only a successful `reminder.sent` audit row starts the window; a
refused attempt does not. A second request inside `resendCooldownMinutes` is answered `429`
`SIGNATURE_RESEND_RATE_LIMITED` with the remaining seconds and makes no provider call. The same command
may name one recipient (the provider is asked to remind that signer) or omit it (the provider's
resend-envelope action).

---

## 3. Decisions taken here

- **The reminder window is read from the audit trail**, not a new column: the successful action is
  already dated and attributable, and a refused attempt cannot silently extend the window.
- **Correction is refused, not stubbed.** The service structure for the exception path exists (state
  check, right, audit); the adapter capability is the switch, and ES.22 is where the live behaviour is
  verified before it can be opened.
- **Void is provider-authoritative.** The local row moves to `voided` only after the provider accepts;
  a failed void leaves the request where it was and records the refusal.
- **Resend does not change local state.** It is a nudge on an already-sent envelope; only a provider
  event changes the projection.

---

## 4. Verification

Run for the combined ES.11–ES.16 delivery:

- `npx vitest run apps/api/test/esignature-*.test.ts` — **14 files, 254 tests, all passing** (the ES.1–ES.10
  suite plus the new mapper, lifecycle and DocuSign wire tests).
- `npx tsc --noEmit -p tsconfig.json` and `npx tsc --noEmit -p apps/web/tsconfig.json` — clean.
- ESLint over every touched API, worker, web and test file with `--max-warnings=0` — clean.
- `pnpm --filter @carocrm/web build` — succeeds (only the pre-existing chunk-size warning).
- Browser pass against the dev stack: the list's signer progress, the detail's recipient status/mode,
  action card and activity timeline render; no console errors. Fixture rows and settings were removed.

Phase-specific tests: `esignature-lifecycle.test.ts` covers the reminder success + cooldown refusal
(`429`, no second call), void confirmation/reason/success/terminal refusal, correction refusal with an
audit row, terminal-state protections, and every provider-call count.

## 5. Still open

- The demo-account behaviour of resend/void and correction is ES.22; correction stays closed until then.
- The reminder policy is installation-wide; per-recipient windows are not modelled.
- No scheduled reminder job exists; reminders are deliberate user actions only.
