# Advanced Integrations — acceptance evidence

> Phase 19-INT.27 deliverable (`PLAN_Phase_19_Advanced_Integrations.md` §19 `19-INT.27`).
> This document records **what was actually run**, what it proved, and what it did **not** prove.
> Compatibility: `docs/compatibility/advanced-integrations.md` · `providers.md`.
> Runbook: `docs/runbooks/advanced-integrations.md`.
> Threat model: `docs/security/advanced-integrations-threat-model.md`.

## 1. The checks that were run

| Check | Command | Result |
| --- | --- | --- |
| Type check (root) | `npx tsc --noEmit -p tsconfig.json` | **pass** — no diagnostics |
| Type check (SPA) | `npx tsc --noEmit -p apps/web/tsconfig.json` | **pass** — no diagnostics |
| Lint (the module and everything it touched) | `npx eslint apps/api/src/advanced-integrations … --max-warnings=0` | **pass** — zero warnings |
| Unit and integration tests | `npx vitest run` | **pass** — **138 files, 1876 tests** |
| Adapter conformance | `assertConnectorContract` over the nine delivered connectors, inside `apps/api/test/advanced-integrations-connectors.test.ts` | **pass** — 9/9, and a deliberately broken connector is refused |
| Migration compatibility | the migrations were applied to the **configured** database and the schema was read back | **pass** — see §3 |
| Browser (Playwright) | `npx playwright test e2e/advanced-integrations.spec.ts` | **not run in this pass** — see §5 |

**The full-repository lint has five pre-existing errors** in files this work did not touch
(`apps/api/src/setup-checklist/index.ts`, `apps/web/src/admin/AdminSettingsShell.tsx`,
`apps/web/src/pages/DashboardsPage.tsx`, `apps/web/src/pages/EntityListPage.tsx`). They are
recorded here rather than fixed, because fixing them would be an unrelated change.

## 2. The evidence per phase

### 19-INT.25 — the cross-module integration contracts

| Acceptance criterion | Evidence |
| --- | --- |
| Explicit contracts with `Sales`, `Projects`, `CustomerSuccess`, `ServiceDesk`, `MarketingAutomation` and `VoiceCommunications`. | Nine contracts across six modules, each naming its owner, its version and **what it owns** (`contracts/*.ts`). |
| Integration events are published only through approved contracts/outbox. | `integration-events.ts`: the event types are an allowlist, an unknown type is refused, and the event is written to the platform's transactional outbox. The **contract** path publishes inside the owner's transaction; the **sync** path publishes after the write, because the sync engine's write path is not one transaction — so a lost *advisory* event is possible, and the record and the run remain the truth. |
| Each module keeps ownership of consent, communication delivery, financial transitions and customer workflows. | The contracts are **read or write through the owner's own service** — `PaymentService.ingestProviderEvent`, `MarketingSuppressionService.add`, `MarketingConsentService.record`, `CaseLifecycleService.run`, `ProjectTaskService.create`, `CustomerSuccessProfileService.ensureForAccount`, `VoiceConsentService.suppress`. No connector writes a domain table. |
| Cross-module tests for ACL propagation and event-loop prevention. | `apps/api/test/advanced-integrations-contracts.test.ts`: a contract call runs under the platform's ACL (the owner refuses when the caller may not read), a contract that nobody published is absent rather than a silent success, and a contract's affected records are recorded as the origin so the outbound path skips them. |
| An imported payload cannot become an authorization. | The protected-field policy: a mapping that targets a protected field **cannot be activated** without a recorded review, and an unreviewed protected value is **dropped** rather than written. Both proved by test. |
| The integrations remain optional and isolated; disabling a dependent module does not crash the core CRM or an unrelated provider. | Every contract adapter injects its domain service with `@Optional()` and registers **only** when the service is present. `GET /api/v1/AdvancedIntegrations/action/contracts` lists the published contracts and names the unavailable ones. |

