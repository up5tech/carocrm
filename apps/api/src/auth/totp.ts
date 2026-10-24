import { createHmac, randomBytes } from 'node:crypto';

/**
 * RFC 6238 TOTP over an RFC 4648 base32 secret — the standard authenticator-app contract, built
 * from `node:crypto`'s HMAC-SHA1 exactly as RFC 4226 §5.3 specifies. No third-party crypto
 * dependency and no invented primitives (AGENTS.md §5.3): HMAC is the whole construction.
 *
 * Everything here is a pure function so the login path and its tests share one definition.
 */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/[\s-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Invalid base32 character.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The 6-digit code for one 30-second time step at `atMs`. */
export function totpAt(secretBase32: string, atMs: number, stepSeconds = 30, digits = 6): string {
  const counter = Math.floor(atMs / 1000 / stepSeconds);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', base32Decode(secretBase32)).update(message).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    ((digest[offset + 1] ?? 0) << 16) |
    ((digest[offset + 2] ?? 0) << 8) |
    (digest[offset + 3] ?? 0);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * Accepts the neighbouring time step as well, so a phone whose clock drifts by up to 30 seconds
 * still signs in — the standard ±1-step validation window.
 */
export function totpVerify(secretBase32: string, code: string, atMs = Date.now(), window = 1): boolean {
  const normalized = code.replace(/[\s-]/g, '');
  if (!/^\d{6}$/.test(normalized)) return false;
  for (let step = -window; step <= window; step++) {
    if (totpAt(secretBase32, atMs + step * 30_000) === normalized) return true;
  }
  return false;
}

/** 160 bits of entropy, the RFC 4226 §4 recommended secret length. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The URI an authenticator app scans; the standard `otpauth://totp/...` shape. */
export function otpauthUri(account: string, secret: string, issuer: string): string {
  return (
    `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}` +
    `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
  );
}

/** The one-time codes shown once at enrollment, formatted `xxxx-xxxx`. */
export function newRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = randomBytes(4).toString('hex');
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });
}
