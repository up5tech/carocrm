import { ValidationError } from '@carocrm/core/errors/index.js';

import { assertSafeProviderBaseUrl } from '../ai-agents/ai-provider-url.js';

/**
 * Phase 19-VC.15 — media URL safety
 * (`PLAN_Phase_19_Voice_Communications.md` §7.5, §15 `19-VC.15`).
 *
 * A provider recording URL is an outbound destination chosen by a callback, which is strictly worse
 * than an administrator-supplied base URL. The platform's SSRF validator is reused so both features
 * share one rule set (https only, no credentials, no metadata/link-local/RFC1918/ULA destinations,
 * loopback only outside production when explicitly allowed) plus a module-level host allowlist:
 * `media.allowedHosts` is empty by default, and an empty allowlist refuses every fetch.
 */
export async function assertSafeMediaUrl(
  raw: string,
  options: { readonly allowedHosts: readonly string[]; readonly allowLoopback: boolean },
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError('The media URL is not a valid URL.');
  }
  const host = url.hostname.toLowerCase();
  if (options.allowedHosts.length > 0 && !options.allowedHosts.some((allowed) => host === allowed.toLowerCase())) {
    throw new ValidationError(`The media host "${host}" is not on the configured media allowlist.`);
  }
  await assertSafeProviderBaseUrl(raw, { allowLoopback: options.allowLoopback });
  return url;
}
