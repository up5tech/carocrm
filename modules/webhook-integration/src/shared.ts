import { createHmac } from 'node:crypto';

import { decryptSecret, encryptSecret } from '@carocrm/core/utils/crypto.js';
import { generateId } from '@carocrm/core/utils/id.js';

/**
 * Shared helpers of the `webhook-integration` package.
 *
 * Two rules from PLAN §48 are enforced here rather than in each caller:
 *
 *  - **Secrets at rest.** A signing secret is stored AES-256-GCM encrypted with the platform's
 *    `ENCRYPTION_KEY` and is never returned by a read path — only `hasSecret` is.
 *  - **SSRF protection.** A webhook URL is a user-supplied destination, so it is resolved and
 *    checked against loopback, link-local, cloud-metadata and RFC1918 ranges before any request is
 *    made. Redirects are not followed.
 */

/** Event types an endpoint can subscribe to; mirrors `DOMAIN_EVENT_TYPES` in `@carocrm/core`. */
export const SUPPORTED_EVENTS = ['entity.created', 'entity.updated', 'entity.deleted', 'entity.restored'] as const;

export interface WebhookEndpointRow {
  id: string;
  name: string;
  url: string;
  events: string[] | string;
  secret_encrypted: string | null;
  enabled: boolean;
  created_at: Date;
  modified_at: Date;
}

export interface WebhookEndpointView {
  id: string;
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
  /** Never the secret itself — only whether one is configured. */
  hasSecret: boolean;
  createdAt: string;
  modifiedAt: string;
}

export interface WebhookDeliveryRow {
  id: string;
  endpoint_id: string;
  event_type: string;
  payload: string;
  status: string;
  attempts: number;
  response_code: number | null;
  error: string | null;
  created_at: Date;
  modified_at: Date;
}

export class WebhookSecurityError extends Error {}

export function toEndpointView(row: WebhookEndpointRow): WebhookEndpointView {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    events: parseEvents(row.events),
    enabled: row.enabled,
    hasSecret: row.secret_encrypted !== null,
    createdAt: new Date(row.created_at).toISOString(),
    modifiedAt: new Date(row.modified_at).toISOString(),
  };
}

export function parseEvents(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((event): event is string => typeof event === 'string');
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((event): event is string => typeof event === 'string') : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Encrypts a signing secret; empty input clears it. Throws when the platform key is missing. */
export function encodeSecret(secret: string): string | null {
  if (secret.trim() === '') return null;
  const key = process.env.ENCRYPTION_KEY ?? '';
  if (key === '') throw new WebhookSecurityError('ENCRYPTION_KEY is not configured; webhook secrets cannot be stored.');
  return encryptSecret(secret, key);
}

export function decodeSecret(row: WebhookEndpointRow): string | null {
  if (row.secret_encrypted === null) return null;
  const key = process.env.ENCRYPTION_KEY ?? '';
  if (key === '') return null;
  try {
    return decryptSecret(row.secret_encrypted, key);
  } catch {
    // A wrong key or a tampered row both land here; the cause is never logged or returned.
    return null;
  }
}

/**
 * Rejects destinations that could reach the host's own network (PLAN §48, SSRF protection).
 * Only `https` is allowed, and every address the hostname resolves to must be public.
 */
export async function assertPublicUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new WebhookSecurityError('The webhook URL is not a valid absolute URL.');
  }
  if (url.protocol !== 'https:') throw new WebhookSecurityError('Webhook URLs must use https.');
  if (url.username !== '' || url.password !== '') throw new WebhookSecurityError('Webhook URLs must not carry credentials.');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'metadata.google.internal') {
    throw new WebhookSecurityError('Webhook URLs must not target the local network.');
  }
  for (const address of await resolveHost(host)) {
    if (!isPublicAddress(address)) throw new WebhookSecurityError(`Webhook URL resolves to a private address (${address}).`);
  }
  return url;
}

async function resolveHost(host: string): Promise<string[]> {
  if (isIpv4(host) || host.includes(':')) return [host];
  try {
    const { lookup } = await import('node:dns/promises');
    const results = await lookup(host, { all: true });
    return results.map((entry) => entry.address);
  } catch {
    // An unresolvable host is rejected by the transport itself, not silently accepted here.
    return [];
  }
}

function isIpv4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function isPublicAddress(address: string): boolean {
  if (isIpv4(address)) return isPublicIpv4(address);
  const lower = address.toLowerCase();
  if (lower === '::' || lower === '::1') return false;
  // Unique-local (fc00::/7) and link-local (fe80::/10), plus IPv4-mapped private ranges.
  if (/^f[cd]/.test(lower)) return false;
  if (/^fe[89ab]/.test(lower)) return false;
  const mapped = /^::ffff:(\d{1,3}(\.\d{1,3}){3})$/.exec(lower);
  if (mapped?.[1] !== undefined) return isPublicIpv4(mapped[1]);
  return true;
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part));
  const [a, b] = parts;
  if (a === undefined || b === undefined) return false;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false; // link-local, including cloud metadata endpoints
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  return true;
}

/** `X-Caro-Signature: sha256=<hmac>` over the raw request body. */
export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

export function newEndpointId(): string {
  return generateId();
}