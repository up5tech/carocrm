# Encryption-Key Rotation

> **Owner:** platform / operations
> **Introduced:** Phase 23.7 (2026-11-12); links to Phase 23.1 (cryptographic primitives) and 23.9
> (operational security).
> **Rule:** rotating `ENCRYPTION_KEY` without re-encrypting the stored payloads makes every credential
> undecryptable. The key change and the data pass are one operation.

## 1. What is encrypted, and with what

`packages/core/src/utils/crypto.ts` provides AES-256-GCM with a random 96-bit IV per value. The stored
payload is self-describing:

```
v1:<iv base64url>:<auth tag base64url>:<ciphertext base64url>
```

`ENCRYPTION_KEY` is **64 hexadecimal characters** (32 bytes). Production boot refuses an empty key;
a missing key disables the credential path rather than storing plaintext.

| Store | Column | Written by |
|---|---|---|
| `email_accounts` | `smtp_password_encrypted` | `email-accounts.service.ts` |
| `ai_provider_connections` | `api_key_encrypted` | `ai-provider-connections.service.ts` |
| `integration_credential_secrets` | `payload_encrypted` | `advanced-integrations/credential-vault.ts` |
| `esignature_credential_secrets` | `payload_encrypted` | `esignature/esignature-credential-vault.ts` |
| `voice_provider_accounts` | `credential_encrypted`, `webhook_secret_encrypted` | `voice-provider-accounts.service.ts` |

No other store keeps a provider secret in plaintext: `config` JSON is refused when it names a
credential, API responses expose only hints/booleans, and vault reads are audit-relevant operations.
The crypto primitive itself is covered by `packages/core/src/utils/crypto.test.ts` (round-trip,
random IV, wrong-key refusal, tamper/format refusal).

## 2. Rotation procedure

1. **Generate a new key** with a CSPRNG, e.g. `openssl rand -hex 32`. Do not reuse the old value.
2. **Stop writes** — stop the API and worker (or put the deployment in maintenance). A value written
   with the old key while the pass runs would be missed.
3. **Rehearse on a restore.** With `OLD_ENCRYPTION_KEY`, the *new* `ENCRYPTION_KEY` and the restore's
   `DATABASE_URL`, run the dry run. It counts what would change and rolls back:
   ```bash
   OLD_ENCRYPTION_KEY=<old> ENCRYPTION_KEY=<new> DATABASE_URL=<restore-url> \
     node scripts/rotate-encryption-key.mjs
   ```
4. **Apply on the primary** with an explicitly reviewed connection string:
   ```bash
   OLD_ENCRYPTION_KEY=<old> ENCRYPTION_KEY=<new> DATABASE_URL=<primary-url> \
     node scripts/rotate-encryption-key.mjs --apply
   ```
   The script walks the five stores in primary-key order, in batches of 200, inside **one**
   transaction. It aborts (and rolls back) if a payload decrypts with neither key; it never overwrites
   an unrecognised payload and never prints a plaintext or ciphertext.
5. **Replace the secret** in the deployment's secret store with the new key (`ENCRYPTION_KEY`), remove
   the old value, and start the API/worker. Keep the old key offline until one successful backup and
   restore drill has completed.
6. **Verify** by opening an existing credential-backed connection (mail account, connector,
   eSignature, voice account, AI provider) and exercising its read/health path, then by a restore drill
   under the new key.
7. **Record** the rotation date, operator, affected stores and the dry-run/apply counts in the
   operations log. The values themselves are never recorded.

## 3. Failure handling

- The script refuses to run when the two keys are equal and when a row is not a `v1:` payload. A
  plaintext or foreign payload is a finding to investigate, not a row to overwrite.
- If the pass fails mid-way the transaction rolls back; retry with the same old/new pair.
- If the process is interrupted after `--apply` but before the secret store is updated, the data is
  under the new key while the app still holds the old one. Restore the old key to the data from the
  verified backup, or finish the secret update — do not run the pass twice in the opposite direction
  without first confirming which key the data uses. The script treats "already decrypts with the new
  key" as a successful no-op, so a retry is safe.
- A lost key is unrecoverable by design (AES-GCM, no escrow in the application). That is why the key
  belongs in the deployment secret store/escrow, not in a repository file.

## 4. What this does not cover

- Backups and their encryption keys are Phase 23.9 (`scripts/backup.mjs` requires encryption by
  default); a database restore must be paired with the key that encrypted the credential payloads.
- Session tokens and JWTs use a separate secret and procedure: `docs/security/jwt-secret-rotation.md`.
- Key rotation does not re-encrypt audit rows (they contain redacted values, not secrets). Audit
  retention/tamper evidence is documented in `docs/security/data-retention.md` §3.
