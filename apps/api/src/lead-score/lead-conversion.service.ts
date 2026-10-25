import { AppError, AuthorizationDeniedError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AclApiService } from '../acl/acl-api.service.js';
import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { DatabaseService,type DbTx } from '../database/database.service.js';
import { EntityCrudService } from '../entity/entity.service.js';
import { runInTransaction } from '../entity/tx-context.js';
import { EventBus } from '../events/event-bus.js';
import { type ConversionPreviewView, LeadConversionPreviewService, type TargetPreview } from './lead-conversion-preview.service.js';
import type { MappingTarget } from './lead-field-mapping.service.js';
import {
  leadScoreAlreadyConvertedError,
  leadScoreConversionConflictError,
  leadScoreConversionInFlightError,
  leadScoreConversionNeedsRecoveryError,
  leadScoreConversionRetryableError,
  leadScoreDuplicateReviewRequiredError,
  leadScoreModuleDisabledError,
  leadScorePreviewStaleError,
  leadScoreReparentRequiredError,
} from './lead-score-errors.js';
import { LeadScoreFeatureGate } from './lead-score-feature-gate.service.js';
import { runAsLeadScoreInternal } from './lead-score-internal.js';
import { LeadScorePermissionService } from './lead-score-permission.service.js';
import { LeadScoreSettingsService } from './lead-score-settings.service.js';
import { type ConversionStatus } from './lead-score-vocabulary.js';

/**
 * Phase 19-LS.13 — running the conversion, once
 * (`PLAN_Phase_19_LeadScore.md` §3.4, §4.3, §7.6, §7.8, §8.3; audit §11 `LS.13`; contract §3, §4, §10).
 *
 * The exit criterion has two halves and they pull in opposite directions: *retrying the same operation cannot
 * create duplicate targets*, and *a failed atomic operation leaves no inconsistent state*. This service answers
 * both with one shape:
 *
 *  - **T1 — claim.** One insert, in its own transaction, carrying the caller's `operationKey`. The LS.2 unique
 *    index is the concurrency guard, so a double click is a replay rather than a race, and a crash after this
 *    point leaves a `processing` row an administrator can see (contract §3.3).
 *  - **T2 — work.** One transaction: lock the Lead, re-read it under the lock, create or link the targets
 *    through `EntityCrudService` (so validation, field ACL, hooks, audit and the outbox are the ordinary ones),
 *    set the Lead's `Converted` status and references, mark the operation `succeeded`, and dispatch
 *    `lead.conversionSucceeded.v1` — all of it, or none of it. Nothing is written before the lock, which is why
 *    the loser of two concurrent attempts can say "already converted" and mean it.
 *  - **T3 — settle.** A separate transaction, only on failure, records *why*: `failed_final` for a refusal that
 *    will not change by repeating it, `failed_retryable` for a transient failure that left nothing behind. The
 *    row is the answer to "what happened to my conversion" when the HTTP response did not arrive.
 *
 * The command runs **as the caller**, never as the module's system principal: a conversion is a user act whose
 * permissions are the user's (plan §9.2). `runAsLeadScoreInternal` is used for exactly one thing — writing the
 * Lead fields and the operation row the LS.2 guard reserves for this module — and it does not touch ACL.
 */
export interface ConvertTargetChoice {
  readonly type: MappingTarget;
  readonly action: 'create' | 'link';
  readonly existingId?: string | undefined;
}

export interface ConvertInput {
  readonly leadId: string;
  readonly operationKey: string;
  readonly targets: readonly ConvertTargetChoice[];
  readonly fieldMerge?: readonly { readonly target: MappingTarget; readonly field: string; readonly value?: unknown }[] | undefined;
  readonly previewHash: string;
  readonly acknowledged: readonly string[];
  readonly overrideDuplicateFor?: readonly MappingTarget[] | undefined;
  readonly allowReparent?: boolean | undefined;
}

/** What the T1 claim stores as the attempt's plan — decisions and the fingerprint, never record values. */
export interface ConversionPlanRecord {
  readonly previewHash: string;
  readonly targets: readonly { readonly type: MappingTarget; readonly action: 'create' | 'link'; readonly existingId: string | null }[];
  readonly fieldMerge: readonly { readonly target: MappingTarget; readonly field: string; readonly value?: unknown }[];
  readonly acknowledged: readonly string[];
  readonly overrideDuplicateFor: readonly MappingTarget[];
  readonly allowReparent: boolean;
}

