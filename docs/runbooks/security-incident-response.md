# Security incident response runbook

> **Owner:** platform / security
> **Introduced:** Phase 23.9 (2026-11-12), `plans/PLAN_Phase_23_Security_Hardening.md` §15 task 3.
> **Scope:** suspected credential or token leak, session mass-revocation, JWT/API-key/encryption-key
> rotation, webhook replay or provider compromise, data exposure, evidence preservation and safe
> communication.
> **Companion procedures:** [`platform-operations.md`](platform-operations.md) (queues, correlation
> ids, authority), [`../security/jwt-secret-rotation.md`](../security/jwt-secret-rotation.md),
> [`../security/encryption-key-rotation.md`](../security/encryption-key-rotation.md),
> [`../security/data-retention.md`](../security/data-retention.md),
> [`../operations/backup-restore.md`](../operations/backup-restore.md), and the module runbooks under
> [`docs/runbooks/`](advanced-integrations.md).
>
> This document is a procedure. It is **not** a claim that an incident has been exercised, that an
> on-call rotation exists, or that legal notification obligations have been agreed. Those are named
> gaps in §8.

## 1. Principles

1. **Contain first, then investigate.** Revoke the credential or stop the write path before reading
   logs for an hour.
2. **Preserve evidence before rotating.** Rotation destroys the ability to reproduce a forged token or
   replay a delivery. Copy the relevant rows and log lines first (§4).
3. **Never widen access to investigate.** Use the existing administrator surface and the operations
   snapshot; do not grant a new role, disable a guard or turn off signature verification.
4. **A secret never goes into a ticket, chat, commit, screenshot or this repository.** Refer to a
   credential by its store and row id, never by value.
5. **One incident lead.** The lead owns the timeline and the decisions; everyone else reports findings
   to the lead.

## 2. Severity and authority

| Severity | Examples | First response | Who may authorise containment |
|---|---|---|---|
| **SEV1** | Confirmed session/token forgery, database or encryption-key exposure, provider secret leak with evidence of use, bulk data exposure | Immediate, all hands | Incident lead + platform owner; legal/owner notified for data exposure |
| **SEV2** | Suspected leaked API key or webhook secret without confirmed use, repeated signature rejections from one provider, single-account compromise | Within 1 hour | Incident lead |
| **SEV3** | Isolated failed-login/lockout spike, a single rejected webhook, a suspected phishing report with no click | Next business day | Platform operator |

There is **no on-call rotation and no paging integration** in this repository (G77/G81); the owner must
name the incident lead and the escalation contact for the deployment. Record both in the deployment's
operations file, not here.

## 3. First 15 minutes

| Step | Action | Why |
|---|---|---|
| 1 | Open an incident record with an id (`INC-YYYYMMDD-nn`), the reporter, the time and the observed symptom. | A stable id goes into the audit/`revoked_reason` and the timeline. |
| 2 | Ask for the failing response's **`x-request-id`** (or the `requestId` in the error body/log line). | It is the join key from the user's report to the server log, outbox row, job and module receipt (`platform-operations.md` §2). |
| 3 | `GET /api/v1/AdminInternal/action/operations` as a system administrator. Read the `security` block: process-local counters, `loginFailures24h`, `signatureRejections24h`, `voiceRejections24h`, `marketingSignatureRejections24h`. | Confirms whether the symptom is authentication, signature or ingestion shaped. The block carries counts and labels, never payloads or addresses. |
| 4 | Read the API/worker logs around the request id. Use the documented fields; do not dump request bodies, cookies, `Authorization` headers or provider payloads into the incident record. | Logs already redact secrets; copying a whole request undoes that. |
| 5 | Decide the severity and the containment action from §5. Write it down before acting. | Containment changes state; the timeline must show who decided what. |
| 6 | If a credential may be in use, revoke it **now** (§5.2–§5.5), then continue the investigation. | Every minute a leaked token lives is a minute of unauthorised access. |

## 4. Evidence preservation

Collect and store these **before** rotating a secret or deleting anything, in a restricted incident
folder (mode 700, files 600, not in the repository, not in the public backup root):

