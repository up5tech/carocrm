# ADR 0002 — The generic connector adapter contract

* **Status:** Accepted
* **Phase:** 19-INT.1 (decided), implemented in 19-INT.6
* **Related:** `docs/modules/advanced-integrations/feature-contract.md` §5 ·
  `docs/implementation/advanced-integrations-audit.md` §1.1, §2

## Context

The repository has **two** provider-adapter precedents and they disagree:

* `apps/api/src/ai-agents/ai-provider.ts` — `AIProviderAdapter` +
  `AIProviderRegistry`. A model gateway: `listModels`, `chat`, `embed`, `complete`. It is about
  *sending prompts and receiving completions*.
* `apps/api/src/voice-communications/voice-provider.ts` — `VoiceProviderAdapter` +
  `VoiceProviderRegistry`. A telephony gateway: `initiateCall`, `sendMessage`, `verifyWebhook`,
  `normalizeWebhook`. It is about *placing a call* and *receiving a callback*.

Neither models what an integration connector needs: listing the provider's objects, reading a page
of records, writing one, and reconciling a cursor.

The plan (§5.3) sketches a `ConnectorAdapter` interface and then says: *"The actual interface must
be derived from repository conventions and the minimum requirements of the first selected
providers. Do not force unsupported operations onto every connector. Represent optional
capabilities explicitly and reject unsupported operations before dispatch."*

## Decision

1. **One contract, modelled on the two precedents.** A single `ConnectorAdapter` interface in the
   module, with the same registry shape as `AIProviderRegistry` and `VoiceProviderRegistry`:
   `register`, `resolve`, `describeAll`, and a fail-closed *disabled* adapter for an unknown key.
   The two existing registries are **not** modified and **not** merged into it — model providers
   and telephony providers are not integration connectors.
2. **Optional operations are optional.** `authorize`, `refreshCredentials`,
   `revokeCredentials`, `fetchPage`, `fetchChanges`, `upsertObject`, `deleteObject`,
   `verifyWebhook` and `normalizeWebhook` are **optional members**. An adapter that does not
   implement one does not advertise it.
3. **Capabilities are declared, not inferred.** Every adapter declares a versioned capability
   document listing, per object: read/create/update/delete/upsert/webhook support, supported sync
   directions, full vs incremental sync, required scopes, page size, rate-limit strategy, external
   identifier fields, deletion visibility, transactional-ness, and data sensitivity.
4. **Unsupported operations are refused before dispatch.** The registry resolves the operation
   against the adapter's declared capabilities *before* a call is made. A connector that cannot
   update an object is refused with a `VALIDATION_FAILED` error naming the missing capability —
   never with a "not implemented" thrown from deep inside the adapter.
5. **The registry is the authority.** Capabilities live with the adapter that implements them, so
   they cannot drift from the code. The plan's §6.1 `IntegrationDefinition` row shape is therefore
   implemented as a **code-registered definition** rather than a database row (decision **D-6** in
   the feature contract).
6. **Errors are normalized at the boundary.** A `ProviderError` carries a stable code
   (`TOKEN_EXPIRED`, `SCOPE_MISSING`, `ACCOUNT_MISMATCH`, `RATE_LIMITED`, `PROVIDER_UNAVAILABLE`,
   `CONFIGURATION_INVALID`, …), a retryability flag, and an optional retry hint. An adapter
   translates its vendor's error into this shape; nothing above the adapter sees a vendor type.
7. **Validation happens at startup.** The registry validates every registered adapter's
   declaration when the module initializes: a malformed capability document, a duplicate provider
   key, or an adapter that claims a capability it does not implement is a startup failure, not a
   runtime surprise.

## Consequences

**Positive**

* The generic REST connector and Google Workspace share one shape, so the framework is proven
  once.
* The admin UI can ask "can this connector do X?" and get a truthful answer, because the answer
  comes from the same declaration the dispatcher checks.
* A new connector is one adapter plus one declaration — no framework change.

**Negative**

* A single interface must cover API-key providers *and* OAuth providers *and* webhook-only
  providers. Optional members are what make that tolerable; a provider that supports nothing but
  webhooks implements nothing but `verifyWebhook` / `normalizeWebhook`.
* Capability documents must be kept in step with the adapter by hand. Startup validation catches
  malformed declarations and impossible claims, but it cannot prove a vendor API behaves as
  declared — that is what the connector's own tests are for.

**Alternatives rejected**

| Alternative | Why rejected |
| --- | --- |
| Extend `AIProviderAdapter` | It models completions and embeddings, not objects and cursors. Reusing it would force the CRM's record model into a prompt API. |
| Extend `VoiceProviderAdapter` | It models placing calls and receiving callbacks. Its `verifyWebhook` shape does not cover a signed *object* payload or a cursor. |
| A shared core plus per-family sub-interfaces | The two families do not exist yet. Speculative hierarchy with one implementation is a liability — the plan explicitly says not to force unsupported operations onto every connector. |
| Capability metadata in the database | It would drift from the adapter that implements it, and it would need seeding on every start (forbidden by AGENTS.md §3.3). |
