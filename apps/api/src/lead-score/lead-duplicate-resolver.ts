import { Inject, Injectable } from '@nestjs/common';
import { type RawBuilder, sql } from 'kysely';

import { AclApiService } from '../acl/acl-api.service.js';
import { DatabaseService } from '../database/database.service.js';
import { EntityCrudService } from '../entity/entity.service.js';
import { LeadScoreFeatureGate } from './lead-score-feature-gate.service.js';
import { LeadScorePermissionService } from './lead-score-permission.service.js';
import {
  domainOf,
  isFreeMailDomain,
  MAX_DUPLICATE_CANDIDATES,
  MAX_DUPLICATE_SCAN,
  normalizedEmail,
  normalizedName,
  PHONE_MATCH_TAIL_DIGITS,
  phoneMatchTail,
} from './lead-score-vocabulary.js';

/**
 * Phase 19-LS.11 — who this Lead may already be (plan §7.3, §9.2; audit §11 `LS.11`).
 *
 * The resolver's job is one sentence long: **find the records this Lead might already be, tell the
 * caller what matched, and tell them when something matched that they may not look at** — never link,
 * never merge, never write. Everything else here exists to keep that sentence true:
 *
 *  - **Exact stages only.** E-mail (normalized), phone (digit tail), Account domain, Account company
 *    name. Nothing before a human decision may produce a *reference*, which is what plan §7.3 means by
 *    "fuzzy similarity only to suggest candidates" — and contract §9.4 bounds even suggestions, so this
 *    build ships the four exact stages and no similarity stage at all rather than a table scan.
 *  - **ACL before the answer.** Candidates come from a type-filtered read, and every row is then checked
 *    with `canAccessRecord`; a row the caller may not read contributes exactly one thing: a number. The
 *    shape of that number is the Voice resolver's precedent (`hiddenMatches`), and its fields are
 *    masked per-field, so a readable Contact whose e-mail is hidden does not hand the value back.
 *  - **The decision is explicit.** `requiresChoice` is true whenever anything matched, visible or not,
 *    and `allowedDecisions` says what the caller may answer — link, create-with-override (only with the
 *    capability), or cancel. LS.12's preview and LS.13's command refuse to proceed without that answer
 *    (contract §8.4), so "ambiguous matches cannot result in silent auto-linking" is a property of the
 *    contract rather than of this response's wording.
 *
 * The Lead itself is read through `EntityCrudService`, which is what makes two guarantees free: record
 * ACL on the source (a Lead the caller cannot read is a 404, not an empty candidate list) and field ACL
 * on the values used as search keys (a hidden `emailAddress` is not a search key, so it cannot become a
 * side channel).
 */

/** One reason a record surfaced. Stable tokens: the client keys its wording on them. */
export type DuplicateReason = 'email_exact' | 'phone_exact' | 'domain_exact' | 'company_exact';

/** Why a stage could not contribute, when it could not. `null` means it ran and found nothing. */
export type DuplicateStageReason = 'no_value' | 'free_mail';

export interface DuplicateCandidate {
  readonly entity: 'Contact' | 'Account';
  readonly id: string;
  /** The record's display value, or `null` when field ACL hides it — never a substitute string. */
  readonly label: string | null;
  readonly matchClass: 'same_person' | 'same_organization';
  readonly reasons: readonly DuplicateReason[];
  /**
   * Only the fields this reader may see, and only those that exist. A hidden field is absent, not empty:
   * the same rule LS.4 established for scoring inputs and LS.9 for engagement readings.
   */
  readonly details: {
    readonly email?: string | undefined;
    readonly phone?: string | undefined;
    readonly website?: string | undefined;
  };
}