export interface ConversionAffordanceView {
  readonly leadId: string;
  readonly canPreview: boolean;
  readonly canConvert: boolean;
  /** Whether this caller may answer "create anyway" to a duplicate warning (the wizard's override box). */
  readonly canOverride: boolean;
  /**
   * The target types this installation may build right now: `conversion.targets`, minus anything whose feature
   * is off. A wizard renders its rows from this list rather than assuming Account/Contact always exist.
   */
  readonly targets: readonly string[];
  readonly alreadyConverted: boolean;
  readonly status: string | null;
  readonly convertedAt: string | null;
  readonly convertedContactId: string | null;
  readonly convertedAccountId: string | null;
  readonly convertedOpportunityId: string | null;
  readonly operationId: string | null;
  /** Stable reasons the button is off; empty when `canConvert` is true (contract §12.2). */
  readonly reasons: readonly string[];
}

export interface ConversionResultView {
  readonly operationId: string;
  readonly operationKey: string;
  readonly status: ConversionStatus;
  readonly leadId: string;
  readonly leadStatus: string | null;
  readonly createdAccountId: string | null;
  readonly createdContactId: string | null;
  readonly createdOpportunityId: string | null;
  readonly linkedAccountId: string | null;
  readonly linkedContactId: string | null;
  readonly linkedOpportunityId: string | null;
  readonly convertedAt: string | null;
  readonly failureCode: string | null;
  readonly completedAt: string | null;
  readonly resultSummary: Record<string, unknown> | null;
}

