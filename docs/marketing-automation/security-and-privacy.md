# Marketing Automation — security, privacy and the public surface

**Delivered in:** Phase 19-MA.5 (public tokens), 19-MA.10 (webhook verification), 19-MA.15 (public forms),
19-MA.18 (retention, diagnostics), 19-MA.19 (hardening).
**Plan:** `PLAN_Phase_19_Marketing_Automation.md` §5.3, §5.3.1, §5.3.2, §5.10, §9, §15 `19-MA.19`.
**Code:** `marketing-public-token.service.ts`, `marketing-event-ingestion.service.ts`, `marketing-form.service.ts`,
`marketing-automation.controller.ts` (public routes), `marketing-identity.ts`, `marketing-retention.service.ts`,
`config.ts` (`MARKETING_WEBHOOK_SECRET`).
**Tests:** `apps/api/test/marketing-automation-consent.test.ts`, `marketing-automation-events.test.ts`,
`marketing-automation-audience.test.ts`.

---

## 1. The authenticated surface

Every `/api/v1/MarketingAutomation/action/*` route runs behind the platform `AuthGuard` and then applies ACL
inside the service, never only in the controller:

| Capability | Gate |
| --- | --- |
| read a campaign, its log, its stats, its sends | `Campaign: read` + record ACL (`AclApiService.assertRecordAccess`) |
| campaign commands, duplicate, archive | `Campaign: edit` (record ACL), plus the send-readiness gate |
| create/edit consent and suppression | `MarketingConsent: create/edit`, `MarketingSuppression: create/edit` |
| issue a public link | `MarketingConsent: create` — a token is a credential, so minting one is a write permission |
| settings, global emergency stop, diagnostics, retention dry run, cross-module events, attribution recording | **administrator only** (`scope.isAdmin`) |
| worker doors (`delivery/run-scheduled-batch`, `journey/run-batch`, `journey/:id/trigger`) | authenticated **and** the shared `x-worker-secret` capability, compared in constant time; an unconfigured capability refuses outright |

The worker door is an additional capability, not a replacement for authentication: a request without a
session is rejected before the handler sees the secret.

Two record-level rules make the domain safe even when a caller holds `edit`:

* `MarketingAutomationWriteGuardService` registers on `beforeValidate` and refuses direct writes to
  server-owned fields (campaign status, transition history, send state, snapshot seals). Status moves only
  through a named command.
* `MarketingSuppression` rows are **never deleted**. Revocation stamps `revokedAt`/`revokedById`/`revokedReason`;
  only `SUPPRESSION_OVERRIDABLE` reasons can be lifted at all.

## 2. The public surface (five routes, all `@Public()`)

| Route | Method | What it can do | What it cannot do |
| --- | --- | --- | --- |
| `public/preferences/:token` | GET | render consent states for the token's identity | change anything; reveal the address |
| `public/unsubscribe/:token` | GET | render the same page | unsubscribe (a crawler or a link preview changes nothing) |
| `public/unsubscribe/:token` | POST | apply a global or purpose-scoped opt-out | grant consent; unsubscribe a different identity |
| `public/confirm/:token` | POST | confirm a double opt-in for the token's purpose | be reached from an unsubscribe link (its own scope) |
| `public/form/submit` | POST | create/link a Lead under the form's fixed schema | choose an arbitrary entity, field or owner |
| `webhook(s)/:providerKey` | POST | record a **signature-verified** provider event | be accepted without a configured secret |

### 2.1 Tokens

* 256 bits from `crypto.randomBytes`, base64url. Only `sha256("carocrm:marketing:token:" + token)` is stored —
  a database leak yields no working links.
* Scoped (`Unsubscribe`, `Preferences`, `OptInConfirmation`) and expiring (`PUBLIC_TOKEN_TTL_DAYS`). Issuing a
  new link of the same scope for the same identity revokes the outstanding one, so a printed link dies when it
  is replaced.