export interface DuplicateCandidatesView {
  readonly leadId: string;
  readonly stages: readonly {
    readonly key: 'email' | 'phone' | 'domain' | 'company';
    readonly evaluated: boolean;
    readonly reason: DuplicateStageReason | null;
  }[];
  readonly candidates: readonly DuplicateCandidate[];
  /**
   * How many records matched but the caller may not read. A count, never an identity — and a *lower
   * bound* when a stage hit its scan limit, which `bounded` reports.
   */
  readonly hiddenMatches: number;
  readonly bounded: boolean;
  /** True whenever anything matched, visible or not. The caller must decide before anything is written. */
  readonly requiresChoice: boolean;
  /** Whether this caller may answer "create anyway" (the `duplicateOverride` capability). */
  readonly canOverride: boolean;
  readonly allowedDecisions: readonly ('link' | 'create_with_override' | 'cancel')[];
  readonly limits: { readonly candidates: number; readonly scan: number };
}

interface CandidateRow {
  readonly id: string;
  /** `name` is a physical column, never an attribute — the LS.2 lesson that a label read from `attrs` is empty. */
  readonly name: string | null;
  readonly attrs: Record<string, unknown>;
  readonly assigned_user_id: string | null;
  readonly created_by_id: string | null;
  readonly team_ids: unknown;
}

interface StagedRow {
  readonly entity: 'Contact' | 'Account';
  readonly row: CandidateRow;
  readonly reason: DuplicateReason;
}

