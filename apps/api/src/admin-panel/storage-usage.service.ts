import { AuthorizationDeniedError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';

/** What the Attachments tab reports about the file store (PLAN_Phase_20_Settings_UX.md §4.3 row 5). */
export interface StorageUsageView {
  /** Files currently stored. */
  attachments: number;
  /** Their total size in bytes. */
  bytes: number;
  /** The largest single file, so a limit that is too low is visible before an upload fails. */
  largest: { name: string; bytes: number } | null;
}

/**
 * Storage figures for the Attachments tab.
 *
 * The tab could not report them before because nothing enumerated the file store; this service answers
 * the two questions an administrator actually asks — how much is stored and what is the biggest file —
 * from the attachment rows the server already owns. It reads metadata only: no file is opened, and no
 * storage provider is contacted, so the answer cannot be slow or provider-specific. Administrator
 * level, checked on the server rather than assumed from the tab being visible.
 */
@Injectable()
export class StorageUsageService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  async usage(): Promise<StorageUsageView> {
    if (!this.scope.isAdmin) {
      throw new AuthorizationDeniedError('Administrator access required.');
    }
    const db = this.database.db;
    const totals = await db
      .selectFrom('attachments')
      .select(({ fn }) => [fn.count<number>('id').as('count'), fn.sum('size').as('bytes')])
      .executeTakeFirst();
    const largest = await db
      .selectFrom('attachments')
      .select(['name', 'size'])
      .orderBy('size', 'desc')
      .limit(1)
      .executeTakeFirst();

    // `sum` over a bigint column comes back as a bigint/string depending on the driver.
    const bytes = Number(totals?.bytes ?? 0);
    return {
      attachments: Number(totals?.count ?? 0),
      bytes: Number.isFinite(bytes) ? bytes : 0,
      largest: largest === undefined ? null : { name: largest.name, bytes: Number(largest.size) },
    };
  }

}
