# Advanced Integrations — feature contract

> Phase 19-INT.1 deliverable (`PLAN_Phase_19_Advanced_Integrations.md` §19 `19-INT.1`).
> Acceptance: *decisions and unresolved dependencies are documented; no connector is enabled by default.*
> Repository audit: `docs/implementation/advanced-integrations-audit.md`.
> Compatibility: `docs/compatibility/advanced-integrations.md` · `provider-matrix.md`.
> ADRs: `adr/0001-secrets-storage.md` · `0002-generic-adapter-contract.md` ·
> `0003-job-topology.md` · `0004-webhook-ingestion-reuse.md`.

---

## 1. Use cases

| # | Use case | Actor | Phase |
| --- | --- | --- | --- |
| UC-1 | Browse the connectors this installation offers, with each one's capabilities, required permissions and setup requirements | Administrator | 19-INT.3 |
| UC-2 | Create a connection to a supported provider, in a draft state, and configure it | Administrator | 19-INT.4 |
| UC-3 | Authorize a connection through the provider's own consent screen, with minimum necessary scopes | Administrator | 19-INT.5 |
| UC-4 | Grant a stored credential to a job that needs it, without the job ever seeing the raw value | System | 19-INT.4 |
| UC-5 | Rotate a credential, revoke a connection, or delete a connection without touching synced CRM records | Administrator | 19-INT.4 |
| UC-6 | Be told that a connection needs reauthorization, and reconnect it | Administrator | 19-INT.5 |
| UC-7 | Pause and resume a connection so that no provider call is made while it is paused | Administrator | 19-INT.4 |
| UC-8 | See which connectors are registered, what each may do, and which of those actions the current caller may perform | Administrator | 19-INT.3 |
| UC-9 | See the module's own health — configured key, registered connectors, available capabilities | Administrator | 19-INT.2 |

---

## 2. Out of scope for this module

| Not owned | Owner |
| --- | --- |
| CRM records and their business rules | Core / the owning domain module |
| Product, quote, order, invoice, payment lifecycle | `Sales` |
| Marketing sending, consent, suppression, journeys | `MarketingAutomation` |
| Telephony, SMS, WhatsApp, inbox, message delivery | `VoiceCommunications` |
| Model providers, agent runtime, tool execution | `AIAgents` |
| Mail transport and mailboxes | `packages/mail` + `email_accounts` |
| Generic outbound webhook endpoints (admin-configured) | `modules/webhook-integration` |
| Connector HTTP reliability, SDK, adapter contract | **19-INT.6** |
| Object/field mapping and transformations | **19-INT.8** |
| Sync engine, checkpoints, sync runs | **19-INT.9** |
| Conflict records, deletion policy | **19-INT.10** |
| Retry/rate-limit/circuit-breaker/dead letters | **19-INT.11** |
| Inbound webhook ingress and signature adapters | **19-INT.12** |
| Outbound sync, echo prevention | **19-INT.13** |
| Admin UI (catalog, wizard, mapping builder, runs, conflicts) | **19-INT.14 / 19-INT.15** |
| Any provider connector | **19-INT.16+** |

**No connector is enabled by default.** The registry starts empty and the first connector arrives in
19-INT.16 or later.

---

## 3. Role matrix

The module uses the platform's **synthetic permission resource** pattern (the one
`apps/api/src/ai-agents/ai-agents-permission.service.ts` established): each module right is an
ACL resource evaluated by `AclApiService`, so the request-scoped role snapshot, the `sysAdmin`
bypass and the wildcard rule all apply unchanged. There is no parallel role table and no separate
permission store.

| Capability | ACL resource | Action | Who holds it by default | What it allows |
| --- | --- | --- | --- | --- |
| `use` | `AdvancedIntegrations` | `read` | `sysAdmin` only | Read the module's health, capability list and navigation |
| `providerAdmin` | `IntegrationProvider` | `edit` | `sysAdmin` only | Read the provider catalog; create/edit connections |
| `credentialAdmin` | `IntegrationCredential` | `edit` | `sysAdmin` only | Rotate, revoke and delete stored credentials |
| `authorize` | `IntegrationConnection` | `edit` | `sysAdmin` only | Start an OAuth flow, reconnect, revoke |
| `settingsAdmin` | `AdvancedIntegrationsSettings` | `edit` | `sysAdmin` only | Change module settings |

