import { timingSafeEqual } from 'node:crypto';

import { AuthenticationFailedError, InvalidQueryError } from '@carocrm/core/errors/index.js';
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { ZodTypeAny } from 'zod';

import { Public } from '../auth/auth.guard.js';
import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { type AppConfig, CONFIG_TOKEN } from '../config.js';
import { BatchRecalculateSchema, ConversionAffordanceQuerySchema, ConversionCandidatesSchema, ConversionCloseSchema, ConversionOperationIdSchema, ConversionOperationsQuerySchema, ConversionPreviewSchema, ConvertSchema, EditorCatalogQuerySchema, InsightRequestSchema, LeadChangedSchema, ModelArchiveSchema, ModelNewVersionSchema, ModelPreviewSchema, ModelPublishSchema, ModelRecalculateSchema, ModelValidateSchema, OperationProbeSchema, RecalculateBatchChunkSchema, ScoreHistoryQuerySchema, ScoreReadSchema, ScoreRecalculateSchema, SettingsPatchSchema } from './dto/lead-score-shapes.js';
import { LeadConversionService } from './lead-conversion.service.js';
import { LeadConversionAuditService } from './lead-conversion-audit.service.js';
import { LeadConversionPreviewService } from './lead-conversion-preview.service.js';
import { LeadDuplicateResolver } from './lead-duplicate-resolver.js';
import { runAsLeadScoreSystem } from './lead-score-authority.js';
import { LeadScoreCalculationService } from './lead-score-calculation.service.js';
import { LeadScoreEditorService } from './lead-score-editor.js';
import { LeadScoreExplanationService } from './lead-score-explanation.service.js';
import { LeadScoreFeatureGate } from './lead-score-feature-gate.service.js';
import { LeadScoreInsightService } from './lead-score-insight.service.js';
import { LeadScoreModelService } from './lead-score-model.service.js';
import { LEADSCORE_CAPABILITIES, LEADSCORE_MODULE, LEADSCORE_PENDING_FEATURES } from './lead-score-module.js';
import { LeadScoreModuleHealthService } from './lead-score-module-health.service.js';
import { LeadScorePermissionService } from './lead-score-permission.service.js';
import { LeadScorePreviewService } from './lead-score-preview.service.js';
import { LeadScoreRecalculationService } from './lead-score-recalculation.service.js';
import { LeadScoreReportService } from './lead-score-report.service.js';
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
 * authorized by the shared `x-worker-secret` and run under the module's documented service authority; LS.11–LS.16
 * added the conversion doors, and LS.17 added `action/insight`, the optional AI explanation.
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
    @Inject(LeadScoreInsightService) private readonly insight: LeadScoreInsightService,
    @Inject(LeadScoreRecalculationService) private readonly recalculation: LeadScoreRecalculationService,
    @Inject(LeadScoreReportService) private readonly reports: LeadScoreReportService,
    @Inject(LeadScoreEditorService) private readonly editor: LeadScoreEditorService,
    @Inject(LeadDuplicateResolver) private readonly duplicates: LeadDuplicateResolver,
    @Inject(LeadConversionPreviewService) private readonly conversionPreview: LeadConversionPreviewService,
    @Inject(LeadConversionService) private readonly conversion: LeadConversionService,
    @Inject(LeadConversionAuditService) private readonly conversionAudit: LeadConversionAuditService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
  ) {}

  /** Module health: the platform foundation, the registration invariants, the features and the gate. */
  @Get('action/health')
  @ApiOperation({ summary: 'Module health: foundation, registration invariants, features, gate' })
  @ApiResponse({ status: 200, description: 'Health view under the caller’s scope' })
  @ApiResponse({ status: 403, description: 'Caller cannot view scores' })
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
  @ApiOperation({ summary: 'What this caller may do, and what this build can actually do' })
  @ApiResponse({ status: 200, description: 'Capabilities, effective features and pending phases' })
  @ApiResponse({ status: 403, description: 'Caller cannot view scores' })
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
  @ApiOperation({ summary: 'The declared permission matrix: the synthetic resources a role must grant' })
  @ApiResponse({ status: 200, description: 'Capability descriptors with resource/action pairs' })
  @ApiResponse({ status: 403, description: 'Caller cannot view scores' })
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
  @ApiOperation({ summary: 'The leadScore settings document with its warnings, pending phases and defaults' })
  @ApiResponse({ status: 200, description: 'Settings view; version bumps on every accepted change' })
  @ApiResponse({ status: 403, description: 'Caller lacks settingsManage' })
  async readSettings() {
    await this.permissions.assert('settingsManage');
    return this.settings.read();
  }

  @HttpCode(200)
  @Post('action/settings')
  @ApiOperation({ summary: 'Patch the settings document; unknown keys are refused' })
  @ApiResponse({ status: 200, description: 'The updated settings view' })
  @ApiResponse({ status: 403, description: 'Caller lacks settingsManage' })
  @ApiResponse({ status: 422, description: 'Invalid patch or invalid conversion mapping' })
  async updateSettings(@Body() body: unknown) {
    await this.permissions.assert('settingsManage');
    return this.settings.update(this.parse(SettingsPatchSchema, body));
  }

  /**
   * Worker entry: the decay sweep (19-LS.9).
   *
   * A scheduled job, so no user is in scope and the same two doors apply as to every other worker route:
   * the shared `x-worker-secret` and the module's own service authority. The route decides nothing about
   * scoring — it asks the recalculation service whether a sweep is switched on and worth running, and that
   * service answers with a rebuild it already knows how to chunk, cap and cancel.
   */
  @Public()
  @HttpCode(200)
  @Post('action/work/decay-sweep')
  @ApiOperation({ summary: 'Worker entry: the decay sweep' })
  @ApiResponse({ status: 200, description: 'Sweep decision: started, or which reason it skipped' })
  @ApiResponse({ status: 401, description: 'Missing or invalid worker capability' })
  async workDecaySweep(@Headers('x-worker-secret') secret?: string) {
    this.assertWorkerSecret(secret);
    return runAsLeadScoreSystem(this.scope, 'decay-sweep', () => this.recalculation.decaySweep());
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
  @ApiOperation({ summary: 'Ask whether an operation would be admitted, without performing it' })
  @ApiResponse({ status: 200, description: 'The gate’s assessment for the named operation' })
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
  /**
   * The vocabulary a model editor may offer: fields, the operators each field's type can answer, the value
   * control, the condition's structural limits and the module's vocabularies.
   *
   * 19-LS.8's exit criterion is that an administrator can manage a model *without editing raw JSON or
   * running code*, and a rule's condition is stored as a JSON tree — so the form's choices have to come from
   * the same sets the validator enforces, not from a second list the SPA keeps. A refused field is returned
   * with its reason rather than hidden, because "why can't I score on this one" is a question the screen
   * should answer with the module's own code.
   */
  @Get('action/editor')
  @ApiOperation({ summary: 'The vocabulary a model editor may offer: fields, operators, limits' })
  @ApiResponse({ status: 200, description: 'Editor catalog derived from metadata and module constants' })
  @ApiResponse({ status: 403, description: 'Caller cannot read models' })
  async editorCatalog(@Query() query: unknown) {
    await this.permissions.assert('modelRead');
    const input = this.parse(EditorCatalogQuerySchema, query ?? {});
    if (input.modelId === undefined) return this.editor.catalog();
    const { model } = await this.models.readModel(input.modelId);
    return this.editor.catalog(model);
  }

  @HttpCode(200)
  @Post('action/model/validate')
  @ApiOperation({ summary: 'Validate a draft model with its rules; side-effect free' })
  @ApiResponse({ status: 200, description: 'The full problem list, each with a stable code' })
  @ApiResponse({ status: 403, description: 'Caller lacks validateModel' })
  @ApiResponse({ status: 422, description: 'Malformed request' })
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
  @ApiOperation({ summary: 'Publish a draft as an immutable version' })
  @ApiResponse({ status: 200, description: 'The published model row' })
  @ApiResponse({ status: 403, description: 'Caller lacks modelPublish, or the module switch is off' })
  @ApiResponse({ status: 409, description: 'The model is not a draft' })
  @ApiResponse({ status: 422, description: 'Validation failed; the model cannot be published' })
  async publishModel(@Body() body: unknown) {
    const input = this.parse(ModelPublishSchema, body);
    return this.models.publish(input.modelId, input.expectedVersion);
  }

  /** Archive a model version: the quick off switch that keeps every stored evaluation intact (plan §9.3). */
  @HttpCode(200)
  @Post('action/model/archive')
  @ApiOperation({ summary: 'Archive a model version; stored evaluations stay intact' })
  @ApiResponse({ status: 200, description: 'The archived model row' })
  @ApiResponse({ status: 403, description: 'Caller lacks modelPublish' })
  @ApiResponse({ status: 409, description: 'The model is already archived' })
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
  @ApiOperation({ summary: 'Open a new draft version from a published or archived model' })
  @ApiResponse({ status: 200, description: 'The new draft, with its rules copied' })
  @ApiResponse({ status: 403, description: 'Caller lacks createModelVersion' })
  @ApiResponse({ status: 409, description: 'The source is a draft, or a draft of this name already exists' })
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
  @ApiOperation({ summary: 'Score a bounded, authorized sample with a model; writes nothing' })
  @ApiResponse({ status: 200, description: 'Sample evaluations; no projection, history or event was written' })
  @ApiResponse({ status: 403, description: 'Caller lacks the capability, or the module switch is off' })
  @ApiResponse({ status: 422, description: 'Malformed request' })
  async previewModel(@Body() body: unknown) {
    const input = this.parse(ModelPreviewSchema, body);
    return this.preview.preview(input.modelId, input.leadIds, input.maxSize);
  }

  /**
   * Queue a bounded rebuild under the active published model, naming it as the reason (plan §8.1).
   *
   * Publishing freezes a version but does not move the projections already on Leads, and scoring always
   * runs under the **active** model — so the step that makes a new version the installed truth is this
   * command: the administrator points `scoring.activeModelId` at the version (an explicit settings choice,
   * not a side effect of publishing) and then asks for the rebuild here. The id must be the active model's,
   * or the run would name a version it does not actually score under; the answer to anything else is a 422
   * that says which version *is* active. The run is the same bounded, chunked rebuild as
   * `action/recalculate-batch` — the difference is provenance: its evaluations record the trigger
   * `model_publish` (plan §5.4 reserved the code for exactly this).
   */
  @HttpCode(200)
  @Post('action/model/recalculate')
  @ApiOperation({ summary: 'Queue a bounded rebuild under the active published model; evaluations name the trigger model_publish' })
  @ApiResponse({ status: 200, description: 'The rebuild job row, its runId and the applied bounds' })
  @ApiResponse({ status: 403, description: 'Caller lacks batchRecalculate, or the module switch is off' })
  @ApiResponse({ status: 422, description: 'Malformed request, no active model, or modelId is not the active model' })
  async recalculateModelBatch(@Body() body: unknown) {
    const input = this.parse(ModelRecalculateSchema, body);
    return this.recalculation.startModelBatch({
      modelId: input.modelId,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.chunkSize === undefined ? {} : { chunkSize: input.chunkSize }),
    });
  }

  // ---------------------------------------------------------------------------
  // the operational report (19-LS.18)
  // ---------------------------------------------------------------------------

  /**
   * The score and conversion metrics of this instance, under the reader's own record scope.
   *
   * Four curated views — the scored population, the bands, the freshness and the conversions — computed with
   * the platform's aggregate, so a reader with `own` scope sees their own numbers and an administrator's are
   * the whole instance's. The definitions travel with the answer, because a metric whose population is
   * ambiguous is not a metric (plan §16 `19-LS.18`).
   */
  @Get('action/report')
  @ApiOperation({ summary: 'Score and conversion metrics, computed under the reader’s own record scope' })
  @ApiResponse({ status: 200, description: 'The four curated views with their populations' })
  async scoreReport() {
    return this.reports.overview();
  }

  // ---------------------------------------------------------------------------
  // AI fit insight (19-LS.17)
  // ---------------------------------------------------------------------------

  /**
   * Ask the configured AIAgents agent for an evidence-grounded explanation of this Lead's fit.
   *
   * The request carries the Lead and an optional replay key; the evidence, the agent, the provider budgets
   * and the output shape are all the server's (plan §6.7). The answer is stored as its own append-only
   * record and returned with its model/provider identity, input digest and run counters — it is never a
   * score and never writes one.
   */
  @HttpCode(200)
  @Post('action/insight')
  @ApiOperation({ summary: 'Ask the configured AI agent for an evidence-grounded explanation of this Lead’s fit' })
  @ApiResponse({ status: 200, description: 'The stored insight with its model/provider identity and input digest' })
  @ApiResponse({ status: 403, description: 'Caller lacks the insight right' })
  @ApiResponse({ status: 409, description: 'No agent configured, agent unsuitable, or the Lead has no current score' })
  @ApiResponse({ status: 502, description: 'The AI run finished without a usable explanation' })
  async requestInsight(@Body() body: unknown) {
    const input = this.parse(InsightRequestSchema, body);
    return this.insight.generate({ leadId: input.leadId, ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }) });
  }

  // ---------------------------------------------------------------------------
  // conversion candidates (19-LS.11)
  // ---------------------------------------------------------------------------

  /**
   * Who this Lead may already be: exact e-mail, phone, Account domain and Account company matches, under
   * the caller's own ACL, plus a count of the matches they may not see.
   *
   * The answer is a *question*, never an action: nothing here links, merges or writes, and
   * `requiresChoice` with `allowedDecisions` is what LS.12's preview and LS.13's command demand an answer
   * to. `hiddenMatches` exists so a caller knows their view is incomplete without learning what is
   * missing — the Voice contact resolver's precedent, for the same reason (plan §7.1, §7.3, §9.2).
   */
  @HttpCode(200)
  @Post('action/conversion/candidates')
  @ApiOperation({ summary: 'Possible existing Contact/Account matches for this Lead, under the caller’s ACL' })
  @ApiResponse({ status: 200, description: 'Candidates with match classes and reasons, plus the hidden-match count' })
  @ApiResponse({ status: 403, description: 'Caller cannot read the Lead or lacks duplicateDetection' })
  @ApiResponse({ status: 422, description: 'Malformed request' })
  async conversionCandidates(@Body() body: unknown) {
    const input = this.parse(ConversionCandidatesSchema, body);
    return this.duplicates.candidates(input.leadId);
  }

  /**
   * May this caller convert this Lead, and has it already been converted? (19-LS.14)
   *
   * A read with no capability gate of its own: the button must be able to ask and get "no" (with reasons)
   * instead of an error. The module switch and the Lead's own record ACL still apply, and the Lead is not
   * echoed beyond the references the caller can already read on the record.
   */
  @Get('action/conversion/affordance')
  @ApiOperation({ summary: 'May this caller convert this Lead, and has it already been converted' })
  @ApiResponse({ status: 200, description: 'The affordance answer with reasons; never an error for "no"' })
  async conversionAffordance(@Query() query: unknown) {
    const input = this.parse(ConversionAffordanceQuerySchema, query ?? {});
    return this.conversion.affordance(input.leadId);
  }

  /**
   * What a conversion would do, without doing any of it (19-LS.12).
   *
   * The answer is the operation: the values each target would receive, the fields that would not be copied
   * and why, the required values still missing, the before/after of every conflict on a linked record, the
   * duplicate candidates (when that switch is on), what the caller must be shown before confirming, and a
   * fingerprint over all of it. Nothing here writes — the service has no writer — and the fingerprint is what
   * makes an old preview refusable instead of merely inadvisable (contract §8.3).
   */
  @HttpCode(200)
  @Post('action/conversion/preview')
  @ApiOperation({ summary: 'What a conversion would do, without doing any of it' })
  @ApiResponse({ status: 200, description: 'Proposed values, skips, conflicts, candidates, confirmations and the fingerprint' })
  @ApiResponse({ status: 403, description: 'Caller cannot read the Lead or lacks conversionPreview' })
  @ApiResponse({ status: 422, description: 'Malformed request or a disabled target' })
  async previewConversion(@Body() body: unknown) {
    const input = this.parse(ConversionPreviewSchema, body);
    return this.conversionPreview.preview(input);
  }

  /**
   * Confirm and run a conversion (19-LS.13).
   *
   * The server re-runs the preview, compares the fingerprint, checks the acknowledgements and the duplicate and
   * re-parent decisions, then claims the operation key and does the work in one transaction. Everything the
   * answer says about the outcome is read back from the operation row, so the caller and the audit trail cannot
   * disagree (contract §3.3).
   */
  @HttpCode(200)
  @Post('action/conversion/convert')
  @ApiOperation({ summary: 'Confirm and run a conversion; idempotent by operation key' })
  @ApiResponse({ status: 200, description: 'The operation row read back after the work, or the replayed prior result' })
  @ApiResponse({ status: 403, description: 'Caller lacks the conversion or target rights' })
  @ApiResponse({ status: 409, description: 'Already converted, key conflict, duplicate review required, or stale preview' })
  @ApiResponse({ status: 422, description: 'Malformed request or a disabled target' })
  @ApiResponse({ status: 503, description: 'A transient failure left nothing behind; retry the same operation' })
  async convertLead(@Body() body: unknown) {
    const input = this.parse(ConvertSchema, body);
    return this.conversion.convert({
      leadId: input.leadId,
      operationKey: input.operationKey,
      targets: input.targets,
      ...(input.fieldMerge === undefined ? {} : { fieldMerge: input.fieldMerge }),
      previewHash: input.previewHash,
      acknowledged: input.acknowledged,
      ...(input.overrideDuplicateFor === undefined ? {} : { overrideDuplicateFor: input.overrideDuplicateFor }),
      ...(input.allowReparent === undefined ? {} : { allowReparent: input.allowReparent }),
    });
  }

  /**
   * The operations an administrator can inspect, bounded and filterable (contract §11.3).
   *
   * Reading needs `conversionAuditRead` and the module on; the Lead's label appears only when the caller may
   * read that Lead, so the row is an audit subject rather than a back door to the record.
   */
  @Get('action/conversion/operations')
  @ApiOperation({ summary: 'Conversion operations an administrator can inspect, bounded and filterable' })
  @ApiResponse({ status: 200, description: 'The page of operation rows the caller may read' })
  @ApiResponse({ status: 403, description: 'Caller lacks conversionAuditRead' })
  async conversionOperations(@Query() query: unknown) {
    const input = this.parse(ConversionOperationsQuerySchema, query ?? {});
    return this.conversionAudit.operations({
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.staleAfterMinutes === undefined ? {} : { staleAfterMinutes: input.staleAfterMinutes }),
      limit: input.limit ?? 25,
    });
  }

  @Get('action/conversion/operations/:operationId')
  @ApiOperation({ summary: 'One conversion operation’s status and result' })
  @ApiResponse({ status: 200, description: 'The operation view' })
  @ApiResponse({ status: 403, description: 'Caller lacks conversionAuditRead' })
  @ApiResponse({ status: 404, description: 'Unknown or invisible operation' })
  async conversionOperation(@Param('operationId') operationId: string) {
    const input = this.parse(ConversionOperationIdSchema, { operationId });
    return this.conversionAudit.operation(input.operationId);
  }

  /** Retry an attempt the accounting proves is safe to re-run, keeping its key (contract §10.2). */
  @HttpCode(200)
  @Post('action/conversion/operations/:operationId/retry')
  @ApiOperation({ summary: 'Retry an operation the accounting proves is safe to re-run, keeping its key' })
  @ApiResponse({ status: 200, description: 'The retried operation' })
  @ApiResponse({ status: 403, description: 'Caller lacks conversionRecover' })
  @ApiResponse({ status: 409, description: 'The operation is not in a retryable state' })
  async retryConversion(@Param('operationId') operationId: string) {
    const input = this.parse(ConversionOperationIdSchema, { operationId });
    return this.conversionAudit.retry(input.operationId);
  }

  /** Close an operation that a human decided not to retry (contract §11.3). */
  @HttpCode(200)
  @Post('action/conversion/operations/:operationId/close')
  @ApiOperation({ summary: 'Close an operation a human decided not to retry' })
  @ApiResponse({ status: 200, description: 'The closed operation' })
  @ApiResponse({ status: 403, description: 'Caller lacks conversionRecover' })
  @ApiResponse({ status: 409, description: 'The operation is not in a closable state' })
  async closeConversion(@Param('operationId') operationId: string, @Body() body: unknown) {
    const input = this.parse(ConversionOperationIdSchema, { operationId });
    const close = this.parse(ConversionCloseSchema, body ?? {});
    return this.conversionAudit.close(input.operationId, close.reason ?? null);
  }

  /** Worker entry: settle conversion rows a crash left in `processing` (contract §11.2). */
  @Public()
  @HttpCode(200)
  @Post('action/work/recover-conversion-operations')
  @ApiOperation({ summary: 'Worker entry: settle conversion rows a crash left in processing' })
  @ApiResponse({ status: 200, description: 'What the recovery settled, and what it left for a human' })
  @ApiResponse({ status: 401, description: 'Missing or invalid worker capability' })
  async workRecoverConversions(@Headers('x-worker-secret') secret?: string) {
    this.assertWorkerSecret(secret);
    return runAsLeadScoreSystem(this.scope, 'conversion-recovery', () => this.conversionAudit.recoverStuck());
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
  @ApiOperation({ summary: 'Score one Lead under the active published model and keep the result' })
  @ApiResponse({ status: 200, description: 'The written (or unchanged) score' })
  @ApiResponse({ status: 403, description: 'Caller lacks recalculate or Lead edit, or the module switch is off' })
  @ApiResponse({ status: 409, description: 'No active published model' })
  @ApiResponse({ status: 422, description: 'Malformed request' })
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
  @ApiOperation({ summary: 'The current score of one Lead, with its breakdown and freshness' })
  @ApiResponse({ status: 200, description: 'Score, band, reasons and the freshness block; no Lead values' })
  @ApiResponse({ status: 403, description: 'Caller cannot read the Lead or lacks explainScore' })
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
  @ApiOperation({ summary: 'Paged evaluation history of one Lead, newest first' })
  @ApiResponse({ status: 200, description: 'The page of evaluations; history is never browsable outside a Lead' })
  @ApiResponse({ status: 403, description: 'Caller cannot read the Lead or lacks explainScore' })
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
  @ApiOperation({ summary: 'Queue a bounded rebuild over the Leads a validated filter names' })
  @ApiResponse({ status: 200, description: 'The first job row, the runId and the applied bounds' })
  @ApiResponse({ status: 403, description: 'Caller lacks batchRecalculate, or the module switch is off' })
  @ApiResponse({ status: 422, description: 'Malformed filter, or no active published model' })
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
  @ApiOperation({ summary: 'Worker entry: a committed Lead change; decide whether it is worth a job' })
  @ApiResponse({ status: 200, description: 'The enqueue decision — one of six answers, always 200' })
  @ApiResponse({ status: 401, description: 'Missing or invalid worker capability' })
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
  @ApiOperation({ summary: 'Worker entry: run the recalculation a job promised' })
  @ApiResponse({ status: 200, description: 'The written (or unchanged) score' })
  @ApiResponse({ status: 401, description: 'Missing or invalid worker capability' })
  async workRecalculate(@Body() body: unknown, @Headers('x-worker-secret') secret?: string) {
    this.assertWorkerSecret(secret);
    const input = this.parse(ScoreRecalculateSchema, body);
    return runAsLeadScoreSystem(this.scope, 'recalculate', () => this.recalculation.recalculateQueued(input.leadId));
  }

  /** Worker entry: evaluate one chunk of a rebuild and hand the cursor to the next chunk. */
  @Public()
  @HttpCode(200)
  @Post('action/work/recalculate-batch-chunk')
  @ApiOperation({ summary: 'Worker entry: evaluate one chunk of a rebuild and queue the next' })
  @ApiResponse({ status: 200, description: 'Chunk counts, cursor and the next job id' })
  @ApiResponse({ status: 401, description: 'Missing or invalid worker capability' })
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
        trigger: input.trigger,
        source: input.source,
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
