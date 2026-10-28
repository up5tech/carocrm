# Phase 22.6 — Domain Contract Tests

> **Date:** 2026-10-28
> **Plan:** `PLAN_Phase_22_Integration_E2E_Hardening.md` §11 (tasks 1–10) and its acceptance criteria
> **Depends on:** `docs/architecture/contract-catalog.md` (22.3), `docs/architecture/module-contracts.md` (22.2), `docs/quality/phase-22-transaction-migration-audit.md` (22.5)
> **Status:** Implemented. 48 new automated assertions across 5 files; 2 product defects fixed; no new database, no destructive command, no external effect.

---

## 1. What this sub-phase did

Phase 22.6 asks for **contract tests**: exercises of each module's *public* integration boundary, with only the external boundaries substituted. The audit of 22.0–22.5 showed three concrete holes, and this sub-phase closes them:

1. **No shared conformance suite for signature providers.** The connector family had one (`advanced-integrations/connector-contract.ts`); the signature family had only a *minimum* check (`assertAdapterContract`) that verified a declared capability had a method. "What is a correct signature provider?" was therefore one thing per vendor.
2. **No fake could produce a provider failure.** Both fakes only failed for reasons the provider itself caused (an unknown template, a missing object). The failures a provider causes *by accident* — a timeout, a rate-limit answer, an expired credential — were untestable, so the platform's answers to them were asserted only by construction, never by test.
3. **The outbox promise had no regression test.** 22.5 verified that events are written inside the caller's transaction by reading the code, and explicitly recommended locking it in with a test. Nothing did.

Additionally, the **contract catalog was not complete**: two contracts that the voice adapter publishes (`voiceCommunications.inbox.read`, `voiceCommunications.message.send`) were missing from the platform's known-key list, so the diagnostics could not account for them.

---

## 2. The contract-test matrix (plan task 1)

Every producer/consumer pair from the 22.0 inventory that has a public boundary. "Covered by" names the file that proves it; "Existing" names a suite that already proved it, so nothing was duplicated.

| # | Producer → consumer | Boundary exercised | Covered by |
|---|---|---|---|
| C1 | Signature provider → ESignature domain | `SignatureProviderAdapter` conformance (fake, DocuSign, Dropbox Sign) | `apps/api/test/phase22-provider-contract.test.ts` |
| C2 | Signature provider → ESignature domain | Provider failure taxonomy (timeout / rate limit / auth expiry / validation) | `apps/api/test/phase22-provider-contract.test.ts` |
| C3 | Signature provider → ESignature domain | Scripted failures raised by the fake adapter | `apps/api/test/phase22-provider-contract.test.ts` |
| C4 | Connector provider → AdvancedIntegrations | `ConnectorAdapter` conformance + scripted failures | `apps/api/test/phase22-provider-contract.test.ts` (existing: `advanced-integrations-connectors.test.ts`) |
| C5 | Domain module → `IntegrationContractRegistry` | Published matrix: owner, version, ownership | `apps/api/test/phase22-integration-contract.test.ts` |
| C6 | Domain module → `IntegrationContractRegistry` | A contract nobody published is a refusal (`null`), not a silent success | `apps/api/test/phase22-integration-contract.test.ts` |
| C7 | Provider → AdvancedIntegrations → **Sales** | `sales.payment.providerEvent` end-to-end (delivery → bridge → contract → payment service) | `apps/api/test/phase22-payment-provider-contract.test.ts` |
| C8 | Provider → AdvancedIntegrations → **Sales** | Redelivery is idempotent on the provider's event id | `apps/api/test/phase22-payment-provider-contract.test.ts` |
| C9 | Provider → AdvancedIntegrations → **Sales** | A terminal payment state is never left | `apps/api/test/phase22-payment-provider-contract.test.ts` |
| C10 | Provider → AdvancedIntegrations → **Sales** | Card data and a missing provider event id are refused | `apps/api/test/phase22-payment-provider-contract.test.ts` |
| C11 | Provider → AdvancedIntegrations → **Sales** | A failed delivery changes nothing | `apps/api/test/phase22-payment-provider-contract.test.ts` |
| C12 | AdvancedIntegrations → CRM records | External-id mapping: link, upsert, resolve, unlink | `apps/api/test/phase22-integration-contract.test.ts` |
| C13 | AdvancedIntegrations → CRM records | Duplicate detection returns candidates and never merges | `apps/api/test/phase22-integration-contract.test.ts` |
| C14 | AdvancedIntegrations → CRM records | Field-mapping validation and the protected-field refusal | `apps/api/test/phase22-integration-contract.test.ts` |
| C15 | Any record mutation → outbox → worker | The event is written in the caller's transaction | `apps/api/test/phase22-event-contract.test.ts` |
| C16 | Any record mutation → outbox → worker | A rolled-back transaction leaves no event | `apps/api/test/phase22-event-contract.test.ts` |
| C17 | Any record mutation → outbox → worker | The committed event carries the committed state | `apps/api/test/phase22-event-contract.test.ts` |
| C18 | Outbox → worker consumer | Unknown optional fields and unknown event types are tolerated | `apps/worker/src/events/domain-event-bus.contract.test.ts` |
| C19 | LeadScore → CRM records | Lead conversion creates/links without duplicating | Existing: `apps/api/test/lead-score-conversion.test.ts` (route level), `lead-score-duplicates.test.ts` |
| C20 | Sales → ESignature | Quote-to-signature contract with fake providers | Existing: `apps/api/test/sales-quote-document.test.ts`, `esignature-flow.test.ts`, `esignature-send.test.ts` |