export interface OperationRecord {
  readonly id: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/** What T2 applies: the decisions from the request plus whatever recovery has already written. */
export interface ExecutablePlan {
  readonly leadRevision: number;
  readonly targets: readonly { readonly type: MappingTarget; readonly action: 'create' | 'link'; readonly existingId?: string | undefined }[];
  readonly fieldMerge: readonly { readonly target: MappingTarget; readonly field: string; readonly value?: unknown }[];
  readonly allowReparent: boolean;
  /** Targets this attempt must not create again, with the id already written (recovery only). */
  readonly alreadyCreated: Readonly<Partial<Record<MappingTarget, string>>>;
}

const SUCCEEDED_EVENT = 'lead.conversionSucceeded.v1';
const FAILED_EVENT = 'lead.conversionFailed.v1';
const CONVERSION_OPERATION_ENTITY = 'LeadConversionOperation';

@Injectable()
export class LeadConversionService {
  constructor(
    @Inject(LeadScoreFeatureGate) private readonly gate: LeadScoreFeatureGate,
    @Inject(LeadScoreSettingsService) private readonly settings: LeadScoreSettingsService,
    @Inject(LeadScorePermissionService) private readonly permissions: LeadScorePermissionService,
    @Inject(LeadConversionPreviewService) private readonly preview: LeadConversionPreviewService,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(EventBus) private readonly events: EventBus,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  /**
   * Convert one Lead under one operation key.
   *
   * The order is deliberate: **replay first** (a repeated key must answer with what happened, not re-derive a
   * plan a converted Lead can no longer satisfy), then rebuild and compare the preview, then the decisions the
   * preview demanded, then the claim, then the work. A refusal before the claim writes nothing at all — an
   * operation row is evidence that an attempt *started*, and a request that failed its own guards did not.
   */
  async convert(input: ConvertInput): Promise<ConversionResultView> {
    await this.gate.assertOperation('conversionExecute');

    const prior = await this.operationByKey(input.operationKey);
    if (prior !== undefined) return this.replay(prior, input.leadId);

    // The preview is re-run, not trusted: it is the same function the caller used, so re-running it with the
    // request reproduces the fingerprint or proves the request stale (contract §8.3).
    const preview = await this.preview.preview({
      leadId: input.leadId,
      targets: input.targets.map((entry) => ({ type: entry.type, action: entry.action, ...(entry.existingId === undefined ? {} : { existingId: entry.existingId }) })),
      ...(input.fieldMerge === undefined ? {} : { fieldMerge: input.fieldMerge }),
    });
    if (preview.previewHash !== input.previewHash) throw leadScorePreviewStaleError(input.leadId, 'hash');
    const expected = new Set(preview.confirmationTypes);
    const given = new Set(input.acknowledged);
    if (expected.size !== given.size || [...expected].some((type) => !given.has(type))) {
      throw leadScorePreviewStaleError(input.leadId, 'confirmation');
    }
    await this.assertDecisions(input, preview);
    this.assertExecutable(preview, input);

    const plan: ConversionPlanRecord = {
      previewHash: preview.previewHash,
      targets: input.targets.map((entry) => ({ type: entry.type, action: entry.action, existingId: entry.existingId ?? null })),
      fieldMerge: input.fieldMerge ?? [],
      acknowledged: input.acknowledged,
      overrideDuplicateFor: input.overrideDuplicateFor ?? [],
      allowReparent: input.allowReparent === true,
    };

    const operationId = await this.claim(input, plan, preview);
    if (operationId.replayed !== undefined) return operationId.replayed;
    return this.executeAndSettle(operationId.id, input.leadId, {
      leadRevision: preview.leadRevision,
      targets: input.targets,
      fieldMerge: input.fieldMerge ?? [],
      allowReparent: input.allowReparent === true,
      alreadyCreated: {},
    });
  }

  /**
   * May this caller convert this Lead, and has it already been converted? (19-LS.14, contract §12.2.)
   *
   * Its own read rather than a block on the score read, because the score read needs `viewScore` and a
   * converter may legitimately hold only the conversion rights. The answer is never a refusal for a missing
   * right — it is a 200 with `canConvert: false` and the reasons, which is what a button needs to disappear
   * without an error toast (the same shape LS.7 chose for the score card's `actions`).
   */
  async affordance(leadId: string): Promise<ConversionAffordanceView> {
    if ((await this.settings.enabled()) !== true) throw leadScoreModuleDisabledError('enabled');
    const lead = await this.entities.get('Lead', leadId);
    const [canPreview, canExecute, canOverride, leadEdit, view] = await Promise.all([
      this.permissions.can('convertPreview'),
      this.permissions.can('convertExecute'),
      this.permissions.can('duplicateOverride'),
      this.acl.canUser('Lead', 'edit'),
      this.settings.read(),
    ]);
    const effective = view.effective;
    const targets = view.settings.conversion.targets.filter((type) => type !== 'Opportunity' || effective['opportunityConversion'] === true);
    const alreadyConverted = lead['status'] === 'Converted' || stringOf(lead['conversionOperationId']) !== null;
    const reasons: string[] = [];
    if (!canPreview) reasons.push('cannot_preview');
    if (!canExecute) reasons.push('cannot_execute');
    if (leadEdit === 'no') reasons.push('lead_not_editable');
    if (effective['conversionPreview'] !== true) reasons.push('preview_disabled');
    if (effective['leadConversion'] !== true) reasons.push('conversion_disabled');
    if (alreadyConverted) reasons.push('already_converted');
    const previewable = canPreview && effective['conversionPreview'] === true;
    return {
      leadId,
      canPreview: previewable,
      canConvert: previewable && canExecute && leadEdit !== 'no' && effective['leadConversion'] === true && !alreadyConverted,
      canOverride,
      targets,
      alreadyConverted,
      status: stringOf(lead['status']),
      convertedAt: instantOf(lead['convertedAt']),
      convertedContactId: stringOf(lead['convertedContactId']),
      convertedAccountId: stringOf(lead['convertedAccountId']),
      convertedOpportunityId: stringOf(lead['convertedOpportunityId']),
      operationId: stringOf(lead['conversionOperationId']),
      reasons,
    };
  }

  /**
   * Re-run an operation that is already claimed (recovery, contract §10.2).
   *
   * The audit service has done the accounting — that is what makes this safe to call — and the plan is
   * re-derived from the *stored* decisions, so a retry after a transient failure runs the same conversion and
   * refuses (`needs_review`) if the Lead, the map or the reader's visibility has moved on since.
   */
  async resume(operation: OperationRecord): Promise<ConversionResultView> {
    const leadId = String(operation.data['sourceLeadId'] ?? '');
    const plan = planOf(operation);
    if (plan === null) {
      await this.settle(operation.id, 'needs_review', 'inconsistent', null);
      throw leadScoreConversionNeedsRecoveryError(operation.id, 'inconsistent');
    }
    let preview: ConversionPreviewView;
    try {
      preview = await this.preview.preview({
        leadId,
        targets: plan.targets.map((entry) => ({ type: entry.type, action: entry.action, ...(entry.existingId === null ? {} : { existingId: entry.existingId }) })),
        ...(plan.fieldMerge.length === 0 ? {} : { fieldMerge: plan.fieldMerge }),
      });
    } catch (error) {
      // The Lead or a target is gone, or this caller may no longer read it: the plan cannot run again.
      const code = failureCodeOf(error);
      await this.settle(operation.id, 'needs_review', code, null);
      throw leadScoreConversionNeedsRecoveryError(operation.id, code);
    }
    if (preview.previewHash !== plan.previewHash) {
      await this.settle(operation.id, 'needs_review', 'stale', null);
      throw leadScoreConversionNeedsRecoveryError(operation.id, 'stale');
    }
    const alreadyCreated: Partial<Record<MappingTarget, string>> = {};
    for (const type of ['Account', 'Contact', 'Opportunity'] as const) {
      const id = stringOf(operation.data[`created${type}Id`]);
      if (id !== null) alreadyCreated[type] = id;
    }
    return this.executeAndSettle(operation.id, leadId, {
      leadRevision: preview.leadRevision,
      targets: plan.targets.map((entry) => ({ type: entry.type, action: entry.action, ...(entry.existingId === null ? {} : { existingId: entry.existingId }) })),
      fieldMerge: plan.fieldMerge,
      allowReparent: plan.allowReparent,
      alreadyCreated,
    });
  }

  /** Re-claim a row that a scan or a retry is about to work on; the conditional update is the mutex. */
  async reclaim(operationId: string): Promise<boolean> {
    const result = await runAsLeadScoreInternal(() =>
      runInTransaction(this.database.db, async () => {
        const row = await this.operationById(operationId);
        if (row === undefined) return false;
        const status = statusOf(row.data['status']);
        if (status !== 'failed_retryable' && status !== 'needs_review' && status !== 'processing') return false;
        await this.entities.update(CONVERSION_OPERATION_ENTITY, operationId, { status: 'processing', confirmedAt: new Date(), failureCode: null });
        return true;
      }),
    );
    return result;
  }

  /** The stored operation for a key, or `undefined`. Read through SQL: the entity is `read: 'no'` by design. */
  async operationByKey(operationKey: string): Promise<OperationRecord | undefined> {
    const rows = await sql<{ id: string; attrs: Record<string, unknown> }>`
      select id, attrs from entity_records
       where entity_type = ${CONVERSION_OPERATION_ENTITY}
         and deleted_at is null
         and attrs->>'operationKey' = ${operationKey}
       limit 1
    `.execute(this.database.db);
    const row = rows.rows[0];
    return row === undefined ? undefined : { id: row.id, data: row.attrs };
  }

  /** A single operation by id, for the audit service. */
  async operationById(operationId: string): Promise<OperationRecord | undefined> {
    const rows = await sql<{ id: string; attrs: Record<string, unknown> }>`
      select id, attrs from entity_records
       where entity_type = ${CONVERSION_OPERATION_ENTITY} and id = ${operationId} and deleted_at is null
       limit 1
    `.execute(this.database.db);
    const row = rows.rows[0];
    return row === undefined ? undefined : { id: row.id, data: row.attrs };
  }

  /** Move a row's state, in its own transaction, under the module marker the LS.2 guard expects. */
  async settle(operationId: string, status: ConversionStatus, failureCode: string | null, summary: Record<string, unknown> | null): Promise<void> {
    const completedAt = new Date().toISOString();
    await runAsLeadScoreInternal(() =>
      runInTransaction(this.database.db, async (tx) => {
        const row = await this.operationById(operationId);
        if (row === undefined) return;
        await this.entities.update(CONVERSION_OPERATION_ENTITY, operationId, {
          status,
          failureCode,
          completedAt,
          resultSummary: JSON.stringify({ plan: planOf(row), ...(summary === null ? {} : { outcome: summary }) }),
        });
        // A terminal or review failure is a fact downstream systems may act on; a retryable one is not final
        // yet, so it stays quiet (contract §10.4).
        if (failureCode !== null && (status === 'failed_final' || status === 'needs_review')) {
          await this.events.dispatch(tx, {
            type: FAILED_EVENT,
            payload: {
              schemaVersion: 1,
              leadId: String(row.data['sourceLeadId'] ?? ''),
              operationId,
              status,
              failureCode,
              correlationId: stringOf(row.data['correlationId']),
              occurredAt: completedAt,
            },
          });
        }
      }),
    );
  }

  /** The answer a repeated key gets (contract §4.2). */
  private replay(prior: OperationRecord, leadId: string): ConversionResultView {
    if (String(prior.data['sourceLeadId'] ?? '') !== leadId) {
      // The key belongs to another Lead. A conflict, and the id it belongs to is not echoed.
      throw leadScoreConversionConflictError(leadId);
    }
    const status = statusOf(prior.data['status']);
    if (status === 'succeeded') return this.view(prior);
    if (status === 'processing') throw leadScoreConversionInFlightError(prior.id);
    if (status === 'failed_retryable' || status === 'needs_review') {
      throw leadScoreConversionNeedsRecoveryError(prior.id, stringOf(prior.data['failureCode']) ?? status);
    }
    // failed_final: repeating it will not change the answer, and the stored code says why.
    throw new ValidationError('This conversion attempt failed finally. A new attempt needs a new operation key.', {
      operationId: prior.id,
      state: status,
      failureCode: stringOf(prior.data['failureCode']),
    });
  }

  /**
   * T1: the unique index is the double-click guard.
   *
   * A genuine race (two requests, same key, same instant) loses here and is answered through the replay path —
   * the row that won is the answer, whatever state it is in.
   */
  private async claim(input: ConvertInput, plan: ConversionPlanRecord, preview: ConversionPreviewView): Promise<{ id: string; replayed?: ConversionResultView }> {
    const created = await runAsLeadScoreInternal(() =>
      runInTransaction(this.database.db, async () =>
        this.entities
          .create(CONVERSION_OPERATION_ENTITY, {
            name: `Convert ${String(input.leadId).slice(0, 8)}`,
            operationKey: input.operationKey,
            sourceLeadId: input.leadId,
            sourceLeadRevision: preview.leadRevision,
            status: 'processing',
            requestedTargets: input.targets.map((entry) => entry.type),
            previewHash: input.previewHash,
            mappingVersion: Object.values(preview.fingerprint.mappingVersions)[0] ?? 1,
            selectedMatchIds: JSON.stringify(input.targets.filter((entry) => entry.action === 'link').map((entry) => entry.existingId ?? '')),
            ...(this.scope.principal?.userId === undefined ? {} : { requestedById: this.scope.principal.userId }),
            requestedAt: new Date(),
            confirmedAt: new Date(),
            correlationId: 'leadScore:convert',
            resultSummary: JSON.stringify({ plan }),
          })
          .catch((error: unknown) => {
            if (error instanceof AppError && error.code === 'DUPLICATE_RECORD') return null;
            throw error;
          }),
      ),
    );
    if (created !== null) return { id: String(created['id'] ?? '') };
    const raced = await this.operationByKey(input.operationKey);
    if (raced === undefined) throw leadScoreConversionConflictError(input.leadId);
    return { id: raced.id, replayed: this.replay(raced, input.leadId) };
  }

  /**
   * T2 then T3.
   *
   * The work is one transaction; the settle is another and runs only when the first threw. Everything T2 needs
   * is read *inside* it — the Lead under a row lock, each linked target in the same transaction — so "the plan
   * was true when we previewed" becomes "the plan is true now, or nothing happens".
   */
  private async executeAndSettle(operationId: string, leadId: string, plan: ExecutablePlan): Promise<ConversionResultView> {
    try {
      await runAsLeadScoreInternal(() =>
        runInTransaction(this.database.db, async (tx) => {
          const locked = await sql<{ id: string }>`
            select id from entity_records
             where id = ${leadId} and entity_type = 'Lead' and deleted_at is null
             for update
          `.execute(tx);
          if (locked.rows.length === 0) throw new AppError('RECORD_NOT_FOUND', 'The Lead no longer exists.', { entity: 'Lead' }, 404);
          await this.work(operationId, leadId, plan, tx);
        }),
      );
    } catch (error) {
      const failure = failureOf(error);
      await this.settle(operationId, failure.status, failure.code, null);
      if (failure.status === 'failed_retryable') throw leadScoreConversionRetryableError(operationId, failure.code);
      throw error;
    }
    const row = await this.operationById(operationId);
    if (row === undefined) throw new AppError('RECORD_NOT_FOUND', 'The conversion operation no longer exists.', { entity: CONVERSION_OPERATION_ENTITY }, 404);
    return this.view(row);
  }

  /** The transactional body: lock held, Lead re-read, targets written, Lead and row updated, event dispatched. */
  private async work(operationId: string, leadId: string, plan: ExecutablePlan, tx: DbTx): Promise<void> {
    const operation = await this.operationById(operationId);
    if (operation === undefined) throw new AppError('RECORD_NOT_FOUND', 'The conversion operation no longer exists.', { entity: CONVERSION_OPERATION_ENTITY }, 404);

    const lead = await this.entities.get('Lead', leadId);
    if (lead['status'] === 'Converted' || stringOf(lead['conversionOperationId']) !== null) {
      throw leadScoreAlreadyConvertedError(leadId, instantOf(lead['convertedAt']), operationId);
    }
    const revision = typeof lead['version'] === 'number' ? lead['version'] : 0;
    if (revision !== plan.leadRevision) {
      throw leadScorePreviewStaleError(leadId, 'revision', { expected: plan.leadRevision, current: revision });
    }

    // The proposal is the preview's own answer, resolved again inside the transaction so it reads what this
    // transaction will write (mapping, ACL and the Lead's own values are the ones in front of it).
    const preview = await this.preview.preview({
      leadId,
      targets: plan.targets.map((entry) => ({ type: entry.type, action: entry.action, ...(entry.existingId === undefined ? {} : { existingId: entry.existingId }) })),
      ...(plan.fieldMerge.length === 0 ? {} : { fieldMerge: plan.fieldMerge }),
    });

    const account = preview.targets.find((entry) => entry.type === 'Account');
    const contact = preview.targets.find((entry) => entry.type === 'Contact');
    const opportunity = preview.targets.find((entry) => entry.type === 'Opportunity');
    const accountId = await this.applyTarget(account, 'Account', plan);
    const contactId = await this.applyTarget(contact, 'Contact', plan, { accountId });
    const opportunityId = await this.applyTarget(opportunity, 'Opportunity', plan, { accountId, contactId });

    const now = new Date().toISOString();
    const actorId = this.scope.principal?.userId ?? null;
    await this.entities.update('Lead', leadId, {
      status: 'Converted',
      convertedAt: now,
      conversionOperationId: operationId,
      convertedAccountId: accountId,
      convertedContactId: contactId,
      convertedOpportunityId: opportunityId,
      ...(actorId === null ? {} : { convertedById: actorId }),
    });

    const created = {
      ...(account?.action === 'create' && accountId !== null ? { createdAccountId: accountId } : {}),
      ...(contact?.action === 'create' && contactId !== null ? { createdContactId: contactId } : {}),
      ...(opportunity?.action === 'create' && opportunityId !== null ? { createdOpportunityId: opportunityId } : {}),
    };
    const linked = {
      ...(account?.action === 'link' && accountId !== null ? { linkedAccountId: accountId } : {}),
      ...(contact?.action === 'link' && contactId !== null ? { linkedContactId: contactId } : {}),
      ...(opportunity?.action === 'link' && opportunityId !== null ? { linkedOpportunityId: opportunityId } : {}),
    };
    const merged = preview.targets.flatMap((target) => target.proposed.filter((entry) => entry.origin === 'merge').map((entry) => `${target.type}.${entry.field}`));
    const outcome = { ...created, ...linked, merged, convertedAt: now };
    await this.entities.update(CONVERSION_OPERATION_ENTITY, operationId, {
      status: 'succeeded',
      completedAt: now,
      ...created,
      ...linked,
      resultSummary: JSON.stringify({ plan: planOf(operation), outcome }),
    });
    await this.events.dispatch(tx, {
      type: SUCCEEDED_EVENT,
      payload: { schemaVersion: 1, leadId, operationId, targets: { created, linked }, correlationId: 'leadScore:convert', occurredAt: now },
    });
  }

  /**
   * Create or link one target, and return its id.
   *
   * A create runs through `EntityCrudService` with the proposal the preview described, so field ACL, required
   * fields, hooks, audit and the outbox are the ordinary ones. A link writes nothing except the relationship and
   * any merge the caller asked for — and, for a Contact, a re-parent the command already validated.
   *
   * `links` are the relationship carries contract §5.1/§6.2 assigns, never mapped values: a Contact points at
   * the operation's Account, and an Opportunity points at that Account and *appends* the operation's Contact to
   * `contactIds`. Appending is the difference between adding the person who was converted and silently removing
   * colleagues from a deal the actor may not even be able to read. The Opportunity's stage, amount and close
   * date stay Sales' — this method writes no selling semantics (19-LS.16).
   */
  private async applyTarget(
    target: TargetPreview | undefined,
    type: MappingTarget,
    plan: ExecutablePlan,
    links: { readonly accountId?: string | null; readonly contactId?: string | null } = {},
  ): Promise<string | null> {
    if (target === undefined) return null;
    const preCreated = plan.alreadyCreated[type];
    if (preCreated !== undefined) return preCreated;
    if (target.action === 'create') {
      const values = proposedValues(target);
      if (links.accountId !== undefined && links.accountId !== null && (type === 'Contact' || type === 'Opportunity')) {
        values['accountId'] = links.accountId;
      }
      if (type === 'Opportunity' && links.contactId !== undefined && links.contactId !== null) {
        values['contactIds'] = [links.contactId];
      }
      const created = await this.entities.create(type, values);
      return String(created['id'] ?? '') || null;
    }
    const id = target.existingId;
    if (id === null) throw new ValidationError('A link needs the record it links to.', { target: type, state: 'missingTarget' });
    const current = await this.entities.get(type, id);
    const patch: Record<string, unknown> = { ...mergedValues(target) };
    if (links.accountId !== undefined && links.accountId !== null && (type === 'Contact' || type === 'Opportunity')) {
      const existingAccount = stringOf(current['accountId']);
      if (existingAccount !== links.accountId) {
        // A Contact moving between Accounts broadens who can reach it, so it needs the explicit decision
        // (contract §6.3). An Opportunity's Account is the operation's by policy (§5.1) and the move was shown
        // as a before/after in the preview, so it does not need a second acknowledgement.
        if (type === 'Contact' && existingAccount !== null && plan.allowReparent !== true) throw leadScoreReparentRequiredError(id, links.accountId, existingAccount);
        patch['accountId'] = links.accountId;
      }
    }
    if (type === 'Opportunity' && links.contactId !== undefined && links.contactId !== null) {
      const currentContacts = Array.isArray(current['contactIds'])
        ? current['contactIds'].filter((entry): entry is string => typeof entry === 'string')
        : [];
      if (!currentContacts.includes(links.contactId)) patch['contactIds'] = [...currentContacts, links.contactId];
    }
    if (Object.keys(patch).length === 0) return id;
    await this.entities.update(type, id, { ...patch, version: current['version'] });
    return id;
  }

  /**
   * The decisions the preview demanded, before anything is claimed.
   *
   * Duplicates: a create next to a candidate — or next to a *hidden* one — needs an explicit
   * `create_with_override`, which is the capability plan §7.3 names. The wizard's three answers are link
   * (expressed as `existingId`), create-with-override, or cancel (not calling this).
   */
  private async assertDecisions(input: ConvertInput, preview: ConversionPreviewView): Promise<void> {
    const overrides = input.overrideDuplicateFor ?? [];
    if (overrides.length > 0) await this.permissions.assert('duplicateOverride');

    const duplicates = preview.duplicates;
    if (duplicates !== null && duplicates.requiresChoice) {
      for (const target of input.targets) {
        if (target.action !== 'create') continue;
        // Only a Contact/Account create can duplicate a candidate; a deal named after the Lead is not the
        // same question, and the resolver produces no Opportunity stage (contract §9, 19-LS.16).
        if (target.type === 'Opportunity') continue;
        const matching = duplicates.candidates.some((candidate) => candidate.entity === target.type);
        if (!matching && duplicates.hiddenMatches === 0) continue;
        if (overrides.includes(target.type)) continue;
        throw leadScoreDuplicateReviewRequiredError(input.leadId, duplicates.candidates.length, duplicates.hiddenMatches);
      }
    }

    if (preview.confirmationTypes.includes('contact_reparent')) {
      const contact = preview.targets.find((entry) => entry.type === 'Contact');
      const account = preview.targets.find((entry) => entry.type === 'Account');
      if (input.allowReparent !== true) throw leadScoreReparentRequiredError(contact?.existingId ?? '', account?.existingId ?? '', null);
      await this.permissions.assert('applyFieldChanges');
      const settings = await this.settings.settings();
      if (settings.conversion.fieldMergeAllowed !== true) {
        throw new AuthorizationDeniedError('Moving a Contact between Accounts is disabled by the conversion policy.', {
          capability: 'applyFieldChanges',
          setting: 'conversion.fieldMergeAllowed',
        });
      }
    }
  }

  /** The preview already answered whether this caller can run the plan; a refusal names the parts. */
  private assertExecutable(preview: ConversionPreviewView, input: ConvertInput): void {
    if (preview.permission.canExecute) return;
    const forbidden = preview.permission.reasons.some((reason) => reason.startsWith('cannot_') || reason.startsWith('target_unreadable'));
    if (forbidden) {
      throw new AuthorizationDeniedError('This conversion cannot run under your permissions.', { leadId: input.leadId, reasons: [...preview.permission.reasons] });
    }
    throw new ValidationError('This conversion cannot run as requested yet.', { leadId: input.leadId, reasons: [...preview.permission.reasons] });
  }

  private view(row: OperationRecord): ConversionResultView {
    const status = statusOf(row.data['status']);
    return {
      operationId: row.id,
      operationKey: String(row.data['operationKey'] ?? ''),
      status,
      leadId: String(row.data['sourceLeadId'] ?? ''),
      leadStatus: status === 'succeeded' ? 'Converted' : null,
      createdAccountId: stringOf(row.data['createdAccountId']),
      createdContactId: stringOf(row.data['createdContactId']),
      createdOpportunityId: stringOf(row.data['createdOpportunityId']),
      linkedAccountId: stringOf(row.data['linkedAccountId']),
      linkedContactId: stringOf(row.data['linkedContactId']),
      linkedOpportunityId: stringOf(row.data['linkedOpportunityId']),
      convertedAt: instantOf(row.data['completedAt']),
      failureCode: stringOf(row.data['failureCode']),
      completedAt: instantOf(row.data['completedAt']),
      resultSummary: objectOf(row.data['resultSummary']),
    };
  }
}

/** The values a create writes, from the proposal the preview produced. */
function proposedValues(target: TargetPreview): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const entry of target.proposed) {
    if (entry.origin === 'merge') continue;
    values[entry.field] = entry.value;
  }
  return values;
}