**Default ACL grants nothing broad.** No role is created by this module. `sysAdmin` holds the
platform wildcard `*` and therefore every capability; `noAccess` (the default user role) holds
`{}` and therefore none. A non-administrator cannot list providers, read connections, or start an
OAuth flow, even if a connector is registered.

Record-level ownership is enforced separately: a connection is visible to the caller who created
it, to a `sysAdmin`, and — when the connection is organization-scoped — to any administrator of the
organization. The module's endpoints assert the capability **and** the ownership before returning
anything.

---

## 4. Connection ownership — decision

**Decision: organization-level ownership in the first release. User-level is supported by the
data model but is not offered by the UI until a connector requires it.**

Rationale:

* A provider account (a Google Workspace tenant, a Stripe account) is normally **shared** by a
  team. A per-user connection would create N duplicate connections to the same tenant, N times the
  token-refresh surface, and N times the risk of a token rotation racing another user's refresh.
* The plan permits both ("only where required"), and the module-level need is low.
* The data model keeps `owner_type` / `owner_id` so that a user-scoped connection can be created
  later without a migration. The uniqueness rule is *per owner*, not per provider, so one
  organization may hold several connections to the same provider (different tenants, environments
  or regions).

Ownership is expressed on the connection row and checked on every read and every privileged
action. A user-scoped connection is visible only to its owner and to `sysAdmin`.

---

## 5. Behaviour contracts

### 5.1 Connection state machine

```
DRAFT ──► PENDING_AUTHORIZATION ──► CONNECTED
                                        │  ▲
                          DEGRADED ◄───┘  │
                            │  ▲            │
                            ▼  │            │
             REAUTHORIZATION_REQUIRED ───────┘
                                        │
DRAFT/DEGRADED ──► PAUSED ──────────────┘
any ──► REVOKED ──► (deleted)
any ──► ERROR
```

| From | Allowed to |
| --- | --- |
| `draft` | `pending_authorization`, `revoked`, `error` |
| `pending_authorization` | `connected`, `reauthorization_required`, `draft`, `error`, `revoked` |
| `connected` | `degraded`, `reauthorization_required`, `paused`, `revoked`, `error` |
| `degraded` | `connected`, `reauthorization_required`, `paused`, `revoked`, `error` |
| `reauthorization_required` | `connected`, `pending_authorization`, `revoked`, `error` |
| `paused` | `connected`, `revoked`, `error` |
| `revoked` | `deleted` only |
| `error` | `draft`, `pending_authorization`, `revoked` |

Rules:

1. Every transition is validated against this table. An invalid transition is refused with
   `VALIDATION_FAILED` and the current state is never changed.
2. **`paused`, `revoked` and `reauthorization_required` are not permission to call the provider.**
   Resolving a connection for an operation refuses those states outright. A job must not treat
   them as "retry later" — a paused connection is paused on purpose.
3. `revoked` is terminal for provider calls. `deleted` removes the row and its credentials; it
   never deletes a CRM record the connection synced.
4. `resume` is only permitted from `paused` and only after the health and authorization checks
   pass. A connection whose credential expired while paused resumes to
   `reauthorization_required`, not to `connected`.

### 5.2 Sync consistency

| Concern | Contract |
| --- | --- |
| Model | **Eventual consistency.** The platform never claims a provider and the CRM agree at a point in time. |
| Read-your-write | Within one sync run, an operation reads the state the previous operation wrote. Across runs, a record may lag by the run's duration plus the queue delay. |
| Ordering | Operations for one connection are processed **in order**; operations for different connections may interleave. |
| Isolation | A sync run is not transactional across objects. A provider that applies writes partially may leave a run partially applied — the run records which operations succeeded. |
| Monotonic cursors | A checkpoint only advances past an object that was applied successfully. A failed object is retried; the cursor does not skip it. |
| Deletion | Never implicit. See §5.4. |

### 5.3 Conflict policy

A conflict is raised when the same record is changed **on both sides** between two syncs, and the
platform cannot decide which is newer (either the provider offers no timestamps, or the CRM
record's `modifiedAt` is not comparable with the provider's clock).

