import { describe, expect, it, vi } from 'vitest';

import type { AIAgentRunService } from '../src/ai-agents/ai-agent-runs.service.js';
import { CRMChatAIAgentsClientService } from '../src/crm-chat/crm-chat-ai-agents-client.service.js';
import {
  CRMChatSettingsSchema,
  type CRMChatSettingsService,
} from '../src/crm-chat/crm-chat-settings.service.js';
import { CRMChatSettingsPatchSchema } from '../src/crm-chat/dto/crm-chat-shapes.js';

/**
 * The execution mode is a dispatch choice, not a second run engine: both modes create the same
 * durable AIAgent run. This suite keeps the contract cheap to verify without a database or provider.
 */
function buildService(mode: 'queue' | 'inline') {
  const create = vi.fn().mockResolvedValue({
    id: 'run-1',
    status: 'queued',
    conversationId: 'conversation-1',
  });
  const execute = vi.fn().mockResolvedValue({ run: { id: 'run-1' }, claimed: true, waitingForApproval: false });
  const settings = { settings: vi.fn().mockResolvedValue({ execution: { mode } }) };

  const service = new CRMChatAIAgentsClientService(
    { create, execute } as unknown as AIAgentRunService,
    settings as unknown as CRMChatSettingsService,
  );
  return { service, create, execute };
}

const submission = {
  agentId: 'agent-1',
  prompt: 'AGENT_TEST_hello',
  idempotencyKey: 'AGENT_TEST_inline',
} as const;

describe('CRM Chat execution mode', () => {
  it('defaults to the durable worker queue', () => {
    expect(CRMChatSettingsSchema.parse({}).execution.mode).toBe('queue');
  });

  it('accepts inline mode through the patch shape and rejects an unknown mode', () => {
    expect(CRMChatSettingsPatchSchema.parse({ execution: { mode: 'inline' } })).toEqual({
      execution: { mode: 'inline' },
    });
    expect(() => CRMChatSettingsSchema.parse({ execution: { mode: 'sync' } })).toThrow();
  });

  it('does not execute the run in the request process in queue mode', async () => {
    const { service, create, execute } = buildService('queue');

    const result = await service.submitTurn(submission);

    expect(create).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(result).toEqual({
      turnId: 'run-1',
      runId: 'run-1',
      status: 'queued',
      conversationId: 'conversation-1',
    });
  });

  it('starts the same durable run in the API process in inline mode', async () => {
    const { service, create, execute } = buildService('inline');

    await service.submitTurn(submission);

    expect(create).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledWith('run-1'));
  });
});
