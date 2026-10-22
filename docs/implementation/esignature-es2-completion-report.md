# Phase 19-ES.2 — Database schema and domain entities

> `PLAN_Phase_19_ESignature.md` §6, §7, §18 `Phase 19-ES.2`.
> Acceptance: the migration is reviewed and applied safely according to `AGENTS.md`; request state
> transitions are unit-tested; provider envelope ids are unique in the appropriate
> connection/account context.
>
> Prerequisites read: `docs/implementation/esignature-audit.md` §6 (the dedicated-table decision),
> `docs/implementation/esignature-es1-completion-report.md` (the gate and the permission matrix this
> phase now has records to talk about), `docs/compatibility/esignature.md`.

ES.2 gives the module its records and its rules. No route, no adapter, no UI: after this phase a
signature request can be stored, moved through its lifecycle, and refused in exactly the ways the plan
says it must be refused — and nothing has ever contacted DocuSign.

---

## 1. Schema

`database/migrations/064_phase19_esignature.sql` — additive only: **8 new tables, 45 explicit
indexes**, no existing table, column or row touched, nothing seeded, no connection enabled. Applied to
the configured primary database (`carocrm_dev`) on 2026-10-22 and recorded in `schema_migrations`; no
database, schema, container or copy was created (`AGENTS.md` §3).

| Table | Role | The constraint that carries a product rule |
| --- | --- | --- |
| `esignature_connections` | The non-secret half of a connection: environment, discovered account context, granted scopes, health stamps, opaque `public_id` | unique `(provider_key, environment, name)`; partial index on `status='connected' AND is_active` is the gate's one hot read |
| `signature_requests` | The request, its lifecycle, approval binding, send correlation, outgoing snapshot and failure classification | unique `(connection_id, provider_envelope_id)` **where the envelope is not null** — plan §6.2: an envelope id is unique in the account context, not globally; unique `send_attempt_id` — one deliberate action, one effective send |
| `signature_recipients` | The signer/CC rows, as submitted | unique `(request_id, role_name)`; routing order intentionally **not** unique, because parallel signing is legal (plan §4.4) |
| `signature_document_snapshots` | `source_snapshot` / `provider_signed_document` / `completion_evidence` / `supporting_document`, each with the SHA-256 of the exact bytes | `content_hash_sha256 ~ '^[0-9a-f]{64}$'`; unique `(request_id, artifact_kind, content_hash_sha256)` and `(…, provider_document_id)` — a retried artifact download cannot create a second row |
| `signature_provider_events` | Append-only normalized event history, with `payload_hash`, the minimized event and a `purge_after` | unique `dedup_key` (plan §10.1.4); `event_type_normalized` keeps `unmapped` as a value, never as success |
| `signature_webhook_inbox` | The durable receipt: verification result, content length, minimized body, processing state | unique `dedup_key`; `signature_status` recorded before any payload field was trusted |
| `signature_template_mappings` | Local workflow → provider template, with role and field mappings as data | unique `(connection_id, provider_template_id, mapping_type)`: a template id means something only inside the account that owns it |
| `signature_audit_entries` | The lifecycle trail (31 declared actions) | append-only to application code, with a validated action name |

Why not `entity_records`: a metadata entity is reachable through the generic `/api/v1/:entity` API, and
a `PATCH` there could move a request to `completed` or forge a `provider_envelope_id` without passing
the state machine, the send guard or the vault. That is the decision audit §6 recorded and this
migration implements, with the same rationale Advanced Integrations wrote into
`database/migrations/056_phase19_advanced_integrations.sql:6-10`.

`signature_requests` also carries `assigned_user_id` and `team_ids` — the tenancy boundary the
record-level ACL evaluates in ES.6 — and every status, kind and role is a `CHECK`-constrained
allowlist, so a value that is not in the plan's vocabulary cannot be stored at all.

## 2. Domain rules now in code

