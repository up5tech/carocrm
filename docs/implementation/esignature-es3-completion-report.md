# Phase 19-ES.3 — Provider adapter contract and fake adapter

> `PLAN_Phase_19_ESignature.md` §5.2, §9, §10.2, §17, §18 `Phase 19-ES.3`.
> Acceptance: an end-to-end domain workflow runs with the fake provider; no test needs production
> credentials; an unsupported capability returns an explicit safe error.
>
> Prerequisites read: `docs/implementation/esignature-audit.md` §5.1, §5.8;
> `esignature-es1-completion-report.md` (the gate and the two-layer error model this phase extends);
> `esignature-es2-completion-report.md` (the records and the state machine the flow drives).

ES.3 gives the module its provider boundary: a contract written from the domain's needs, one
in-process implementation of it for tests, and the idempotency/correlation rules that make an
ambiguous provider answer recoverable. **No DocuSign code exists yet** and no network call is
possible — the point of the phase is that the whole lifecycle can be proven before a vendor is
involved.

---

## 1. Files

| File | What it owns |
| --- | --- |
| `providers/signature-provider.port.ts` | `SignatureProviderAdapter` and every provider-neutral type: the connection status, account context, prepare/send inputs, envelope + recipient status, artifacts, the verified webhook notification. `mode: 'live' \| 'fake' \| 'disabled'`, the capability map, `adapterSupports`, `assertAdapterContract`, `redactContext`. |
| `providers/signature-provider.errors.ts` | The adapter-side taxonomy: `NotSupportedByProviderError`, `SendOutcomeUnknownError`, `classifyAdapterError`, `redactAdapterError`, and the single `toModuleError` translation into ES.1's stable API codes. Adds `unknown_outcome` **as a module category**, not as a member of the shared platform union. |
| `providers/signature-provider.idempotency.ts` | Correlation ids from the platform request context, and SHA-256 idempotency keys derived from `(purpose, connection, request, sendAttempt, envelope, discriminator)`: `prepareIdentity`, `sendIdentity`, `artifactIdentity`. |
| `providers/signature-provider.registry.ts` | `SIGNATURE_PROVIDER_ADAPTERS` token, one adapter per provider key, capability refusal before dispatch, the production guard, and `report()` for the health view. |
| `providers/signature-provider-signature.ts` | The Connect HMAC mechanism, built on the connector kit's `hmacSha256Base64` + `timingSafeEquals`: `connectSignature`, `readSignatureHeader`, `verifyConnectSignature` with a reason that separates this installation's gaps (`no_secret`) from a sender's (`signature mismatch`), `rawBodyHash`, `valueHash`. |
| `providers/fake-signature-provider.adapter.ts` | The contract implementation for tests: deterministic time and ids, idempotent prepare/send, scripted envelope and signer progression, deterministic artifacts, a lost-send-response knob, and a `calls` ledger so "the draft performed no send" is assertable. |
| `esignature-connection-gate.service.ts` | Provider capability now comes from the **bound adapter** when one exists, falling back to the declared contract while the real adapter is unwritten. |
| `esignature-module-health.service.ts` | `providerAdapters` in the health view, and a `provider-adapter` check that says which mode is bound. |
| `index.ts`, `apps/web/src/api/types.ts`, `apps/web/src/pages/ESignaturePage.tsx`, `i18n/{en,vi}/esignature.json` | The public surface, the typed health view, and the page line that names the bound adapter instead of letting a green tick imply a live integration. |
| `apps/api/test/esignature-provider.test.ts`, `apps/api/test/esignature-flow.test.ts` | 28 contract/registry/error/idempotency tests and the end-to-end slice. |

## 2. The contract, and why it is this shape

Nine operations, which is exactly the initial slice agreed in the audit: connection status, account
context, prepare, send, envelope status, recipients, signed documents, completion evidence, webhook
verification. Templates, embedded signing, reminders, void and correction have **capability flags and no
methods** — plan §5.2 forbids empty no-op methods, so an operation that cannot be performed cannot be
requested: the registry answers `NotSupportedByProviderError`, and the gate turns that into
`NOT_SUPPORTED_BY_PROVIDER`. When ES.7/ES.14/ES.16 deliver them, they add a method and flip a flag.

