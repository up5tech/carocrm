import { randomUUID } from 'node:crypto';

import { DuplicateRecordError, NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import type { Updateable } from 'kysely';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import type { AIAgentSkillsTable } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import {
  type AppliedSkill,
  normalizeSkillInstructions,
  orderSkillBindings,
  type ResolvedSkill,
  SKILL_KEY_PATTERN,
  validateSkillInstructions,
} from './ai-agent-skills.js';
import { AIAgentsPermissionService } from './ai-agents-permission.service.js';
import { AIAgentsPolicyService } from './ai-agents-policy.service.js';

/**
 * Phase 25.4 — reusable, versioned, non-executable agent skills.
 *
 * A skill key is the stable identity; a version is an immutable instruction snapshot. Drafts may be
 * edited, publication freezes one version, and later edits must create a new version. Publishing a
 * newer version never rewrites an older one, so a published agent that pinned version 2 keeps using
 * exactly that text after version 3 appears. Archiving removes a version from the picker but keeps
 * it resolvable for agents that already pinned it.
 *
 * Skills are text, never code. There is no script field, no dynamic import and no executable tool
 * surface. Every write goes through the `skillAdmin` capability plus row ownership/visibility; every
 * read goes through the module's `use` capability plus the same row visibility rules.
 */

export const SKILL_STATUS_SET = new Set(['draft', 'published', 'archived']);
export const SKILL_VISIBILITY_SET = new Set(['private', 'team', 'organization']);

export interface SkillListQuery {
  readonly key?: string | undefined;
  readonly status?: string | undefined;
  readonly q?: string | undefined;
  readonly scope?: 'mine' | 'all' | undefined;
  readonly offset?: number | undefined;
  readonly maxSize?: number | undefined;
}

export interface SkillView {
  readonly id: string;
  readonly key: string;
  readonly version: number;
  readonly label: string;
  readonly description: string | null;
  readonly instructions: string;
  readonly status: string;
  readonly visibility: string;
  readonly teamId: string | null;
  readonly ownerUserId: string | null;
  readonly publishedById: string | null;
  readonly publishedAt: string | null;
  readonly publicationNote: string | null;
  readonly canEdit: boolean;
  readonly createdAt: string;
  readonly modifiedAt: string;
}

export interface CreateSkillInput {
  readonly key: string;
  readonly label: string;
  readonly description?: string | undefined;
  readonly instructions: string;
  readonly visibility?: 'private' | 'team' | 'organization' | undefined;
  readonly teamId?: string | null | undefined;
}

export interface UpdateSkillInput {
  readonly label?: string | undefined;
  readonly description?: string | null | undefined;
  readonly instructions?: string | undefined;
  readonly visibility?: 'private' | 'team' | 'organization' | undefined;
  readonly teamId?: string | null | undefined;
}

export interface SkillResolutionIssue {
  readonly key: string;
  readonly version: number;
  readonly message: string;
}

export interface SkillResolution {
  readonly skills: readonly ResolvedSkill[];
  readonly issues: readonly SkillResolutionIssue[];
}

interface Viewer {
  readonly userId: string;
  readonly teamIds: readonly string[];
  readonly isAdmin: boolean;
  readonly seesEverything: boolean;
  readonly canWrite: boolean;
}

@Injectable()
export class AIAgentSkillService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(AIAgentsPermissionService) private readonly permissions: AIAgentsPermissionService,
    @Inject(AIAgentsPolicyService) private readonly policy: AIAgentsPolicyService,
  ) {}

  // -------------------------------------------------------------------------
  // reads
  // -------------------------------------------------------------------------

  async list(query: SkillListQuery = {}): Promise<{
    list: SkillView[];
    total: number;
    offset: number;
    count: number;
  }> {
    await this.permissions.assert('use');
    const offset = Math.max(0, query.offset ?? 0);
    const maxSize = Math.min(50, Math.max(1, query.maxSize ?? 20));
    const viewer = await this.viewer();

    let builder = this.database.db.selectFrom('ai_agent_skills').where('is_deleted', '=', false);
    if (query.key !== undefined && query.key.trim() !== '') builder = builder.where('skill_key', '=', query.key.trim());
    if (query.status !== undefined && SKILL_STATUS_SET.has(query.status)) {
      builder = builder.where('status', '=', query.status);
    }
    if (query.q !== undefined && query.q.trim() !== '') {
      const term = `%${query.q.trim().replace(/[%_]/g, '')}%`;
      builder = builder.where((eb) =>
        eb.or([eb('label', 'ilike', term), eb('skill_key', 'ilike', term), eb('description', 'ilike', term)]),
      );
    }
    if (query.scope === 'mine') {
      builder = builder.where('owner_user_id', '=', viewer.userId);
    } else if (!viewer.seesEverything) {
      builder = builder.where((eb) => {
        const clauses = [eb('visibility', '=', 'organization'), eb('owner_user_id', '=', viewer.userId)];
        if (viewer.teamIds.length > 0) clauses.push(eb('team_id', 'in', viewer.teamIds));
        return eb.or(clauses);
      });
    }

    const totalRow = await builder.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirst();
    const rows = await builder
      .selectAll()
      .orderBy('skill_key', 'asc')
      .orderBy('version', 'desc')
      .offset(offset)
      .limit(maxSize)
      .execute();
    return {
      list: rows.map((row) => this.toView(row, viewer)),
      total: Number(totalRow?.count ?? 0),
      offset,
      count: rows.length,
    };
  }

  async get(key: string, version: number): Promise<SkillView> {
    await this.permissions.assert('use');
    const viewer = await this.viewer();
    return this.toView(await this.visibleRow(key, version, viewer), viewer);
  }

  async latest(key: string): Promise<SkillView> {
    await this.permissions.assert('use');
    const viewer = await this.viewer();
    const row = await this.database.db
      .selectFrom('ai_agent_skills')
      .selectAll()
      .where('skill_key', '=', key)
      .where('is_deleted', '=', false)
      .orderBy('version', 'desc')
      .executeTakeFirst();
    if (!row || !this.isVisible(row, viewer)) throw new NotFoundError(`Skill "${key}" does not exist.`);
    return this.toView(row, viewer);
  }

  // -------------------------------------------------------------------------
  // draft writes
  // -------------------------------------------------------------------------

  async create(input: CreateSkillInput): Promise<SkillView> {
    await this.policy.assertDefinitionsEnabled();
    await this.permissions.assert('skillAdmin');
    const key = input.key.trim();
    if (!SKILL_KEY_PATTERN.test(key)) {
      throw new ValidationError('Skill keys start with a letter and contain lowercase letters, digits or underscores.');
    }
    const instructions = this.validateInstructions(input.instructions);

    const existing = await this.database.db
      .selectFrom('ai_agent_skills')
      .select(['id', 'status'])
      .where('skill_key', '=', key)
      .where('is_deleted', '=', false)
      .execute();
    if (existing.some((row) => row.status === 'draft')) {
      throw new DuplicateRecordError(`Skill "${key}" already has an editable draft.`);
    }
    const version = existing.length === 0 ? 1 : await this.nextVersion(key);
    const now = new Date();
    const id = randomUUID();
    const ownerId = this.scope.userId ?? null;
    await this.database.db
      .insertInto('ai_agent_skills')
      .values({
        id,
        skill_key: key,
        version,
        label: input.label.trim(),
        description: input.description?.trim() ?? null,
        instructions,
        status: 'draft',
        visibility: input.visibility ?? 'team',
        owner_user_id: ownerId,
        team_id: input.teamId ?? this.scope.teamIds()[0] ?? null,
        published_by_id: null,
        published_at: null,
        publication_note: null,
        is_deleted: false,
        created_at: now,
        modified_at: now,
        created_by_id: ownerId,
        modified_by_id: ownerId,
      })
      .execute();
    return this.get(key, version);
  }

  async update(key: string, version: number, input: UpdateSkillInput): Promise<SkillView> {
    await this.policy.assertDefinitionsEnabled();
    await this.permissions.assert('skillAdmin');
    const viewer = await this.viewer();
    const row = await this.visibleRow(key, version, viewer);
    this.assertEditable(row, viewer);
    const patch: Updateable<AIAgentSkillsTable> = {
      modified_at: new Date(),
      modified_by_id: this.scope.userId ?? null,
    };
    if (input.label !== undefined) patch['label'] = input.label.trim();
    if (input.description !== undefined) patch['description'] = input.description?.trim() ?? null;
    if (input.instructions !== undefined) patch['instructions'] = this.validateInstructions(input.instructions);
    if (input.visibility !== undefined) patch['visibility'] = input.visibility;
    if (input.teamId !== undefined) patch['team_id'] = input.teamId;
    await this.database.db.updateTable('ai_agent_skills').set(patch).where('id', '=', row.id).execute();
    return this.get(key, version);
  }

  async publish(key: string, version: number, note?: string): Promise<SkillView> {
    await this.policy.assertDefinitionsEnabled();
    await this.permissions.assert('skillAdmin');
    const viewer = await this.viewer();
    const row = await this.visibleRow(key, version, viewer);
    this.assertEditable(row, viewer);
    const issues = validateSkillInstructions(row.instructions);
    if (issues.length > 0) throw new ValidationError('This skill draft cannot be published.', { issues });
    const now = new Date();
    await this.database.db
      .updateTable('ai_agent_skills')
      .set({
        status: 'published',
        published_by_id: this.scope.userId ?? null,
        published_at: now,
        publication_note: note?.trim() ?? null,
        modified_at: now,
        modified_by_id: this.scope.userId ?? null,
      })
      .where('id', '=', row.id)
      .where('status', '=', 'draft')
      .execute();
    return this.get(key, version);
  }

  async archive(key: string, version: number): Promise<SkillView> {
    await this.policy.assertDefinitionsEnabled();
    await this.permissions.assert('skillAdmin');
    const viewer = await this.viewer();
    const row = await this.visibleRow(key, version, viewer);
    this.assertOwned(row, viewer);
    if (row.status !== 'published') {
      throw new ValidationError('Only a published skill version can be archived.');
    }
    await this.database.db
      .updateTable('ai_agent_skills')
      .set({ status: 'archived', modified_at: new Date(), modified_by_id: this.scope.userId ?? null })
      .where('id', '=', row.id)
      .execute();
    return this.get(key, version);
  }

  async remove(key: string, version: number): Promise<{ success: true }> {
    await this.permissions.assert('skillAdmin');
    const viewer = await this.viewer();
    const row = await this.visibleRow(key, version, viewer);
    this.assertEditable(row, viewer);
    if (row.status !== 'draft') {
      throw new ValidationError('Only a draft can be deleted. Archive a published version instead.');
    }
    await this.database.db
      .updateTable('ai_agent_skills')
      .set({ is_deleted: true, modified_at: new Date(), modified_by_id: this.scope.userId ?? null })
      .where('id', '=', row.id)
      .execute();
    return { success: true };
  }

  // -------------------------------------------------------------------------
  // binding resolution
  // -------------------------------------------------------------------------

  /**
   * Publication-time resolution. The publisher must be able to read each pinned version, and the
   * version must be published (never a draft or an archived-only pick). Visibility is checked here,
   * not at run time, because a background worker has no interactive principal.
   */
  async resolveForPublication(bindings: readonly { key: string; version: number }[]): Promise<SkillResolution> {
    const ordered = orderSkillBindings(bindings);
    if (ordered.length === 0) return { skills: [], issues: [] };
    const viewer = await this.viewer();
    const rows = await this.loadExact(ordered);
    const byId = new Map(rows.map((row) => [`${row.skill_key}:${String(row.version)}`, row]));
    const issues: SkillResolutionIssue[] = [];
    const skills: ResolvedSkill[] = [];
    for (const binding of ordered) {
      const row = byId.get(`${binding.key}:${String(binding.version)}`);
      if (!row) {
        issues.push({ ...binding, message: `Skill "${binding.key}" version ${String(binding.version)} does not exist.` });
      } else if (!this.isVisible(row, viewer)) {
        issues.push({
          ...binding,
          message: `Skill "${binding.key}" version ${String(binding.version)} is not visible to you.`,
        });
      } else if (row.status !== 'published') {
        issues.push({
          ...binding,
          message: `Skill "${binding.key}" version ${String(binding.version)} is not published.`,
        });
      } else {
        skills.push({
          key: row.skill_key,
          version: row.version,
          label: row.label,
          instructions: row.instructions,
        });
      }
    }
    return { skills, issues };
  }

  /**
   * Run-time resolution is deliberately ACL-free: publication already checked visibility, and the
   * pinned version's text is part of the immutable agent snapshot. Drafts are refused; archived
   * versions remain resolvable so an older published agent never changes under its operator.
   */
  async resolvePinned(bindings: readonly { key: string; version: number }[]): Promise<{
    skills: readonly ResolvedSkill[];
    applied: readonly AppliedSkill[];
  }> {
    const ordered = orderSkillBindings(bindings);
    if (ordered.length === 0) return { skills: [], applied: [] };
    const rows = await this.loadExact(ordered);
    const byId = new Map(rows.map((row) => [`${row.skill_key}:${String(row.version)}`, row]));
    const skills: ResolvedSkill[] = [];
    for (const binding of ordered) {
      const row = byId.get(`${binding.key}:${String(binding.version)}`);
      if (!row || (row.status !== 'published' && row.status !== 'archived')) {
        throw new ValidationError(`Pinned skill "${binding.key}" version ${String(binding.version)} is unavailable.`);
      }
      skills.push({
        key: row.skill_key,
        version: row.version,
        label: row.label,
        instructions: row.instructions,
      });
    }
    return {
      skills,
      applied: skills.map((skill) => ({ key: skill.key, version: skill.version, label: skill.label })),
    };
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  private async nextVersion(key: string): Promise<number> {
    const row = await this.database.db
      .selectFrom('ai_agent_skills')
      .select((eb) => eb.fn.max('version').as('version'))
      .where('skill_key', '=', key)
      .executeTakeFirst();
    return Number(row?.version ?? 0) + 1;
  }

  private async loadExact(
    bindings: readonly { key: string; version: number }[],
  ): Promise<readonly AIAgentSkillsTable[]> {
    if (bindings.length === 0) return [];
    return this.database.db
      .selectFrom('ai_agent_skills')
      .selectAll()
      .where((eb) =>
        eb.or(
          bindings.map((binding) =>
            eb.and([eb('skill_key', '=', binding.key), eb('version', '=', binding.version)]),
          ),
        ),
      )
      .where('is_deleted', '=', false)
      .execute();
  }

  private validateInstructions(value: string): string {
    const issues = validateSkillInstructions(value);
    if (issues.length > 0) throw new ValidationError('The skill instructions are invalid.', { issues });
    return normalizeSkillInstructions(value);
  }

  private assertOwned(row: AIAgentSkillsTable, viewer: Viewer): void {
    if (!viewer.canWrite) {
      throw new ValidationError('You may not manage reusable skills.');
    }
    if (!viewer.isAdmin && row.owner_user_id !== null && row.owner_user_id !== viewer.userId &&
        !(row.team_id !== null && viewer.teamIds.includes(row.team_id))) {
      throw new NotFoundError(`Skill "${row.skill_key}" version ${String(row.version)} does not exist.`);
    }
  }

  private assertEditable(row: AIAgentSkillsTable, viewer: Viewer): void {
    this.assertOwned(row, viewer);
    if (row.status !== 'draft') {
      throw new ValidationError('A published skill version is immutable. Create a new version to change it.');
    }
  }

  private async visibleRow(key: string, version: number, viewer: Viewer): Promise<AIAgentSkillsTable> {
    const row = await this.database.db
      .selectFrom('ai_agent_skills')
      .selectAll()
      .where('skill_key', '=', key)
      .where('version', '=', version)
      .where('is_deleted', '=', false)
      .executeTakeFirst();
    if (!row || !this.isVisible(row, viewer)) {
      throw new NotFoundError(`Skill "${key}" version ${String(version)} does not exist.`);
    }
    return row;
  }

  private isVisible(row: AIAgentSkillsTable, viewer: Viewer): boolean {
    return (
      viewer.seesEverything ||
      row.visibility === 'organization' ||
      (row.owner_user_id !== null && row.owner_user_id === viewer.userId) ||
      (row.team_id !== null && viewer.teamIds.includes(row.team_id))
    );
  }

  private async viewer(): Promise<Viewer> {
    const [canWrite, canPublish] = await Promise.all([
      this.permissions.can('skillAdmin'),
      this.permissions.can('publish'),
    ]);
    return {
      userId: this.scope.userId ?? '',
      teamIds: this.scope.teamIds(),
      isAdmin: this.scope.isAdmin,
      seesEverything: this.scope.isAdmin || canWrite || canPublish,
      canWrite,
    };
  }

  private toView(row: AIAgentSkillsTable, viewer: Viewer): SkillView {
    return {
      id: row.id,
      key: row.skill_key,
      version: row.version,
      label: row.label,
      description: row.description,
      instructions: row.instructions,
      status: row.status,
      visibility: row.visibility,
      teamId: row.team_id,
      ownerUserId: row.owner_user_id,
      publishedById: row.published_by_id,
      publishedAt: row.published_at?.toISOString() ?? null,
      publicationNote: row.publication_note,
      canEdit: viewer.canWrite && row.status === 'draft' &&
        (viewer.isAdmin ||
          (row.owner_user_id !== null && row.owner_user_id === viewer.userId) ||
          (row.team_id !== null && viewer.teamIds.includes(row.team_id))),
      createdAt: row.created_at.toISOString(),
      modifiedAt: row.modified_at.toISOString(),
    };
  }
}