| Evidence | Where it lives | What to copy |
|---|---|---|
| Request/job correlation | `x-request-id`, `outbox_events.correlation_id`, job payload/result metadata, module receipt `correlation_id` | The ids and the surrounding log lines, not full payloads. |
| Authentication events | `user_sessions` (id, user id, family id, created/expiry/revoked timestamps, `revoked_reason`), `auth_login_attempts` (hashed subject only) | Rows for the affected account(s) and window. |
| Audit trail | `audit_log`, including denial rows written since Phase 23.4 | Rows for the affected entity/actor and window. |
| Provider/webhook evidence | ESignature `signature_webhook_inbox`/events, voice receipts/events, marketing `marketing_events`, Advanced Integrations receipts | The receipt ids, signature outcome, timestamps and dedup keys. The normalized payload may be minimized by retention; do not reconstruct it from a third party. |
| Data-access evidence | Attachment download/read audit rows, export job rows, `stream_items` | Counts and record ids, not file contents. |
| Security-event counts | `AdminInternal/action/operations` `security` block, process-local | Take a timestamped copy; counters reset on restart. |

Write a SHA-256 of each exported file and record it with the incident id. Do not edit or truncate
`audit_log`, receipts or logs; retention jobs are not an incident tool (and `audit_log` is excluded
from automated retention — `docs/security/data-retention.md` §3).

## 5. Scenario procedures

### 5.1 Suspected credential or token leak

**Symptoms:** a token, cookie, API key or connection string appears in a ticket, chat, screenshot,
commit, browser extension, shared machine or a provider dashboard; an unexpected session appears in
`GET /api/v1/AppUser/me/sessions`; `loginFailures24h` or `auth.lockout` rises.

**Contain, in this order:**

1. Identify the credential type from §5.2–§5.5 and follow that procedure. Do not rotate every secret
   at once: an encryption-key rotation is a data migration, not a restart.
2. If the credential is a **session or refresh token**, revoke the account's sessions (§5.2). A revoked
   session is rejected on both access and refresh paths (verified by
   `phase23-2-sessions-apikeys.test.ts`).