`assertAdapterContract` runs at registration, so an adapter that declares `sendEnvelope` without
implementing it fails at startup rather than at the first signature request. `mode` is part of the
interface for the same reason plan §9.4 requires an environment badge: a fake that answers is a fact
an operator is entitled to see.

The context object carries the bearer token and nothing else secret. `redactContext` is the only
diagnostic form of it, and a test asserts that the token appears in no result, no call record and no
redacted view.

## 3. Idempotency, and the one thing a retry must never do

Keys are **derived from intent, never generated at call time** — a random per-attempt key would make a
retry a new request, which for a send means a second invitation to a real person. The derivation is a
SHA-256 over already-validated identifiers, matching the platform's existing convention
(`advanced-integrations/outbound-sync.service.ts:330-345`, a hashed key with a unique DB column), and
preparation is keyed on the **outgoing snapshot digest**, so a changed draft is a different intent
while an unchanged one is the same.

`sendEnvelope` refuses to run without the request's `send_attempt_id`, and `sendIdentity` throws rather
than falling back to a request-scoped key: a send that cannot say which action it belongs to is a bug,
and the plan's ambiguous-send recovery depends on that pair existing.

`SendOutcomeUnknownError` is not `transient`. It carries the correlation id, the idempotency key and —
when known — the envelope id, and it has no retry semantics at all: the only legal next step is to ask
the provider what happened. That is `send_unknown` and the reconciliation path, and it is deliberately
kept out of the shared `PROVIDER_ERROR_CATEGORIES` union, whose members are wired to retry behaviour in
another module.

## 4. The fake, and what it is for

`FakeSignatureProviderAdapter` is a contract implementation with scripted state: a fixed epoch plus a
sequence counter for timestamps, ids derived from hashes of the caller's own keys, and three knobs the
plan's scenarios need —

- **idempotent preparation**: the same key returns the same envelope and its document ids;
- **`loseNextSendResponse()`**: the envelope is accepted and *then* the answer is lost, which is the
  only way to test `send_unknown` honestly (plan §17.2 scenario 6);
- **`advance()` / `recipientAction()`**: partial signing, completion and decline happen on command, so
  a multi-signer envelope cannot be marked complete early by accident.

It is registered outside production only, by `useFactory` in the module barrel — the same guard shape as
the connector registrar (`connector-registrar.service.ts:243`) and `VoiceProviderRegistry`'s fail-closed
resolution (`voice-provider.ts:650-657`). The registry additionally refuses to *register* a fake when
`NODE_ENV === 'production'`, so the double cannot arrive by configuration or import order. `hasLiveAdapter`
keeps distinguishing them, and the health check prints the mode.

The webhook half exercises the **mechanism**, not DocuSign's wire format: base64 HMAC-SHA-256 over the
raw bytes, compared with the platform's constant-time helper. ES.11 captures the real header layout and
payload from a demo account and corrects `signature-provider-signature.ts` once, for every caller —
which is why that logic lives outside the fake rather than inside it.

## 5. Verification

| Suite | Tests | What it proves |
| --- | --- | --- |
| `esignature-provider.test.ts` | 28 | The contract (operation list, refusal of an incomplete adapter, refusal of a claimed webhook method), the registry (one adapter per key, no fake in production, unsupported capability refused), idempotency keys (stable per intent, different per action, a send needs its attempt token), the fake (idempotent prepare, single effective send, lost-response semantics, unknown envelope as `unknown`, scripted multi-signer progression, deterministic artifacts, verification refusal codes with no fields leaked, unmapped event types, token never echoed, reset), the shared HMAC kit, and the error taxonomy's mappings |
| `esignature-flow.test.ts` | 3 | **The end-to-end slice**: authorized connection → draft → one signer → one PDF snapshot → immutable outgoing snapshot → prepare (idempotent) → send → envelope id recorded → `sent` only on provider evidence → verified Connect delivery → one event row (replay creates none) → recipient projection monotonic → completion by evidence only → signed document + certificate recorded as new artifacts (source hash unchanged, evidence class with no purge date, retried download stores nothing new) → audit trail → snapshot digest still verifies. Plus the lost-send scenario held at `send_unknown`, refusing a second send attempt and resolving through reconciliation with **one** envelope and **one** provider send call. |
| ES.1 + ES.2 suites, re-run | 73 | The gate now answers capabilities through the bound adapter; the health schema check and the ES.1 refusal tests are unchanged |