**Deliberately not duplicated.** C19 and C20 are already proven at their public boundaries (HTTP route and provider port respectively). Phase 22.6 added a *service-level* test for neither, because the plan asks for coverage of the critical edges, not a second copy of the same assertion.

---

## 3. What was added to the product (not only tests)

| File | Change | Why |
|---|---|---|
| `apps/api/src/esignature/providers/signature-provider.contract.ts` | **New.** `runSignatureProviderContract()` / `assertSignatureProviderContract()` — nine rules, each with a stable `check` name, mirroring the connector suite | Plan task 7 asks for a *shared* provider contract suite; the signature family had none |
| `apps/api/src/esignature/providers/signature-provider.registry.ts` | The registry now runs the full suite at registration | A suite nothing calls is documentation, not a contract |
| `apps/api/src/esignature/providers/fake-signature-provider.adapter.ts` | `failNextCall(operation, error)` | Plan acceptance: "fake providers simulate … timeout, rate-limit response, authentication expiry" |
| `apps/api/src/advanced-integrations/connectors/fake/fake-provider.adapter.ts` | `failNextCall(operation, error)` | Same acceptance criterion for the connector family |
| `apps/api/src/advanced-integrations/integration-contracts.ts` | **Fix.** `voiceCommunications.inbox.read` and `voiceCommunications.message.send` added to `INTEGRATION_CONTRACT_KEYS` | Two published contracts were not known to the platform (Finding F1 below) |
| `apps/api/test/support/fake-payment-provider.ts` | **New.** A provider delivery double that can fail | The payment boundary is the provider's *event*, not a gateway object |

### The conformance rules (signature provider)

`providerKey` (a stable lowercase key) · `adapterVersion` · `providerApiVersion` · `mode` · `envelopeDrafting` · a capability declaration that **answers for every known operation** (an unanswered operation reads as "not supported", which hides a mistake behind a refusal) · a declared operation **has** its method · `verifyWebhook` implies `verifyAndParseWebhook` · a **direct** sender declares `sendNewEnvelope` (otherwise the send is refused at the last moment) · a **draft** provider declares `sendEnvelope` (otherwise a prepared draft could never be sent).

---

## 4. Defects found and fixed

| # | Defect | Severity | Fix | Regression test |
|---|---|---|---|---|
| F1 | Two contracts published by the voice adapter (`voiceCommunications.inbox.read`, `voiceCommunications.message.send`) were missing from `INTEGRATION_CONTRACT_KEYS`, so `knownKeys()` under-reported what the platform could account for | Medium | Constant widened | `phase22-integration-contract.test.ts` → "knows every contract key a module publishes" |
| F2 | The signature provider family had no conformance suite; a broken adapter would only be discovered at the first send | Medium | Suite added and wired into the registry | `phase22-provider-contract.test.ts` → "is honoured by every adapter this build ships" / "refuses a broken adapter at registration" |
| F3 | Neither fake could produce a provider failure, so the timeout / rate-limit / auth-expiry answers were unprovable | Medium | `failNextCall` on both fakes | `phase22-provider-contract.test.ts` → "the provider failure matrix" |
| F4 | The architecture guard (`scripts/check-architecture-boundaries.mjs`, Phase 22.2) referenced `rel` outside the block that declares it, so the guard would throw a `ReferenceError` instead of reporting a violation — and it kept the repo's lint gate red | Medium | `rel` computed once at the top of `checkFile` | `pnpm lint` + `pnpm lint:arch` |

No behavioural change to any existing flow was introduced by F1–F3: the fixes are a constant, a registration check, and test-only fakes. F4 is a guard script, not product code.

---

## 5. Evidence — commands actually run

