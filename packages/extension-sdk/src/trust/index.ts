import { createHash, createPublicKey, type KeyObject,verify } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';

import { ExtensionError } from '../errors/index.js';

/**
 * Extension package trust (Phase 23.6, PLAN §38.4).
 *
 * An extension is executable code that runs inside the API process with the platform's database
 * handle. The directory is deployment-owned, but "the operator copied it there" is not evidence
 * that the bytes are the reviewed release: a package can be altered after installation, or pulled
 * from a compromised mirror. The trust check therefore binds the *whole package content* to an
 * Ed25519 key the deployment already trusts.
 *
 * Signed material is a canonical file digest, not a hash of a manifest field:
 *
 *   for each regular file under the package root, except `extension.sig`, sorted by POSIX path:
 *     "<relative path>\n<size in bytes>\n<sha256 hex>\n"
 *
 * `extension.sig` is a JSON document:
 *
 *   { "keyId": "caro-release-2026", "algorithm": "ed25519", "signature": "<base64>" }
 *
 * Ed25519 signs the UTF-8 digest string directly (`crypto.verify(null, ...)`). Changing, adding or
 * removing any file — including the backend module, metadata, migrations or manifest — invalidates
 * the signature.
 *
 * Modes:
 *   - `off`     — no verification (development only; never the production default).
 *   - `warn`    — untrusted packages still load, and the loader records a warning.
 *   - `enforce` — untrusted packages are refused before metadata or code is read.
 */

export const EXTENSION_SIGNATURE_FILE = 'extension.sig';

export type ExtensionTrustMode = 'off' | 'warn' | 'enforce';

export interface ExtensionTrustPolicy {
  readonly mode: ExtensionTrustMode;
  /** Trusted Ed25519 public keys, keyed by the `keyId` named in `extension.sig`. */
  readonly trustedKeys: ReadonlyMap<string, KeyObject>;
}

export interface ExtensionTrustDecision {
  readonly trusted: boolean;
  readonly keyId: string | null;
  /** `null` when trusted; otherwise an operator-readable reason. */
  readonly reason: string | null;
}

const OFF: ExtensionTrustDecision = { trusted: true, keyId: null, reason: null };

/**
 * Parses `EXTENSION_TRUSTED_KEYS`: a JSON object of `keyId -> PEM` or `keyId -> base64 SPKI DER`.
 * A malformed value is an operator error and fails the boot; silently treating it as "no keys"
 * would turn a typo into an open trust store.
 */
export function parseTrustedKeys(value: string | Record<string, string>): Map<string, KeyObject> {
  let parsed: unknown;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch (error: unknown) {
      throw new ExtensionError('EXTENSION_SIGNATURE_INVALID', 'EXTENSION_TRUSTED_KEYS is not valid JSON.', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    parsed = value;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ExtensionError('EXTENSION_SIGNATURE_INVALID', 'EXTENSION_TRUSTED_KEYS must be a JSON object of keyId to public key.');
  }

  const keys = new Map<string, KeyObject>();
  for (const [keyId, encoded] of Object.entries(parsed)) {
    if (typeof encoded !== 'string' || encoded.trim() === '') {
      throw new ExtensionError('EXTENSION_SIGNATURE_INVALID', `Trusted extension key "${keyId}" must be a non-empty string.`, { keyId });
    }
    try {
      keys.set(keyId, importPublicKey(encoded));
    } catch (error: unknown) {
      throw new ExtensionError('EXTENSION_SIGNATURE_INVALID', `Trusted extension key "${keyId}" is not a valid public key.`, {
        keyId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return keys;
}

/** Builds the policy once at boot; the loader and the admin installer share it. */
export function extensionTrustPolicy(mode: ExtensionTrustMode, trustedKeys: string | Record<string, string>): ExtensionTrustPolicy {
  return { mode, trustedKeys: parseTrustedKeys(trustedKeys) };
}

/** The canonical digest string that a package signature covers. */
export function extensionPackageDigest(dir: string): string {
  const files = listPackageFiles(dir).filter((file) => file !== EXTENSION_SIGNATURE_FILE).sort();
  let canonical = '';
  for (const file of files) {
    const bytes = readFileSync(join(dir, file.split('/').join(sep)));
    canonical += `${file}\n${bytes.length}\n${createHash('sha256').update(bytes).digest('hex')}\n`;
  }
  return canonical;
}

export function verifyExtensionPackage(dir: string, policy: ExtensionTrustPolicy): ExtensionTrustDecision {
  if (policy.mode === 'off') return OFF;

  let signature: { keyId: string; algorithm: string; signature: Buffer };
  try {
    signature = readSignature(dir);
  } catch (error: unknown) {
    return { trusted: false, keyId: null, reason: error instanceof Error ? error.message : String(error) };
  }

  if (signature.algorithm !== 'ed25519') {
    return { trusted: false, keyId: signature.keyId, reason: `unsupported signature algorithm "${signature.algorithm}"` };
  }
  const key = policy.trustedKeys.get(signature.keyId);
  if (key === undefined) {
    return { trusted: false, keyId: signature.keyId, reason: `signing key "${signature.keyId}" is not trusted` };
  }

  try {
    const valid = verify(null, Buffer.from(extensionPackageDigest(dir), 'utf8'), key, signature.signature);
    return valid
      ? { trusted: true, keyId: signature.keyId, reason: null }
      : { trusted: false, keyId: signature.keyId, reason: 'package content does not match its signature' };
  } catch (error: unknown) {
    return { trusted: false, keyId: signature.keyId, reason: `signature verification failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function readSignature(dir: string): { keyId: string; algorithm: string; signature: Buffer } {
  let text: string;
  try {
    text = readFileSync(join(dir, EXTENSION_SIGNATURE_FILE), 'utf8');
  } catch {
    throw new Error(`package is unsigned (missing ${EXTENSION_SIGNATURE_FILE})`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${EXTENSION_SIGNATURE_FILE} is not valid JSON`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${EXTENSION_SIGNATURE_FILE} must be a JSON object`);
  }
  const record = value as Record<string, unknown>;
  const keyId = record['keyId'];
  const algorithm = record['algorithm'] ?? 'ed25519';
  const encoded = record['signature'];
  if (typeof keyId !== 'string' || keyId.trim() === '') throw new Error(`${EXTENSION_SIGNATURE_FILE} has no keyId`);
  if (typeof algorithm !== 'string') throw new Error(`${EXTENSION_SIGNATURE_FILE} has an invalid algorithm`);
  if (typeof encoded !== 'string' || encoded.trim() === '') throw new Error(`${EXTENSION_SIGNATURE_FILE} has no signature`);
  const signature = Buffer.from(encoded, 'base64');
  if (signature.length !== 64) throw new Error(`${EXTENSION_SIGNATURE_FILE} is not a 64-byte Ed25519 signature`);
  return { keyId, algorithm, signature };
}

function listPackageFiles(dir: string, prefix = ''): string[] {
  const entries = readdirSync(join(dir, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    // A package that ships a symlink could make the digest read bytes outside its directory, and
    // the backend importer would follow the same link. Refuse it instead of resolving it.
    if (entry.isSymbolicLink()) throw new Error(`package contains a symbolic link ("${path}")`);
    if (entry.isDirectory()) files.push(...listPackageFiles(dir, path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function importPublicKey(encoded: string): KeyObject {
  const value = encoded.trim();
  if (value.includes('BEGIN')) return createPublicKey(value);
  return createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' });
}
