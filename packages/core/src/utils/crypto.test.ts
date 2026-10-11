import { describe, expect, it } from 'vitest';

import { decryptSecret, encryptSecret,SecretDecryptionError } from './crypto.js';

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const OTHER_KEY = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a secret and never stores the plaintext', () => {
    const payload = encryptSecret('hunter2', KEY);
    expect(payload.startsWith('v1:')).toBe(true);
    expect(payload).not.toContain('hunter2');
    expect(decryptSecret(payload, KEY)).toBe('hunter2');
  });

  it('uses a fresh IV per encryption', () => {
    expect(encryptSecret('same', KEY)).not.toBe(encryptSecret('same', KEY));
  });

  it('refuses to decrypt with the wrong key', () => {
    const payload = encryptSecret('secret', KEY);
    expect(() => decryptSecret(payload, OTHER_KEY)).toThrow(SecretDecryptionError);
  });

  it('rejects malformed payloads and invalid keys', () => {
    expect(() => encryptSecret('x', 'short')).toThrow(SecretDecryptionError);
    expect(() => decryptSecret('not-a-payload', KEY)).toThrow(SecretDecryptionError);
  });
});