/** The values an explicit merge writes. */
function mergedValues(target: TargetPreview): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const entry of target.proposed) {
    if (entry.origin === 'merge') values[entry.field] = entry.value;
  }
  return values;
}

function planOf(row: OperationRecord): ConversionPlanRecord | null {
  const summary = objectOf(row.data['resultSummary']);
  const plan = summary === null ? undefined : summary['plan'];
  if (typeof plan !== 'object' || plan === null) return null;
  const record = plan as Record<string, unknown>;
  const previewHash = typeof record['previewHash'] === 'string' ? record['previewHash'] : '';
  const targets = Array.isArray(record['targets']) ? record['targets'] : [];
  if (previewHash === '' || targets.length === 0) return null;
  return {
    previewHash,
    targets: targets.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return [];
      const target = entry as Record<string, unknown>;
      const type = target['type'];
      if (type !== 'Contact' && type !== 'Account' && type !== 'Opportunity') return [];
      return [
        {
          type,
          action: target['action'] === 'link' ? ('link' as const) : ('create' as const),
          existingId: typeof target['existingId'] === 'string' ? target['existingId'] : null,
        },
      ];
    }),
    fieldMerge: Array.isArray(record['fieldMerge'])
      ? record['fieldMerge'].flatMap((entry) => {
          if (typeof entry !== 'object' || entry === null) return [];
          const merge = entry as Record<string, unknown>;
          const type = merge['target'];
          if (type !== 'Contact' && type !== 'Account' && type !== 'Opportunity') return [];
          return [{ target: type, field: String(merge['field'] ?? ''), value: merge['value'] }];
        })
      : [],
    acknowledged: Array.isArray(record['acknowledged']) ? record['acknowledged'].map((entry) => String(entry)) : [],
    overrideDuplicateFor: Array.isArray(record['overrideDuplicateFor'])
      ? record['overrideDuplicateFor'].filter((entry): entry is MappingTarget => entry === 'Contact' || entry === 'Account' || entry === 'Opportunity')
      : [],
    allowReparent: record['allowReparent'] === true,
  };
}

