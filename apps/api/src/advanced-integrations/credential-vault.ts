import { randomUUID } from 'node:crypto';

import { ValidationError } from '@carocrm/core/errors/index.js';
import { decryptSecret, encryptSecret, SecretDecryptionError } from '@carocrm/core/utils/crypto.js';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { type AppConfig, CONFIG_TOKEN } from '../config.js';
import { DatabaseService } from '../database/database.service.js';
import { type CredentialState, type SecretKind } from './advanced-integrations-domain.js';

/**
 * Phase 19-INT.4 — the credential vault
 * (`PLAN_Phase_19_Advanced_Integrations.md` §6.3, §7.3; `19-INT.4`; ADR 0001).
 *
 * The platform already owns a secret-at-rest primitive: AES-256-GCM with a per-encryption random
 * IV and a self-describing payload (`packages/core/src/utils/crypto.ts`), keyed by
 * `ENCRYPTION_KEY`. Three features already use it.
 *
 * This file is the **narrow port** the plan asks for: the domain talks to `CredentialVaultPort`
 * and never to `encryptSecret` directly, so encryption is not scattered through the domain and the
 * key is reachable from exactly one place.
 *
 * The ciphertext lives in its own table, `integration_credential_secrets`, never in
 * `entity_records.attrs`. That is what makes "a secret can never leak through the generic entity
 * API" a property of the data model rather than a convention.
 */

/** What the vault stores. Never returned by a read API. */
export interface StoredCredential {
  readonly id: string;
  readonly connectionId: string;
  readonly kind: SecretKind;
  readonly state: CredentialState;
  readonly createdAt: string;
  readonly modifiedAt: string;
  readonly rotatedAt: string | null;
  readonly revokedAt: string | null;
  /** ISO timestamp at which the credential stops being usable, when it has one. */
  readonly expiresAt: string | null;
}

/**
 * The vault port.
 *
 * `read` is the only way to obtain a plaintext value and it is permission-gated by the caller.
 * `describe` never returns one.
 */
export interface CredentialVaultPort {
  /** Store a secret, or replace the one of the same kind on the connection. */
  store(input: {
    connectionId: string;
    kind: SecretKind;
    value: string;
    expiresAt?: string | null;
  }): Promise<StoredCredential>;
  /** The plaintext value, or `null` when there is none or it was revoked. */
  read(input: { connectionId: string; kind: SecretKind }): Promise<string | null>;
  /** The metadata, never the value. */
  describe(input: { connectionId: string; kind: SecretKind }): Promise<StoredCredential | null>;
  /** Every credential a connection holds. */
  list(connectionId: string): Promise<readonly StoredCredential[]>;
  /** Replace a value in place; the row keeps its identity so references stay valid. */
  rotate(input: { connectionId: string; kind: SecretKind; value: string; expiresAt?: string | null }): Promise<StoredCredential>;
  /** Mark a credential revoked. The ciphertext is overwritten, not kept. */
  revoke(input: { connectionId: string; kind: SecretKind }): Promise<void>;
  /** Remove every credential a connection holds. */
  removeConnection(connectionId: string): Promise<void>;
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
export class EncryptedCredentialVault implements CredentialVaultPort {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
  ) {}

