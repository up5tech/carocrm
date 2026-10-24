import { timingSafeEqual } from 'node:crypto';

import { AuthenticationFailedError, InvalidQueryError } from '@carocrm/core/errors/index.js';
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { ZodTypeAny } from 'zod';

import { Public } from '../auth/auth.guard.js';
import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { type AppConfig, CONFIG_TOKEN } from '../config.js';
import { BatchRecalculateSchema, LeadChangedSchema, ModelArchiveSchema, ModelNewVersionSchema, ModelPreviewSchema, ModelPublishSchema, ModelValidateSchema, OperationProbeSchema, RecalculateBatchChunkSchema, ScoreHistoryQuerySchema, ScoreReadSchema, ScoreRecalculateSchema, SettingsPatchSchema } from './dto/lead-score-shapes.js';
import { runAsLeadScoreSystem } from './lead-score-authority.js';
import { LeadScoreCalculationService } from './lead-score-calculation.service.js';
import { LeadScoreExplanationService } from './lead-score-explanation.service.js';
import { LeadScoreFeatureGate } from './lead-score-feature-gate.service.js';
import { LeadScoreModelService } from './lead-score-model.service.js';
import { LEADSCORE_CAPABILITIES, LEADSCORE_MODULE, LEADSCORE_PENDING_FEATURES } from './lead-score-module.js';
import { LeadScoreModuleHealthService } from './lead-score-module-health.service.js';
import { LeadScorePermissionService } from './lead-score-permission.service.js';
import { LeadScorePreviewService } from './lead-score-preview.service.js';
import { LeadScoreRecalculationService } from './lead-score-recalculation.service.js';
import { LeadScoreSettingsService } from './lead-score-settings.service.js';

