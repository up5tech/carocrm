import { ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';

import { type AIToolContext, type AIToolDefinition,AIToolRegistry } from '../ai-agents/index.js';
import { DatabaseService } from '../database/database.service.js';
import { OmnichannelConversationService } from './omnichannel-conversation.service.js';
import { OmnichannelSettingsService } from './omnichannel-settings.service.js';

/**
 * Phase 19-OM.19 — the channel-send tool (extension E16, plan §14 `19-OM.19`).
 *
 * Without a registered tool the AIAgents approval matrix can never fire for a send: any AI-originated
 * message would either be impossible or bypass approval. This definition closes that gap:
 *
 *  - `effectClass: 'material_write'` and `requiresApproval: true` — the run pauses for a **human**
 *    approval before the tool executes (the default matrix requires approval for material writes).
 *  - `execute` calls the same workspace facade the composer uses, under the **initiating actor's**
 *    request scope: policy/consent/capability/ACL checks all apply to AI text exactly as to typed
 *    text; AI cannot grant itself a capability or skip a refusal.
 *  - A tool failure whose effect is unknown is recorded by the runtime as `outcome_unknown` and never
 *    auto-retried (AIAgents owns that state machine); this handler never retries a send itself.
 */

export const OMNICHANNEL_SEND_TOOL = 'omnichannel.send_message';

const SendArgumentsSchema = z
  .object({
    conversationId: z.string().trim().min(1).max(120),
    body: z.string().min(1).max(20_000),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();

@Injectable()
export class OmnichannelAiTools {
  constructor(
    @Inject(AIToolRegistry) private readonly registry: AIToolRegistry,
    @Inject(OmnichannelConversationService) private readonly conversations: OmnichannelConversationService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(OmnichannelSettingsService) private readonly settings: OmnichannelSettingsService,
  ) {
    const definition: AIToolDefinition = {
      key: OMNICHANNEL_SEND_TOOL,
      label: 'Send an omnichannel message',
      description:
        'Send one customer-visible message in an existing conversation, through the same policy, consent and capability checks as an agent reply. Requires human approval before execution.',
      version: '1',
      owningModule: 'Omnichannel',
      effectClass: 'material_write',
      requiresApproval: true,
      entityScopes: ['CommunicationConversation', 'CommunicationMessage'],
      inputSchema: SendArgumentsSchema,
      inputJsonSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['conversationId', 'body', 'idempotencyKey'],
        properties: {
          conversationId: { type: 'string', description: 'The conversation to send in.' },
          body: { type: 'string', description: 'Plain-text message body.' },
          idempotencyKey: { type: 'string', description: 'Stable key so a retry cannot double-send.' },
        },
      },
      maxResultBytes: 2_000,
      timeoutMs: 15_000,
      preview: async (args, _context: AIToolContext) => {
        const parsed = SendArgumentsSchema.parse(args);
        return {
          summary: `Send this message in conversation ${parsed.conversationId}: ${parsed.body.slice(0, 140)}`,
          targets: [{ type: 'CommunicationConversation', id: parsed.conversationId }],
          detail: { body: parsed.body.slice(0, 500) },
        };
      },
      execute: async (args, context: AIToolContext) => {
        const parsed = SendArgumentsSchema.parse(args);
        // The model may only send into the conversation its run was started from, under the same
        // human's scope. A hallucinated or injected conversation id is refused before any policy work.
        await this.assertRunScope(context, parsed.conversationId);
        // The tool runs outside the request that queued it, so it asks the module switch itself: a
        // workspace that was switched off after the run started must not send anything.
        await this.settings.assertWorkspace();
        const result = await this.conversations.send(parsed.conversationId, {
          body: parsed.body,
          idempotencyKey: parsed.idempotencyKey,
        });
        return {
          summary:
            result.message.state === 'unknown'
              ? `Message ${result.message.id} was accepted with an unknown outcome; it must be reconciled, not resent.`
              : `Message ${result.message.id} recorded with state "${result.message.state}"${result.duplicate ? ' (idempotent duplicate)' : ''}.`,
          result: { messageId: result.message.id, state: result.message.state, duplicate: result.duplicate },
          resultRef: result.message.id,
        };
      },
    };
    this.registry.register(definition);
  }

  private async assertRunScope(context: AIToolContext, conversationId: string): Promise<void> {
    const row = (await sql<{ input: unknown; initiated_by_user_id: string | null }>`
      select input, initiated_by_user_id from ai_agent_runs where id = ${context.runId}
    `.execute(this.database.db)).rows[0];
    const input = typeof row?.input === 'object' && row.input !== null ? (row.input as Record<string, unknown>) : {};
    const record = typeof input['record'] === 'object' && input['record'] !== null ? (input['record'] as Record<string, unknown>) : {};
    const boundConversation = typeof record['id'] === 'string' ? record['id'] : null;
    if (
      row === undefined ||
      row.initiated_by_user_id !== context.actorUserId ||
      record['entity'] !== 'CommunicationConversation' ||
      boundConversation !== conversationId
    ) {
      throw new ValidationError('This AI run may only send in the conversation it was started from.', {
        refusals: ['run_scope_mismatch'],
      });
    }
  }
}
