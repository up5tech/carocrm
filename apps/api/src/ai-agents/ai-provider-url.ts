import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { ValidationError } from '@carocrm/core/errors/index.js';
import {
  isLoopbackHostname,
  isMetadataHostname,
  isPrivateAddress,
  normalizeHostname,
} from '@carocrm/core/net/address.js';

/**
 * Phase 19-AI.4 — provider URL safety
 * (plans/PLAN_Phase_19_AI_Agents.md §7.4, §11.1, §20 `19-AI.4`).
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

/** Phase 23.5: the classification itself is shared with every other outbound-URL validator. */
export const isLoopbackHost = isLoopbackHostname;
export { isPrivateAddress };

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
  const hostname = normalizeHostname(url.hostname);
  if (hostname === '') throw new ValidationError('The provider base URL must name a host.');
  if (isMetadataHostname(hostname) || (isIP(hostname) === 4 && hostname === '169.254.169.254')) {
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
