import { isIP } from 'node:net';

/**
 * Canonical host/address classification for every outbound destination the platform validates.
 *
 * Phase 23.5 (plan §11 task 3) found four independent copies of this rule, and the copies disagreed
 * about IPv6: `https://[::1]/` passed one of them because the URL parser keeps the brackets, and an
 * IPv4-mapped address written in hex (`::ffff:7f00:1`) passed another. A validator that misses one
 * spelling of loopback is not a partial control — it is a bypass. So the classification lives here
 * once, and each caller keeps only its own protocol/allowlist policy.
 *
 * `private` deliberately includes invalid input: a caller that cannot prove an address is public must
 * refuse it. `loopback` is reported separately because a self-hosted runtime may opt in to it.
 */

export type AddressKind = 'public' | 'loopback' | 'private' | 'invalid';

const METADATA_HOSTNAMES: ReadonlySet<string> = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'metadata',
]);

/** Lower-cases a hostname and removes IPv6 brackets and a trailing root dot. */
export function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
}

export function isMetadataHostname(hostname: string): boolean {
  return METADATA_HOSTNAMES.has(normalizeHostname(hostname));
}

/** True for `localhost`, any `*.localhost` name, `127.0.0.0/8` and `::1`. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  return classifyAddress(host) === 'loopback';
}

/** Classifies an IPv4 or IPv6 literal. Anything unparseable is `invalid`, never `public`. */
export function classifyAddress(address: string): AddressKind {
  const value = stripZoneId(address.trim());
  const ipv4 = parseIpv4(value);
  if (ipv4 !== null) return classifyIpv4(ipv4);
  const ipv6 = parseIpv6(value);
  if (ipv6 === null) return 'invalid';
  return classifyIpv6(ipv6);
}

export function isLoopbackAddress(address: string): boolean {
  return classifyAddress(address) === 'loopback';
}

/** True for loopback, private, reserved and malformed addresses — everything that is not public. */
export function isPrivateAddress(address: string): boolean {
  return classifyAddress(address) !== 'public';
}

export function isPublicAddress(address: string): boolean {
  return classifyAddress(address) === 'public';
}

function stripZoneId(value: string): string {
  const index = value.indexOf('%');
  return index === -1 ? value : value.slice(0, index);
}

function parseIpv4(value: string): readonly number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const numbers: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const number = Number(part);
    if (number < 0 || number > 255) return null;
    numbers.push(number);
  }
  return numbers;
}

function classifyIpv4(parts: readonly number[]): AddressKind {
  const [a = 0, b = 0, c = 0] = parts;
  if (a === 127) return 'loopback';
  if (a === 0 || a === 10) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'private'; // carrier-grade NAT
  if (a === 169 && b === 254) return 'private'; // link-local, including metadata
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return 'private'; // IETF + TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return 'private';
  if (a === 198 && (b === 18 || b === 19)) return 'private'; // benchmarking
  if (a === 198 && b === 51 && c === 100) return 'private'; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return 'private'; // TEST-NET-3
  if (a >= 224) return 'private'; // multicast, reserved, broadcast
  return 'public';
}

function parseIpv6(input: string): readonly number[] | null {
  let value = input.toLowerCase();
  if (isIP(value) !== 6) return null;

  // Express an embedded dotted quad as two hexadecimal groups so the rest of the parser sees one form.
  const lastColon = value.lastIndexOf(':');
  if (lastColon === -1) return null;
  const tailToken = value.slice(lastColon + 1);
  if (tailToken.includes('.')) {
    const embedded = parseIpv4(tailToken);
    if (embedded === null) return null;
    const high = ((embedded[0] ?? 0) << 8) | (embedded[1] ?? 0);
    const low = ((embedded[2] ?? 0) << 8) | (embedded[3] ?? 0);
    value = `${value.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`;
  }

  const halves = value.split('::');
  if (halves.length > 2) return null;
  const headRaw = halves[0] ?? '';
  const tailRaw = halves[1];
  const head = headRaw === '' ? [] : headRaw.split(':');
  const tail = tailRaw === undefined || tailRaw === '' ? [] : tailRaw.split(':');
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 && head.length !== 8) return null;
  if (missing < 0) return null;

  const tokens = [...head, ...new Array<string>(missing).fill('0'), ...tail];
  const groups = tokens.map((token) => (/^[0-9a-f]{1,4}$/.test(token) ? Number.parseInt(token, 16) : Number.NaN));
  if (groups.length !== 8 || groups.some((group) => !Number.isInteger(group))) return null;
  return groups;
}

function classifyIpv6(groups: readonly number[]): AddressKind {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;

  if (groups.every((group) => group === 0)) return 'private'; // unspecified
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) return 'loopback';

  // IPv4-mapped (::ffff:0:0/96) and the deprecated IPv4-compatible (::/96) forms.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    return classifyEmbeddedIpv4(g6, g7);
  }
  // NAT64 well-known prefix 64:ff9b::/96.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return classifyEmbeddedIpv4(g6, g7, true);
  }
  // 6to4 (2002::/16) carries the destination IPv4 address in the next two groups. Embedded loopback
  // is private here, not loopback: `2002:7f00:1::` is a public six-to-four address, and treating it as
  // loopback would let an opted-in self-hosted connection reach 127.0.0.1 through a relay.
  if (g0 === 0x2002) return classifyEmbeddedIpv4(g1, g2, true);
  // Teredo (2001:0::/32) carries the client IPv4 address XORed with all ones.
  if (g0 === 0x2001 && g1 === 0) return classifyEmbeddedIpv4(g6 ^ 0xffff, g7 ^ 0xffff, true);

  if (g0 === 0x2001 && g1 === 0x0db8) return 'private'; // documentation range
  if ((g0 & 0xfe00) === 0xfe00) return 'private'; // link-local fe80::/10 and deprecated site-local fec0::/10
  if ((g0 & 0xfe00) === 0xfc00) return 'private'; // unique-local fc00::/7
  if ((g0 & 0xff00) === 0xff00) return 'private'; // multicast
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return 'private'; // discard-only 100::/64
  return 'public';
}

function classifyEmbeddedIpv4(high: number, low: number, loopbackIsPrivate = false): AddressKind {
  const kind = classifyIpv4([(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff]);
  return loopbackIsPrivate && kind === 'loopback' ? 'private' : kind;
}