**Environment checks:** `pnpm typecheck` (API + tests + web) green; `eslint --max-warnings=0` green on
every touched path; `pnpm -r build` green across API, worker, web, packages and modules.

**Full suite:** 2379 tests, **2372 passed, 7 failed** across the same five files that fail without ES.3
— `docs-content` and `packages/docs/corpus` (the pre-existing `/EmailTemplate` `unknownAppRoute` from
commit `5ce375e`), and `service-desk`, `service-desk-workflow`, `service-desk-sla` (shared
development-database state and a time-of-day-dependent SLA assertion). All 104 ESignature tests pass:
20 (ES.1) + 34 (ES.2 domain) + 19 (ES.2 entities) + 28 (ES.3 contract) + 3 (ES.3 flow).

Data hygiene: every row the flow test creates carries `AGENT_TEST_<runId>` and is deleted by exact id,
children before parents. After the run all eight ESignature tables hold 0 rows, verified by query. No
test database, schema or container was created, and no credential was read, written or needed: the
fake ignores the bearer token it is handed, which is the point.

**Live check** (scratch build on ports 3033/8083, the user's own dev servers untouched, the
installation restored afterwards by deleting the `ESignature` settings row): `GET
/ESignature/action/health` reported the bound adapter as
`{ providerKey: 'docusign', mode: 'fake', adapterVersion: 'fake-1.0.0' }` with the six later
operations `false`, and its check line read *"A \"fake\" adapter is bound for \"docusign\" …
A fake adapter can never sign a real contract."* The module page rendered that in the provider card's
header (`Test adapter bound (fake-1.0.0)`), with no raw i18n keys on screen; both locale catalogs serve
the three new keys (`/api/v1/I18n?locale=en` and `?locale=vi`), and the dev SPA's cached catalog in
`localStorage` is what decides which of them a given browser session shows. All eight module tables
held 0 rows afterwards.

## 6. Decisions taken in this phase

**Capability flags exist for operations with no method.** The alternative — methods that throw
"not implemented" — would let a UI offer a void button. The refusal is in the declaration, where the
UI can see it too.

**The bound adapter is the source of truth for capabilities.** The gate prefers it and falls back to the
declared contract only while no adapter is bound, so an implementation cannot drift ahead of its own
declaration.

**`unknown_outcome` is a module category, not a platform one.** Adding it to
`PROVIDER_ERROR_CATEGORIES` would change how a shared runtime treats every connector's failures. The
domain state `send_unknown` plus `PROVIDER_OUTCOME_UNKNOWN` carry the meaning where it belongs.

**The fake's signature scheme is the mechanism, not the vendor's format.** Documenting that gap is the
honest move: `docs/compatibility/esignature.md` records the Connect fixtures as an ES.11 task, and the
verification helper is in one file so the correction is one edit.

**The page names the adapter mode.** An operator looking at a green capability list must be able to tell
that nothing here has ever reached DocuSign.

## 7. Deliberately not in this phase

- `providers/docusign/` and any dependency on `docusign-esign`: ES.4 owns the OAuth flow, the vault
  write and the real adapter; the SDK/license review stays where plan §9.3 put it (ES.21).
- The send/prepare **commands** with permissions, approval checks and audit wiring: ES.10, which also
  owns the recovery workbench for `send_unknown`. ES.3's flow test orchestrates the repositories the
  way those commands will, and nothing more.
- The Connect endpoint, the raw-body hook extension and the inbox worker job: ES.11.
- Template catalog, recipient views, reminders, void and correction: ES.7, ES.14, ES.16.
- Rate limiting and circuit breaking around these calls: the platform's `resilience.ts` is already the
  adapter's to use, and the ES.4 adapter is where the per-operation retry classes get declared.
