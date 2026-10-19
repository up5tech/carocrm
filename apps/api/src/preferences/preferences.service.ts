import { RecordNotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import { PREFERENCE_NAMES,preferenceSchema } from './preference-shapes.js';

export interface PreferenceView {
  name: string;
  value: unknown;
  updatedAt: string;
}

/**
 * Per-user preferences (PLAN_Phase_20_Settings_UX.md §5.9, §20.10).
 *
 * Ownership is structural: every query keys off the caller's own id and the routes carry no user id,
 * so there is no code path that could read another account's row — not for administrators either.
 * That is what "never leak between users" means here, and `user-preferences.test.ts` pins it.
 */
@Injectable()
export class PreferencesService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  private requireUser(): string {
    const userId = this.scope.userId;
    if (userId === undefined || userId === null || userId === '') {
      throw new RecordNotFoundError('User', String(userId ?? ''));
    }
    return userId;
  }

  /** Every preference this account has set. Names without a row are absent — the client keeps defaults. */
  async all(): Promise<{ items: PreferenceView[] }> {
    const userId = this.requireUser();
    const rows = await this.database.db
      .selectFrom('user_preferences')
      .select(['name', 'data', 'modified_at'])
      .where('user_id', '=', userId)
      .orderBy('name')
      .execute();
    return {
      items: rows.map((row) => ({ name: row.name, value: row.data, updatedAt: row.modified_at.toISOString() })),
    };
  }

  async get(name: string): Promise<PreferenceView> {
    this.assertKnown(name);
    const userId = this.requireUser();
    const row = await this.database.db
      .selectFrom('user_preferences')
      .select(['name', 'data', 'modified_at'])
      .where('user_id', '=', userId)
      .where('name', '=', name)
      .executeTakeFirst();
    if (row === undefined) {
      return { name, value: null, updatedAt: new Date(0).toISOString() };
    }
    return { name: row.name, value: row.data, updatedAt: row.modified_at.toISOString() };
  }

  async put(name: string, value: unknown): Promise<PreferenceView> {
    this.assertKnown(name);
    const schema = preferenceSchema(name);
    if (schema === undefined) {
      throw new ValidationError('Unknown preference name.', { name, allowed: PREFERENCE_NAMES });
    }
    const userId = this.requireUser();
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new ValidationError(`The value for "${name}" is not valid.`, {
        name,
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }
    const now = new Date();
    // JSONB params travel as text: the value has to be serialized, the way the metadata store does it.
    const stored = JSON.stringify(parsed.data) as unknown;
    await this.database.db
      .insertInto('user_preferences')
      .values({ user_id: userId, name, data: stored, created_at: now, modified_at: now })
      .onConflict((oc) => oc.columns(['user_id', 'name']).doUpdateSet({ data: stored, modified_at: now }))
      .execute();
    return { name, value: parsed.data, updatedAt: now.toISOString() };
  }

  private assertKnown(name: string): void {
    if (!PREFERENCE_NAMES.includes(name)) {
      throw new ValidationError('Unknown preference name.', { name, allowed: PREFERENCE_NAMES });
    }
  }
}
