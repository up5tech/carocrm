import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { ValidationError } from '@carocrm/core/errors/index.js';

/**
 * Phase 19-AI.4 — provider URL safety
 * (PLAN_Phase_19_AI_Agents.md §7.4, §11.1, §20 `19-AI.4`).
 *
 * A provider `baseUrl` is administrator-supplied, but it is still an outbound destination chosen by
 * configuration. The rules are deliberately narrow:
 *
 *  - `http` and `https` are both accepted; a plain `http` URL is allowed (credentials travel in
 *    plaintext, so prefer `https` for non-local endpoints);
 *  - no credentials in the URL; *  - cloud metadata and link-local destinations are always refused;
 *  - loopback is allowed **only** outside production and **only** when the connection explicitly
 *    opts in (a local Ollama/self-hosted runtime), so a normal connection cannot reach the host;
 *  - RFC1918/ULA ranges are refused.
 *
 * DNS is resolved here, and again by `fetch`, so a record that changes between the check and the call
 * is a residual rebinding risk. Redirects are disabled in the adapter (`redirect: 'error'`) and the
 * endpoint is admin-only and audited, which is the boundary this phase documents.
 */

export interface ProviderUrlOptions {
  readonly allowLoopback: boolean;
}

export interface SafeProviderUrl {
  readonly url: URL;
  readonly loopback: boolean;
}

const METADATA_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  '169.254.169.254',
]);

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1';
}

/** True for IPv4/IPv6 addresses that must never be reached by an external-provider connection. */
export function isPrivateAddress(address: string): boolean {
  const value = address.toLowerCase().split('%')[0] ?? '';
  if (isIP(value) === 4) return isPrivateIpv4(value);
  if (isIP(value) === 6) {
    if (value === '::1' || value === '::') return true;
    if (value.startsWith('fe80') || value.startsWith('fc') || value.startsWith('fd')) return true;
    // IPv4-mapped address, e.g. ::ffff:10.0.0.1
    const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1] !== undefined) return isPrivateIpv4(mapped[1]);
    return false;
  }
  return true;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part));
  const [a, b] = parts;
  if (a === undefined || b === undefined) return true;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  return false;
}

export async function assertSafeProviderBaseUrl(raw: string, options: ProviderUrlOptions): Promise<SafeProviderUrl> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError('The provider base URL is not a valid absolute URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ValidationError('Provider base URLs must use http or https.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new ValidationError('Provider base URLs must not carry credentials.');
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname === '') throw new ValidationError('The provider base URL must name a host.');
  if (METADATA_HOSTS.has(hostname) || (isIP(hostname) === 4 && hostname === '169.254.169.254')) {
    throw new ValidationError('Provider base URLs must not target cloud metadata endpoints.');
  }

  const loopback = isLoopbackHost(hostname);
  if (loopback) {
    if (!options.allowLoopback) {
      throw new ValidationError(
        'This connection does not allow a loopback provider. Enable the self-hosted option only for a local runtime.',
      );
    }
    return { url, loopback: true };
  }

  let addresses: readonly { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new ValidationError(`The provider host "${hostname}" could not be resolved.`);
  }
  if (addresses.length === 0) throw new ValidationError(`The provider host "${hostname}" resolved to no address.`);
  for (const entry of addresses) {
    if (isPrivateAddress(entry.address)) {
      throw new ValidationError('Provider base URLs must not resolve to a private, loopback or link-local address.');
    }
  }
  return { url, loopback: false };
}
