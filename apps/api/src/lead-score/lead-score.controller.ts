import { InvalidQueryError } from '@carocrm/core/errors/index.js';
import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { ZodTypeAny } from 'zod';

import { ModelArchiveSchema, ModelNewVersionSchema, ModelPreviewSchema, ModelPublishSchema, ModelValidateSchema, OperationProbeSchema, SettingsPatchSchema } from './dto/lead-score-shapes.js';
import { LeadScoreFeatureGate } from './lead-score-feature-gate.service.js';
import { LeadScoreModelService } from './lead-score-model.service.js';
import { LEADSCORE_CAPABILITIES, LEADSCORE_MODULE, LEADSCORE_PENDING_FEATURES } from './lead-score-module.js';
import { LeadScoreModuleHealthService } from './lead-score-module-health.service.js';
import { LeadScorePermissionService } from './lead-score-permission.service.js';
import { LeadScorePreviewService } from './lead-score-preview.service.js';
import { LeadScoreSettingsService } from './lead-score-settings.service.js';

/**
 * Phase 19-LS.1 — the `LeadScore` control plane (`PLAN_Phase_19_LeadScore.md` §4.1, §8, §16 `19-LS.1`).
 *
 * What exists here grows with each sub-phase, and every route passes the same permission service and the
 * same gate rather than re-implementing a check: LS.1 added identity, rights, the settings document and the
 * gate probe; LS.3 added the model lifecycle (`validate`, `publish`, `archive`, `new-version`); LS.4 added
 * `preview`, the one engine-backed operation that writes nothing. The score read, the recalculation and the
 * conversion command still arrive with their own sub-phases (§16).
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
    @Inject(LeadScoreModelService) private readonly models: LeadScoreModelService,
    @Inject(LeadScorePreviewService) private readonly preview: LeadScorePreviewService,
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

  // ---------------------------------------------------------------------------
  // model lifecycle (19-LS.3)
  // ---------------------------------------------------------------------------

  /**
   * Validate a draft model with its rules.
   *
   * Read-only and side-effect free — it writes no score and touches no Lead — so an editor can call it on
   * a half-finished draft as often as it likes. The answer is the whole list of problems, each with a
   * stable code, not only the first one (plan §6.1).
   */
  @HttpCode(200)
  @Post('action/model/validate')
  async validateModel(@Body() body: unknown) {
    const input = this.parse(ModelValidateSchema, body);
    return this.models.validate(input.modelId);
  }

  /**
   * Publish a draft as an immutable version.
   *
   * The command that decides what a stored score means from now on, so it asks for `modelPublish` — a
   * separate right from editing a draft (plan §9.1) — and it re-validates rather than trusting an earlier
   * `validate` answer.
   */
  @HttpCode(200)
  @Post('action/model/publish')
  async publishModel(@Body() body: unknown) {
    const input = this.parse(ModelPublishSchema, body);
    return this.models.publish(input.modelId, input.expectedVersion);
  }

  /** Archive a model version: the quick off switch that keeps every stored evaluation intact (plan §9.3). */
  @HttpCode(200)
  @Post('action/model/archive')
  async archiveModel(@Body() body: unknown) {
    const input = this.parse(ModelArchiveSchema, body);
    return this.models.archive(input.modelId, input.expectedVersion);
  }

  /**
   * Open a new draft version from a published or archived one.
   *
   * This is how a published model is "edited" without editing it: the old version stays exactly as the
   * scores that name it were produced by, and the copy is what changes (plan §5.1, §6.1 rollback).
   */
  @HttpCode(200)
  @Post('action/model/new-version')
  async newModelVersion(@Body() body: unknown) {
    const input = this.parse(ModelNewVersionSchema, body);
    return this.models.newVersion(input.modelId);
  }

  /**
   * Score a bounded, authorized sample with a model and change nothing.
   *
   * This is plan §15.2 stage 3 — the step between administering a model and publishing one: an administrator
   * compares the outputs against the rules they meant before a version becomes what every future score is
   * read from. The service enforces the three things that make that safe: the sample comes from the core list
   * path, so record and field ACL are the real ones; the answer carries no Lead values; and nothing here
   * writes a projection, an evaluation, an audit row or an event (§6.1, §9.2, §9.4).
   */
  @HttpCode(200)
  @Post('action/model/preview')
  async previewModel(@Body() body: unknown) {
    const input = this.parse(ModelPreviewSchema, body);
    return this.preview.preview(input.modelId, input.leadIds, input.maxSize);
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
