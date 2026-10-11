import { createHash } from 'node:crypto';

import { v4 as uuidv4 } from 'uuid';

export function generateId(): string {
  return uuidv4();
}

export function generateShortId(): string {
  return uuidv4().replace(/-/g, '').substring(0, 8);
}

export function hashString(input: string, algorithm = 'sha256'): string {
  return createHash(algorithm).update(input).digest('hex');
}

export function generateApiKeyId(): string {
  return 'key_' + generateShortId();
}

export function generateApiKeySecret(): string {
  return Array.from({ length: 32 }, () =>
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[
      Math.floor(Math.random() * 62)
    ],
  ).join('');
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}