3. If the credential is a **password**, reset it through the administrator route
   `POST /api/v1/User/:id/password-reset` (revokes that account's open sessions) or have the user use
   the self-service reset. Do not send a password in chat.
4. If the credential is a **provider credential** (SMTP, AI provider, connector, eSignature, voice),
   revoke it at the provider first, then replace it in the credential vault and exercise the health
   path. The vault stores ciphertext; a database read does not reveal it without `ENCRYPTION_KEY`.
5. If a **database connection string** leaked, rotate the database role's password, update the secret
   store, restart the API and worker, and check `pg_stat_activity` for unknown peers. Do not reuse the
   old role for the new deployment.

### 5.2 Session mass-revocation

There is no single "revoke every session in the installation" endpoint. Use the narrowest action:

| Scope | Action | Effect |
|---|---|---|
| One account, user present | `POST /api/v1/AppUser/me/password` after re-authentication | Revokes **all** of that user's open sessions (`auth.service.ts` `changePassword`). |
| One account, administrator | `POST /api/v1/User/:id/password-reset` with a new password | Revokes **all** of that account's open sessions (`identity.service.ts` `resetUserPassword`). |
| One account, compromised | `DELETE /api/v1/User/:id` (soft delete) | Marks the account deleted and revokes its open sessions (`identity.service.ts` `deleteUser`). Prefer this when the account itself, not just its password, is suspect. |
| One session | `DELETE /api/v1/AppUser/me/sessions/:sessionId` | The caller's own session only; ownership-scoped, another user's id answers 404. |
| Many accounts | Reviewed SQL under the incident id (below), then verify | No admin-wide endpoint exists; a bulk loop of password resets is more disruptive and changes passwords you may not want to change. |

For a bulk revocation, run **one** transaction against the reviewed primary, scoped to the exact user
ids and an explicit reason, and record the count:

```sql
BEGIN;
UPDATE user_sessions
   SET revoked_at = now(), revoked_reason = 'incident-INC-YYYYMMDD-nn'
 WHERE user_id IN ('<id-1>', '<id-2>')
   AND revoked_at IS NULL;
-- Expect the same number as the account list; roll back on a mismatch.
COMMIT;
```

Rules: never `UPDATE user_sessions` without a `user_id`/session predicate; never delete the rows (they
are evidence and the retention job prunes them later); after the update, ask one affected user to
refresh and confirm a 401, and confirm a fresh sign-in works. Record the statement, the ids and the
count in the incident record.

**If the signing key itself may be compromised**, session revocation is not enough: rotate
`JWT_SECRET` (`docs/security/jwt-secret-rotation.md`). That invalidates every outstanding access and
refresh token at once, so treat it as an installation-wide sign-out and announce it.

### 5.3 JWT secret rotation

Follow [`../security/jwt-secret-rotation.md`](../security/jwt-secret-rotation.md). Summary:

1. Generate `openssl rand -hex 32`; store it in the secret manager, never in the repository.
2. Deploy/restart the API and worker with the new `JWT_SECRET` and `NODE_ENV=production`.
3. The boot guard rejects the development default and the compose placeholder
   (`change-me-in-production`).
4. Every previously issued access and refresh token fails; users sign in again.
5. Verify login, refresh and logout; record the rotation (who, when, reason, incident id) — never the
   value.

Do not rotate back after users have re-authenticated; their new refresh tokens belong to the new key.

### 5.4 API-key rotation or revocation

1. List the keys for the API user: `GET /api/v1/ApiKey/:apiUserId` (administrator). Note `id`,
   `last_used_at`, `scopes` and `allowed_ips`; do not copy the secret (only its hash exists).
2. Replace it: `POST /api/v1/ApiKey/:keyId/rotate` returns the new secret **once** and stops the old
   one immediately. Revoke without replacement: `DELETE /api/v1/ApiKey/:keyId`.
3. Deliver the new secret out of band to the integration owner; never paste it into the incident
   record. Confirm the old key now answers 401 and the new one works.
4. If the key was used from an unexpected address, the `last_used_at`/IP restriction fields and the
   API access log around the request id are the evidence. Capture them first.

### 5.5 Encryption-key rotation

Follow [`../security/encryption-key-rotation.md`](../security/encryption-key-rotation.md). The key
change and the re-encryption pass are **one operation**:

1. Stop API/worker writes (maintenance), generate the new key.
2. Dry-run `scripts/rotate-encryption-key.mjs` against a restore, then `--apply` against the reviewed
   primary; it walks the five vault stores in one transaction and aborts on an unrecognised payload.
3. Replace `ENCRYPTION_KEY` in the secret store, restart, and verify one connection in each store.
4. Keep the old key offline until a successful backup and restore drill; a lost key is unrecoverable.
5. Record counts and operator, never key material.

If a key is suspected compromised, assume every stored provider credential is compromised too: rotate
the provider credentials after the data pass, not only the key.

### 5.6 Webhook replay or provider compromise

**Symptoms:** `webhook.replay` or `webhook.signature.rejected` in the logs; a spike in
`signatureRejections24h` / `voiceRejections24h` / `marketingSignatureRejections24h`; duplicate
business effects from one delivery; a provider reports a leaked signing secret.

1. **Stop the door, not the module.** Rotate the per-door secret and update the provider:
   - Advanced Integrations: the connection's webhook secret (`docs/runbooks/advanced-integrations.md`).
   - Marketing: `MARKETING_WEBHOOK_SECRET`; blank means **no** event is accepted (fail closed).
   - Voice: the provider account's `webhook_secret_encrypted` (`docs/modules/voice-communications/`).
   - ESignature: the provider's Connect/callback secret (`docs/runbooks/esignature-admin-setup.md`).
2. **Do not replay or purge receipts while the secret is suspect.** Rejected deliveries are evidence.
   A terminal receipt may be replayed only through the module's audited recovery path, and only after
   the new secret is verified.
3. Confirm the new secret with a provider test delivery. A valid delivery must produce one normalized
   event, not a duplicate: dedup keys and the replay window are enforced per module.
4. If a replayed delivery already had a business effect, identify the affected records from the
   receipt/`correlation_id`, correct them through the module's audited action, and record what was
   changed. Do not edit module tables directly unless the module runbook says to.
5. If the provider itself is compromised (not just the secret), disable the connection/account, revoke
   its OAuth grant at the provider, and treat every credential in that vault as exposed (§5.5).

### 5.7 Data exposure

**Symptoms:** a record, attachment, export or report was visible to someone outside its ACL; a public
link or misconfigured storage exposed files; a log/ticket contains personal data.

1. **Stop the exposure:** remove the share/link, disable the export or attachment route's credential,
   or revoke the session/API key that fetched it. If a storage bucket is public, change the bucket
   policy before investigating how it became public.
2. **Scope it:** use `audit_log` (including denials), attachment read/download audit, export job rows
   and `stream_items` to answer *which records, which actor, which window*. Counts first; contents only
   when necessary and only in the restricted incident folder.
3. **Preserve:** export the evidence with hashes (§4). Do not delete the exposed rows to "clean up".
4. **Decide notification:** the incident lead informs the owner and legal/compliance. Whether and when
   to notify a customer or regulator is a legal decision; this runbook does not set a deadline. Do not
   promise a notification you are not authorised to make.
5. **Close the cause:** fix the authorization/ACL path, add the regression to the security suite, and
   record the gap id if it is a new class. A data-exposure incident is not closed by deleting the post.

## 6. Communication

- Use one channel with a named scribe; keep the timeline in the incident record, not in chat.
- Status updates state: what is known, what was done, what is next, and the next update time. Label
  hypotheses as hypotheses.
- Never include secrets, tokens, cookies, connection strings, provider payloads or personal data in an
  update. Refer to records by id.
- External communication (customers, providers, regulators) is owned by the owner/legal, not by the
  on-call operator. The platform provides facts, not legal conclusions.
- After containment, write a short post-incident review: cause, detection, impact window, what worked,
  what did not, and the follow-up gap ids with owners and dates. Do not name individuals in the blame
  sense.

## 7. Safe diagnostics reference

| Question | Read-only source |
|---|---|
| Is the API up and is the database reachable? | `GET /health/live`, `GET /health/ready` |
| What is the queue/outbox/dead-letter state? | `GET /api/v1/AdminInternal/action/operations` |
| Which auth/signature events fired recently? | The `security` block of the same snapshot; process-local counters and 24-hour receipt counts |
| Which session opened a token? | `user_sessions` by `user_id`/family and timestamps; `GET /AppUser/me/sessions` for the caller |
| Which request caused this? | `x-request-id` → log line → `outbox_events.correlation_id`/job metadata/module receipt |
| Was a denial recorded? | `audit_log` denial rows (Phase 23.4) |
| Was a webhook accepted/rejected? | The module receipt and normalized event; `webhook.signature.rejected`/`webhook.replay` log lines |

**Never** for diagnosis: disable the auth guard, set `EXTENSION_TRUST_MODE=warn` in production, blank a
webhook secret to "see if it works" (blank fails closed), grant a role to a test account, run
`TRUNCATE`, delete `audit_log`, restore over the primary, or print an environment file.

## 8. Known gaps and preconditions

| Gap | Effect on this runbook | Owner / next step |
|---|---|---|
| No on-call rotation or paging (G77/G81) | Detection depends on a user report or a manual check of the operations snapshot; there is no page. | Deployment owner: name the on-call and alert route. |
| No admin-wide session-revocation endpoint | A bulk revocation is a reviewed SQL transaction (§5.2), not a button. | Auth: consider an admin endpoint in a later phase. |
| Security counters are process-local and reset on restart (G77) | Take a timestamped copy before restarting; there is no time series. | Platform: exporter/backend decision. |
| No approved recovery environment (G80) | A destructive containment step cannot be rehearsed on a restore; do not create one during an incident. | Platform/owner: approve target and RPO/RTO. |
| No legal/compliance owner for notification | The runbook stops at "inform owner/legal"; no deadline or template is asserted. | Owner: assign legal/compliance and record the outcome in `docs/security/distribution-compliance.md`. |

## 9. Post-incident checklist

- [ ] Incident id, severity, lead and timeline recorded.
- [ ] Affected credential(s) revoked/rotated; old value confirmed rejected.
- [ ] Sessions re-verified: an old token fails, a fresh sign-in works.
- [ ] Evidence exported with SHA-256 and stored restricted; nothing deleted.
- [ ] Affected records/business effects identified and corrected through audited paths.
- [ ] Root cause and the missing regression test recorded as a gap id.
- [ ] Owner/legal notified where data exposure is involved; decision recorded.
- [ ] Follow-ups have owners and dates; the runbook is updated if a step was wrong.
