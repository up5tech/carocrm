import { type CanActivate, type CustomDecorator, type ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';

import { OmnichannelSettingsService } from './omnichannel-settings.service.js';

export const OMNICHANNEL_CONTROL_PLANE_KEY = 'omnichannel:control-plane';

/**
 * Marks a route as part of the module's control plane. A control-plane route stays reachable while
 * the workspace switch is off, so an administrator can still see why the module is off, read and
 * write its settings, exercise the data-rights commands and switch it back on.
 */
export function ControlPlane(): CustomDecorator {
  return SetMetadata(OMNICHANNEL_CONTROL_PLANE_KEY, true);
}

/**
 * The module switch as a route gate — the `crmChat` precedent, one layer down.
 *
 * `features.workspace` is the module-level kill switch: with it off the workspace is dead and every
 * agent-facing route answers 403 `FEATURE_DISABLED`. The gate sits on the controller so it is
 * **fail-closed by default**: a route added later is covered unless it is deliberately marked as
 * control plane. The routes that must stay reachable say so with `@ControlPlane()`.
 *
 * The public web-chat prefix is not covered here — it has its own fail-closed channel check (the
 * allowlist and the workspace switch), and the provider webhook prefix deliberately stays open so
 * receipts are still recorded; stopping inbound effects is the per-connection switch's job.
 */
@Injectable()
export class OmnichannelWorkspaceGuard implements CanActivate {
  constructor(@Inject(OmnichannelSettingsService) private readonly settings: OmnichannelSettingsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    if (Reflect.getMetadata(OMNICHANNEL_CONTROL_PLANE_KEY, handler) === true) return true;
    await this.settings.assertWorkspace();
    return true;
  }
}
