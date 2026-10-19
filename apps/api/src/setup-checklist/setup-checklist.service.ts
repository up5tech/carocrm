import { Inject, Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service.js';

export interface SetupChecklistItem {
  id: string;
  labelKey: string;
  descriptionKey: string;
  route: string;
  completed: boolean;
  order: number;
}

/**
 * Setup checklist (PLAN_Phase_20_Settings_UX.md §20.15): a guided first-run experience for
 * administrators. Each item has a deep link into the relevant settings page. Completion is
 * structural — an item is "done" when the underlying resource exists (a menu override row, at least
 * one mailbox, etc.) — so the list cannot be gamed by ticking boxes without doing the work.
 */
@Injectable()
export class SetupChecklistService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async getItems(): Promise<{ items: SetupChecklistItem[]; progress: { done: number; total: number } }> {
    const db = this.database.db;

    // Check completion structurally
    const [hasMenu, hasMailbox, hasRole, hasTeam, hasUser] = await Promise.all([
      db.selectFrom('app_settings').selectAll().where('name', '=', 'navigation').executeTakeFirst(),
      db.selectFrom('email_accounts').selectAll().where('is_deleted', '=', false).limit(1).executeTakeFirst(),
      db.selectFrom('roles').selectAll().where('is_deleted', '=', false).limit(1).executeTakeFirst(),
      db.selectFrom('teams').selectAll().where('is_deleted', '=', false).limit(1).executeTakeFirst(),
      db.selectFrom('users').selectAll().where('is_deleted', '=', false).where('type', '!=', 'system').limit(1).executeTakeFirst(),
    ]);

    const items: SetupChecklistItem[] = [
      { id: 'menu', labelKey: 'web.setup.menuLabel', descriptionKey: 'web.setup.menuHint', route: '/admin/settings/menu', completed: !!hasMenu, order: 1 },
      { id: 'email', labelKey: 'web.setup.emailLabel', descriptionKey: 'web.setup.emailHint', route: '/admin/settings/email', completed: !!hasMailbox, order: 2 },
      { id: 'roles', labelKey: 'web.setup.rolesLabel', descriptionKey: 'web.setup.rolesHint', route: '/admin/settings/roles', completed: !!hasRole, order: 3 },
      { id: 'teams', labelKey: 'web.setup.teamsLabel', descriptionKey: 'web.setup.teamsHint', route: '/admin/settings/teams', completed: !!hasTeam, order: 4 },
      { id: 'users', labelKey: 'web.setup.usersLabel', descriptionKey: 'web.setup.usersHint', route: '/admin/settings/users', completed: !!hasUser, order: 5 },
    ];

    const done = items.filter((i) => i.completed).length;
    return { items: items.sort((a, b) => a.order - b.order), progress: { done, total: items.length } };
  }
}
