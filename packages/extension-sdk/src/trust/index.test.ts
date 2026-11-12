import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ExtensionError } from '../errors/index.js';
import { loadExtensions } from '../load/index.js';
import { scanExtensionPackages } from '../loader/index.js';
import {
  EXTENSION_SIGNATURE_FILE,
  extensionPackageDigest,
  extensionTrustPolicy,
  parseTrustedKeys,
  verifyExtensionPackage,
} from './index.js';

const roots: string[] = [];

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'carocrm-trust-'));
  roots.push(root);
  return root;
}

function package_(root: string, id = 'signed'): string {
  const dir = join(root, id);
  mkdirSync(join(dir, 'metadata'), { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ id, name: id, version: '1.0.0' }));
  writeFileSync(join(dir, 'metadata', 'entities.json'), '{"entities":{}}');
  writeFileSync(join(dir, 'backend.mjs'), 'export default {};');
  return dir;
}

function keypair(): { privateKey: KeyObject; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey: privateKey as KeyObject, publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
}

function signPackage(dir: string, privateKey: KeyObject, keyId = 'test-key'): void {
  const signature = sign(null, Buffer.from(extensionPackageDigest(dir), 'utf8'), privateKey).toString('base64');
  writeFileSync(join(dir, EXTENSION_SIGNATURE_FILE), JSON.stringify({ keyId, algorithm: 'ed25519', signature }));
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe('extension package trust', () => {
  it('accepts a package signed by a trusted key', () => {
    const root = workspace();
    const dir = package_(root);
    const { privateKey, publicKey } = keypair();
    signPackage(dir, privateKey);
    const policy = extensionTrustPolicy('enforce', { 'test-key': publicKey });

    expect(verifyExtensionPackage(dir, policy)).toEqual({ trusted: true, keyId: 'test-key', reason: null });
  });

  it('refuses an unsigned package and a package altered after signing', () => {
    const root = workspace();
    const dir = package_(root);
    const { privateKey, publicKey } = keypair();
    const policy = extensionTrustPolicy('enforce', { 'test-key': publicKey });

    expect(verifyExtensionPackage(dir, policy)).toMatchObject({ trusted: false, reason: expect.stringContaining('unsigned') });

    signPackage(dir, privateKey);
    expect(verifyExtensionPackage(dir, policy).trusted).toBe(true);

    writeFileSync(join(dir, 'backend.mjs'), 'export default { providers: ["evil"] };');
    const altered = verifyExtensionPackage(dir, policy);
    expect(altered.trusted).toBe(false);
    expect(altered.reason).toContain('does not match');
  });

  it('refuses a package signed by a key the deployment does not trust', () => {
    const root = workspace();
    const dir = package_(root);
    const { privateKey } = keypair();
    const other = keypair();
    signPackage(dir, privateKey, 'other-key');
    const policy = extensionTrustPolicy('enforce', { 'test-key': other.publicKey });

    expect(verifyExtensionPackage(dir, policy)).toMatchObject({
      trusted: false,
      keyId: 'other-key',
      reason: expect.stringContaining('not trusted'),
    });
  });

  it('enforce skips an untrusted package; warn keeps it and records the finding', () => {
    const root = workspace();
    package_(root);
    const { publicKey } = keypair();

    const enforced = scanExtensionPackages(root, { trust: extensionTrustPolicy('enforce', { 'test-key': publicKey }) });
    expect(enforced.packages).toEqual([]);
    expect(enforced.errors).toHaveLength(1);
    expect(enforced.errors[0]?.message).toContain('not trusted');

    const warned = scanExtensionPackages(root, { trust: extensionTrustPolicy('warn', { 'test-key': publicKey }) });
    expect(warned.packages.map((pkg) => pkg.id)).toEqual(['signed']);
    expect(warned.warnings).toHaveLength(1);
  });

  it('enforce refuses registration of an unsigned package, then loads it once signed', async () => {
    const root = workspace();
    const dir = package_(root);
    const { privateKey, publicKey } = keypair();
    const policy = extensionTrustPolicy('enforce', { 'test-key': publicKey });

    const blocked = await loadExtensions({ directory: root, enabledIds: new Set(['signed']), trust: policy });
    expect(blocked.size).toBe(0);
    expect(blocked.ids()).toEqual([]);

    signPackage(dir, privateKey);
    const loaded = await loadExtensions({ directory: root, enabledIds: new Set(['signed']), trust: policy });
    expect(loaded.ids()).toEqual(['signed']);
    expect(loaded.providers()).toEqual([]);
  });

  it('off leaves the package untouched', () => {
    const root = workspace();
    package_(root);
    expect(verifyExtensionPackage(join(root, 'signed'), extensionTrustPolicy('off', {}))).toEqual({
      trusted: true,
      keyId: null,
      reason: null,
    });
  });

  it('parses PEM and base64 SPKI keys, and rejects malformed key configuration', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const pem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
    expect(parseTrustedKeys({ pem }).size).toBe(1);

    expect(() => parseTrustedKeys('not-json')).toThrowError(ExtensionError);
    expect(() => parseTrustedKeys(JSON.stringify({ key: 'not-a-key' }))).toThrowError(/not a valid public key/);
  });
});