| File | Rule |
| --- | --- |
| `esignature-state-machine.ts` | The 14-state transition table, split by **who may cause a move**: `local`, `provider`, `reconciliation`. Every provider-owned state (`sent`, `delivered`, `partially_signed`, `completed`, `declined`, `voided`, `expired`) is unreachable from a CRM command; a terminal state's only exit is reconciliation; `send_unknown` cannot go back to `ready_to_send`, which is the blind retry the plan forbids. Plus the recipient projection's monotonic rule and the settled states. |
| `esignature-snapshot.ts` | The immutable envelope: canonical JSON, SHA-256 digest, deep-frozen copy, digest re-verified on every read, and `approvalStillApplies` — the reviewer's decision binds to a digest, so a changed document or recipient invalidates it. |
| `esignature-retention.ts` | What may be purged and what may not: webhook/event payloads get a `purge_after` from the settings document; the event history, the audit trail and the completion certificate get **none**. A zero day setting means "no automatic deletion", never "delete now". Plus the per-table soft-delete/append-only discipline. |
| `signature-connection.repository.ts` | The connection lifecycle table, the authorization write (refuses an empty account context), the operator's active switch (refused before authorization), health stamps, and disconnect-as-soft-delete. No credential column exists in this file's world. |
| `signature-request.repository.ts` | Draft creation, guarded transitions with `version` compare-and-set (`CONCURRENCY_CONFLICT` for a stale writer), refusal of server-owned columns in a draft edit, atomic send-attempt claim, envelope attachment with a clean duplicate refusal, approval binding, `softDelete` only before send. |
| `signature-recipient.repository.ts` | Draft-only replacement, identity snapshot (email normalized, name as typed), role collision refusal, `applyStatus` idempotent by event id and monotonic by rank, `assertMatches` for the future embedded-view check. |
| `signature-document-snapshot.repository.ts` | Record-by-hash idempotency, "same slot, different bytes" refusal, evidence classification from the retention rule, removal only from a draft, and no operation that can write to a source artifact's bytes. |
| `signature-provider-event.repository.ts` | Append with `dedup_key` conflict-to-no-op, `payloadDigest` over canonical JSON, and processing bookkeeping that never touches the event's content. |
| `signature-webhook-inbox.repository.ts` | Durable accept (returns the existing row and `created: false` for a redelivery), a claim-style `markState` with a `from` guard so two workers cannot both process, problem-delivery list and per-state counts. |
| `signature-template-mapping.repository.ts` | Mapping CRUD with version checks, and the refusal of anything expression-shaped or any unknown property in a role/field mapping (plan §6.7). |
| `signature-audit.repository.ts` | Declared-action allowlist, segment-based redaction (secrets, tokens, URLs, bodies, raw content dropped; hashes and digests kept because they are evidence), append-only surface. |

`ESignatureConnectionGate` now reads `SignatureConnectionRepository.countUsable()` instead of its own
query, so the gate and the records cannot disagree, and the unreachable `schema_pending` gate reason
was removed with the tables now existing. Secret kinds were aligned to the vault's own vocabulary
(`client_secret`, `oauth_refresh_token`, `webhook_secret`) so ES.4 stores them without touching a
shared constraint.

## 3. Review of the migration before applying

The file has not been edited since it was applied (written 21:57:26, applied 21:57:46): an
already-applied migration is never amended here — the shared database tracks `schema_migrations` by
filename, so a later edit would silently never arrive.

Checked before running: zero occurrences of `DROP`, `TRUNCATE`, `ALTER TABLE`, `UPDATE`,
`DELETE FROM` or `RENAME`; every statement `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`;
run inside the existing per-file transaction of `database/migrate.ts`.

Constraint behaviour was then probed on the configured database, and each refusal is the expected SQL
state: duplicate envelope on one connection `23505`; reuse of a `send_attempt_id` `23505`; an unknown
request status and a non-hex content hash both `23514` (the column `CHECK`s); two recipients in one
template role `23505`; two parallel recipients at one routing order **accepted**; duplicate inbox and
event dedup keys `23505`; a recipient for a missing request `23503` (the `RESTRICT` foreign keys). A direct SQL `UPDATE … status='completed'` succeeds
at the database level — the row is not protected from the DBA's own hand — which is precisely why no
application path writes that column except through `transition()`.

## 4. Verification

| Suite | Tests | Result |
| --- | --- | --- |
| `apps/api/test/esignature-domain.test.ts` (pure unit, no database) | 34 | pass |
| `apps/api/test/esignature-entities.test.ts` (configured primary database) | 19 | pass |
| `apps/api/test/esignature.test.ts` (ES.1 API suite, re-run against the new schema) | 20 | pass |