| Policy | Behaviour |
| --- | --- |
| `provider_wins` | The provider's value overwrites the CRM's. Requires the mapping to declare the provider authoritative for that field. |
| `crm_wins` | The CRM's value is written back to the provider, if the provider supports write-back for that object. Otherwise the provider value is kept and the difference is recorded. |
| `manual` | The conflict is recorded and **nothing is written**. The operator resolves it explicitly. This is the default. |
| `newest_wins` | Only valid when both sides carry a comparable timestamp. The platform refuses to apply this policy when the provider does not expose a reliable `updated_at`. |

Rules:

* The default policy is `manual` — the platform never silently overwrites a CRM field.
* A conflict resolution is rejected when either side changed after the conflict was detected
  (stale resolution).
* Conflict resolution is audited with the actor and the reason.

### 5.4 Deletion semantics

| Provider behaviour | Platform behaviour |
| --- | --- |
| Deletion is visible (the object is gone and the provider says so) | The CRM record is **unlinked** and flagged. It is not deleted. |
| Deletion is tombstoned (the provider reports a deleted state) | The CRM record is unlinked and flagged, keeping the last known snapshot. |
| Deletion is not synchronized | Nothing happens. The mapping records that the provider does not report deletions. |

**A provider-side delete never hard-deletes a CRM record.** Deleting a connection never deletes
the CRM records it synced; the link is removed and the record remains. This is the plan's explicit
rule and it is the reason the platform does not offer a "delete synced records" action.

### 5.5 Retry

| Concern | Contract |
| --- | --- |
| Unit | One **operation**, not one page and not one run. A retried operation re-reads only the page it needs. |
| Mechanism | The platform's job queue (BullMQ) with bounded attempts and exponential backoff. |
| Retryable | Timeouts, 429, 5xx, and connection resets. |
| Not retryable | 4xx other than 429 — a bad request will fail again. A revoked token is **not** retried; it moves the connection to `reauthorization_required`. |
| Backoff | Exponential with a cap, plus a provider-supplied `Retry-After` when present. |
| Idempotency | A retry must not duplicate an effect. Operations carry an idempotency key where the provider supports one. |
| Terminal failure | After the last attempt the operation becomes a **dead letter** and is replayable by an operator. |

### 5.6 Cursor and checkpoint

