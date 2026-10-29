# Phase 22.17 — Security and Privacy Regression Suite

> **Date:** 2026-10-29
> **Plan:** `PLAN_Phase_22_Integration_E2E_Hardening.md` §16
> **Status:** Started — phase report landed; the risk-based security test matrix is being derived from the threat
> areas and the security tests already written in the sub-phases (auth, ACL, provider contracts, redaction).

---

## 1. Objective

Turn the highest-risk security invariants into automated tests, guided by the current OWASP ASVS/API security
guidance and the project's threat model.

## 2. Threat areas (plan §16)

- Broken object-level authorization (BOLA/IDOR).
- Broken function-level authorization.
- Field-level permission bypass.
- Cross-team/cross-account/cross-portal-user data leakage.
- Insecure direct object access to attachments, recordings, transcripts, signed documents, message media, export
  files, and audit history.
- Injection through filters, sort keys, dynamic field names, templates, custom formulas, webhook payloads, and
  external identifiers.
- SSRF through integration URLs, webhooks, media URLs, import URLs, OAuth callbacks, or user-specified endpoints.
- Cross-site scripting in CRM fields, chat transcripts, email/WhatsApp content, rendered templates, and rich text.
- CSRF/session handling issues where relevant to the authentication model.
- Unsafe redirect and OAuth callback validation.
- Replay attacks and unsigned/invalid provider events.
- Prompt injection and tool misuse in AIAgents/CRMChat.
- Secret exposure in logs, traces, errors, browser state, and provider diagnostics.
- Rate-limit bypass, brute force, resource exhaustion, and unbounded bulk operations.
- Unsubscribe/consent bypass and external communication without policy validation.
- Race conditions that violate authorization or one-time action semantics.

## 3. Tasks (plan §16, 12 items)

1. Build a risk-based test matrix rather than relying only on a generic security checklist.
2. For each key entity, test access as owner, team member, unrelated user, administrator, API user, portal user, and
   unauthenticated caller as applicable.
3. Test attachment/media downloads independently from the parent record endpoint.
4. Test bulk API, exports, reports, search/autocomplete, related-record selectors, and async jobs for the same
   authorization constraints.
5. Test malformed and malicious query filters without executing arbitrary SQL.
6. Test HTML/script payload rendering as text or sanitized content as appropriate; ensure no executable untrusted
   content reaches privileged contexts.
7. Test OAuth `state`, redirect URI validation, token refresh/revocation, and least-privilege scopes where adapters
   support OAuth.
8. Test provider webhook signatures with valid, invalid, stale, duplicated, and malformed payloads.
9. Verify secrets and personal data are redacted in logs by automated assertions against representative failure cases.
10. Verify CRMChat/AIAgents outputs cannot change tool schemas, bypass approvals, or access records outside ACL.
11. Verify user-facing errors do not disclose whether a protected record exists where project policy requires
    non-disclosure.
12. Link failures to the relevant OWASP requirement/category and add a regression test for each fixed defect.

## 4. Acceptance criteria (plan §16)

- No known critical/high authorization or injection issue introduced by this workstream remains open without a
  documented exception and mitigation.
- Security tests cover the critical entity/API/provider paths, not only login.
- Any exception is recorded with an owner, scope, mitigation, and review date.

## 5. Status

- **Task 1 — risk-based test matrix: done** (see §7).
- **Task 2 — regression tests: started.** Phase doc + risk matrix landed; the first regression-test batch is next.
- **Next:** task 2 — author regression tests for the matrix rows that are not yet covered.

## 6. Known limitations

- None yet — no security regression test has been authored in this sub-phase.

## 7. Risk-based test matrix (task 1 — done)

Threat areas mapped to the security/regression coverage already landed in 22.4–22.16, plus the open gaps.

| # | Threat area | Existing coverage (sub-phase) | Matrix action for 22.17 |
|---|---|---|---|
| 1 | BOLA / IDOR | `auth.test.ts`, `acl-matrix.test.ts`, `phase22-journey-*` | Regression-test critical entities (Account, Lead, Case, Contact) as owner / team / unrelated / admin / portal / unauthenticated. Open: G37 (Case `own` create), G65 (home client-side content choice). |
| 2 | Broken function-level authorization | G11 (dead-letter replay), G43 (connector writes), G35 (MCP approval) — fixed 22.13/22.14 | Re-run the capability-gate regression suites; add the AIAgents write doors that do not route through the approval decision. |
| 3 | Field-level permission bypass | G64 (raw `error.message` catch sites), ACL matrix | Regression: field-level refusal surfaced as a field error, not a leak. |
| 4 | Cross-team / cross-account / cross-portal leakage | G31 (campaign reports), G34 (help corpus), G39 (turn sources) | Regression: cross-team chat/CRM reads refused; turn `sources` re-authorized (G39 open). |
| 5 | Insecure direct object access (IDoA) | — | New: attachments, media, exports, audit history downloaded independently from the parent record endpoint. |
| 6 | Injection / XSS | — | New: malicious filters, sort keys, dynamic field names, templates, formulas, webhook payloads without arbitrary SQL; HTML/script rendered as text or sanitized. |
| 7 | SSRF | G47/G48/G49 (integrations) open | New: integration URL, webhook, media, import, OAuth callback endpoints validated before fetch. |
| 8 | CSRF / session | auth tests | Regression: session rotation, CSRF posture where the auth model requires it. |
| 9 | Replay / unsigned / malformed provider events | phase22-replay-contract, phase22-provider-contract | Covered; regression re-run on each provider contract change. |
| 10 | Prompt injection / tool misuse | G35 fixed via phase22-journey-ai-controlled-actions, `crm-chat-security.test.ts` | Regression: tool schemas immutable, approvals still gate writes, ACL re-checked per tool. |
| 11 | Secret exposure in logs/errors | G54 fixed (`error-payload-hygiene`) | Covered; regression on new failure paths. |
| 12 | Rate-limit / brute force / resource exhaustion | `rate-limit.test.ts` | Covered; regression on new auth/bulk paths. |
| 13 | Unsubscribe / consent bypass | G24/G31 fixed, phase22-journey-marketing-consent-attribution | Covered; regression on consent policy gaps. |
| 14 | Race conditions / authorization | phase22-out-of-order-events, transaction audit | Regression: concurrent duplicate actions respecting one-time semantics. |

## 8. Acceptance criteria (plan §16) — status

- [~] **No known critical/high authorization or injection issue introduced by this workstream remains open without a
  documented exception and mitigation.** Partially closed by 22.13–22.14 fixes; the matrix tracks what is still open.
- [~] **Security tests cover the critical entity/API/provider paths, not only login.** In progress: matrix now extends
  coverage to chat, integrations, media, consent.
- [ ] **Any exception is recorded with an owner, scope, mitigation, and review date.** Pending exceptions from open
  findings (G38, G39, G47–G49, …) to be dispositioned as part of this phase.