* **Every failure is the same sentence** (`PUBLIC_TOKEN_INVALID_MESSAGE`) — unknown, expired, revoked, wrong
  scope or over-budget are indistinguishable, so the endpoint cannot be used to test whether an address is in
  the CRM.
* A mutating call is capped at `MAX_PUBLIC_ATTEMPTS = 25`; past that the token is retired on the spot.
* `markUsed` makes the operation idempotent: pressing the link twice is one opt-out reported twice, not an
  error and not a second history row.

### 2.2 Address identity

Recipient identity is a digest (`emailIdentity`): HMAC-SHA256 keyed with `ENCRYPTION_KEY` when one is
configured, otherwise a salted SHA-256 with the marker `carocrm:marketing:email:`. The module stores `emailHash`
in consent, suppression, snapshot, token and delivery records; the plaintext address stays on the canonical
CRM record where field ACL already governs it. `identityStrength` reports `keyed` or `unkeyed`, and the health
endpoint surfaces it — an operator should know that an unkeyed digest is dictionary-attackable for common
addresses.

### 2.3 Provider webhooks

* **Fail closed.** `MARKETING_WEBHOOK_SECRET` is empty by default. With no secret there is nothing to verify
  against, so every event is written to the inbox as `rejected` / `SECRET_NOT_CONFIGURED` and no
  `marketing_events` row is created. There is no built-in default secret — a public constant would let anyone
  forge a signature.
* Comparison is `timingSafeEqual` over equal-length buffers; a length mismatch is a rejection, not an
  exception.
* A replay window of five minutes is enforced on `x-webhook-timestamp`; a stale request is refused before
  anything is written.
* The raw payload is redacted before storage (`redactPayload` drops any key matching `secret|token|password|signature`).
* Deduplication is `(provider, dedup_key)` in `marketing_provider_webhook_inbox`; a retry returns the original
  outcome with `duplicate: true`.
* Side effects run under the module's service identity because a webhook has no principal. A failure is
  recorded on the inbox row (`processed_with_errors` + reason) rather than swallowed.

### 2.4 Tracking endpoints

* `public/click?to=…` is a **same-origin bounce**: a rooted path is accepted (`//host` and `/\host` are not),
  and an absolute URL only when its origin equals `delivery.publicBaseUrl`. It cannot be used as an open
  redirect to a third-party host, and it records no event.
* `public/open` returns a 1×1 transparent GIF and records nothing — this deployment does not mint
  per-recipient pixel identifiers.
* Engagement events therefore come from the provider, not from link rewriting. That is a deliberate trade:
  rewriting every link would require a URL-signing key and would break the recipient's trust in the domain
  they see.

### 2.5 Public forms

`public/form/submit` accepts a **fixed** shape (`firstName`, `lastName`, `email`, `company`, `consent`,
`campaignId`, `journeyId`, `journeyVersionId`, `source`, `utmSource`, `utmMedium`, `utmCampaign`,
`idempotencyKey`, and a `website` honeypot). It cannot name an entity type, a field, an owner or an arbitrary
record id.

* **One answer, always.** The route replies `{ "accepted": true }` for a new Lead, a Lead reused by address, an
  idempotent repeat and a honeypot hit. The service's richer result (`created`/`duplicate`/`leadId`) is for
  internal callers only — a public form must not become a CRM membership oracle.
* **Anti-abuse.** A non-empty `website` field is a silent honeypot hit (nothing is written). The per-IP limiter
  allows ten submissions per minute per caller address, and the controller passes `request.ip` so the limit is
  actually per caller rather than one deployment-wide bucket.
* **Deduplication.** An `idempotencyKey` that already produced a Lead returns that Lead; without one, an
  existing Lead with the same address is reused rather than duplicated. The key is the Lead's own
  `formIntakeKey` attribute — declared on the entity since Phase 22.12, because before that the write was
  silently dropped and the lookup could never match (gap G24).
