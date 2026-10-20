# ADR 0001 — Secret storage for provider credentials

* **Status:** Accepted
* **Phase:** 19-INT.1 (decided), implemented in 19-INT.4
* **Supersedes:** nothing
* **Related:** `docs/implementation/advanced-integrations-audit.md` §1.1, §2 ·
  `docs/modules/advanced-integrations/feature-contract.md` §5.8

## Context

`AdvancedIntegrations` must store provider credentials: OAuth access and refresh tokens, client
secrets, API keys and webhook signing secrets. The plan (§6.3) requires "the repository's
established secrets mechanism", and adds: *"If none exists, add a vault abstraction rather than
embedding encryption throughout the domain."*

The repository **does** have an established mechanism:

* `packages/core/src/utils/crypto.ts` — `encryptSecret` / `decryptSecret`, AES-256-GCM, a random
  96-bit IV per encryption, and a self-describing `v1:iv:tag:ciphertext` payload.
* The key comes from `ENCRYPTION_KEY` (64 hex characters), supplied by the caller. The primitive
  never reads the environment itself.
* Three existing features already use it: `email_accounts.smtp_password_encrypted`,
  `ai_provider_connections.api_key_encrypted`, and
  `voice_provider_accounts.credential_encrypted` / `webhook_secret_encrypted`.

The audit found what it does **not** have: no key identifier or version, no rotation path, no
vault abstraction, and no shared redaction helper.

## Decision

1. **Use the existing primitive.** Secrets are encrypted with `encryptSecret` and decrypted with
   `decryptSecret` from `@carocrm/core/utils/crypto.js`, using `config.encryptionKey`.
2. **Hide it behind a narrow port.** The domain talks to a `CredentialVaultPort`, never to
   `encryptSecret` directly. The port is implemented once by `EncryptedCredentialVault`.
3. **Store the ciphertext in a dedicated table**, `integration_credential_secrets`, never in
   `entity_records.attrs`. A dedicated table means the generic entity API cannot serialize a
   secret, and it lets the row carry the metadata the domain needs — secret kind, key version,
   token expiry, rotation and revocation timestamps, owner scope — without putting any of it in a
   JSON blob a generic read might return.
4. **A connection holds a reference, not a secret.** The connection row carries
   `credential_reference_id`. This is the plan's §6.2 `credential_reference_id` and it is what
   makes "never plain-text tokens" structurally true rather than a convention.
5. **Never return a secret.** Read APIs expose `hasCredential` and a non-secret
   `credentialHint` — a short prefix that identifies the credential to a human without disclosing
   it. The vault's `read` is the only path to a plaintext value, and it is permission-gated.
6. **Redact at the boundary.** A shared `redactSecrets()` helper masks credential-shaped keys in
   structured log payloads and in any object about to be returned. The redaction is applied where
   the value crosses a trust boundary, not at every call site.
7. **Fail closed when the key is missing.** If `ENCRYPTION_KEY` is unset, a write of a secret is
   refused with an actionable message, exactly as `VoiceProviderAccountsService` does. Reads of an
   already-encrypted secret fail with a message that names the cause without echoing the payload.

## Consequences

**Positive**

* No second cryptography, no new dependency, and one place to look for secret handling.
* The plan's "vault abstraction" requirement is satisfied without a new package.
* A secret can never leak through the generic entity API, because it is not in `entity_records`.

**Negative**

* **Key rotation is still open.** The payload is self-describing by *algorithm* version, not by
  *key* version; rotating `ENCRYPTION_KEY` today makes every stored secret undecryptable. This is
  pre-existing behaviour shared with `email_accounts` and the two provider-account stores, and it
  is recorded as unresolved dependency **U-2** in the feature contract. It is deliberately not
  solved here: changing the on-disk format for three existing features is a separate, reviewed
  change.
* The vault port is a local adapter, not a cloud secrets manager. Swapping in a real vault later
  means implementing the port, not changing the domain.

**Alternatives rejected**

| Alternative | Why rejected |
| --- | --- |
| Store secrets in `app_settings` / `entity_records` JSON | A generic read would serialize the secret. Unacceptable. |
| Add a cloud secrets manager dependency | A new infrastructure dependency for a capability the platform already has locally, before any connector exists. |
| Embed `encryptSecret` in each service | Exactly what the plan forbids ("rather than embedding encryption throughout the domain"). It also makes the encryption key reachable from many call sites. |
| Key version now | Touches three existing stores' on-disk format; a separate reviewed change. |
