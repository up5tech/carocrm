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
 * Setup checklist (PLAN_Phase_20_Settings_UX.md §4.10, §20.15): a guided first-run experience for
 * administrators. Each item has a deep link into the relevant settings page. Completion is
 * structural — an item is "done" when the underlying resource exists (a menu override row, a
 * mailbox, a workflow, the brand row's logo, an administrator's entity override) — so the list
 * cannot be gamed by ticking boxes without doing the work.
 *
 * Two of the plan's eight checks are represented structurally rather than literally:
 * - "at least one custom field" is "an administrator has saved entity metadata", because a field, a
 *   layout and a nav override all land in the same override row and a field-only check would miss a
 *   layout-only customisation;
 * - "main menu reviewed" is "the navigation document has been written", because reviewing a menu and
 *   leaving it as shipped is indistinguishable from never opening the tab.
 */
@Injectable()
export class SetupChecklistService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async getItems(): Promise<{ items: SetupChecklistItem[]; progress: { done: number; total: number } }> {
    const db = this.database.db;

    const [hasMenu, hasMailbox, hasRole, hasTeam, hasUser, hasWorkflow, brand, override] = await Promise.all([
      db.selectFrom('app_settings').select('name').where('name', '=', 'navigation').executeTakeFirst(),
      db.selectFrom('email_accounts').select('id').where('is_deleted', '=', false).limit(1).executeTakeFirst(),
      db.selectFrom('roles').select('id').where('is_deleted', '=', false).limit(1).executeTakeFirst(),
      db.selectFrom('teams').select('id').where('is_deleted', '=', false).limit(1).executeTakeFirst(),
      db.selectFrom('users').select('id').where('is_deleted', '=', false).where('type', '!=', 'system').limit(1).executeTakeFirst(),
      db.selectFrom('workflows').select('id').where('is_deleted', '=', false).limit(1).executeTakeFirst(),
      db.selectFrom('app_settings').select('data').where('name', '=', 'brand').executeTakeFirst(),
      // The Entity Manager writes its overrides to one row; any content means an administrator
      // changed a field, a layout or the entity's navigation behaviour.
      db.selectFrom('app_settings').select('data').where('name', '=', 'entity').executeTakeFirst(),
    ]);

    const logo = (brand?.data as { logoAttachmentId?: string | null } | undefined)?.logoAttachmentId ?? null;
    const overrideData = override?.data as Record<string, unknown> | undefined;

    const items: SetupChecklistItem[] = [
      { id: 'users', labelKey: 'web.setup.usersLabel', descriptionKey: 'web.setup.usersHint', route: '/admin/settings/users', completed: !!hasUser, order: 1 },
      { id: 'roles', labelKey: 'web.setup.rolesLabel', descriptionKey: 'web.setup.rolesHint', route: '/admin/settings/roles', completed: !!hasRole, order: 2 },
      { id: 'teams', labelKey: 'web.setup.teamsLabel', descriptionKey: 'web.setup.teamsHint', route: '/admin/settings/teams', completed: !!hasTeam, order: 3 },
      { id: 'email', labelKey: 'web.setup.emailLabel', descriptionKey: 'web.setup.emailHint', route: '/admin/settings/email', completed: !!hasMailbox, order: 4 },
      { id: 'logo', labelKey: 'web.setup.logoLabel', descriptionKey: 'web.setup.logoHint', route: '/admin/settings/general', completed: logo !== null && logo !== '', order: 5 },
      {
        id: 'fields',
        labelKey: 'web.setup.fieldsLabel',
        descriptionKey: 'web.setup.fieldsHint',
        route: '/admin/entity-manager',
        completed: overrideData !== undefined && Object.keys(overrideData).length > 0,
        order: 6,
      },
      { id: 'workflow', labelKey: 'web.setup.workflowLabel', descriptionKey: 'web.setup.workflowHint', route: '/admin/workflows', completed: !!hasWorkflow, order: 7 },
      { id: 'menu', labelKey: 'web.setup.menuLabel', descriptionKey: 'web.setup.menuHint', route: '/admin/settings/menu', completed: !!hasMenu, order: 8 },
    ];

    const done = items.filter((i) => i.completed).length;
    return { items: items.sort((a, b) => a.order - b.order), progress: { done, total: items.length } };
  }
}