/**
 * Phase 19-LS.1 — the `LeadScore` control plane (`PLAN_Phase_19_LeadScore.md` §4.1, §8, §16 `19-LS.1`).
 *
 * What exists here grows with each sub-phase, and every route passes the same permission service and the
 * same gate rather than re-implementing a check: LS.1 added identity, rights, the settings document and the
 * gate probe; LS.3 added the model lifecycle (`validate`, `publish`, `archive`, `new-version`); LS.4 added
 * `preview`, the one engine-backed operation that writes nothing; LS.5 added the score write and its two
 * reads (`score/recalculate`, `score/:leadId`, `score/:leadId/history`); LS.6 added the background half —
 * `recalculate-batch` for an administrator, and the three `@Public()` worker routes the queue calls, which are
 * authorized by the shared `x-worker-secret` and run under the module's documented service authority. The
 * conversion command still arrives with its own sub-phase (§16).
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
    @Inject(LeadScoreCalculationService) private readonly calculation: LeadScoreCalculationService,
    @Inject(LeadScoreExplanationService) private readonly explanation: LeadScoreExplanationService,
    @Inject(LeadScoreRecalculationService) private readonly recalculation: LeadScoreRecalculationService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
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

  /**
   * Score one Lead under the active published model and keep the result.
   *
   * This is the write half of 19-LS.5 and the interactive half of the same command 19-LS.6 queued behind it:
   * an explicit call for one record, behind `LeadScoreRecalculate` *and* the core `Lead:edit` right, because a
   * score is written onto a Lead (plan §8.2, §9.1). Recomputing a Lead whose data has not moved records nothing
   * new — the evaluation's deterministic key and the projection comparison make that a no-op rather than a
   * second history row and a bumped record version (§5.4, §10.2). A job runs the identical service through
   * `action/work/recalculate`, and a rebuild through `action/recalculate-batch`.
   */
  @HttpCode(200)
  @Post('action/score/recalculate')
  async recalculateScore(@Body() body: unknown) {
    const input = this.parse(ScoreRecalculateSchema, body);
    return this.calculation.recalculate(input.leadId);
  }

  /**
   * The current score of one Lead, with the rules behind it and whether it is still current.
   *
   * Plan §16 `19-LS.5` accepts on *"users can explain the score and know whether it is current"*, so this
   * answers both halves: the breakdown names the rules that contributed and the ones that could not answer,
   * and the freshness block says which input revision the projection describes and why it may no longer
   * describe this Lead. The breakdown carries no Lead value — a reason that quoted a field would turn an
   * explanation into a way to read past field ACL (§6.5, §9.2).
   */
  @Get('action/score/:leadId')
  async readScore(@Param('leadId') leadId: string) {
    const input = this.parse(ScoreReadSchema, { leadId });
    return this.explanation.score(input.leadId);
  }

  /**
   * Paged evaluation history of one Lead, newest first.
   *
   * `LeadScoreEvaluation` is `read: 'no'` for a general entity read by design, so this Lead-scoped command is
   * the door: the caller must be able to read the Lead *and* hold the explanation right, which is what makes
   * "history is append-only and never browsable" a real property rather than a comment (§5.4, §8.2).
   */
  @Get('action/score/:leadId/history')
  async readScoreHistory(@Param('leadId') leadId: string, @Query() query: unknown) {
    const input = this.parse(ScoreReadSchema, { leadId });
    const page = this.parse(ScoreHistoryQuerySchema, query ?? {});
    return this.explanation.history(input.leadId, page.limit ?? 20, page.offset ?? 0);
  }

  // ---------------------------------------------------------------------------
  // background recalculation (19-LS.6)
  // ---------------------------------------------------------------------------

  /**
   * Queue a bounded rebuild over the Leads a validated filter names.
   *
   * The request returns a job row rather than a result, for the reason plan §11.1 gives every batch: a
   * rebuild can walk a long Lead set, and an operator needs to see its progress, its counts and a cancel
   * button while it runs (`/admin/jobs`), not a request that has to stay open until it finishes. The work
   * itself is chunked — one job evaluates at most `MAX_BATCH_CHUNK` Leads and hands the cursor to the next.
   */
  @HttpCode(200)
  @Post('action/recalculate-batch')
  async recalculateBatch(@Body() body: unknown) {
    const input = this.parse(BatchRecalculateSchema, body);
    return this.recalculation.startBatch({
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.chunkSize === undefined ? {} : { chunkSize: input.chunkSize }),
      ...(input.where === undefined ? {} : { where: input.where }),
    });
  }

  /**
   * Worker entry: a committed Lead change happened, decide whether it is worth a job.
   *
   * Never a 4xx for "nothing to do": this route is called from an at-least-once outbox subscriber, so an
   * answer like "the change cannot move this score" has to be a response, not a retry storm.
   */
  @Public()
  @HttpCode(200)
  @Post('action/work/lead-changed')
  async workLeadChanged(@Body() body: unknown, @Headers('x-worker-secret') secret?: string) {
    this.assertWorkerSecret(secret);
    const input = this.parse(LeadChangedSchema, body);
    return runAsLeadScoreSystem(this.scope, 'lead-changed', () =>
      this.recalculation.handleLeadChanged({ leadId: input.leadId, revision: input.revision, changed: input.changed }),
    );
  }

  /** Worker entry: run the recalculation a job promised, as the documented service authority. */
  @Public()
  @HttpCode(200)
  @Post('action/work/recalculate')
  async workRecalculate(@Body() body: unknown, @Headers('x-worker-secret') secret?: string) {
    this.assertWorkerSecret(secret);
    const input = this.parse(ScoreRecalculateSchema, body);
    return runAsLeadScoreSystem(this.scope, 'recalculate', () => this.recalculation.recalculateQueued(input.leadId));
  }

  /** Worker entry: evaluate one chunk of a rebuild and hand the cursor to the next chunk. */
  @Public()
  @HttpCode(200)
  @Post('action/work/recalculate-batch-chunk')
  async workBatchChunk(@Body() body: unknown, @Headers('x-worker-secret') secret?: string) {
    this.assertWorkerSecret(secret);
    const input = this.parse(RecalculateBatchChunkSchema, body);
    return runAsLeadScoreSystem(this.scope, 'recalculate-batch-chunk', () =>
      this.recalculation.runBatchChunk({
        runId: input.runId,
        limit: input.limit,
        chunkSize: input.chunkSize,
        processed: input.processed,
        cursor: input.cursor,
        where: input.where,
      }),
    );
  }

  /**
   * The shared worker capability, compared in constant time and never logged.
   *
   * An unset secret refuses every worker route rather than leaving them open, exactly like the platform's
   * other worker twins: a deployment that has not configured the capability cannot accidentally run
   * background scoring, and the answer is an authentication failure, not a partial execution.
   */
  private assertWorkerSecret(supplied: string | undefined): void {
    const expected = this.config.reportWorkerSecret;
    if (expected === '' || supplied === undefined) {
      throw new AuthenticationFailedError('Invalid worker capability.');
    }
    const expectedBytes = Buffer.from(expected);
    const suppliedBytes = Buffer.from(supplied);
    if (expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) {
      throw new AuthenticationFailedError('Invalid worker capability.');
    }
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
