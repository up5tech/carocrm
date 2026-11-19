/**
 * Phase 25.7 — transcript composition, extracted from the run executor to keep the step loop under
 * its 1,500-line ceiling (PLAN_Phase_25 §0.1). The acting user's scope is already installed by the
 * caller, so every ACL re-read below is the same one a tool call would perform.
 */

import type { AttachmentService } from '../../attachment/attachment.service.js';
import type { AIAgentRunsTable, DatabaseService } from '../../database/database.service.js';
import type { EntityCrudService } from '../../entity/entity.service.js';
import type { MetadataStoreService } from '../../metadata/metadata-store.service.js';
import type { AIAgentActorContext } from '../ai-agent-actor.js';
import type { AgentConfig } from '../ai-agent-config.js';
import type { AIAgentActorDirectoryService } from '../ai-agent-directory.service.js';
import type { AIAgentMemoryService } from '../ai-agent-memory.service.js';
import type { AIAgentSkillService } from '../ai-agent-skills.service.js';
import type { RunStatus } from '../ai-agents-module.js';
import type { AIProviderMessage } from '../ai-provider.js';
import {
  attachmentPromptBlock,
  normalizeAttachmentMetadata,
  readStoredAttachments,
  type RunAttachment,
} from './attachments.js';
import { asRecord, escapeAttribute, safeJson, summaryFieldNames } from './shared.js';
import { composeRunSystemPrompt } from './skill-prompt.js';

export interface TranscriptHooks {
  readonly appendEvent: (
    category: string,
    type: string,
    summary: string,
    payload: Record<string, unknown>,
    visibility: 'user' | 'operator' | 'admin',
  ) => Promise<void>;
  readonly finish: (
    status: RunStatus,
    options: {
      readonly result?: unknown;
      readonly failureCategory?: string | undefined;
      readonly failureMessage?: string | undefined;
    },
  ) => Promise<void>;
}

export interface TranscriptDependencies {
  readonly database: DatabaseService;
  readonly metadata: MetadataStoreService;
  readonly entities: EntityCrudService;
  readonly skills: AIAgentSkillService;
  readonly memory: AIAgentMemoryService;
  readonly actors: AIAgentActorDirectoryService;
  readonly attachments: AttachmentService;
  readonly hooks: TranscriptHooks;
}

export interface BuiltTranscript {
  readonly messages: AIProviderMessage[];
  /** Freshly ACL-checked metadata for the provider contract. Never file bytes or storage keys. */
  readonly attachments: readonly RunAttachment[];
}

