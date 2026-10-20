# Advanced Integrations — operator runbook

> Phase 19-INT.26 / 19-INT.27 deliverable (`PLAN_Phase_19_Advanced_Integrations.md` §16.3, §19
> `19-INT.26`, `19-INT.27`).
> Companion documents: `docs/compatibility/advanced-integrations.md` · `providers.md` ·
> `oauth-scopes.md` · `sync-semantics.md` · `webhook-security.md`.
> Threat model: `docs/security/advanced-integrations-threat-model.md`.

This runbook answers the question an operator actually has at 3 a.m.: **what do I do about this?**
Each entry states the symptom, the cause, the safe action and the recovery — and, where it matters,
what the platform will *not* do on its own.

## 0. The five commands you will need

| Command | What it does |
| --- | --- |
| `GET /api/v1/AdvancedIntegrations/action/health` | The module's own state: the configured key, the registered connectors, the features that are on. |
| `GET /api/v1/AdvancedIntegrations/action/connections/:id/detail` | One connection: its state, its scopes, its last run, its sync lag, its last webhook and **what needs attention**. |
| `GET /api/v1/AdvancedIntegrations/action/metrics` | The derived metrics: connections by status, runs by outcome, provider errors by code, webhook verdicts, the cursor age, the reauthorization backlog. |
| `GET /api/v1/AdvancedIntegrations/action/audit` | The module's own trail: every privileged action, with its actor and its reason. |
| `GET /api/v1/AdvancedIntegrations/action/contracts` | Which cross-module contracts are published, and which are unavailable because their owning module is not installed. |

The first two need the module's *use* capability. The last two need the *diagnostics* capability,
which is deliberately separate: the metrics and the trail show more than the catalog does.

## 1. The OAuth token expired or the refresh was rejected

**Symptom.** The connection's state is `reauthorization_required`, and the detail says
`TOKEN_EXPIRED`. The metrics show a growing reauthorization backlog.

**Cause.** The provider expired the grant, the administrator revoked it, or the refresh token was
rotated by a provider-side policy.

**What to do.**

1. `POST /api/v1/AdvancedIntegrations/action/connections/:id/reconnect` — this starts the same
   authorization flow as the first time. The state is single-use and bound to the connection, so
   the callback cannot be aimed at another connection.
2. If the provider reports that a scope was removed, the connection stays in
   `reauthorization_required` and the detail names the **missing scope** — a permission class, never
   a credential. Grant the scope at the provider and reconnect again.

**What the platform will not do.** It will not retry the refresh. A refresh that failed because the
grant is gone would fail forever, and the platform refuses to consume quota on it.

## 2. A required provider scope was removed

**Symptom.** `MISSING_SCOPES` in the connection's warnings, and the missing scope is named.

**Cause.** The provider reduced the grant, or the administrator changed the granted scopes.

**What to do.** Reconnect with the scopes the provider now offers. If the provider will not grant
them, the connection cannot be used for the objects that need them — narrow the mapping to the
objects that still work, rather than leaving a mapping that fails on every record.

**Note on the scope check.** A connection that asked for *less* than the provider's full set has
its requirement narrowed to what it asked for. That is why a narrowed connection does not report a
permanently missing scope.

## 3. The provider API is down or rate limiting

**Symptom.** Runs fail with `RATE_LIMITED` or `PROVIDER_UNAVAILABLE`. The metrics show the error
code climbing and the circuit breaker opening.

**Cause.** The provider is degraded, or the account's quota is exhausted.

**What to do.**

1. Look at `metrics.circuits` — a circuit in state `open` means the platform is **already**
   refusing calls for that provider. That is the mitigation working, not a new problem.
2. `Retry-After` is honoured automatically, so a 429 does not become a retry storm.
3. If the provider has published an incident, wait for it. The bounded retry will exhaust itself
   and the operation becomes a **dead letter** — it is not lost.

**What to do with the dead letters.** `GET /api/v1/AdvancedIntegrations/action/connections/:id/dead-letters`
lists them; `POST /api/v1/AdvancedIntegrations/action/dead-letters/:id/replay` retries one. The
replay is idempotent, so a replay after a successful-but-ambiguous attempt does not apply the
operation twice.

## 4. A spike of invalid webhook signatures

