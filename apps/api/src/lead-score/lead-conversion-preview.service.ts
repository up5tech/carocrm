import { ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { AclApiService } from '../acl/acl-api.service.js';
import { EntityCrudService } from '../entity/entity.service.js';
import { type DuplicateCandidate,LeadDuplicateResolver } from './lead-duplicate-resolver.js';
import {
  type ConversionSection,
  type FieldConflict,
  LeadFieldMappingService,
  type MappingTarget,
  previewHash,
  type ProposedField,
  type SkippedField,
  templateTokens,
} from './lead-field-mapping.service.js';
import { leadScorePreviewStaleError, leadScoreTargetDisabledError } from './lead-score-errors.js';
import { LeadScoreFeatureGate } from './lead-score-feature-gate.service.js';
import { LEADSCORE_FEATURES } from './lead-score-module.js';
import { LeadScorePermissionService } from './lead-score-permission.service.js';
import { LeadScoreSettingsService } from './lead-score-settings.service.js';

/**
 * Phase 19-LS.12 — the side-effect-free conversion preview
 * (`PLAN_Phase_19_LeadScore.md` §7.1–§7.4, §8.3, §11.4; audit §11 `LS.12`; contract §8).
 *
 * The exit criterion is *"the preview is side-effect-free and faithfully describes the operation that would
 * run"*, and both halves are structural here rather than promised:
 *
 *  - **Side-effect-free** because this service has no writer. It reads the Lead through the canonical path
 *    (so record and field ACL are the real ones), reads candidate targets the same way, and returns an
 *    answer. The suite asserts it the way LS.4 and LS.8 do — record, audit, outbox and job counts, and the
 *    Lead's `version` and `modifiedAt`, are unchanged across a call.
 *  - **Faithful** because the answer is the *same code path* LS.13 will run: `LeadFieldMappingService`
 *    resolves the values, the duplicate resolver supplies the candidates, and the fingerprint covers every
 *    input those two read — the Lead revision, each target's mapping version, the explicit field merges, and
 *    **the fields this actor could see and write when the preview was taken**. A permission change between
 *    preview and confirm therefore invalidates the fingerprint instead of letting the command write values
 *    the actor can no longer read (plan §9.2).
 *
 * A preview is also a **question**, not only a description: `confirmationTypes` lists what the person must
 * be shown before confirming (candidates, skipped values, before/after merges, a re-parent), and the command
 * will require exactly that set to come back acknowledged (contract §8.4).
 */

export type ConfirmationType = 'simple' | 'duplicates_present' | 'values_will_be_skipped' | 'field_merge' | 'contact_reparent' | 'opportunity_created';

export interface ConversionPreviewInput {
  readonly leadId: string;
  readonly targets: readonly { readonly type: MappingTarget; readonly action: 'create' | 'link'; readonly existingId?: string | undefined }[];
  readonly fieldMerge?: readonly { readonly target: MappingTarget; readonly field: string; readonly value?: unknown }[] | undefined;
  readonly expectedLeadRevision?: number | undefined;
  readonly mappingVersion?: number | undefined;
}

export interface TargetPreview {
  readonly type: MappingTarget;
  readonly action: 'create' | 'link';
  readonly existingId: string | null;
  /** The linked record as this caller may see it — `null` for a create, or when it is unreadable. */
  readonly existing: { readonly id: string; readonly label: string | null } | null;
  readonly mappingVersion: number;
  readonly proposed: readonly ProposedField[];
  readonly skipped: readonly SkippedField[];
  readonly required: readonly string[];
  readonly conflicts: readonly FieldConflict[];
  readonly notCopied: readonly string[];
  /**
   * The links this target will carry when the conversion runs (contract §6): a Contact points at the chosen
   * Account, an Opportunity at the Account and the Contact, an Account at nothing. `id` is the existing
   * record's id, or `null` when that target is being created in the same operation.
   */
  readonly relationship: readonly { readonly type: MappingTarget; readonly action: 'create' | 'link'; readonly id: string | null }[];
}

export interface ConversionPreviewView {
  readonly leadId: string;
  readonly leadRevision: number;
  readonly targets: readonly TargetPreview[];
  readonly duplicates: {
    readonly candidates: readonly DuplicateCandidate[];
    readonly hiddenMatches: number;
    readonly requiresChoice: boolean;
    readonly bounded: boolean;
    readonly limits: { readonly candidates: number; readonly scan: number };
  } | null;
  readonly permission: { readonly canExecute: boolean; readonly reasons: readonly string[] };
  readonly confirmationTypes: readonly ConfirmationType[];
  readonly previewHash: string;
  /** The mapping versions and reader scopes the fingerprint covers, so a client can explain a stale answer. */
  readonly fingerprint: {
    readonly mappingVersions: Readonly<Partial<Record<MappingTarget, number>>>;
    readonly leadScope: readonly string[];
    readonly readerScope: Readonly<Record<string, readonly string[]>>;
  };
}

/** Skip reasons that mean "a mapped value will not be copied", as opposed to "a link writes nothing". */
const PROBLEM_SKIPS = new Set(['source_hidden', 'target_no_such_field', 'field_type_incompatible', 'never_mappable', 'value_invalid']);

@Injectable()
export class LeadConversionPreviewService {
  constructor(
    @Inject(LeadScoreFeatureGate) private readonly gate: LeadScoreFeatureGate,
    @Inject(LeadScoreSettingsService) private readonly settings: LeadScoreSettingsService,
    @Inject(LeadScorePermissionService) private readonly permissions: LeadScorePermissionService,
    @Inject(LeadFieldMappingService) private readonly mapping: LeadFieldMappingService,
    @Inject(LeadDuplicateResolver) private readonly duplicates: LeadDuplicateResolver,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(AclApiService) private readonly acl: AclApiService,
  ) {}

  async preview(input: ConversionPreviewInput): Promise<ConversionPreviewView> {
    await this.gate.assertOperation('conversionPreview');
    const settings = await this.settings.settings();
    const section = settings.conversion;

    // The Lead through the canonical path: a Lead this caller cannot read is a 404, and a field their ACL
    // hides is absent — which is what keeps it out of `proposed` and out of the fingerprint's lead scope.
    const lead = await this.entities.get('Lead', input.leadId);
    const leadRevision = typeof lead['version'] === 'number' ? lead['version'] : 0;
    if (input.expectedLeadRevision !== undefined && input.expectedLeadRevision !== leadRevision) {
      throw leadScorePreviewStaleError(input.leadId, 'revision', { expected: input.expectedLeadRevision, current: leadRevision });
    }

    await this.assertTargets(input.targets, section);
    const requested = input.targets.map((entry) => entry.type);
    const mappingVersions: Partial<Record<MappingTarget, number>> = {};
    for (const type of requested) mappingVersions[type] = section.mapping[type].version;
    if (input.mappingVersion !== undefined && requested.some((type) => section.mapping[type].version !== input.mappingVersion)) {
      throw leadScorePreviewStaleError(input.leadId, 'mapping', { expected: input.mappingVersion });
    }

    const visibleLeadFields = new Set(await this.acl.visibleFields('Lead'));
    const personTargetPresent = requested.includes('Contact');
    const mergeAllowedByPolicy = section.fieldMergeAllowed && (await this.permissions.can('applyFieldChanges'));
    const mergesByTarget = groupMerges(input.fieldMerge ?? []);

    const base: (Omit<TargetPreview, 'relationship'>)[] = [];
    const permissionReasons: string[] = [];
    let reparent: { contactId: string; accountId: string } | null = null;
    if ((await this.acl.canUser('Lead', 'edit')) === 'no') permissionReasons.push('lead_not_editable');
    const chosenAccount = input.targets.find((entry) => entry.type === 'Account');
    const contactFields = new Set(await this.acl.visibleFields('Contact'));

    for (const choice of input.targets) {
      const existing = choice.action === 'link' && choice.existingId !== undefined ? await this.readTarget(choice.type, choice.existingId) : undefined;
      const resolution = this.mapping.resolveTarget({
        target: choice.type,
        action: choice.action,
        mapping: section.mapping[choice.type],
        lead,
        visibleLeadFields,
        merge: mergesByTarget.get(choice.type) ?? [],
        mergeAllowed: mergeAllowedByPolicy,
        ...(existing === undefined ? {} : { existing: existing.data }),
        personTargetPresent,
      });
      base.push({
        type: choice.type,
        action: choice.action,
        existingId: choice.existingId ?? null,
        existing: existing === undefined ? null : { id: choice.existingId ?? '', label: labelOf(existing.data) },
        mappingVersion: section.mapping[choice.type].version,
        ...resolution,
      });

      // A linked Contact that already belongs to a different Account is a re-parent: the relationship will
      // move it, so the person has to be shown that (contract §6.3). The current id is read only when this
      // caller may see `accountId` on the Contact.
      if (choice.type === 'Contact' && choice.action === 'link' && existing !== undefined && chosenAccount !== undefined && chosenAccount.existingId !== undefined && contactFields.has('accountId')) {
        const currentAccount = existing.data['accountId'];
        if (typeof currentAccount === 'string' && currentAccount !== '' && currentAccount !== chosenAccount.existingId) {
          reparent = { contactId: choice.existingId ?? '', accountId: chosenAccount.existingId };
        }
      }

      if (choice.action === 'create' && (await this.acl.canUser(choice.type, 'create')) === 'no') permissionReasons.push(`cannot_create_${choice.type}`);
      if (choice.action === 'link' && (await this.acl.canUser(choice.type, 'read')) === 'no') permissionReasons.push(`cannot_read_${choice.type}`);
      // A target the caller named but cannot read is not confirmed to exist: the answer says the operation
      // cannot run, not whether the id was real (plan §8.4, contract §9.2).
      if (choice.action === 'link' && existing === undefined) permissionReasons.push(`target_unreadable_${choice.type}`);
      if (resolution.required.length > 0) permissionReasons.push(`required_missing_${choice.type}`);
      if (resolution.skipped.some((entry) => entry.reason === 'merge_not_allowed')) permissionReasons.push(`merge_not_allowed_${choice.type}`);
    }

    const duplicates = (await this.settings.featureEnabled('duplicateDetection')) ? await this.duplicates.candidates(input.leadId) : null;

    const fingerprintFacts = await this.fingerprintFacts(requested, section, visibleLeadFields, mergesByTarget);
    const hash = previewHash({
      leadId: input.leadId,
      leadRevision,
      targets: input.targets.map((entry) => ({ type: entry.type, action: entry.action, existingId: entry.existingId ?? null })),
      mappingVersions,
      fieldMerge: input.fieldMerge ?? [],
      leadScope: fingerprintFacts.leadScope,
      readerScope: fingerprintFacts.readerScope,
      fieldMergeAllowed: mergeAllowedByPolicy,
    });

    const targets: TargetPreview[] = base.map((entry) => ({ ...entry, relationship: relationshipsOf(entry.type, input.targets) }));

    return {
      leadId: input.leadId,
      leadRevision,
      targets,
      duplicates:
        duplicates === null
          ? null
          : {
              candidates: duplicates.candidates,
              hiddenMatches: duplicates.hiddenMatches,
              requiresChoice: duplicates.requiresChoice,
              bounded: duplicates.bounded,
              limits: duplicates.limits,
            },
      permission: { canExecute: permissionReasons.length === 0, reasons: permissionReasons },
      confirmationTypes: confirmationTypesOf(targets, duplicates, reparent),
      previewHash: hash,
      fingerprint: { mappingVersions, ...fingerprintFacts },
    };
  }

  /**
   * Which combinations this request may ask for, before any record is read.
   *
   * The settings decide what exists (contract §5.2), the request cannot name a type twice, a link must name
   * its target and a create must not — and Opportunity is refused while its phase has not shipped, with the
   * phase in the answer rather than a generic "no".
   */
  private async assertTargets(targets: ConversionPreviewInput['targets'], section: ConversionSection): Promise<void> {
    const seen = new Set<string>();
    for (const target of targets) {
      if (seen.has(target.type)) {
        throw new ValidationError('A conversion may name each target type once.', { target: target.type, state: 'duplicate' });
      }
      seen.add(target.type);
      if (!section.targets.includes(target.type)) throw leadScoreTargetDisabledError(target.type, 'notEnabled');
      if (target.action === 'link' && target.existingId === undefined) {
        throw new ValidationError('A link needs the record it links to.', { target: target.type, state: 'missingTarget' });
      }
      if (target.action === 'create' && target.existingId !== undefined) {
        throw new ValidationError('A create does not take an existing record id.', { target: target.type, state: 'unexpectedTarget' });
      }
    }
    if (seen.has('Opportunity') && (await this.settings.featureEnabled('opportunityConversion')) === false) {
      const phase = LEADSCORE_FEATURES.find((feature) => feature.key === 'opportunityConversion')?.pendingPhase ?? null;
      throw leadScoreTargetDisabledError('Opportunity', phase === null ? 'notEnabled' : 'pending', phase ?? undefined);
    }
  }

  /** A chosen target, or `undefined` when this caller may not read it — the two are the same answer here. */
  private async readTarget(type: MappingTarget, id: string): Promise<{ data: Record<string, unknown> } | undefined> {
    try {
      return { data: await this.entities.get(type, id) };
    } catch {
      return undefined;
    }
  }

  /**
   * The fields the fingerprint must cover.
   *
   * `leadScope` is the mapped Lead fields this reader may see — the ones whose disappearance would change
   * what the operation copies. `readerScope` is, per requested target, the fields the actor may **read and
   * write right now**: a preview taken while a field was visible must not execute after it is hidden
   * (contract §8.3; this is the security half of the hash, not bookkeeping).
   */
  private async fingerprintFacts(
    requested: readonly MappingTarget[],
    section: ConversionSection,
    visibleLeadFields: ReadonlySet<string>,
    merges: ReadonlyMap<MappingTarget, readonly { readonly field: string }[]>,
  ): Promise<{ leadScope: string[]; readerScope: Record<string, readonly string[]> }> {
    const leadRead = new Set<string>();
    const readerScope: Record<string, readonly string[]> = {};
    for (const type of requested) {
      const mapping = section.mapping[type];
      const touched = new Set<string>(merges.get(type)?.map((entry) => entry.field) ?? []);
      for (const entry of mapping.fields) {
        leadRead.add(entry.from);
        touched.add(entry.to);
      }
      for (const [field, value] of Object.entries(mapping.createDefaults)) {
        touched.add(field);
        if (typeof value === 'string') for (const token of templateTokens(value)) leadRead.add(token);
      }
      const writable: string[] = [];
      for (const field of touched) {
        const access = await this.acl.fieldAccess(type, field);
        if (access.read !== 'no' && access.edit !== 'no') writable.push(field);
      }
      readerScope[type] = writable.sort();
    }
    return { leadScope: [...leadRead].filter((field) => visibleLeadFields.has(field)).sort(), readerScope };
  }
}

/**
 * What the person has to be shown before confirming (contract §8.4).
 *
 * `simple` is always there so the list is never empty, and the rest are added only when they are true: a
 * candidate (visible or not), a mapped value that will not be copied for a reason, a before/after merge, a
 * re-parent. `opportunity_created` is declared for the contract's shape but cannot be produced until
 * 19-LS.16 makes an Opportunity target reachable.
 */
function confirmationTypesOf(
  targets: readonly TargetPreview[],
  duplicates: { readonly candidates: readonly unknown[]; readonly hiddenMatches: number } | null,
  reparent: { contactId: string } | null,
): ConfirmationType[] {
  const types: ConfirmationType[] = ['simple'];
  if (duplicates !== null && (duplicates.candidates.length > 0 || duplicates.hiddenMatches > 0)) types.push('duplicates_present');
  if (targets.some((target) => target.skipped.some((entry) => PROBLEM_SKIPS.has(entry.reason)))) types.push('values_will_be_skipped');
  if (targets.some((target) => target.conflicts.length > 0 || target.proposed.some((entry) => entry.origin === 'merge'))) types.push('field_merge');
  if (reparent !== null) types.push('contact_reparent');
  return types;
}

/** The links a target carries, from the choices made in this same request (contract §6). */
function relationshipsOf(
  type: MappingTarget,
  chosen: ConversionPreviewInput['targets'],
): TargetPreview['relationship'] {
  const link = (wanted: MappingTarget): { type: MappingTarget; action: 'create' | 'link'; id: string | null } | null => {
    const found = chosen.find((entry) => entry.type === wanted);
    return found === undefined ? null : { type: wanted, action: found.action, id: found.action === 'link' ? found.existingId ?? null : null };
  };
  if (type === 'Contact') {
    const account = link('Account');
    return account === null ? [] : [account];
  }
  if (type === 'Opportunity') {
    return [link('Account'), link('Contact')].filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  }
  return [];
}

function groupMerges(
  merges: readonly { readonly target: MappingTarget; readonly field: string; readonly value?: unknown }[],
): Map<MappingTarget, { field: string; value: unknown }[]> {
  const grouped = new Map<MappingTarget, { field: string; value: unknown }[]>();
  for (const entry of merges) {
    const list = grouped.get(entry.target) ?? [];
    list.push({ field: entry.field, value: entry.value });
    grouped.set(entry.target, list);
  }
  return grouped;
}

function labelOf(data: Record<string, unknown>): string | null {
  const value = data['name'];
  return typeof value === 'string' && value !== '' ? value : null;
}