  async store(input: {
    connectionId: string;
    kind: SecretKind;
    value: string;
    expiresAt?: string | null;
  }): Promise<StoredCredential> {
    const value = input.value.trim();
    if (value === '') throw new ValidationError('A stored secret cannot be empty.');
    const payload = this.encrypt(value);
    const now = new Date();
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    // One credential per (connection, kind). A second store of the same kind replaces the value
    // rather than accumulating rows nobody can tell apart.
    const row = await sql<CredentialRow>`
      insert into integration_credential_secrets
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
    const created = row.rows[0];
    if (!created) throw new ValidationError('The credential could not be stored.');
    return toStored(created);
  }

  async read(input: { connectionId: string; kind: SecretKind }): Promise<string | null> {
    const row = await this.requireRow(input.connectionId, input.kind);
    if (!row) return null;
    if (row.state === 'revoked') return null;
    return this.decrypt(row.payload_encrypted);
  }

  async describe(input: { connectionId: string; kind: SecretKind }): Promise<StoredCredential | null> {
    const row = await this.requireRow(input.connectionId, input.kind);
    return row ? toStored(row) : null;
  }

  async list(connectionId: string): Promise<readonly StoredCredential[]> {
    const rows = await sql<CredentialRow>`
      select * from integration_credential_secrets where connection_id = ${connectionId} order by kind asc
    `.execute(this.database.db);
    return rows.rows.map((row) => toStored(row));
  }

  async rotate(input: {
    connectionId: string;
    kind: SecretKind;
    value: string;
    expiresAt?: string | null;
  }): Promise<StoredCredential> {
    const value = input.value.trim();
    if (value === '') throw new ValidationError('A stored secret cannot be empty.');
    const existing = await this.requireRow(input.connectionId, input.kind);
    if (!existing) return this.store(input);
    const expiresAt = input.expiresAt === undefined ? existing.expires_at : input.expiresAt ? new Date(input.expiresAt) : null;
    const row = await sql<CredentialRow>`
      update integration_credential_secrets set
        payload_encrypted = ${this.encrypt(value)},
        state = 'active',
        expires_at = ${expiresAt},
        rotated_at = now(),
        modified_at = now(),
        revoked_at = null
      where id = ${existing.id}
      returning *
    `.execute(this.database.db);
    const rotated = row.rows[0];
    if (!rotated) throw new ValidationError('The credential could not be rotated.');
    return toStored(rotated);
  }

  async revoke(input: { connectionId: string; kind: SecretKind }): Promise<void> {
    const existing = await this.requireRow(input.connectionId, input.kind);
    if (!existing) return;
    // The ciphertext is overwritten rather than kept, so a revoked credential cannot be recovered
    // from a database snapshot.
    await sql`
      update integration_credential_secrets set
        payload_encrypted = ${''},
        state = 'revoked',
        revoked_at = now(),
        modified_at = now()
      where id = ${existing.id}
    `.execute(this.database.db);
  }

  async removeConnection(connectionId: string): Promise<void> {
    await sql`delete from integration_credential_secrets where connection_id = ${connectionId}`.execute(
      this.database.db,
    );
  }

  private async requireRow(connectionId: string, kind: SecretKind): Promise<CredentialRow | null> {
    const rows = await sql<CredentialRow>`
      select * from integration_credential_secrets
      where connection_id = ${connectionId} and kind = ${kind}
      limit 1
    `.execute(this.database.db);
    return rows.rows[0] ?? null;
  }

  private encrypt(plaintext: string): string {
    if (this.config.encryptionKey.trim() === '') {
      throw new ValidationError(
        'ENCRYPTION_KEY is not configured, so a credential cannot be stored. Configure the platform encryption key and retry.',
      );
    }
    return encryptSecret(plaintext, this.config.encryptionKey);
  }

  private decrypt(payload: string): string {
    if (this.config.encryptionKey.trim() === '') {
      throw new ValidationError(
        'The credential is encrypted but ENCRYPTION_KEY is not configured; the connection cannot be used.',
      );
    }
    try {
      return decryptSecret(payload, this.config.encryptionKey);
    } catch (error) {
      if (error instanceof SecretDecryptionError) {
        throw new ValidationError(
          'The stored credential could not be decrypted. Check ENCRYPTION_KEY or re-enter the secret.',
        );
      }
      throw error;
    }
  }
}

function toStored(row: CredentialRow): StoredCredential {
  return {
    id: row.id,
    connectionId: row.connection_id,
    kind: row.kind as SecretKind,
    state: row.state as CredentialState,
    createdAt: row.created_at.toISOString(),
    modifiedAt: row.modified_at.toISOString(),
    rotatedAt: row.rotated_at ? row.rotated_at.toISOString() : null,
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
  };
}