**Symptom.** `WEBHOOK_SIGNATURE_FAILURES` in the connection's warnings, and `webhooks.rejected`
climbing in the metrics.

**Cause.** One of four things, and they are distinguishable:

| The rejected deliveries carry | The cause |
| --- | --- |
| A `reason` of `signature_mismatch` | The signing secret is wrong, or the provider changed its scheme. |
| A `reason` of `stale_timestamp` | The provider's clock and the platform's differ, or a delivery was replayed. |
| A `reason` of `missing_signature` | The provider is not sending the header the connector expects — a scheme change, or a different provider key. |
| A `reason` of `raw_body_required` | The raw body was not captured, so the signature could not be computed over the exact bytes. |

**What to do.** Rotate the webhook secret on the connection
(`POST /api/v1/AdvancedIntegrations/action/connections/:id/rotate-secret` with the
`webhook_secret` kind), and paste the new secret into the provider's webhook configuration. The
old deliveries stay in the trail as evidence.

**What the platform will not do.** It never stores the payload of a rejected delivery, and it never
lets a rejected delivery change a CRM record.

## 5. A webhook subscription expired or was disabled

**Symptom.** No deliveries arrive, and the connection's last webhook is old. Nothing fails — which
is what makes this one dangerous.

**Cause.** A Graph subscription expired (Graph subscriptions last days, not months), or the
provider's subscription was disabled.

**What to do.**

- For Microsoft 365: `POST /api/v1/AdvancedIntegrations/action/connections/:id/renew-subscriptions`.
  The subscription ids live in the connection's `subscriptionIds` option.
- For every other provider: re-create the subscription at the provider, pointing at the
  connection's webhook URL.

**Prevention.** The cursor age in the metrics is the early warning. A connection whose cursor has
not moved for longer than the provider's expected cadence is stale even when nothing failed.

## 6. The cursor was invalidated and a reconciliation is required

**Symptom.** The metrics show `cursors.resetRequired` above zero, and the next run is a full
enumeration.