* **What the form may leave on the Lead.** `company` (the declared field), `utmSource`, `utmMedium`,
  `utmCampaign` and a `campaignId` link are captured as acquisition evidence, shown in the Lead detail view's
  `Acquisition` panel. The three UTM values are detail-only; `campaignId` is a link and audited, because it
  marks a business fact; `formIntakeKey` is not shown at all — it is dedup evidence the intake reads. A `campaignId` that is not a live Campaign is dropped rather than
  refused — a stranger's form post must not fail, and must not invent attribution either. Those five
  fields belong to the intake: a write through `/api/v1/Lead` that sets any of them is refused with
  `MARKETING_INTAKE_FIELDS_SERVER_OWNED`, because a hand-typed intake key could make somebody else's
  later submission look like a duplicate of it.
* **Consent.** `consent: true` writes an `ExplicitOptIn` consent record with `policyVersion: "1"` and the form
  as `captureContext`. Without it, the Lead is still captured and **no** marketing consent is implied, and a
  journey is not enrolled.
* Promotional journey enrollment requires both consent and an explicit `journeyId` + `journeyVersionId` whose
  version graph exists; the enrollment uses `form:<address>` as its dedupe key.

## 3. Content safety

* Templates are rendered by the shared engine and sanitized (`marketing-template-render.ts`): scripts, event
  handlers and unsafe protocols are removed, links are validated, and unresolved placeholders are reported in
  `warnings` instead of being blanked.
* Placeholder context is built from an **allowlisted** recipient projection — a template cannot read a field the
  sender could not open, and it cannot hydrate an arbitrary entity.
* Rendered output is escaped per context; the renderer never concatenates untrusted values into HTML.
* Every actual send pins a `MarketingTemplateRevision` (content hash) so what was sent can be reconstructed.

## 4. Retention and deletion

`POST …/action/retention/dryRun` (administrator) reports, for a cutoff, how many `marketing_events` rows and
sent/delivered delivery rows would be removed. Two rules hold:

* **Suppression is excluded from retention, permanently.** Deleting it could re-email an opted-out person.
* The dry run is the only implemented operation; there is no destructive bulk delete behind this release. An
  operator who needs actual purging does it deliberately, per the runbook, not by calling a hidden flag.

Consent history (`MarketingConsentEvent`) is append-only and records actor/source, prior state, new state and
reason, which is what a data-subject request is answered from.

## 5. What is logged, and what is not

Logged: campaign/send/journey ids, state transitions, provider error **codes**, batch totals, inbox ids,
`processed_with_errors` reasons.

Never logged: message bodies, recipient lists, raw tokens, provider secrets, webhook signatures, SMTP
credentials, `DATABASE_URL`. The settings API returns provider **keys and counts**, never credentials; the
health endpoint reports the test-send allowlist as a boolean and a count, never the addresses.

## 6. Known limits (risk accepted, not hidden)

| Limit | Consequence | Mitigation |
| --- | --- | --- |
| Public endpoints are rate-limited only by the platform's global limiter (`RATE_LIMIT_MAX`) | a determined caller can spend the deployment's request budget | deploy behind a WAF/proxy rate limit for `/public/*` |
| `public/click` cannot forward to a third-party host | external link click tracking is not available | provider-reported `clicked` events are the supported path |
| No per-recipient open pixel | open rate is provider-dependent | report `delivered` for reach; `opened` is labelled approximate |
| An unkeyed `ENCRYPTION_KEY` makes identity digests dictionary-attackable | weak pseudonymity | set `ENCRYPTION_KEY`; the health endpoint reports `unkeyed` |
| Webhook dedupe is keyed on the provider's event id | a provider that reuses ids loses events | confirm the provider's id semantics before go-live (runbook §2) |
| Legal compliance is deployment-specific | the module implements controls, not legal advice | counsel review per jurisdiction before enabling promotional sending |
