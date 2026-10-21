import { randomUUID } from 'node:crypto';

import { NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import type { CRMChatPromptsTable } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import { CRMChatPermissionService } from './crm-chat-permission.service.js';
import { CRMChatPolicyService } from './crm-chat-policy.service.js';

/**
 * Phase 19-CHAT.14 — saved prompt templates (PLAN_Phase_19_CRM_Chat.md §7.6, §17 `19-CHAT.14`;
 * contract §6.5, §7.6).
 *
 * A template is **data, never a program**. It is a name and a body the owner inserts into the
 * composer; the text is then submitted like any other message and runs under the submitter's own
 * authorization. Nothing here can name a tool, an entity, a role or a permission, and there is no
 * shared or administrator-owned scope — the table's own comment says so, and the unique constraint
 * `(owner_user_id, name)` is what makes two users' "Weekly summary" two different rows.
 *
 * The invariants:
 *
 *  1. **Owner in the SQL.** Every read and write filters on `owner_user_id`, so another user's
 *     template is a `404`, never a `403` — the answer for "not yours" and "not there" is the same.
 *  2. **No execution path.** This service never evaluates, interpolates or renders a template
 *     into anything executable. It stores and returns text.
 *  3. **Bounded text.** The lengths here are the same bounds the table's check constraints enforce,
 *     so an invalid template is a `422` with a stable message instead of a database error.
 */
export interface CRMChatPromptView {
  readonly id: string;
  readonly name: string;
  readonly promptTemplate: string;
  readonly description: string | null;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly modifiedAt: string;
}

export interface CRMChatPromptCreateInput {
  readonly name: string;
  readonly promptTemplate: string;
  readonly description?: string | undefined;
}

export interface CRMChatPromptPatchInput {
  readonly name?: string | undefined;
  readonly promptTemplate?: string | undefined;
  readonly description?: string | null | undefined;
  readonly enabled?: boolean | undefined;
}

@Injectable()
export class CRMChatPromptService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(CRMChatPermissionService) private readonly permissions: CRMChatPermissionService,
    @Inject(CRMChatPolicyService) private readonly policy: CRMChatPolicyService,
  ) {}

  /** The caller's own templates. There is no administrator scope and no shared catalogue yet. */
  async list(): Promise<{ list: CRMChatPromptView[]; count: number }> {
    await this.permissions.assert('use');
    await this.policy.assertWorkspace();
    const userId = this.requireUserId();

    const rows = await this.database.db
      .selectFrom('crm_chat_prompts')
      .selectAll()
      .where('owner_user_id', '=', userId)
      .orderBy('name', 'asc')
      .execute();

    return { list: rows.map((row) => this.toView(row)), count: rows.length };
  }

  async create(input: CRMChatPromptCreateInput): Promise<CRMChatPromptView> {
    await this.permissions.assert('prompts');
    await this.policy.assertWorkspace();
    const userId = this.requireUserId();

    const name = input.name.trim();
    const template = input.promptTemplate.trim();
    const description = input.description === undefined ? null : input.description.trim();

    const row: CRMChatPromptsTable = {
      id: randomUUID(),
      owner_user_id: userId,
      name,
      prompt_template: template,
      description,
      enabled: true,
      created_at: new Date(),
      modified_at: new Date(),
    };

    try {
      await this.database.db.insertInto('crm_chat_prompts').values(row).execute();
    } catch (error) {
      // `uq_crm_chat_prompts_owner_name_key` — the owner already has a template with this name.
      if (isUniqueViolation(error)) {
        throw new ValidationError(`A prompt template named "${name}" already exists.`, { field: 'name' });
      }
      throw error;
    }

    return this.toView(row);
  }

  async patch(id: string, patch: CRMChatPromptPatchInput): Promise<CRMChatPromptView> {
    await this.permissions.assert('prompts');
    await this.policy.assertWorkspace();
    const userId = this.requireUserId();
    const existing = await this.ownerPrompt(id);

    const update: Partial<CRMChatPromptsTable> = { modified_at: new Date() };
    if (patch.name !== undefined) {
      update.name = patch.name.trim();
    }
    if (patch.promptTemplate !== undefined) {
      update.prompt_template = patch.promptTemplate.trim();
    }
    if (patch.description !== undefined) {
      update.description = patch.description === null ? null : patch.description.trim();
    }
    if (patch.enabled !== undefined) {
      update.enabled = patch.enabled;
    }
    if (Object.keys(update).length === 1) {
      // An empty patch is a read. Returning the current view avoids a pointless write.
      return this.toView(existing);
    }

    try {
      await this.database.db
        .updateTable('crm_chat_prompts')
        .set(update)
        .where('id', '=', existing.id)
        .where('owner_user_id', '=', userId)
        .execute();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ValidationError(`A prompt template named "${String(update.name)}" already exists.`, {
          field: 'name',
        });
      }
      throw error;
    }

    const updated = await this.ownerPrompt(id);
    return this.toView(updated);
  }

  async remove(id: string): Promise<{ status: true }> {
    await this.permissions.assert('prompts');
    await this.policy.assertWorkspace();
    const userId = this.requireUserId();
    const existing = await this.ownerPrompt(id);

    await this.database.db
      .deleteFrom('crm_chat_prompts')
      .where('id', '=', existing.id)
      .where('owner_user_id', '=', userId)
      .execute();

    return { status: true };
  }

  /** Owner-scoped lookup: a miss is `404`, never `403`. */
  private async ownerPrompt(id: string): Promise<CRMChatPromptsTable> {
    const userId = this.requireUserId();
    if (typeof id !== 'string' || id.trim() === '') {
      throw new NotFoundError('Prompt template not found.');
    }
    const row = await this.database.db
      .selectFrom('crm_chat_prompts')
      .selectAll()
      .where('id', '=', id)
      .where('owner_user_id', '=', userId)
      .executeTakeFirst();
    if (!row) throw new NotFoundError(`Prompt template "${id}" does not exist.`);
    return row;
  }

  private requireUserId(): string {
    const id = this.scope.userId;
    if (id === undefined) throw new NotFoundError('No authenticated user for this prompt request.');
    return id;
  }

  private toView(row: CRMChatPromptsTable): CRMChatPromptView {
    return {
      id: row.id,
      name: row.name,
      promptTemplate: row.prompt_template,
      description: row.description,
      enabled: row.enabled,
      createdAt: row.created_at.toISOString(),
      modifiedAt: row.modified_at.toISOString(),
    };
  }
}

/** Postgres unique violation (`23505`). */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}