The state-transition acceptance is the unit suite's job and the repository integration proves the same
rules survive a real write: a CRM-originated move to `sent` is refused, the evidenced one is accepted
and stamps `sent_at`; `completed → sent` is refused as finished; reconciliation re-confirms
`completed`; a stale `version` loses with `CONCURRENCY_CONFLICT`; a draft edit naming `status` is
refused; a sent request cannot be edited or soft-deleted; a second request cannot take an envelope id
already recorded on that connection while a different connection may use the same id; a send attempt
token cannot be reused by another request.

Data hygiene: every row created by these runs carries `AGENT_TEST_<runId>` and is deleted by exact id,
children before parents. After the run, all eight tables were queried and hold **0 rows**.

**Full suite, same working tree:** 2341 passed, 7 failed across 5 files. Those seven are the same
failures the checkout produces without ES.2 (verified by re-running the baseline in the previous
phase): `docs-content` + `packages/docs/corpus` on the pre-existing `/EmailTemplate`
`unknownAppRoute` (commit `5ce375e`), and `service-desk` / `service-desk-workflow` /
`service-desk-sla` on shared development-database state and a time-of-day-dependent SLA assertion.
ES.2 adds none of them and fixes none of them.

Also green: `pnpm typecheck` (API + tests + web), `eslint --max-warnings=0` on every touched path, and
`pnpm -r build` (API, worker, web, packages, modules).

**Live check of the built application** (scratch instance on port 3032 against the configured primary
database, then stopped): `GET /api/v1/ESignature/action/health` reported
`implementedPhases = [19-ES.0, 19-ES.1, 19-ES.2]`, `ok = true`, all 8 structures present,
`check schema = 8 signature tables are present`, and the gate closed —
`ready: false, reason: module_disabled, enabledConnections: 0`. The same instance also reported
`secret-encryption` as not configured, which is true of this development environment
(`ENCRYPTION_KEY` unset): the connection check is honest rather than assumed. No request was sent to
any provider, and no settings row was written.

## 5. Decisions taken in this phase

**Transitions are filtered by origin, not only by target.** A table of allowed pairs would still let a
CRM command write `completed`, because `sent → completed` *is* a legal pair. The origin parameter is
what makes plan §1.2 ("the provider is the signing authority") executable.

**An operator may raise reconciliation, and may not resolve it.** `local → reconciliation_required` is
allowed everywhere it is meaningful: it fabricates no progress, it says "I am going to ask the
provider". Landing on the answer requires `provider` or `reconciliation`.

**`completed` is a settled recipient status.** A signer who has signed cannot later be marked
`declined` by a late event, so `completed` joins the three provider endings in the settled set — and
`recipientRank` returns `null` for all four, because they are not stages.

**Artifacts are identified by content, not by a slot.** Idempotency for the future download job comes
from `(request, kind, hash)` and `(request, kind, provider_document_id)` rather than from a
caller-supplied key, so a retried job is a no-op by construction.

**Retention defaults to keeping.** The evidence trail, the event history and the completion certificate
have no purge date, and a `0` setting means "no automatic deletion". Purging a contract's proof is a
decision with the retention owner in the room (plan §12.1), not a cron default.

**Redaction is segment-based and keeps digests.** `clientSecret`, `signatureUrl`, `rawPayload` are
dropped; `contentHashSha256` is kept, because a digest is the opposite of the content it summarizes.

**Uniqueness is scoped where the plan scopes it.** Envelope ids are unique per connection, recipient
roles unique per request, routing orders deliberately not unique.

## 6. Deliberately not in this phase

- Routes and DTOs for requests, recipients, documents and connections (ES.6, ES.4), and the SPA
  surfaces (ES.13). The repositories have no HTTP surface yet, which is why the integration suite calls
  them directly.
- The provider adapter and its `unknown_outcome` taxonomy (ES.3), OAuth and the credential writes
  (ES.4), reading bytes and computing the hashes it stores (ES.5), the preview that fills
  `outgoing_snapshot` (ES.8), the guarded send that fills `send_attempt_id` (ES.10), the webhook route
  that fills `signature_webhook_inbox` (ES.11), the status mapper that fills
  `signature_provider_events` (ES.12), artifact downloads (ES.15) and the approval engine that reads
  `approved_digest` (ES.17).
- Any job registration, scheduled cleanup or domain event publication: the columns and rules those
  phases need are in place, so they will not have to change the schema.
- No dependency was added, no seed row was written, and no test database was created.
