import { randomUUID } from 'node:crypto';

import { ValidationError } from '@carocrm/core/errors/index.js';
import { decryptSecret, encryptSecret, SecretDecryptionError } from '@carocrm/core/utils/crypto.js';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { type AppConfig, CONFIG_TOKEN } from '../config.js';
import { DatabaseService } from '../database/database.service.js';
import { type ESignatureSecretKind,SECRET_KINDS } from './esignature-domain.js';
import { encryptionKeyMissingError } from './esignature-errors.js';

/**
 * Phase 19-ES.4 — the module's credential vault
 * (`PLAN_Phase_19_ESignature.md` §4.1, §6.1, §9.2; `19-ES.4` acceptance
 * "credentials are absent from logs, frontend bundles, API responses and normal configuration output").
 *
 * Advanced Integrations' `EncryptedCredentialVault` is the pattern, and the *table* is not reusable:
 * `integration_credential_secrets.connection_id` foreign-keys `integration_connections (id)`, so an
 * ESignature connection's credential cannot be stored there without changing a table that module
 * owns. `esignature_credential_secrets` (migration `065`) therefore mirrors the column set, the
 * `kind` allowlist and the `state` machine exactly, and this file mirrors the port: the same
 * AES-256-GCM primitive from `@carocrm/core`, the same one-credential-per-`(connection, kind)` rule,
 * the same overwrite-on-revoke.
 *
 * Three rules make the acceptance criterion a property of the code rather than a habit:
 *
 * 1. **`read` is the only method that returns a plaintext**, and its callers are the OAuth exchange
 *    and the adapter context builder — never a controller. `describe` and `list` return metadata,
 *    which is what every view in this module shows.
 * 2. **Nothing is ever logged here.** No logger is injected, so there is no call site that could
 *    write a credential by accident.
 * 3. **A revoked credential loses its ciphertext.** Overwriting beats keeping it, so a database
 *    snapshot taken after a disconnect does not contain a usable secret (plan §9.2).
 */

/** What the vault holds. The plaintext is deliberately not part of this shape. */
export interface ESignatureStoredCredential {
  readonly id: string;
  readonly connectionId: string;
  readonly kind: ESignatureSecretKind;
  readonly state: 'active' | 'revoked';
  readonly createdAt: string;
  readonly modifiedAt: string;
  readonly rotatedAt: string | null;
  readonly revokedAt: string | null;
  /** When the credential stops being usable — a fact, not a secret, and the refresh decision reads it without decrypting. */
  readonly expiresAt: string | null;
}

/** `store` accepts a value; every other method returns at most metadata. */
export interface ESignatureCredentialVaultPort {
  store(input: { connectionId: string; kind: ESignatureSecretKind; value: string; expiresAt?: string | null }): Promise<ESignatureStoredCredential>;
  read(input: { connectionId: string; kind: ESignatureSecretKind }): Promise<string | null>;
  describe(input: { connectionId: string; kind: ESignatureSecretKind }): Promise<ESignatureStoredCredential | null>;
  list(connectionId: string): Promise<readonly ESignatureStoredCredential[]>;
  revoke(input: { connectionId: string; kind: ESignatureSecretKind }): Promise<void>;
  /** Destroy every credential of a connection. Used by disconnect. */
  clear(connectionId: string): Promise<number>;
}

interface CredentialRow {
  id: string;
  connection_id: string;
  kind: string;
  state: string;
  payload_encrypted: string;
  expires_at: Date | null;
  created_at: Date;
  modified_at: Date;
  rotated_at: Date | null;
  revoked_at: Date | null;
}

