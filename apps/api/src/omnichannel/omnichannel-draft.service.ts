import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AclApiService } from '../acl/acl-api.service.js';
import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import { OmnichannelPermissionService } from './omnichannel-permission.service.js';
import { assertDraftBody } from './omnichannel-snippet.service.js';

/**
 * Phase 19-OM.12 — per-agent reply drafts (plan §14 `19-OM.12` "keep draft and public-send modes
 * distinct").
 *
 * A draft is **workspace state**, not a communication record: it lives in `omnichannel_drafts` (one
 * per conversation per agent), never appears in the timeline, never reaches an adapter, and is
 * deleted by the send that uses it. Editing requires the reply capability and conversation read
 * access; an agent can only ever see their own draft, and the unique index makes "one draft" the
 * storage's promise rather than the code's.
 */
export interface DraftView {
  readonly id: string;
  readonly conversationId: string;
  readonly body: string;
  readonly isInternalNote: boolean;
  readonly updatedAt: string;
}

@Injectable()
export class OmnichannelDraftService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(OmnichannelPermissionService) private readonly permissions: OmnichannelPermissionService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  async get(conversationId: string): Promise<{ readonly draft: DraftView | null }> {
    await this.permissions.assert('inboxView');
    await this.acl.assertAccess('CommunicationConversation', 'read');
    return { draft: await this.find(conversationId) };
  }

  async save(
    conversationId: string,
    input: { readonly body: string; readonly isInternalNote?: boolean | undefined },
  ): Promise<{ readonly draft: DraftView | null }> {
    await this.permissions.assert('reply');
    await this.acl.assertAccess('CommunicationConversation', 'read');
    const body = assertDraftBody(input.body);
    const userId = this.requireUserId();
    if (body === '') {
      // An empty draft is a discarded draft: the composer clearing itself must not leave a row.
      await this.deleteRow(conversationId, userId);
      return { draft: null };
    }
    const now = new Date();
    await sql`
      insert into omnichannel_drafts (id, conversation_id, user_id, body, is_internal_note, created_at, modified_at)
      values (${randomUUID()}, ${conversationId}, ${userId}, ${body}, ${input.isInternalNote === true}, ${now}, ${now})
      on conflict (conversation_id, user_id)
      do update set body = excluded.body, is_internal_note = excluded.is_internal_note, modified_at = ${now}
    `.execute(this.database.db);
    return { draft: await this.find(conversationId) };
  }

  async remove(conversationId: string): Promise<{ readonly removed: boolean }> {
    await this.permissions.assert('reply');
    await this.acl.assertAccess('CommunicationConversation', 'read');
    return { removed: await this.deleteRow(conversationId, this.requireUserId()) };
  }

  private async find(conversationId: string): Promise<DraftView | null> {
    const row = (await sql<{ id: string; body: string; is_internal_note: boolean; modified_at: Date }>`
      select id, body, is_internal_note, modified_at from omnichannel_drafts
      where conversation_id = ${conversationId} and user_id = ${this.requireUserId()}
      limit 1
    `.execute(this.database.db)).rows[0];
    return row === undefined
      ? null
      : {
          id: row.id,
          conversationId,
          body: row.body,
          isInternalNote: row.is_internal_note,
          updatedAt: new Date(row.modified_at).toISOString(),
        };
  }

  private async deleteRow(conversationId: string, userId: string): Promise<boolean> {
    const deleted = (await sql<{ id: string }>`
      delete from omnichannel_drafts where conversation_id = ${conversationId} and user_id = ${userId} returning id
    `.execute(this.database.db)).rows;
    return deleted.length > 0;
  }

  private requireUserId(): string {
    const userId = this.scope.principal?.userId ?? '';
    if (userId === '') throw new Error('A draft needs an authenticated user.');
    return userId;
  }
}