| Rule | Detail |
| --- | --- |
| Storage | One checkpoint per (connection, object mapping, direction). |
| Advance | Only past an operation that succeeded. |
| Scope | A checkpoint is bound to the connection **and** the provider account/tenant; changing the tenant invalidates it. |
| Expiry | Providers expire cursors (Google's `syncToken` is the classic case). An expired cursor is **not** an error to swallow — it triggers a full re-sync of that object, recorded as such. |
| Manual reset | An operator may reset a checkpoint, which forces a full re-sync. The reset is audited. |
| Never stored | A cursor is not a secret, but it is not exposed to a non-administrator either; it is part of the connection's configuration. |

### 5.7 Idempotency

| Layer | Rule |
| --- | --- |
| Inbound webhook | A provider delivery id is deduplicated against a receipt table. A duplicate delivery is acknowledged and discarded, never processed twice. |
| Inbound poll | The checkpoint makes a repeated page a no-op. |
| Outbound write | Every outbound operation carries an idempotency key derived from (connection, mapping, provider object id, target version). The provider receives it when it supports one. |
| Local ledger | Every applied operation is recorded, so a replay is detectable rather than silent. |

### 5.8 Retention

| Record | Retention |
| --- | --- |
| Connection configuration | Until the connection is deleted. Deleting a connection removes its configuration and its credentials. |
| Credentials | Removed with the connection. A rotated credential's previous payload is overwritten, never kept. |
| OAuth authorization state | Short-lived — deleted on use, and swept after its expiry. It is single-use by construction. |
| Credential values in logs | Never. Redaction is applied at the logger boundary, not at the call site. |
| Audit trail | Kept with the platform audit log. It records *that* a credential was rotated, never *what* it was. |

---

## 6. Connector tiers

The tier assignment is unchanged from the plan §2.4 and is recorded in
`docs/compatibility/advanced-integrations/provider-matrix.md`.

| Tier | Providers | First release |
| --- | --- | --- |
| 0 | The control plane and the generic REST / outbound webhook connector | Generic REST first |
| 1 | Google Workspace, Microsoft 365, Zoom, Stripe | Google Workspace second |
| 2 | Mailchimp, Meta Lead Ads | No |
| 3 | Ecommerce, accounting, data enrichment | No |

**Acceptance criteria for the first simple connector** (the generic REST connector, 19-INT.24):
a fake adapter must be able to validate a connection, list object schemas, fetch a page and return a
normalized error without a vendor SDK; a sync run against it must produce one linked record, one
checkpoint and one replayable operation on failure; and the whole path must be exercised with no
network access.

---

## 7. Decisions and their consequences

| # | Decision | Consequence |
| --- | --- | --- |
| D-1 | Secrets live behind a narrow vault port backed by the existing AES-256-GCM primitive (ADR 0001) | No second crypto stack; key rotation is still open |
| D-2 | One adapter contract, not a shared core plus per-family extensions (ADR 0002) | The generic REST and Google connectors share one shape |
| D-3 | The retry unit is the operation (ADR 0003) | A retry never re-reads a whole page |
| D-4 | A third, shared webhook ingress; the existing two are not migrated (ADR 0004) | No risk to live Voice and Marketing integrations |
| D-5 | Connections live in a **dedicated table**, not in `entity_records` | The generic entity API cannot bypass the connection state machine |
| D-6 | Provider definitions are **code-registered**, not database rows | Capabilities cannot drift from the adapter that implements them |
| D-7 | Organization-level connection ownership in the first release | Fewer tokens, fewer refresh races |
| D-8 | The sidebar entry and the admin panel tab are registered with **19-INT.14**, not with 19-INT.2 | A navigation entry names a real SPA route. Registering it before the page exists would ship a dead link |
| D-9 | The OAuth callback and the credential refresh run under the **documented service authority** | The work is attributable, and the platform's own authorization engine is not bypassed by a special case |
| D-10 | The rate limiter and the circuit breaker keep their state in the **database**, not in memory | The API and the worker are separate processes. A per-process limiter would let the two of them together exceed the provider's quota, and a per-process breaker would let one of them keep hammering a provider the other has given up on |
| D-11 | One **executor** is the only path from the engine to a connector | The reliability rules (connection state, rate limit, circuit breaker, credential resolution) live in one place, so no engine code can call a provider without them |
| D-12 | The raw body is captured by a **scoped** Fastify `preParsing` hook, not by replacing the JSON parser | Buffering every request body would cost memory on every call and would interfere with the multipart streaming the attachment upload relies on. The default parser is untouched |
| D-13 | The echo guard is a **record-origin table**, not a flag on the record | The origin is not part of the record's data, is not shown to an operator, and cannot be forged by a user editing a record |

D-5 revises the *provisional* storage choice recorded in
`docs/implementation/advanced-integrations-audit.md` §4. The reason is specific: a metadata entity
is reachable through the generic `/api/v1/:entity` API, and a `PATCH /api/v1/IntegrationConnection/:id`
would move a connection between states without passing the state machine. Control-plane state must
not be reachable that way.

D-6 revises the plan's §6.1 `IntegrationDefinition` fields that imply a database row. The
repository's own precedent (`AIProviderRegistry`, `VoiceProviderRegistry`) registers adapters in
code, and a code-registered definition is what "validate connector declarations on module startup"
requires.

---

## 8. Unresolved dependencies

| # | Dependency | Blocks | Resolved by |
| --- | --- | --- | --- |
| U-1 | A raw-body capture path for webhook signature verification | 19-INT.12, and any provider that signs exact bytes | 19-INT.12 — the Fastify adapter currently has no raw-body plugin |
| U-2 | Key rotation / key versioning for `ENCRYPTION_KEY` | Production secret rotation | Follow-up ADR after the first connector is live |
| U-3 | The provider HTTP client's redirect, timeout and retry policy | 19-INT.6 and every connector after it | 19-INT.6 |
| U-4 | Whether the metrics facility is built | Operator dashboards | 19-INT.26 — until then, health is derived from `jobs` and `audit_log` |
| U-5 | The exact OAuth scopes per provider | Each connector's `required_scopes` | The connector's own audit phase, from the vendor's current documentation |
| U-6 | Whether a second connection may exist for the same provider and owner | The uniqueness rule | Resolved: yes — uniqueness is (provider, owner, name), so several are allowed |
