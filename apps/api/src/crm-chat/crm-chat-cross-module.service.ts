import { NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { log } from '@carocrm/core/logger/index.js';
import { Inject, Injectable } from '@nestjs/common';

import type { EntityCrudService } from '../entity/entity.service.js';
import { EntityCrudService as EntityService } from '../entity/entity.service.js';
import type { MetadataStoreService } from '../metadata/metadata-store.service.js';
import { METADATA_STORE } from '../metadata/metadata-store.service.js';

/**
 * Phase 19-CHAT.11 — cross-module analysis (PLAN_Phase_19_CRM_Chat.md §5.5, §17 `19-CHAT.11`;
 * contract §6.7).
 *
 * ## No implicit joins
 *
 * A cross-module question ("which accounts have overdue invoices and open tickets?") is answered by
 * walking **declared relations** from a record the caller already has, one bounded hop at a time.
 * The relation names come from the metadata registry and are validated before every hop, so Chat
 * never invents a foreign key, never joins two unrelated entities and never fans out without a
 * bound. The scenario list below is server-owned: a caller names a scenario and its root record,
 * and cannot inject an entity, a relation, a SQL fragment or a join.
 *
 * ## Partial results are a first-class answer
 *
 * A module that is not installed, a relation the installation does not declare, or a record the
 * caller may not read yields a **partial** result with a per-step reason — never a zero that reads
 * like "there is nothing", and never an error that hides the parts that did work. The freshness
 * stamp says when the answer was computed.
 *
 * ## ACL
 *
 * Every hop goes through the Entity Engine's `related()` read, which applies the record predicate
 * of the target entity. A caller who may not see a target record does not see it in the answer;
 * the hop simply contributes fewer rows.
 */

/** One declared hop of a scenario. */
export interface CRMChatCrossModuleStep {
  /** The relation to follow, as declared in the entity metadata. */
  readonly relation: string;
  /** A short, user-safe label for this hop. */
  readonly label: string;
  /** Maximum rows this hop may contribute. */
  readonly maxSize: number;
}

/** A curated, server-owned cross-module path. */
export interface CRMChatCrossModuleScenario {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  /** The entity the scenario starts from. */
  readonly rootEntity: string;
  readonly steps: readonly CRMChatCrossModuleStep[];
}

/** The result of one hop. */
export interface CRMChatCrossModuleStepResult {
  readonly relation: string;
  readonly label: string;
  readonly entity: string;
  readonly records: readonly Record<string, unknown>[];
  readonly count: number;
  /** Why this hop produced nothing, when it produced nothing for a reason other than "no rows". */
  readonly reason: string | null;
}

/** The result of a whole scenario run. */
export interface CRMChatCrossModuleResult {
  readonly scenario: string;
  readonly label: string;
  readonly rootEntity: string;
  readonly rootId: string;
  readonly steps: readonly CRMChatCrossModuleStepResult[];
  /** True when at least one hop could not be answered in full. */
  readonly partial: boolean;
  readonly warnings: readonly string[];
  /** When the answer was computed; the caller can compare it with a later read. */
  readonly computedAt: string;
}

/**
 * The curated paths. Every relation named here is validated against the metadata registry before
 * it is used, so an installation that does not declare one reports a partial result rather than
 * failing the whole scenario.
 */
export const CRM_CHAT_CROSS_MODULE_SCENARIOS: readonly CRMChatCrossModuleScenario[] = [
  {
    key: 'account-360',
    label: 'Account overview',
    description: 'Contacts, opportunities, invoices, cases and quotes that belong to one account.',
    rootEntity: 'Account',
    steps: [
      { relation: 'contacts', label: 'Contacts', maxSize: 25 },
      { relation: 'opportunities', label: 'Opportunities', maxSize: 25 },
      { relation: 'invoices', label: 'Invoices', maxSize: 25 },
      { relation: 'cases', label: 'Support cases', maxSize: 25 },
      { relation: 'quotes', label: 'Quotes', maxSize: 25 },
    ],
  },
  {
    key: 'opportunity-commercial',
    label: 'Opportunity commercial documents',
    description: 'The quotes raised against one opportunity.',
    rootEntity: 'Opportunity',
    steps: [{ relation: 'quotes', label: 'Quotes', maxSize: 25 }],
  },
  {
    key: 'project-delivery',
    label: 'Project delivery',
    description: 'The tasks, members and linked accounts and contacts of one project.',
    rootEntity: 'Project',
    steps: [
      { relation: 'tasks', label: 'Tasks', maxSize: 50 },
      { relation: 'members', label: 'Members', maxSize: 25 },
      { relation: 'accounts', label: 'Accounts', maxSize: 25 },
      { relation: 'contacts', label: 'Contacts', maxSize: 25 },
    ],
  },
  {
    key: 'contact-service',
    label: 'Contact service history',
    description: 'The support cases raised by one contact.',
    rootEntity: 'Contact',
    steps: [{ relation: 'cases', label: 'Support cases', maxSize: 25 }],
  },
];

/** Hard bounds so a scenario can never fan out without a limit. */
const MAX_STEPS = 8;
const DEFAULT_TIMEOUT_MS = 10_000;

@Injectable()
export class CRMChatCrossModuleService {
  constructor(
    @Inject(EntityService) private readonly entities: EntityCrudService,
    @Inject(METADATA_STORE) private readonly metadata: MetadataStoreService,
  ) {}

  /** The curated scenarios this installation can answer. */
  scenarios(): readonly CRMChatCrossModuleScenario[] {
    return CRM_CHAT_CROSS_MODULE_SCENARIOS;
  }

  /**
   * Run a curated scenario against one record.
   *
   * The root record is read through the Entity Engine first, so a record the caller may not see is
   * reported as absent rather than as an empty analysis.
   */
  async run(scenarioKey: string, rootId: string): Promise<CRMChatCrossModuleResult> {
    const scenario = CRM_CHAT_CROSS_MODULE_SCENARIOS.find((candidate) => candidate.key === scenarioKey);
    if (!scenario) {
      throw new NotFoundError(`Cross-module scenario "${scenarioKey}" does not exist.`);
    }
    if (typeof rootId !== 'string' || rootId.trim() === '') {
      throw new ValidationError('A root record id is required.', { field: 'rootId' });
    }

    const started = Date.now();
    const warnings: string[] = [];
    const steps: CRMChatCrossModuleStepResult[] = [];
    let partial = false;

    // The root must be readable by this caller; the Entity Engine answers 404 for "not yours".
    await this.entities.get(scenario.rootEntity, rootId);

    for (const step of scenario.steps.slice(0, MAX_STEPS)) {
      if (Date.now() - started > DEFAULT_TIMEOUT_MS) {
        partial = true;
        warnings.push('The analysis stopped early because it reached its time budget.');
        break;
      }

      const relation = this.metadata.registry.getRelation(scenario.rootEntity, step.relation);
      if (!relation?.target) {
        partial = true;
        warnings.push(`The relation "${step.relation}" is not declared on "${scenario.rootEntity}".`);
        steps.push({
          relation: step.relation,
          label: step.label,
          entity: scenario.rootEntity,
          records: [],
          count: 0,
          reason: `The relation "${step.relation}" is not available in this installation.`,
        });
        continue;
      }

      try {
        const page = await this.entities.related(scenario.rootEntity, rootId, step.relation, {
          maxSize: step.maxSize,
        });
        steps.push({
          relation: step.relation,
          label: step.label,
          entity: relation.target,
          records: page.list,
          count: page.count,
          reason: null,
        });
      } catch (error) {
        // The hop failed (usually an ACL denial on the target entity, or a module that is not
        // installed). The reason is logged for the operator; the caller gets a generic one.
        partial = true;
        const reason = `The "${step.label}" records could not be read.`;
        warnings.push(reason);
        log.warn({
          component: 'crm-chat',
          eventType: 'cross-module',
          scenario: scenario.key,
          relation: step.relation,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        }, `Cross-module hop "${step.relation}" failed.`);
        steps.push({
          relation: step.relation,
          label: step.label,
          entity: relation.target,
          records: [],
          count: 0,
          reason,
        });
      }
    }

    return {
      scenario: scenario.key,
      label: scenario.label,
      rootEntity: scenario.rootEntity,
      rootId,
      steps,
      partial,
      warnings,
      computedAt: new Date().toISOString(),
    };
  }
}