@Injectable()
export class ESignatureCredentialVault implements ESignatureCredentialVaultPort {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
  ) {}

  async store(input: {
    connectionId: string;
    kind: ESignatureSecretKind;
    value: string;
    expiresAt?: string | null;
  }): Promise<ESignatureStoredCredential> {
    assertKind(input.kind);
    const value = input.value.trim();
    if (value === '') throw new ValidationError('A stored credential cannot be empty.');
    const payload = this.encrypt(value);
    const now = new Date();
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    const row = await sql<CredentialRow>`
      insert into esignature_credential_secrets
        (id, connection_id, kind, state, payload_encrypted, expires_at, created_at, modified_at)
      values
        (${randomUUID()}, ${input.connectionId}, ${input.kind}, 'active', ${payload}, ${expiresAt}, ${now}, ${now})
      on conflict (connection_id, kind) do update set
        payload_encrypted = excluded.payload_encrypted,
        state = 'active',
        expires_at = excluded.expires_at,
        rotated_at = now(),
        modified_at = now(),
        revoked_at = null
      returning *
    `.execute(this.database.db);
    const stored = row.rows[0];
    if (stored === undefined) throw new ValidationError('The credential could not be stored.');
    return toCredential(stored);
  }

  /**
   * The plaintext, or `null` when the connection holds none or it was revoked.
   *
   * Reachable only from the OAuth exchange and the adapter context builder. A controller that calls
   * this has turned a credential into a response body, which is the one thing this module may not do.
   */
  async read(input: { connectionId: string; kind: ESignatureSecretKind }): Promise<string | null> {
    assertKind(input.kind);
    const row = await this.requireRow(input.connectionId, input.kind);
    if (row === null || row.state === 'revoked') return null;
    return this.decrypt(row.payload_encrypted);
  }

  async describe(input: { connectionId: string; kind: ESignatureSecretKind }): Promise<ESignatureStoredCredential | null> {
    assertKind(input.kind);
    const row = await this.requireRow(input.connectionId, input.kind);
    return row === null ? null : toCredential(row);
  }

  async list(connectionId: string): Promise<readonly ESignatureStoredCredential[]> {
    const rows = await sql<CredentialRow>`
      select * from esignature_credential_secrets
      where connection_id = ${connectionId}
      order by kind asc
    `.execute(this.database.db);
    return rows.rows.map((row) => toCredential(row));
  }

  async revoke(input: { connectionId: string; kind: ESignatureSecretKind }): Promise<void> {
    assertKind(input.kind);
    const existing = await this.requireRow(input.connectionId, input.kind);
    if (existing === null) return;
    await sql`
      update esignature_credential_secrets set
        payload_encrypted = ${''},
        state = 'revoked',
        revoked_at = now(),
        modified_at = now()
      where id = ${existing.id}
    `.execute(this.database.db);
  }

  async clear(connectionId: string): Promise<number> {
    const result = await sql`
      delete from esignature_credential_secrets where connection_id = ${connectionId}
    `.execute(this.database.db);
    return Number(result.numAffectedRows ?? 0n);
  }

  private async requireRow(connectionId: string, kind: ESignatureSecretKind): Promise<CredentialRow | null> {
    const rows = await sql<CredentialRow>`
      select * from esignature_credential_secrets
      where connection_id = ${connectionId} and kind = ${kind}
      limit 1
    `.execute(this.database.db);
    return rows.rows[0] ?? null;
  }

  /**
   * Missing key is the module's stable `ENCRYPTION_KEY_MISSING` failure, not a generic validation
   * error: a connection whose credential cannot be encrypted is a gate condition, and the gate
   * already reports the same code.
   */
  private encrypt(plaintext: string): string {
    if (this.config.encryptionKey.trim() === '') throw encryptionKeyMissingError();
    return encryptSecret(plaintext, this.config.encryptionKey);
  }

  private decrypt(payload: string): string {
    if (this.config.encryptionKey.trim() === '') throw encryptionKeyMissingError();
    try {
      return decryptSecret(payload, this.config.encryptionKey);
    } catch (error) {
      if (error instanceof SecretDecryptionError) {
        throw new ValidationError('The stored credential could not be decrypted. Check ENCRYPTION_KEY or re-enter the secret.');
      }
      throw error;
    }
  }
}

/** The kind list is the schema's CHECK, enforced before the write so the failure is a name, not a database error. */
function assertKind(kind: string): asserts kind is ESignatureSecretKind {
  if (!(SECRET_KINDS as readonly string[]).includes(kind)) {
    throw new ValidationError(`"${kind}" is not a credential kind this module can store.`, { allowed: [...SECRET_KINDS] });
  }
}

function toCredential(row: CredentialRow): ESignatureStoredCredential {
  return {
    id: row.id,
    connectionId: row.connection_id,
    kind: row.kind as ESignatureSecretKind,
    state: row.state as 'active' | 'revoked',
    createdAt: row.created_at.toISOString(),
    modifiedAt: row.modified_at.toISOString(),
    rotatedAt: row.rotated_at ? row.rotated_at.toISOString() : null,
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
  };
}