| Command | Result |
|---|---|
| `npx vitest run apps/api/test/phase22-provider-contract.test.ts` | **15 passed** |
| `npx vitest run apps/api/test/phase22-integration-contract.test.ts` | **16 passed** |
| `npx vitest run apps/api/test/phase22-event-contract.test.ts` | **4 passed** |
| `npx vitest run apps/api/test/phase22-payment-provider-contract.test.ts` | **8 passed** |
| `npx vitest run` (the four new files together) | **43 passed** |
| `pnpm --filter @carocrm/worker test` | **215 passed** (21 files, including the new `domain-event-bus.contract.test.ts` with 5 tests) |
| Regression sweep of the affected suites (`esignature-provider`, `esignature-docusign`, `esignature-dropbox-sign`, `esignature-flow`, `esignature-send`, `advanced-integrations-contracts`, `advanced-integrations-engine`, `advanced-integrations-connectors`, `sales-payments`) | **193 passed**, 0 failed |
| `pnpm lint:changed` | 0 errors, 0 warnings (11 changed files) |
| `pnpm lint` | clean — after fixing F4, a pre-existing error in the Phase 22.2 architecture guard |
| `pnpm lint:arch` | `OK: no new shared-core -> business-domain imports (known exceptions=2)` |
| `pnpm typecheck` | clean |
| `npx tsc --noEmit -p apps/api/tsconfig.json` | clean (this project also type-checks the test folder, which the root config excludes) |
| `pnpm verify` | **green** — `lint` exit 0, `typecheck` exit 0, `test` 235 files / 3183 tests passed, `test:web` 5 files / 21 tests passed |

**Database discipline.** Every suite runs against the configured primary database (`AGENTS.md` §3.1). No database, schema or container was created; nothing was truncated or dropped. Each run's rows are deleted by exact id in `afterAll`, and the outbox rows the runs published are deleted with the same run marker. A post-run query confirmed zero leftovers for this sub-phase's tables and event types.

**External effects.** None. Mail is `memory`, jobs go to the scratch queue `crm-jobs-test`, and every provider is a fake. No message, call, signature request, charge or webhook left the machine.

---

## 6. Known limitations of this sub-phase

1. **The worker suite is not part of the root `pnpm verify`.** The worker keeps its own Vitest config (`apps/worker/vitest.config.ts`); the root config collects `apps/api/test` and `packages/*/src` only. The new consumer-contract test therefore runs with `pnpm --filter @carocrm/worker test`. Wiring the worker into the root gate belongs to 22.22 (CI quality gates) and was not done here.
2. **The LeadScore conversion contract was not re-tested at the service level.** Its route-level coverage is strong (`lead-score-conversion.test.ts`), so a second copy would have added no evidence. The **service-level** API (`LeadConversionService.convert` / `operationByKey`) still has no direct test; that is recorded in `docs/quality/known-gaps.md` (G3).
3. **The ESignature ⇄ Sales contract is covered per module, not as one journey.** The quote-to-signature chain is proven by the Sales suite and the ESignature suite separately; the end-to-end chain is 22.9's job.
4. **A pre-existing suite leaves two records behind.** `advanced-integrations-contracts.test.ts` creates two contacts (`Protected Target`, `Record`) that its cleanup does not remove. They are not this sub-phase's rows and were left untouched, as `AGENTS.md` §3.3 requires; the gap is recorded in `docs/quality/known-gaps.md` (G4).
5. **The conformance suites are per family.** Signature providers and connectors are two different port families with two different key conventions (`dropbox_sign` uses an underscore, connector keys are hyphen-only). A third family would need its own rules rather than a merged one.

---

## 7. Acceptance criteria (plan §11)

- [x] **Contract tests cover every critical cross-module edge and are deterministic.** The matrix in §2 covers C1–C18 with new tests; C19–C20 were already proven at their public boundaries and are cited, not duplicated. Every new test is deterministic: no clock, no randomness, no network, no external provider.
- [x] **Fake providers simulate success, validation failures, timeout, rate-limit response, authentication expiry, and retry-safe event delivery.** Success and validation failures were already simulable; `failNextCall` added timeout / rate-limit / auth-expiry to both fakes, and the retry-safe delivery is proven by the redelivery test (C8) and by the fake's idempotency on the provider's event id.
- [x] Tests are at the public service / API / event boundary; no private method names or query-builder details are asserted.
- [x] Permission checks and error envelopes are exercised at the boundary (the contract refuses with the platform's own errors, and the provider failures keep their stable codes: `TIMEOUT`, `RATE_LIMITED`, `TOKEN_EXPIRED`).
- [x] Domain event payloads reflect committed state and are not emitted by a transaction that rolled back (C15–C17).
- [x] Consumer behaviour for unknown optional fields and event versions is verified (C18).
- [x] Provider adapter conformance uses a shared suite that all adapters of that family pass (C1, C4).
- [x] External-id mapping and field-mapping validation are verified (C12–C14).
- [x] The LeadScore conversion contract creates/links without duplicating records — verified by the existing suite (C19).
- [x] ESignature and Sales contracts are exercised with fake DocuSign and payment adapters (C1–C3, C7–C11).

**Not done in this sub-phase (and why):** the OpenAPI document (22.3 Finding F1) stays ungenerated, so the API contract remains the catalog plus these assertions; the `schemaVersion` envelope on event payloads (22.3 Finding F2) is a design decision that belongs to 22.7, which will assert it in the replay tests.
