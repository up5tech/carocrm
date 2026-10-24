import { InvalidQueryError } from '@carocrm/core/errors/index.js';
import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { ZodTypeAny } from 'zod';

import { OperationProbeSchema, SettingsPatchSchema } from './dto/lead-score-shapes.js';
import { LeadScoreFeatureGate } from './lead-score-feature-gate.service.js';
import { LEADSCORE_CAPABILITIES, LEADSCORE_MODULE, LEADSCORE_PENDING_FEATURES } from './lead-score-module.js';
import { LeadScoreModuleHealthService } from './lead-score-module-health.service.js';
import { LeadScorePermissionService } from './lead-score-permission.service.js';
import { LeadScoreSettingsService } from './lead-score-settings.service.js';

/**
 * Phase 19-LS.1 — the `LeadScore` control plane (`PLAN_Phase_19_LeadScore.md` §4.1, §8, §16 `19-LS.1`).
 *
 * Only the control plane exists at this phase: identity, the caller's rights, the settings document
 * and a probe of the gate that will stand in front of every score and every conversion. The scoring
 * engine, the model administration, the duplicate review and the conversion command arrive with
 * their own sub-phases (§16) and pass through the same permission service and the same gate rather
 * than re-implementing a check.
 *
 * Every route asserts a capability server-side; hiding a badge in the SPA is never authorization
 * (AGENTS.md §5.3). The controller owns no business rule.
 *
 * Registered **before** `ENTITY_CONTROLLERS` in `AppModule`, so the static `LeadScore` prefix can
 * never be swallowed by the generic `/api/v1/:entity` wildcard — otherwise `LeadScore` would read as
 * "entity `LeadScore`, record `action`" and the plan's §8 routes would be unreachable.
 */
@ApiTags('lead-score')
@Controller('api/v1/LeadScore')
export class LeadScoreController {
  constructor(
    @Inject(LeadScoreModuleHealthService) private readonly health: LeadScoreModuleHealthService,
    @Inject(LeadScorePermissionService) private readonly permissions: LeadScorePermissionService,
    @Inject(LeadScoreSettingsService) private readonly settings: LeadScoreSettingsService,
    @Inject(LeadScoreFeatureGate) private readonly gate: LeadScoreFeatureGate,
  ) {}

  /** Module health: the platform foundation, the registration invariants, the features and the gate. */
  @Get('action/health')
  async moduleHealth() {
    await this.permissions.assert('viewScore');
    return this.health.health();
  }

  /**
   * What this caller may do, and what this build can actually do.
   *
   * The SPA renders from this answer: a missing capability means the matching endpoint would refuse
   * the call, not that a button is merely hidden (plan §9.1). `pendingFeatures` is returned alongside
   * it so a screen can say "not implemented yet" instead of presenting a control that errors.
   */
  @Get('action/capabilities')
  async capabilities() {
    await this.permissions.assert('viewScore');
    const view = await this.settings.read();
    return {
      module: LEADSCORE_MODULE.id,
      capabilities: await this.permissions.describe(),
      enabled: view.settings.enabled === true,
      effective: view.effective,
      pendingFeatures: LEADSCORE_PENDING_FEATURES,
    };
  }

  /**
   * The declared permission matrix itself, so an administrator can see which synthetic resources a
   * role must grant. `viewScore` still gates it: the platform's role list and its names are not this
   * answer's business (plan §9.2).
   */
  @Get('action/permissions')
  async permissionMatrix() {
    await this.permissions.assert('viewScore');
    return {
      capabilities: LEADSCORE_CAPABILITIES.map((capability) => ({
        key: capability.key,
        label: capability.label,
        description: capability.description,
        resource: capability.resource,
        action: capability.action,
      })),
    };
  }

  /**
   * The settings document with its warnings, its pending phases and its defaults.
   *
   * Read and write share one right (`settingsManage`), like `ESignature`: the document is the module's
   * control plane, and a policy is administered rather than browsed. A caller with only `viewScore`
   * learns the effective answer from `action/capabilities`, and no field here can ever be a secret.
   */
  @Get('action/settings')
  async readSettings() {
    await this.permissions.assert('settingsManage');
    return this.settings.read();
  }

  @HttpCode(200)
  @Post('action/settings')
  async updateSettings(@Body() body: unknown) {
    await this.permissions.assert('settingsManage');
    return this.settings.update(this.parse(SettingsPatchSchema, body));
  }

  /**
   * Ask whether an operation would be admitted, without performing it.
   *
   * This is the gate's contract made observable: a UI, an integration test and an operator get the
   * same answer — the capability, the feature, and the sub-phase that still owns the work — from one
   * place. It never mutates a record and never computes a score.
   */
  @HttpCode(200)
  @Post('action/operation-gate')
  async operationGate(@Body() body: unknown) {
    const input = this.parse(OperationProbeSchema, body);
    return this.gate.assess(input.operation);
  }

  private parse<T extends ZodTypeAny>(schema: T, value: unknown): T['_output'] {
    const parsed = schema.safeParse(value ?? {});
    if (!parsed.success) {
      throw new InvalidQueryError('Invalid Lead Score request.', {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }
    return parsed.data;
  }
}
