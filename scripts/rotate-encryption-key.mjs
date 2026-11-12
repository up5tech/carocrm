#!/usr/bin/env node
/**
 * Phase 23.7 — re-encrypt every stored secret from OLD_ENCRYPTION_KEY to ENCRYPTION_KEY.
 *
 * `ENCRYPTION_KEY` is a 64-hex-character AES-256-GCM key. Rotating it is *not* a config change:
 * every `v1:` payload in the tables below was written with the old key, and replacing the variable
 * without this pass makes every credential undecryptable. This script walks the five stores, one
 * primary-key-ordered batch at a time, inside a single transaction:
 *
 *   - a row already encrypted with the new key is counted and left alone;
 *   - a row the old key cannot decrypt (and the new key cannot either) aborts the transaction —
 *     a plaintext or foreign payload is a finding, never something to overwrite;
 *   - with no `--apply` it only counts, so the operator can rehearse against a restore.
 *
 * Usage:
 *   OLD_ENCRYPTION_KEY=<64 hex> ENCRYPTION_KEY=<64 hex> DATABASE_URL=... \
 *     node scripts/rotate-encryption-key.mjs           # dry run
 *   ... node scripts/rotate-encryption-key.mjs --apply # commit
 *
 * Never prints a plaintext or a ciphertext. Stop the API/worker before `--apply`, then write the new
 * key into the deployment secret store and start them again. Procedure:
 * `docs/security/encryption-key-rotation.md`.
 */
import pg from 'pg';

import { decryptSecret, encryptSecret, SecretDecryptionError } from '@carocrm/core/utils/crypto.js';

const TARGETS = [
  { table: 'email_accounts', pk: 'id', columns: ['smtp_password_encrypted'] },
  { table: 'ai_provider_connections', pk: 'key', columns: ['api_key_encrypted'] },
  { table: 'integration_credential_secrets', pk: 'id', columns: ['payload_encrypted'] },
  { table: 'esignature_credential_secrets', pk: 'id', columns: ['payload_encrypted'] },
  { table: 'voice_provider_accounts', pk: 'id', columns: ['credential_encrypted', 'webhook_secret_encrypted'] },
];

const apply = process.argv.includes('--apply');
const oldKey = process.env.OLD_ENCRYPTION_KEY ?? '';
const newKey = process.env.ENCRYPTION_KEY ?? '';
const databaseUrl = process.env.DATABASE_URL ?? '';

if (!databaseUrl) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}
if (!oldKey || !newKey) {
  console.error('OLD_ENCRYPTION_KEY and ENCRYPTION_KEY are required.');
  process.exit(2);
}
if (oldKey === newKey) {
  console.error('OLD_ENCRYPTION_KEY and ENCRYPTION_KEY are the same; nothing to rotate.');
  process.exit(2);
}

const BATCH = 200;
const client = new pg.Client({ connectionString: databaseUrl });
let rotated = 0;
let alreadyNew = 0;

async function rotateColumn(target, column) {
  let cursor = '';
  for (;;) {
    const rows = await client.query({
      text: `SELECT ${target.pk} AS pk, ${column} AS payload FROM ${target.table}
              WHERE ${column} IS NOT NULL AND ${column} <> '' AND ${target.pk} > $1
              ORDER BY ${target.pk} LIMIT $2 FOR UPDATE`,
      values: [cursor, BATCH],
    });
    if (rows.rowCount === 0) return;
    for (const row of rows.rows) {
      cursor = String(row.pk);
      const payload = String(row.payload);
      if (!payload.startsWith('v1:')) {
        throw new Error(`${target.table}.${column} row ${cursor} is not a v1 payload; refusing to overwrite it.`);
      }
      let plaintext;
      try {
        plaintext = decryptSecret(payload, oldKey);
      } catch (oldError) {
        try {
          decryptSecret(payload, newKey);
          alreadyNew += 1;
          continue;
        } catch {
          throw new SecretDecryptionError(
            `${target.table}.${column} row ${cursor} decrypts with neither key (${oldError instanceof Error ? oldError.message : 'unknown'}); rotate from a restore, not by overwriting.`,
          );
        }
      }
      if (apply) {
        await client.query({
          text: `UPDATE ${target.table} SET ${column} = $1 WHERE ${target.pk} = $2`,
          values: [encryptSecret(plaintext, newKey), cursor],
        });
      }
      rotated += 1;
    }
    if (rows.rowCount < BATCH) return;
  }
}

try {
  await client.connect();
  await client.query('BEGIN');
  for (const target of TARGETS) {
    for (const column of target.columns) {
      await rotateColumn(target, column);
    }
  }
  if (apply) await client.query('COMMIT');
  else await client.query('ROLLBACK');
  console.log(
    `encryption key rotation ${apply ? 'committed' : 'dry run (rolled back)'}: ${String(rotated)} rotated, ${String(alreadyNew)} already new.`,
  );
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  console.error(error instanceof Error ? error.message : 'encryption key rotation failed');
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