**Cause.** The provider expired the cursor (Google's `syncToken`, for one).

**What to do.** Nothing. The platform drops the cursor and re-runs the full enumeration on the next
run.

**What the platform will not do.** It will not delete a CRM record because the record is missing
from the new snapshot. A provider-side delete maps to *unlink*, not to a hard delete, so a
reconciliation cannot empty the CRM.

## 7. Duplicate records, or an infinite echo loop

**Symptom.** The same record appears twice, or the outbound operation count grows without a user
doing anything.

**Cause.** Almost always an echo: a change made by a sync is pushed back to the provider, which
reports it again.

**What to do.**

1. Check `metrics.providerErrors` and the run list. A run that only *updates* and never *creates* is
   the echo.
2. The echo guard is the **record origin**: a record whose last change came from a sync on that
   connection is not pushed back. A contract-applied change (a payment that became `paid`, a case
   that was resolved) records its origin the same way, so a domain transition cannot loop either.
3. If the duplicates are real — a provider returned two records with the same unique value — the
   platform opens a **conflict** rather than merging on a guess. Resolve it in the conflict
   workbench.

## 8. A large sync is stuck, or it is producing too many failures

**Symptom.** A run has been `running` for a long time, or the failure count climbs.

**What to do.**

1. `POST /api/v1/AdvancedIntegrations/action/runs/:id/cancel` stops the run. The checkpoint only
   advances past a successful operation, so a cancelled run resumes where it stopped.
2. `GET /api/v1/AdvancedIntegrations/action/connections/:id/runs` shows the run's counters:
   scanned, applied, skipped, failed.
3. The `SyncRunSchema` request body caps a manual run: `maxRecords` (at most 1000) and `pageSize`.
   A manual run is bounded on purpose — a bulk sync has limits and a dry-run, per plan §13.5.

## 9. The provider's API version was sunset

**Symptom.** The provider answers with a deprecation notice, or a 400 that mentions the version.

**Cause.** The connector pins an API version (`providerApiVersion` in the catalog). The provider
removed it.

**What to do.** The pin is in the connector's own code, so an upgrade is a reviewed change: bump
the constant, run the connector contract suite, and check the provider's changelog for the field
names the connector reads. The pinned versions are listed in
`docs/compatibility/advanced-integrations/providers.md`.

## 10. Credential rotation and revocation

**Rotating a secret.**

1. `POST /api/v1/AdvancedIntegrations/action/connections/:id/rotate-secret` with the kind
   (`api_key`, `client_secret`, `webhook_secret`, `signing_secret`) and the new value. The value is
   **write-only**: no read path ever returns it.
2. Paste the new secret at the provider, in the same order as above — the platform first, the
   provider second. The reverse order leaves a window in which the provider signs with a secret the
   platform no longer holds, and every delivery is rejected.

**Revoking a connection.**

`POST /api/v1/AdvancedIntegrations/action/connections/:id/revoke` withdraws the provider grant
(where the provider publishes a revocation endpoint) and then revokes the stored credential — either
way, so a provider that cannot revoke still leaves nothing usable behind.

**What revocation does not do.** It does not delete the CRM records the connection synced, and it
does not delete the external-id links. The connection keeps its configuration so an operator can
see what was revoked.

**Disabling a connector without revoking it.** `POST /api/v1/AdvancedIntegrations/action/connections/:id/pause`
stops every provider call while keeping the grant, the credential and the history. This is the
right action for a provider outage; use *revoke* when the grant itself should end.

## 11. Data retention and incident response

**The retention policy** lives in the module's settings (`retention`). It is **off by default**: a
deployment decides, deliberately, that a diagnostic row may be discarded. When it is on, the purge
runs daily (`advancedIntegrations.purgeRetention`) and removes:

| What | Default period |
| --- | --- |
| A sync operation's redacted payload | 30 days |
| A webhook delivery's raw provider payload | 14 days |
| A resolved conflict's snapshots | 90 days |
| A discarded or replayed dead letter | 90 days |
| A finished sync run | 90 days |
| A decided enrichment result | 30 days |
| An audit row | 365 days |

**What the purge never does.** It never touches a CRM record, a credential, an external-id link,
or an audit row that is still inside its own retention period. It removes by primary key, in a
bounded batch, with a predicate about age and terminal state. There is no `TRUNCATE` and no
table-wide delete anywhere in the module.

**For a data-export or erasure request** under a legal or contractual policy: the module can
remove the *diagnostics* it holds, and it can unlink a CRM record from a provider. It cannot erase
a record at the provider — the platform does not promise provider-side erasure it cannot perform.
Say so plainly rather than implying a coverage that does not exist.

**For a secret leak.** Rotate the affected secret (section 10), then read the audit trail for the
window between the leak and the rotation. The trail records the *fact* that a credential changed
and who changed it; it never records the value.

## 12. The rollback and disable plan

**To disable one connector.** Pause its connections. Every provider call stops immediately; the
credentials, the mappings, the history and the CRM records stay.

**To disable the whole module.** Turn the module's features off in its settings (`connections`,
`oauth`). The module's routes keep answering, and the health report says what is off.

**To roll back a code change.** The module's persistence is **additive**: every migration creates a
table or adds a column, and none of them drops or renames anything. So a rollback is a code
rollback, and the schema stays compatible with the previous code — except for the columns the
*new* code writes, which the old code ignores.

**What a rollback does not undo.** A record a sync already wrote stays written, and a provider
call that already happened is not recalled. Undo a mapping change by **retiring** the mapping and
reconciling, not by rolling back the code.

## 13. The controlled debug mode

The debug mode exists because an operator sometimes needs to see *what shape* a provider's payload
has. It is deliberately narrow:

- it is **off by default**;
- it **expires** — set `debug.expiresAt`, and the mode stops working when the moment passes. The
  health report warns when a debug mode has no expiry, because a debug mode nobody switches off is
  a debug mode that stays on;
- it exposes only the **field names** and the size of a payload. Never a value.
- it needs the *diagnostics* capability, not merely the *use* capability.

## 14. Who owns what

| Question | The answer |
| --- | --- |
| May this connector write a payment? | No. The `Sales` contract `sales.payment.providerEvent` owns it. |
| May this connector resubscribe someone? | No. The `MarketingAutomation` contract owns consent and suppression. |
| May this connector move a case, a task or a customer profile? | No. The owning module's contract does. |
| May this connector assign a record's owner or team? | No. A protected field is never written by an imported payload unless the mapping recorded the review. |
| Which contracts exist right now? | `GET /api/v1/AdvancedIntegrations/action/contracts` — and a contract that is *absent* means the owning module is not installed. |
