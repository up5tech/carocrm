import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AclApiService } from '../acl/acl-api.service.js';
import { DatabaseService } from '../database/database.service.js';
import { type CallSessionView,VoiceCallService } from '../voice-communications/index.js';

/**
 * Phase 19-OM.13 — call context in the workspace (plan §14 `19-OM.13`).
 *
 * A call is a `voice_call_session`, **not** a conversation (contract §4). This service therefore
 * never converts calls into messages or threads: it reads the owner's ACL-scoped call list
 * (`VoiceCallService.list`), and for each call resolves the customer's existing message
 * conversation — by digit-equal participant address — so the agent can *open* it in one action. No
 * provider API is called, no credential is held, and the transport/opt-out state stays entirely in
 * `VoiceCommunications`.
 */
export interface OmnichannelCallView extends CallSessionView {
  /** The customer's existing conversation on any message channel, when one exists. */
  readonly conversationId: string | null;
}

@Injectable()
export class OmnichannelCallService {
  constructor(
    @Inject(VoiceCallService) private readonly calls: VoiceCallService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async recent(query: { readonly limit: number; readonly offset: number }): Promise<{ readonly list: readonly OmnichannelCallView[] }> {
    await this.acl.assertAccess('CommunicationConversation', 'read');
    const calls = await this.calls.list(query);
    const list: OmnichannelCallView[] = [];
    for (const call of calls) {
      list.push({ ...call, conversationId: await this.findConversationId(call) });
    }
    return { list };
  }

  /**
   * The explicit "open conversation" action. The call is looked up through the owner's own
   * accessor — a call this caller cannot see is a 404, not a probe — and the lookup does not
   * depend on how many calls the list happens to hold.
   */
  async openConversation(callId: string): Promise<{ readonly callId: string; readonly conversationId: string | null }> {
    await this.acl.assertAccess('CommunicationConversation', 'read');
    const call = await this.calls.get(callId);
    return { callId, conversationId: await this.findConversationId(call) };
  }

  private async findConversationId(call: CallSessionView): Promise<string | null> {
    const address = call.direction === 'inbound' ? call.fromNumber : call.toNumber;
    const digits = (address ?? '').replace(/[^0-9]/g, '');
    if (digits === '') return null;
    const row = (await sql<{ conversation_id: string }>`
      select p.conversation_id
      from voice_conversation_participants p
      join voice_conversations c on c.id = p.conversation_id
      where p.role = 'customer'
        and regexp_replace(p.address, '[^0-9]', '', 'g') = ${digits}
      order by c.last_activity_at desc nulls last
      limit 1
    `.execute(this.database.db)).rows[0];
    return row?.conversation_id ?? null;
  }
}