function failureOf(error: unknown): { status: 'failed_final' | 'failed_retryable'; code: string } {
  if (!(error instanceof AppError)) return { status: 'failed_retryable', code: 'transient' };
  switch (error.code) {
    case 'LEADSCORE_ALREADY_CONVERTED':
      return { status: 'failed_final', code: 'already_converted' };
    case 'LEADSCORE_PREVIEW_STALE':
      return { status: 'failed_final', code: 'lead_changed' };
    case 'LEADSCORE_CONVERSION_REPARENT_REQUIRED':
      return { status: 'failed_final', code: 'reparent_required' };
    case 'AUTHORIZATION_DENIED':
    case 'FORBIDDEN':
    case 'FEATURE_DISABLED':
      return { status: 'failed_final', code: 'forbidden' };
    case 'VALIDATION_FAILED':
      return { status: 'failed_final', code: 'target_invalid' };
    case 'RECORD_NOT_FOUND':
    case 'NOT_FOUND':
      return { status: 'failed_final', code: 'target_missing' };
    case 'CONCURRENCY_CONFLICT':
    case 'DUPLICATE_RECORD':
      return { status: 'failed_final', code: 'target_changed' };
    default:
      return { status: 'failed_final', code: error.code.toLowerCase() };
  }
}

function failureCodeOf(error: unknown): string {
  return failureOf(error).code;
}

function statusOf(value: unknown): ConversionStatus {
  return value === 'succeeded' || value === 'failed_retryable' || value === 'failed_final' || value === 'needs_review' ? value : 'processing';
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function instantOf(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'string' && value !== '') return value;
  return null;
}

function objectOf(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}
