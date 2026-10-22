import { Inject, Injectable } from '@nestjs/common';

import { ESignatureConnectionGate } from './esignature-connection-gate.service.js';
import { ESignaturePermissionService } from './esignature-permission.service.js';
import { ESignatureSettingsService } from './esignature-settings.service.js';

/**
 * Phase 19-ES.1 — the module-visibility signal the navigation and the SPA ask for
 * (`PLAN_Phase_19_ESignature.md` §13.1; `19-ES.1`).
 *
 * ESignature owns no metadata entity: its requests and connections will be dedicated tables, so the
 * sidebar would otherwise either show a page that answers 403 on every call or hide a page the
 * caller may use. This answers one question from the platform's own ACL plus the module's own gate:
 * *does this caller hold the read capability, and is the module switched on?*
 *
 * It is a report, not a gate. Hiding a menu item is not a security control, and every route it
 * hides is refused server-side by `ESignaturePermissionService` and `ESignatureConnectionGate`
 * (AGENTS.md §5.3).
 */
@Injectable()
export class ESignatureNavigationService {
  constructor(
    @Inject(ESignaturePermissionService) private readonly permissions: ESignaturePermissionService,
    @Inject(ESignatureConnectionGate) private readonly gate: ESignatureConnectionGate,
    @Inject(ESignatureSettingsService) private readonly settings: ESignatureSettingsService,
  ) {}

  async visibility(): Promise<{
    readonly visible: boolean;
    readonly admin: boolean;
    /** The module switch an administrator controls; `false` also drops it from the sidebar. */
    readonly enabled: boolean;
    /** Whether a provider operation would be admitted for anyone at all right now. */
    readonly ready: boolean;
    /** The closed gate's stable reason, so the page can explain itself instead of showing an error. */
    readonly reason: string;
  }> {
    const [visible, admin] = await Promise.all([this.permissions.can('use'), this.permissions.can('connectionManage')]);
    const [assessment, settings] = await Promise.all([this.gate.assessment(), this.settings.read()]);
    return {
      visible,
      admin,
      enabled: settings.settings.enabled,
      ready: assessment.ready,
      reason: assessment.reason,
    };
  }
}
