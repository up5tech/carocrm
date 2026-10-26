import { Inject, Injectable } from '@nestjs/common';

import { OmnichannelPermissionService } from './omnichannel-permission.service.js';
import { OmnichannelSettingsService } from './omnichannel-settings.service.js';

/**
 * Phase 19-OM.2 — the module-visibility signal the navigation asked for
 * (`PLAN_Phase_19_Omnichannel.md` §14 `19-OM.2`; contract §3 F1).
 *
 * Omnichannel owns no metadata entity (decision D1: the records live in `VoiceCommunications`), so
 * the sidebar would otherwise either show a page that answers 403 on every call or hide a page the
 * caller may use. This answers one composed question from the platform's own ACL plus the module's
 * own switch: *does this caller hold the inbox-read capability, and is the workspace switched on?*
 *
 * It is a report, not a gate. Hiding a menu item is not a security control, and every route it
 * hides is refused server-side by `OmnichannelPermissionService` (AGENTS.md §5.3).
 */
@Injectable()
export class OmnichannelNavigationService {
  constructor(
    @Inject(OmnichannelPermissionService) private readonly permissions: OmnichannelPermissionService,
    @Inject(OmnichannelSettingsService) private readonly settings: OmnichannelSettingsService,
  ) {}

  async visibility(): Promise<{
    readonly visible: boolean;
    readonly admin: boolean;
    /** The module switch an administrator controls; `false` also drops it from the sidebar. */
    readonly enabled: boolean;
    /** The workspace capability the navigation seed is gated on. */
    readonly resource: string;
  }> {
    const [visible, admin] = await Promise.all([
      this.permissions.can('inboxView'),
      this.permissions.can('settingsManage'),
    ]);
    const enabled = (await this.settings.settings()).features.workspace;
    return {
      visible: visible && enabled,
      admin,
      enabled,
      resource: this.permissions.definition('inboxView').resource,
    };
  }
}