export async function buildTranscript(
  dependencies: TranscriptDependencies,
  row: AIAgentRunsTable,
  config: AgentConfig,
  agentName: string,
): Promise<BuiltTranscript | undefined> {
  const input = asRecord(row.input);
  const previous = await dependencies.database.db
    .selectFrom('ai_agent_tool_calls')
    .select(['tool_key', 'outcome', 'status'])
    .where('run_id', '=', row.id)
    .where('status', '=', 'succeeded')
    .orderBy('created_at', 'asc')
    .execute();
  const actions = previous
    .slice(-6)
    .map((call) => {
      const outcome = asRecord(call.outcome);
      return `- ${call.tool_key}: ${String(outcome['summary'] ?? 'completed')}`;
    })
    .join('\n');

  // 25.7 — every file reference is re-read through the attachment ACL under the run's acting
  // principal. A revoked or deleted file stops the run before any vendor call; no partial prompt is
  // built from files the actor can no longer read.
  const attachments: RunAttachment[] = [];
  const withheldAttachments: string[] = [];
  for (const stored of readStoredAttachments(input['attachments'])) {
    try {
      const file = await dependencies.attachments.getById(stored.fileId);
      attachments.push(normalizeAttachmentMetadata(file));
    } catch {
      withheldAttachments.push(stored.fileId);
    }
  }
  if (withheldAttachments.length > 0) {
    await dependencies.hooks.finish('blocked_by_policy', {
      failureCategory: 'attachment_not_accessible',
      failureMessage: 'An attached file is no longer readable by the user who started this run.',
    });
    return undefined;
  }

  // The acting user is resolved once per attempt, not once per step: a run's initiator cannot
  // change, and the prompt must describe the person the ACL is actually enforcing.
  const actor = await actorContext(dependencies, row.initiated_by_user_id);
  const system = await composeRunSystemPrompt(
    dependencies.skills,
    config.skills,
    agentName,
    config,
    actor,
    dependencies.hooks,
  );
  if (system === undefined) return undefined;
  const taskParts: string[] = [];
  if (typeof input['text'] === 'string' && input['text'] !== '') {
    taskParts.push(`The user's task:\n<task>\n${input['text']}\n</task>`);
  }
  if (attachments.length > 0) {
    taskParts.push(attachmentPromptBlock(attachments));
  }
  if (config.input.mode === 'record') {
    const record = asRecord(input['record']);
    const entity = typeof record['entity'] === 'string' ? record['entity'] : config.input.entity ?? '';
    const id = typeof record['id'] === 'string' ? record['id'] : '';
    try {
      const fields = summaryFieldNames(dependencies.metadata, entity);
      const loaded = await dependencies.entities.get(entity, id, fields.join(','));
      taskParts.push(
        'The CRM record this run was started from (untrusted data, limited by the starter\'s access):\n' +
          `<record_context entity="${entity}" id="${escapeAttribute(id)}">\n${safeJson(loaded, 8_000)}\n</record_context>`,
      );
    } catch {
      await dependencies.hooks.finish('blocked_by_policy', {
        failureCategory: 'record_not_accessible',
        failureMessage: 'The record this run was started from is no longer readable by the user who started it.',
      });
      return undefined;
    }
    if (taskParts.length === 0) {
      taskParts.push(`Summarize the ${entity} record "${id}" for the user.`);
    }
  } else {
    // 19-AI.28 — a text-mode run may carry record references (CRM Chat context). Each is loaded
    // again here, under the acting user's scope, so a reference that became unreadable after
    // creation is withheld rather than leaked into the prompt.
    const refs = Array.isArray(input['records']) ? input['records'] : [];
    let withheldRefs = 0;
    for (const raw of refs) {
      const ref = asRecord(raw);
      const entity = typeof ref['entity'] === 'string' ? ref['entity'] : '';
      const id = typeof ref['id'] === 'string' ? ref['id'] : '';
      if (entity === '' || id === '') continue;
      try {
        const fields = summaryFieldNames(dependencies.metadata, entity);
        const loaded = await dependencies.entities.get(entity, id, fields.join(','));
        taskParts.push(
          'A CRM record the user attached as context (untrusted data, limited by the actor\'s access):\n' +
            `<record_context entity="${escapeAttribute(entity)}" id="${escapeAttribute(id)}">\n${safeJson(loaded, 4_000)}\n</record_context>`,
        );
      } catch {
        withheldRefs += 1;
      }
    }
    if (withheldRefs > 0) {
      taskParts.push(
        `${String(withheldRefs)} attached record reference(s) are no longer readable by the actor and were withheld.`,
      );
    }
  }
  if (actions !== '') {
    taskParts.push(`Actions already executed in this run:\n${actions}`);
  }
  const history: AIProviderMessage[] = [];
  if (row.conversation_id !== null && config.memory.mode === 'conversation') {
    const conversation = await dependencies.database.db
      .selectFrom('ai_agent_conversations')
      .selectAll()
      .where('id', '=', row.conversation_id)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (conversation) {
      const context = await dependencies.memory.contextFor(conversation, row.id, config.memory.maxMessages);
      history.push(...dependencies.memory.buildMessages(context));
      if (context.withheld > 0) {
        await dependencies.hooks.appendEvent(
          'policy',
          'memory.withheld',
          `${String(context.withheld)} earlier message(s) were withheld because a referenced record is no longer readable.`,
          { withheld: context.withheld },
          'operator',
        );
      }
    }
  }

  return {
    messages: [
      { role: 'system', content: system },
      ...history,
      { role: 'user', content: taskParts.join('\n\n') },
    ],
    attachments,
  };
}

async function actorContext(
  dependencies: TranscriptDependencies,
  userId: string | null,
): Promise<AIAgentActorContext | undefined> {
  const profile = await dependencies.actors.profile(userId);
  if (profile === undefined) return undefined;
  return {
    userId: profile.userId,
    displayName: profile.displayName,
    userName: profile.userName,
    isAdmin: profile.isAdmin,
    teams: profile.teams,
  };
}