**The `AIAgents` module is deliberately not wired.** The plan asks for the AI runtime to be
"optional protected assistive use only". A connector-driven tool that lets an agent call a
third-party provider is a path that turns a model output into an outbound request, and the
transformation compiler is an allowlist by design. The honest answer is a documented refusal, not
a partial integration — see the threat model §4.

### 19-INT.26 — observability, security hardening and retention

| Acceptance criterion | Evidence |
| --- | --- |
| Metrics. | `GET /api/v1/AdvancedIntegrations/action/metrics` returns the plan's §16.1 list: connections by provider and status, runs by outcome with duration and backlog, records by outcome, provider errors by code, webhook verdicts with processing latency, the circuit state, the cursor age, the reauthorization backlog, the dead-letter count and the enrichment counts. |
| No high-cardinality labels. | The document carries a provider key, a status, an error code or a state — never a record id, a token or a URL. The circuit breaker is reported **per provider**, not per connection, because its key holds a connection id. Proved by test. |
| Structured logs, correlation ids and redaction. | `correlation_id` on a run, an operation and a webhook receipt; the audit trail's detail is passed through `redactSecrets`; the HTTP client logs no header, body or query string. |
| Health state and alert thresholds. | The connection detail reports the thresholds of the module settings: a **streak** of failed runs, a sync lag beyond the configured window, and a count of rejected webhook deliveries. |
| A controlled debug mode with expiry, explicit authorization and additional redaction. | `settings.debug` — off by default, with an expiry that the health report warns about when it is missing. The mode exposes only the **field names** and the size of a payload, and it needs the `diagnostics` capability. |
| Retention jobs for sync logs, raw payload references, conflicts and dead letters. | `integration-retention.service.ts` and the daily `advancedIntegrations.purgeRetention` schedule. The policy is **off by default**, and the purge removes by primary key, in a bounded batch, with a predicate about age and terminal state. |
| A threat model review. | `docs/security/advanced-integrations-threat-model.md`: the trust boundaries, the control for each, the plan's eight scenarios, and the known gaps. |
| All administrative actions are audited and permission-checked. | `integration_audit.service.ts` with an allowlisted action vocabulary, called from the connection lifecycle, the mapping service, the conflict service, the dead-letter service and the enrichment service. Every route checks a capability. |
| Operational failures are diagnosable without exposing secrets or unnecessary personal data. | The metrics, the trail and the runbook. The runbook names the symptom, the cause, the safe action and the recovery for **thirteen** situations. |

### 19-INT.27 — release readiness

| Acceptance criterion | Evidence |
| --- | --- |
| Type checks, lint, unit tests, adapter contracts, safe DB integration tests and API tests. | §1. The database tests run against the **configured** primary database; no extra database was created, and every row a test created is deleted **by id**. |
| Migration compatibility against the existing database, without resetting it. | §3. |
| Provider setup docs, the credentials/secrets runbook, supported API versions, limitations, incident response and rollback/disable plans. | `docs/compatibility/advanced-integrations/providers.md` (per provider), `docs/compatibility/advanced-integrations/oauth-scopes.md` (scopes and client ids), `docs/compatibility/advanced-integrations/sync-semantics.md` (pinned API versions and cursor facts), `docs/runbooks/advanced-integrations.md` (§10 credentials, §11 retention and incident response, §12 rollback and disable). |
| Feature flags and provider enablement defaults are safe. | §4. |
| Acceptance evidence and known gaps per provider. | §2.3 and §5. |

## 3. The migration check

The migrations were applied to the **configured** database — the one in `.env` — and never to a
second one. The check reads the schema back and confirms the business data is intact:

```
recent migrations: 060_phase19_advanced_integrations_observability.sql,
                    059_phase19_advanced_integrations_enrichment.sql,
                    058_phase19_advanced_integrations_webhook_key.sql,
                    057_phase19_advanced_integrations_engine.sql
integration tables: 19
new columns: integration_audit_log.correlation_id,
              integration_field_mappings.allow_protected,
              integration_sync_operations.correlation_id,
              integration_sync_runs.correlation_id,
              integration_webhook_deliveries.correlation_id
live Contact records: 88 | live Account records: 78
```

