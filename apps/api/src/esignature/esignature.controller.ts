import { InvalidQueryError } from '@carocrm/core/errors/index.js';
import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { ZodTypeAny } from 'zod';

import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { OperationProbeSchema, SettingsPatchSchema } from './dto/esignature-shapes.js';
import { ESIGNATURE_OPERATIONS,ESignatureConnectionGate } from './esignature-connection-gate.service.js';
import { ESignatureModuleHealthService } from './esignature-module-health.service.js';
import { ESignatureNavigationService } from './esignature-navigation.service.js';
import { ESignaturePermissionService } from './esignature-permission.service.js';
import { ESignatureSettingsService } from './esignature-settings.service.js';

/**
 * Phase 19-ES.1 — the `ESignature` control-plane API
 * (`PLAN_Phase_19_ESignature.md` §8.1, §12, §18 `19-ES.1`).
 *
 * Only the control plane exists at this phase: identity, the caller's capabilities, the security
 * policy, and a probe of the gate that stands in front of every provider call. Requests,
 * recipients, documents, connections and the Connect endpoint arrive with their own sub-phases
 * (§18), and each will pass through the same two services rather than re-implementing a check.
 *
 * Every route checks a capability server-side; hiding a control in the SPA is never authorization.
 * A route that would contact the provider calls `ESignatureConnectionGate.assertOperation` first, so
 * "no provider operations are possible before a connection is enabled" is enforced in one place
 * instead of being remembered per endpoint.
 *
 * Registered before `ENTITY_CONTROLLERS`, so the static `ESignature` prefix can never be swallowed
 * by the generic `/api/v1/:entity` wildcard.
 */
@ApiTags('esignature')
@Controller('api/v1/ESignature')
export class ESignatureController {
  constructor(
    @Inject(ESignatureModuleHealthService) private readonly health: ESignatureModuleHealthService,
    @Inject(ESignaturePermissionService) private readonly permissions: ESignaturePermissionService,
    @Inject(ESignatureSettingsService) private readonly settings: ESignatureSettingsService,
    @Inject(ESignatureNavigationService) private readonly navigation: ESignatureNavigationService,
    @Inject(ESignatureConnectionGate) private readonly gate: ESignatureConnectionGate,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  /** Module health: the platform foundation, the feature state, the gate and the checks. */
  @Get('action/health')
  async moduleHealth() {
    await this.permissions.assert('use');
    return this.health.health();
  }

  /**
   * What this caller may do, and what the first provider can do.
   *
   * The SPA renders from this answer; a missing capability means the matching endpoint would refuse
   * the call, not that the UI merely hides a button (plan §12.1).
   */
  @Get('action/capabilities')
  async capabilities() {
    await this.permissions.assert('use');
    return {
      capabilities: await this.permissions.describe(),
      provider: await this.gate.assessment(),
    };
  }

  /** The module's own navigation signal. */
  @Get('action/nav')
  async nav() {
    await this.permissions.assert('use');
    return this.navigation.visibility();
  }

  // ---------------------------------------------------------------------------
  // settings
  // ---------------------------------------------------------------------------

  /**
   * The validated settings document with its warnings, its pending phases and its defaults.
   *
   * The same right as the write, like `AdvancedIntegrations`: the document is the security policy —
   * feature switches, document ceilings, the approval policy, the embedded return-host allowlist — and
   * a policy is administered, not browsed. A user's own screens read the effective answer from
   * `action/capabilities` and `action/nav`, and no field here can ever be a secret.
   */
  @Get('action/settings')
  async readSettings() {
    await this.permissions.assert('connectionManage');
    return this.settings.read();
  }

  @HttpCode(200)
  @Post('action/settings')
  async updateSettings(@Body() body: unknown) {
    await this.permissions.assert('connectionManage');
    return this.settings.update(this.parse(SettingsPatchSchema, body));
  }

  // ---------------------------------------------------------------------------
  // the gate
  // ---------------------------------------------------------------------------

  /**
   * Ask the gate what it would answer for one adapter operation, and let it refuse in the caller's
   * own stable error.
   *
   * This is the security contract made inspectable: an operator or a test can prove that a send, a
   * recipient view or a download is refused before a connection is enabled, without any code path
   * that could reach DocuSign. It performs no provider call of its own.
   */
  @HttpCode(200)
  @Post('action/gate/check')
  async checkOperation(@Body() body: unknown) {
    const { operation } = this.parse(OperationProbeSchema, body);
    await this.gate.assertOperation(operation);
    return { operation, admitted: true };
  }

  /** The operation names the gate knows, so a client never guesses a string. */
  @Get('action/gate/operations')
  async operations() {
    await this.permissions.assert('use');
    return { operations: ESIGNATURE_OPERATIONS, provider: this.scope.userType ?? 'user' };
  }

  private parse<T extends ZodTypeAny>(schema: T, value: unknown): T['_output'] {
    const parsed = schema.safeParse(value ?? {});
    if (!parsed.success) {
      throw new InvalidQueryError('Invalid ESignature request.', {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }
    return parsed.data;
  }
}
