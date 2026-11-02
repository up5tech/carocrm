import { Inject, Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service.js';
import { I18nService } from '../i18n/i18n.service.js';
import type { AIAgentActorContext, AIAgentActorTeam } from './ai-agent-actor.js';

/**
 * Phase 19-CHAT.21 — one answer to "who is this user"
 * (plans/PLAN_Phase_19_CRM_Chat.md §17 `19-CHAT.21`; `plans/SPEC.md` §9.2 T1.1).
 *
 * Two callers need the acting user and they must never disagree:
 *
 *  - the system prompt (`AIAgentRunService.actorContext`), which needs the id a filter accepts;
 *  - the `crm_actor_context` tool, which needs the id **and** the locale, timezone and teams the
 *    model cannot otherwise know — including which local day "today" is.
 *
 * A second query written next to the tool would have drifted: the prompt would keep saying one thing
 * while the tool answered another. Both now read this service.
 *
 * ## Bounds
 *
 * One query for the user, one for teams, each bounded. A deleted or missing user yields `undefined`
 * rather than an error: a run whose initiator was removed must fail on ACL, not on prompt assembly.
 *
 * ## Fallbacks
 *
 * `users.locale` and `users.timezone` are nullable by design ("null = instance default"), so the
 * instance default from `I18nService` is applied here, once. A profile therefore always carries a
 * usable zone, which is what the period resolver needs.
 */

export interface AIAgentActorProfile extends AIAgentActorContext {
  readonly email: string | null;
  /** IANA zone the calendar arithmetic runs in; never empty. */
  readonly timezone: string;
  /** The user's UI locale, falling back to the instance default. */
  readonly locale: string;
}

const MAX_TEAMS = 50;

@Injectable()
export class AIAgentActorDirectoryService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(I18nService) private readonly i18n: I18nService,
  ) {}

  /**
   * The full profile, or `undefined` when the user no longer exists.
   *
   * `timeZone` may be supplied by a caller that already knows it; it exists for tests and for a
   * future per-request override, and is validated by the period resolver rather than here.
   */
  async profile(userId: string | null): Promise<AIAgentActorProfile | undefined> {
    if (userId === null || userId === '') return undefined;
    const user = await this.database.db
      .selectFrom('users')
      .select(['user_name', 'first_name', 'last_name', 'is_admin', 'email_address', 'locale', 'timezone'])
      .where('id', '=', userId)
      .where('is_deleted', '=', false)
      .executeTakeFirst();
    if (user === undefined) return undefined;

    const defaults = await this.i18n.settings();
    const teams = await this.teams(userId);

    const display = [user.first_name ?? '', user.last_name ?? '']
      .map((part) => part.trim())
      .filter((part) => part !== '')
      .join(' ');

    return {
      userId,
      displayName: display === '' ? user.user_name : display,
      userName: user.user_name,
      isAdmin: user.is_admin,
      teams,
      email: user.email_address,
      locale: user.locale ?? defaults.defaultLocale,
      timezone: user.timezone ?? defaults.defaultTimezone,
    };
  }

  /**
   * Id → display name, for the keys an aggregate grouped by `assignedUserId`.
   *
   * A group key is an id; an answer that reads "u_9f3a1c: 1200000" is technically correct and
   * useless. Bounded to the ids actually returned, and it exposes nothing beyond a name: no email,
   * no role, no permission.
   */
  async displayNames(ids: readonly string[]): Promise<Record<string, string>> {
    const unique = [...new Set(ids.filter((id) => id !== ''))].slice(0, 200);
    if (unique.length === 0) return {};
    const rows = await this.database.db
      .selectFrom('users')
      .select(['id', 'user_name', 'first_name', 'last_name'])
      .where('id', 'in', unique)
      .where('is_deleted', '=', false)
      .execute();
    const out: Record<string, string> = {};
    for (const row of rows) {
      const display = [row.first_name ?? '', row.last_name ?? '']
        .map((part) => part.trim())
        .filter((part) => part !== '')
        .join(' ');
      out[row.id] = display === '' ? row.user_name : display;
    }
    return out;
  }

  private async teams(userId: string): Promise<readonly AIAgentActorTeam[]> {    const rows = await this.database.db
      .selectFrom('users_teams')
      .innerJoin('teams', 'teams.id', 'users_teams.team_id')
      .select(['teams.id', 'teams.name'])
      .where('users_teams.user_id', '=', userId)
      .where('teams.is_deleted', '=', false)
      .orderBy('teams.name', 'asc')
      .limit(MAX_TEAMS)
      .execute();
    return rows.map((team) => ({ id: team.id, name: team.name }));
  }
}
