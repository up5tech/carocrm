import type { ExtensionTrustPolicy } from '@carocrm/extension-sdk';
import { extensionTrustPolicy } from '@carocrm/extension-sdk';

import type { AppConfig } from '../config.js';

/**
 * Phase 23.6 — one trust policy for boot and for the admin installer.
 *
 * Both paths must agree: an operator must not be able to install a package through
 * `POST /api/v1/Extension/:id/install` that the next boot would refuse, nor the reverse. The
 * policy parses `EXTENSION_TRUSTED_KEYS` once per call; a malformed value throws and the boot (or
 * the request) fails instead of silently trusting everything.
 */
export function extensionTrustFromConfig(config: AppConfig): ExtensionTrustPolicy {
  return extensionTrustPolicy(config.extensionTrustMode, config.extensionTrustedKeys);
}
