import { randomUUID } from 'node:crypto';

import { NotFoundError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AclApiService } from '../acl/acl-api.service.js';
import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import { OmnichannelPermissionService } from './omnichannel-permission.service.js';
import { OmnichannelSettingsService } from './omnichannel-settings.service.js';

/**
 * Phase 19-OM.18 — authorized data export and module-owned retention
 * (plan §14 `19-OM.18`; acceptance: retention explicit and testable, consent never copied).
 *
 * Two responsibilities, both inside the module's own boundary:
 *
 * 1. **Data-rights export** of one conversation for an administrator: conversation metadata,
 *    participants (addresses and their evidence) and the **customer-visible** messages only —
 *    internal notes are excluded in SQL, exactly like the widget query, because an export handed to
 *    a data subject must never contain staff notes. The act is audited (counts, never content).
 * 2. **Retention of the artefacts Omnichannel owns** — stale per-agent drafts and expired visitor
 *    sessions — driven by the module's own settings. Message/media/webhook retention stays with
 *    VoiceCommunications (`voice_media.retention_at` sweep) and MarketingAutomation for email; no
 *    second consent or retention store is created here.
 *
 * Deletion of the canonical conversation/message records is deliberately **not** implemented here:
 * those rows belong to VoiceCommunications and their erasure needs the platform's documented
 * retention/deletion workflow (legal review, audit preservation). The export answers the access
 * request; erasure is recorded as an open owner task in the retention document.
 */

export interface ConversationExport {
  readonly generatedAt: string;
  readonly conversation: {
    readonly id: string;
    readonly channel: string;
    readonly status: string;
    readonly priority: string;
    readonly createdAt: string;
    readonly lastActivityAt: string | null;
    readonly caseId: string | null;
    readonly assignedUserId: string | null;
  };
  readonly participants: readonly {
    readonly address: string;
    readonly role: string;
    readonly entityType: string | null;
    readonly entityId: string | null;
    readonly displayName: string | null;
    readonly verificationState: string;
    readonly linkConfidence: string;
  }[];
  /** Customer-visible messages only; internal notes are never exported. */
  readonly messages: readonly {
    readonly id: string;
    readonly direction: 'inbound' | 'outbound';
    readonly body: string | null;
    readonly state: string;
    readonly createdAt: string;
  }[];
  /** Whether the record holds internal notes; their count is not disclosed. */
  readonly excluded: { readonly internalNotes: boolean };
}

@Injectable()
export class OmnichannelDataService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(OmnichannelPermissionService) private readonly permissions: OmnichannelPermissionService,
    @Inject(OmnichannelSettingsService) private readonly settings: OmnichannelSettingsService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  /** Administrator export for a data-subject access request. */
  async exportConversation(conversationId: string): Promise<ConversationExport> {
    await this.permissions.assert('settingsManage');
    await this.acl.assertAccess('CommunicationConversation', 'read');
    const conversation = (await sql<{
      id: string;
      channel: string;
      status: string;
      priority: string;
      created_at: Date;
      last_activity_at: Date | null;
      case_id: string | null;
      assigned_user_id: string | null;
    }>`
      select id, channel, status, priority, created_at, last_activity_at, case_id, assigned_user_id
      from voice_conversations where id = ${conversationId}
    `.execute(this.database.db)).rows[0];
    if (conversation === undefined) throw new NotFoundError(`Conversation "${conversationId}" does not exist.`);

    const participants = (await sql<{
      address: string;
      role: string;
      entity_type: string | null;
      entity_id: string | null;
      display_name: string | null;
      verification_state: string;
      link_confidence: string;
    }>`
      select address, role, entity_type, entity_id, display_name, verification_state, link_confidence
      from voice_conversation_participants where conversation_id = ${conversationId}
      order by created_at asc
    `.execute(this.database.db)).rows;

    const messages = (await sql<{
      id: string;
      direction: string;
      body: string | null;
      state: string;
      created_at: Date;
    }>`
      select id, direction, body, state, created_at
      from voice_messages
      where conversation_id = ${conversationId} and is_internal_note = false
      order by created_at asc limit 5000
    `.execute(this.database.db)).rows;

    const hasInternalNotes = (await sql<{ present: boolean }>`
      select exists(
        select 1 from voice_messages where conversation_id = ${conversationId} and is_internal_note = true
      ) as present
    `.execute(this.database.db)).rows[0]?.present === true;
    const exportView: ConversationExport = {
      generatedAt: new Date().toISOString(),
      conversation: {
        id: conversation.id,
        channel: conversation.channel,
        status: conversation.status,
        priority: conversation.priority,
        createdAt: new Date(conversation.created_at).toISOString(),
        lastActivityAt: conversation.last_activity_at === null ? null : new Date(conversation.last_activity_at).toISOString(),
        caseId: conversation.case_id,
        assignedUserId: conversation.assigned_user_id,
      },
      participants: participants.map((row) => ({
        address: row.address,
        role: row.role,
        entityType: row.entity_type,
        entityId: row.entity_id,
        displayName: row.display_name,
        verificationState: row.verification_state,
        linkConfidence: row.link_confidence,
      })),
      messages: messages.map((row) => ({
        id: row.id,
        direction: row.direction === 'outbound' ? 'outbound' : 'inbound',
        body: row.body,
        state: row.state,
        createdAt: new Date(row.created_at).toISOString(),
      })),
      excluded: { internalNotes: hasInternalNotes },
    };
    await this.audit(conversationId, 'CommunicationConversationExport', {
      messages: exportView.messages.length,
      participants: exportView.participants.length,
      internalNotesExcluded: exportView.excluded.internalNotes,
    });
    return exportView;
  }

  /** Purge module-owned artefacts past their configured retention (administrator). */
  async purge(): Promise<{ readonly drafts: number; readonly sessions: number; readonly retention: { staleDraftDays: number; expiredSessionDays: number } }> {
    await this.permissions.assert('settingsManage');
    const retention = (await this.settings.settings()).retention;
    const drafts = (await sql<{ id: string }>`
      delete from omnichannel_drafts
      where modified_at < now() - (${retention.staleDraftDays} || ' days')::interval
      returning id
    `.execute(this.database.db)).rows;
    const sessions = (await sql<{ id: string }>`
      delete from omnichannel_visitor_sessions
      where (status = 'expired' or expires_at < now())
        and expires_at < now() - (${retention.expiredSessionDays} || ' days')::interval
      returning id
    `.execute(this.database.db)).rows;
    return { drafts: drafts.length, sessions: sessions.length, retention };
  }

  private async audit(conversationId: string, action: string, data: Record<string, unknown>): Promise<void> {
    await sql`
      insert into audit_log (id, entity_type, record_id, username, user_id, action, "order", data)
      values (${`audit_${randomUUID()}`}, 'CommunicationConversation', ${conversationId},
              ${this.scope.principal?.userName ?? null}, ${this.scope.userId ?? null}, ${action}, 0,
              ${JSON.stringify(data)}::jsonb)
    `.execute(this.database.db);
  }
}
