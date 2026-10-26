import { ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AclApiService } from '../acl/acl-api.service.js';
import { DatabaseService } from '../database/database.service.js';
import { type CaseAssignmentDecision,CaseAssignmentService } from '../service-desk/index.js';
import { type InboxConversationView,VoiceInboxService } from '../voice-communications/index.js';

/**
 * Phase 19-OM.11 — conversation routing policy (plan §14 `19-OM.11`; decision D2).
 *
 * The **engine** stays in ServiceDesk (`CaseAssignmentService.decideFor`): rules, queue strategies,
 * round-robin/least-busy, workload and fallbacks are its. The **record** stays in Voice
 * (`VoiceInboxService.assign`): ACL, optimistic concurrency and the append-only assignment event are
 * its. This service only composes the two — it builds the conversation subject, asks ServiceDesk for
 * a decision, applies it through the owner, and returns the decision unchanged so the workspace can
 * explain *why* a conversation landed where it did. There is no second queue or rule evaluator.
 */
@Injectable()
export class OmnichannelRoutingService {
  constructor(
    @Inject(CaseAssignmentService) private readonly assignment: CaseAssignmentService,
    @Inject(VoiceInboxService) private readonly inbox: VoiceInboxService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  /** Route one conversation deterministically; `expectedVersion` makes a concurrent claim a 409. */
  async route(
    conversationId: string,
    input: { readonly expectedVersion?: number | undefined } = {},
  ): Promise<{ readonly decision: CaseAssignmentDecision; readonly conversation: InboxConversationView }> {
    await this.acl.assertAccess('CommunicationConversation', 'read');
    const row = (await sql<{
      id: string;
      channel: string;
      priority: string;
      status: string;
      language: string | null;
      category: string | null;
      current_queue_id: string | null;
      assigned_team_id: string | null;
    }>`
      select id, channel, priority, status, language, category, current_queue_id, assigned_team_id
      from voice_conversations where id = ${conversationId}
    `.execute(this.database.db)).rows[0];
    if (row === undefined) throw new ValidationError(`Conversation "${conversationId}" does not exist.`);

    // The subject is the conversation's own facts; a Case has no channel/language/category, so the
    // same rule fields are inert for cases (unchanged behaviour) and useful here.
    const decision = await this.assignment.decideFor({
      objectType: 'conversation',
      subject: {
        channel: row.channel,
        priority: row.priority,
        status: row.status,
        ...(row.language === null ? {} : { language: row.language }),
        ...(row.category === null ? {} : { category: row.category }),
        ...(row.current_queue_id === null ? {} : { queueId: row.current_queue_id }),
        ...(row.assigned_team_id === null ? {} : { teamId: row.assigned_team_id }),
      },
    });

    const conversation = await this.inbox.assign(conversationId, {
      userId: decision.assignedUserId,
      teamId: decision.teamId,
      ...(decision.queueId === null ? {} : { queueId: decision.queueId }),
      reason: `routed (${decision.fallbackReason ?? 'rule matched'})`,
      routing: {
        strategy: decision.strategy,
        routingRuleId: decision.routingRuleId,
        routingRuleName: decision.routingRuleName,
        fallbackReason: decision.fallbackReason,
      },
      ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
    });
    return { decision, conversation };
  }
}