@Injectable()
export class LeadDuplicateResolver {
  constructor(
    @Inject(LeadScoreFeatureGate) private readonly gate: LeadScoreFeatureGate,
    @Inject(LeadScorePermissionService) private readonly permissions: LeadScorePermissionService,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  /**
   * The candidates for one Lead, under the active conversion switches.
   *
   * `duplicateCheck` is its own gate operation (capability `convertPreview`, feature `duplicateDetection`)
   * so an installation can turn candidate review off without turning off the rest of the module — and so
   * the answer's availability is the same question the preview will ask, rather than a second policy.
   */
  async candidates(leadId: string): Promise<DuplicateCandidatesView> {
    await this.gate.assertOperation('duplicateCheck');
    // Record ACL and field ACL both apply here: a Lead this caller cannot read is a 404, and a field they
    // cannot read is absent from `lead`, which is what keeps it out of the search keys below.
    const lead = await this.entities.get('Lead', leadId);

    const email = normalizedEmail(lead['emailAddress']);
    const phone = phoneMatchTail(lead['phoneNumber']);
    const company = normalizedName(lead['company']);
    const emailDomain = email === null ? null : domainOf(email);
    const organizationDomain = isFreeMailDomain(emailDomain) ? null : emailDomain;

    const stages: DuplicateCandidatesView['stages'] = [
      { key: 'email', evaluated: email !== null, reason: email === null ? 'no_value' : null },
      { key: 'phone', evaluated: phone !== null, reason: phone === null ? 'no_value' : null },
      {
        key: 'domain',
        evaluated: organizationDomain !== null,
        reason: organizationDomain !== null ? null : emailDomain !== null && isFreeMailDomain(emailDomain) ? 'free_mail' : 'no_value',
      },
      { key: 'company', evaluated: company !== null, reason: company === null ? 'no_value' : null },
    ];

    const staged: StagedRow[] = [];
    let bounded = false;
    if (email !== null) {
      const { rows, capped } = await this.scanContactEmail(email);
      bounded ||= capped;
      staged.push(...rows.map((row) => ({ entity: 'Contact' as const, row, reason: 'email_exact' as const })));
    }
    if (phone !== null) {
      const { rows, capped } = await this.scanContactPhone(phone);
      bounded ||= capped;
      staged.push(...rows.map((row) => ({ entity: 'Contact' as const, row, reason: 'phone_exact' as const })));
    }
    if (organizationDomain !== null) {
      const { rows, capped } = await this.scanAccountDomain(organizationDomain);
      bounded ||= capped;
      staged.push(...rows.map((row) => ({ entity: 'Account' as const, row, reason: 'domain_exact' as const })));
    }
    if (company !== null) {
      const { rows, capped } = await this.scanAccountCompany(company);
      bounded ||= capped;
      staged.push(...rows.map((row) => ({ entity: 'Account' as const, row, reason: 'company_exact' as const })));
    }

    const visible: DuplicateCandidate[] = [];
    const hidden = new Set<string>();
    for (const hit of dedupe(staged)) {
      const key = `${hit.entity}:${hit.row.id}`;
      if (!(await this.canRead(hit.entity, hit.row))) {
        hidden.add(key);
        continue;
      }
      const candidate = await this.describe(hit.entity, hit.row, hit.reasons);
      // Readable, but nothing that could name it: counted like a hidden match rather than offered as a
      // row of blanks, because there is nothing a person could choose between.
      if (candidate === null) hidden.add(key);
      else visible.push(candidate);
    }

    const candidates = visible
      .sort((left, right) => rank(left) - rank(right) || right.reasons.length - left.reasons.length || (left.label ?? '').localeCompare(right.label ?? ''))
      .slice(0, MAX_DUPLICATE_CANDIDATES);

    const requiresChoice = candidates.length > 0 || hidden.size > 0;
    const canOverride = await this.permissions.can('duplicateOverride');
    const allowedDecisions: DuplicateCandidatesView['allowedDecisions'] = requiresChoice
      ? canOverride
        ? ['link', 'create_with_override', 'cancel']
        : ['link', 'cancel']
      : [];

    return {
      leadId,
      stages,
      candidates,
      hiddenMatches: hidden.size,
      bounded,
      requiresChoice,
      canOverride,
      allowedDecisions,
      limits: { candidates: MAX_DUPLICATE_CANDIDATES, scan: MAX_DUPLICATE_SCAN },
    };
  }

  /**
   * The four reads, each a type-filtered exact predicate with a hard limit.
   *
   * `idx_entity_records_type (entity_type, deleted_at)` is what keeps these from being a whole-table
   * scan; the attribute expression itself has no index, which is the one thing LS.18's query check has
   * to weigh (contract §9.4: no new index is added here on a hunch).
   */
  private async scanContactEmail(email: string): Promise<{ rows: CandidateRow[]; capped: boolean }> {
    return this.scan(
      'Contact',
      sql`lower(btrim(coalesce(attrs->>'emailAddress', ''))) = ${email}`,
    );
  }

  private async scanContactPhone(tail: string): Promise<{ rows: CandidateRow[]; capped: boolean }> {
    // The same expression `phoneMatchTail` applies: digits only, trunk zeros dropped, last N kept.
    return this.scan(
      'Contact',
      sql`right(regexp_replace(regexp_replace(coalesce(attrs->>'phoneNumber', ''), '[^0-9]', '', 'g'), '^0+', ''), ${PHONE_MATCH_TAIL_DIGITS}) = ${tail}`,
    );
  }

  private async scanAccountDomain(domain: string): Promise<{ rows: CandidateRow[]; capped: boolean }> {
    // Mirrors `domainOf`: strip a scheme, a leading `www.`, then the path, query, fragment and port.
    return this.scan(
      'Account',
      sql`lower(split_part(split_part(split_part(split_part(regexp_replace(regexp_replace(coalesce(attrs->>'website', ''), '^[a-z][a-z0-9+.-]*://', ''), '^www[.]', ''), '/', 1), '?', 1), '#', 1), ':', 1)) = ${domain}`,
    );
  }

  private async scanAccountCompany(company: string): Promise<{ rows: CandidateRow[]; capped: boolean }> {
    // Mirrors `normalizedName`: trimmed, whitespace collapsed, case-folded.
    return this.scan(
      'Account',
      // `name` is a physical column (LS.2): reading it from `attrs` matched nothing at all, which the
      // organization test caught. The expression mirrors `normalizedName` over the column, not the attribute.
      sql`lower(regexp_replace(btrim(coalesce(name, '')), '[[:space:]]+', ' ', 'g')) = ${company}`,
    );
  }

  private async scan(entity: 'Contact' | 'Account', predicate: RawBuilder<unknown>): Promise<{ rows: CandidateRow[]; capped: boolean }> {
    const rows = await sql<CandidateRow>`
      select id,
             name,
             attrs,
             assigned_user_id,
             created_by_id,
             team_ids
        from entity_records
       where entity_type = ${entity}
         and deleted_at is null
         and ${predicate}
       order by modified_at desc
       limit ${MAX_DUPLICATE_SCAN}
    `.execute(this.database.db);
    return { rows: rows.rows, capped: rows.rows.length === MAX_DUPLICATE_SCAN };
  }

  /** Record ACL for an already-loaded row, in the shape `AclApiService` expects. */
  private async canRead(entity: 'Contact' | 'Account', row: CandidateRow): Promise<boolean> {
    const decision = await this.acl.canAccessRecord(entity, 'read', {
      id: row.id,
      ...(row.assigned_user_id === null ? {} : { assignedUserId: row.assigned_user_id }),
      ...(row.created_by_id === null ? {} : { createdById: row.created_by_id }),
      teams: teamsOf(row.team_ids),
      data: row.attrs,
    });
    return decision.allowed;
  }

  /**
   * The candidate as this reader may see it, or `null` when even the identity is unreadable.
   *
   * A record the caller may read but whose *label* is hidden is not a candidate they can choose — there
   * is nothing to choose between — so it is withheld and counted like any other hidden match rather than
   * returned as a row of blanks. Every value that *is* returned passes the same field ACL that a record
   * page would apply.
   */
  private async describe(entity: 'Contact' | 'Account', row: CandidateRow, reasons: readonly DuplicateReason[]): Promise<DuplicateCandidate | null> {
    const visible = new Set(await this.acl.visibleFields(entity));
    const attr = (name: string): string | null => {
      if (!visible.has(name)) return null;
      const value = row.attrs[name];
      return typeof value === 'string' && value.trim() !== '' ? value : null;
    };

    // The display value lives in the `name` column; the attribute copy exists only for a few entities.
    const label = visible.has('name') ? row.name ?? attr('name') : null;
    if (label === null) return null;

    const email = attr('emailAddress');
    const phone = attr('phoneNumber');
    const website = entity === 'Account' ? attr('website') : null;
    return {
      entity,
      id: row.id,
      label,
      matchClass: reasons.includes('email_exact') || reasons.includes('phone_exact') ? 'same_person' : 'same_organization',
      reasons: [...reasons],
      details: {
        ...(email === null ? {} : { email }),
        ...(phone === null ? {} : { phone }),
        ...(website === null ? {} : { website }),
      },
    };
  }
}

/** One row per (entity, id), with every reason it matched merged, in a stable order. */
function dedupe(staged: readonly StagedRow[]): { entity: 'Contact' | 'Account'; row: CandidateRow; reasons: DuplicateReason[] }[] {
  const merged = new Map<string, { entity: 'Contact' | 'Account'; row: CandidateRow; reasons: DuplicateReason[] }>();
  const order: DuplicateReason[] = ['email_exact', 'phone_exact', 'domain_exact', 'company_exact'];
  for (const hit of staged) {
    const key = `${hit.entity}:${hit.row.id}`;
    const found = merged.get(key);
    if (found === undefined) merged.set(key, { entity: hit.entity, row: hit.row, reasons: [hit.reason] });
    else if (!found.reasons.includes(hit.reason)) found.reasons.push(hit.reason);
  }
  for (const entry of merged.values()) entry.reasons.sort((left, right) => order.indexOf(left) - order.indexOf(right));
  return [...merged.values()];
}

/** A person match outranks an organization match; both outrank nothing, and order is otherwise stable. */
function rank(candidate: DuplicateCandidate): number {
  return candidate.matchClass === 'same_person' ? 0 : 1;
}

function teamsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}