Both migrations are **additive**: `059` creates two tables, `060` creates one table and adds four
columns. No table, column or row was dropped, renamed or rewritten, and no seed row was inserted
beyond the one scheduled job. A rollback of the code leaves the schema compatible, because the old
code simply ignores the new columns.

## 4. The defaults are safe

| Default | Value | Why it is safe |
| --- | --- | --- |
| Every provider | `available`, **not connected** | A registered connector is *available*. A connection must be created, authorized and mapped before anything is called. |
| The fake provider | Registered **only outside production**, and marked `deprecated`. | A live deployment must not be able to select a provider that fabricates answers. |
| The OAuth flow | **Off** | A deployment registers an OAuth connector and turns it on. |
| The expiry notices | **Off** | They need the scheduled job. |
| The retention purge | **Off** | A deployment decides, deliberately, that a diagnostic row may be discarded. |
| The debug mode | **Off**, and it expires | A debug mode nobody switches off is a debug mode that stays on. |
| The generic REST connector | **Read-only** | No arbitrary outbound request is possible. |
| The Stripe, Meta, Shopify, QuickBooks and accounting connectors | **Read-only** | No charge, no lead, no order, no invoice is ever created at a provider. |
| The Zoom recorder | **Not implemented** | A recording needs a separate privacy and retention decision. |
| The QuickBooks environment | **Sandbox** | A half-configured installation cannot post to a production ledger. |
| The enrichment provider | **Disabled by default** | A profile is opt-in, per field, with a human decision. |
| A new role | **None** | `sysAdmin` holds the platform wildcard; the default user role holds nothing. The module creates no role. |
| The contract adapters | **Optional** | A module that is not installed publishes no contract, and the caller degrades instead of crashing. |

## 5. The known gaps

These are the honest limits of this delivery. None of them is hidden in a code comment.

| Gap | What it means for a deployment |
| --- | --- |
| **No connector was verified against a live vendor account.** | Every provider-side fact is the implementation's own pin. Confirm the endpoint, the scope names and the signature algorithm against the vendor's current documentation before enabling a connector in production. |
| **The Playwright spec was not run in this pass.** | The spec was updated for the populated catalog, but the browser run is a separate, heavier check. Run `npx playwright test e2e/advanced-integrations.spec.ts` before a release. |
| The platform has **no metrics facility**. | The metrics here are derived from the module's own tables. A real telemetry stack would replace them; the document's shape would survive the move. |
| The provider **cost and quota** figures are not reported. | No delivered provider publishes a reliable figure, and the plan says to report it only where the vendor does. |
| **Mailchimp's webhook primitive is MD5.** | The vendor's algorithm. The platform compensates, but a deployment with a strict crypto policy should not enable that connector. |
| The **AI-assisted configuration helper** does not exist. | Deliberate. See the threat model §4. |
| The **cross-module contracts** cover six modules, not every module. | `Projects`, `CustomerSuccess`, `ServiceDesk` and `VoiceCommunications` have one contract each; `AIAgents` has none, deliberately. A connector that needs a behaviour no contract publishes must not implement it itself. |
| The **outbound generic REST** path does not exist. | A connector that writes to a vetted endpoint needs a reviewed decision about which data may leave the CRM. |
| The provider **contract suites** are the platform's own, not the vendors'. | The suite proves the adapter honours the *platform's* contract. It cannot prove the vendor has not changed its API. |

## 6. What a reviewer should do next

1. Read `docs/compatibility/advanced-integrations/providers.md` and confirm each pin against the
   vendor's current documentation. That is the step this delivery could not take.
2. Configure one connector end to end — the **generic REST** connector is the cheapest, because it
   needs no vendor account: create a connection with an allowlisted endpoint, publish a mapping,
   run a sync, inspect the run, then pause the connection and confirm that the provider is no longer
   called.
3. Read the runbook's §10 and rotate a secret, then read `GET /api/v1/AdvancedIntegrations/action/audit`
   and confirm the trail shows the rotation and no value.
4. Read the threat model and decide which of the known gaps your organisation accepts.
