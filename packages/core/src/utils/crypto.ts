/**
 * Secret-at-rest encryption for mail account credentials (PLAN §28.3: "Secrets and credentials must
 * be stored encrypted at rest").
 *
 * AES-256-GCM with a random 96-bit IV per encryption; the payload carries its own version tag so a
 * future algorithm change can re-encrypt lazily. The key comes from `ENCRYPTION_KEY` (64 hex chars)
 * and is supplied by the caller — this module never reads the environment itself.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const KEY_BYTES = 32;

export class SecretDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretDecryptionError';
  }
}

function keyBuffer(key: string): Buffer {
  const trimmed = key.trim();
  if (trimmed.length !== KEY_BYTES * 2 || !/^[0-9a-fA-F]+$/.test(trimmed)) {
    throw new SecretDecryptionError(
      `Encryption key must be ${String(KEY_BYTES * 2)} hex characters (32 bytes), got ${String(trimmed.length)} characters.`,
    );
  }
  return Buffer.from(trimmed, 'hex');
}

/** Encrypts a secret into a self-describing payload safe to store in a TEXT column. */
export function encryptSecret(plaintext: string, key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBuffer(key), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`;
}

/** Decrypts a payload produced by {@link encryptSecret}; throws SecretDecryptionError otherwise. */
export function decryptSecret(payload: string, key: string): string {
  const parts = payload.trim().split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new SecretDecryptionError('Unsupported encrypted payload; expected a "v1:" secret payload.');
  }
  const ivPart = parts[1] as string;
  const tagPart = parts[2] as string;
  const dataPart = parts[3] as string;
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyBuffer(key), Buffer.from(ivPart, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(dataPart, 'base64url')), decipher.final()]).toString('utf8');
  } catch (error) {
    // A wrong key or a tampered row both land here; the cause is never logged or returned.
    throw new SecretDecryptionError(
      `Could not decrypt the stored secret (${error instanceof Error ? error.message : 'invalid payload'}). Check ENCRYPTION_KEY.`,
    );
  }
}