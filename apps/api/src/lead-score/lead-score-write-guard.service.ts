import { ValidationError } from '@carocrm/core/errors/index.js';
import type { HookContext } from '@carocrm/entity-engine/types/index.js';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';

import { HookRegistry } from '../hooks/hook.registry.js';
import {
  changedKeys,
  isLeadScoreInternalWrite,
  LEADSCORE_ENTITY_TYPES,
  MODULE_WRITTEN_ENTITY_TYPES,
  SERVER_OWNED_LEAD_FIELDS,
} from './lead-score-internal.js';

/**
 * Phase 19-LS.2 — the write guard for the fields and records Lead Score owns
 * (`PLAN_Phase_19_LeadScore.md` §0.1-8, §5.3–§5.6, §7.6; audit §4, §6).
 *
 * The domain commands are not the only way into these rows. `/api/v1/Lead/:id` reaches the same record
 * that holds the score projection, and `/api/v1/LeadScoreEvaluation` reaches the history. So this guard
 * runs on `beforeValidate` — the one phase every write passes through — and refuses a **client** write
 * that sets a field the module computes. Writes performed by a Lead Score domain service are marked
 * (`runAsLeadScoreInternal`) and pass.
 *
 * Two refusals, two reasons:
 *
 * 1. on `Lead`, a server-owned attribute (plan §5.3, §5.6). A score is the output of a versioned model
 *    evaluated against a data snapshot, and the `Converted` references are the outcome of the conversion
 *    command — a client that could write `convertedContactId` could fake a conversion out of a Contact id
 *    it can already see, which is exactly the "hidden mutation" plan §1.2 rules out;
 * 2. on `LeadScoreEvaluation` and `LeadConversionOperation`, the whole record: history is append-only and
 *    written by the engine, and an operation row is created by the command that carries it. Editing one
 *    by hand would break the audit trail the operation id exists to provide (§5.4, §5.5).
 *
 * **The guard is not behind the module switch.** Disabling Lead Score closes its screens and its jobs,
 * but `scoreValue` and `convertedAccountId` remain the module's attributes on a core record, and an
 * installation that turned the module off should still not be able to forge a score or a conversion
 * through the record API. `Lead` CRUD itself is untouched: an ordinary name, status or phone edit never
 * reaches this check, because it changes none of these keys (plan §16 `19-LS.1` exit criterion, kept
 * true here and re-tested).
 *
 * `LeadScoreModel` and `LeadScoreRule` are deliberately *not* module-written: they are draft
 * administration records whose lifecycle (publish, archive, immutability) 19-LS.3 enforces, and the
 * field list they must protect is already declared in `SERVER_OWNED_MODEL_FIELDS`.
 */

/** The `Lead` attributes Lead Score computes. */
const LEAD_SERVER_OWNED: readonly string[] = SERVER_OWNED_LEAD_FIELDS;

const GUARDED: ReadonlySet<string> = new Set<string>(LEADSCORE_ENTITY_TYPES);

@Injectable()
export class LeadScoreWriteGuardService implements OnApplicationBootstrap {
  constructor(@Inject(HookRegistry) private readonly hooks: HookRegistry) {}

  onApplicationBootstrap(): void {
    this.register();
  }

  register(): void {
    // One hook per guarded entity, the shape `service-desk` and `marketingAutomation` use: the registry
    // filters by entity before the handler runs, so an ordinary record write pays nothing.
    this.hooks.register({
      name: 'leadScore.leadFieldGuard',
      phase: 'beforeValidate',
      entity: 'Lead',
      handler: (context) => this.guardLeadFields(context),
    });

    for (const entity of MODULE_WRITTEN_ENTITY_TYPES) {
      this.hooks.register({
        name: `leadScore.${entity}Guard`,
        phase: 'beforeValidate',
        entity,
        handler: (context) => this.guardModuleWritten(context),
      });
    }
  }

  private guardLeadFields(context: HookContext): void {
    if (isLeadScoreInternalWrite()) return;
    const data = context.data;
    if (data === undefined) return;

    const changed = context.operation === 'create' ? Object.keys(data) : changedKeys(data, context.previous ?? {});
    const offending = changed.filter((key) => LEAD_SERVER_OWNED.includes(key));
    if (offending.length === 0) return;

    throw new ValidationError(
      `These fields on Lead are owned by the Lead Score module and cannot be set through the record API: ${offending.join(', ')}. ` +
        'A score is stored by the scoring engine, and a conversion happens through the conversion command.',
      { entity: context.entity, fields: offending },
    );
  }

  private guardModuleWritten(context: HookContext): void {
    if (!GUARDED.has(context.entity)) return;
    if (isLeadScoreInternalWrite()) return;
    throw new ValidationError(
      context.operation === 'create'
        ? `A ${context.entity} is written only by its Lead Score command, so it cannot be created through the record API.`
        : `${context.entity} rows are written by the Lead Score engine and cannot be ${context.operation === 'delete' ? 'deleted' : 'edited'} through the record API.`,
      { entity: context.entity, operation: context.operation },
    );
  }
}
